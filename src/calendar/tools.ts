import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { configPath, type Config } from '../config.js';
import type { CalendarInfo, CalendarObject, CalendarStore } from './dav.js';
import { attendeeCount, buildEvent, describe, expand, expandOne, removeInstance, updateEvent, type EventInput, type Occurrence } from './ical.js';
import { formatInZone, parseInstant, startOfDay, wallAt, wallToMs } from './time.js';

const DAY_MS = 86400000;
const MAX_EVENTS = 500;

// ---------------------------------------------------------------- event ids

interface EventRef {
  account: string;
  path: string;
  rid?: string;
}

function encodeId(ref: EventRef): string {
  const parts = [ref.account, ref.path, ...(ref.rid ? [ref.rid] : [])];
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

function decodeId(id: string): EventRef {
  try {
    const [account, path, rid] = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (typeof account === 'string' && typeof path === 'string') return { account, path, rid };
  } catch {}
  throw new Error(`invalid event id "${id}"; use an id returned by list_events or search_events`);
}

// ---------------------------------------------------------------- helpers

type Ctx = { store: CalendarStore; config: Config };

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

function guardrailError(key: string, why: string): Error {
  return new Error(`${why} This is disabled by the user's config. To allow it, set guardrails.${key} = true in ${configPath()}.`);
}

interface Found {
  occ: Occurrence;
  obj: CalendarObject;
}

function eventOut(f: Found, tz: string, detailed: boolean) {
  const { calendar } = f.obj;
  const { uid, ...fields } = describe(f.occ, tz, detailed);
  return {
    id: encodeId({ account: calendar.account, path: new URL(f.obj.url).pathname, rid: f.occ.rid }),
    calendar: calendar.id,
    ...fields,
    ...(detailed ? { uid } : {}),
  };
}

async function collect(ctx: Ctx, startMs: number, endMs: number, calendars?: string[], accounts?: string[]) {
  const { calendars: cals, errors } = await ctx.store.filterCalendars(calendars, accounts);
  const found: Found[] = [];
  const results = await Promise.allSettled(
    cals.map(async (cal) => {
      for (const obj of await ctx.store.fetchRange(cal, startMs, endMs)) {
        try {
          for (const occ of expand(obj.data, startMs, endMs, ctx.config.timezone)) found.push({ occ, obj });
        } catch {
          // Skip objects we can't parse rather than failing the whole listing.
        }
      }
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') errors.push({ account: cals[i].id, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  found.sort((a, b) => a.occ.startMs - b.occ.startMs || Number(b.occ.allDay) - Number(a.occ.allDay));
  return { found, errors };
}

function range(ctx: Ctx, start: string | undefined, end: string | undefined, defaultBackDays: number, defaultForwardDays: number) {
  const tz = ctx.config.timezone;
  const today = startOfDay(Date.now(), tz);
  const startMs = start ? parseInstant(start, tz) : today - defaultBackDays * DAY_MS;
  let endMs = end ? parseInstant(end, tz) : startMs + (defaultBackDays + defaultForwardDays) * DAY_MS;
  // A date-only end means "through that day".
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())) endMs += DAY_MS;
  if (endMs <= startMs) throw new Error('end must be after start');
  return { startMs, endMs };
}

function listing(ctx: Ctx, found: Found[], errors: { account: string; error: string }[]) {
  const tz = ctx.config.timezone;
  return {
    timezone: tz,
    events: found.slice(0, MAX_EVENTS).map((f) => eventOut(f, tz, false)),
    ...(found.length > MAX_EVENTS ? { truncated: `showing ${MAX_EVENTS} of ${found.length}; narrow the range` } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

async function loadEvent(ctx: Ctx, id: string): Promise<Found & { ref: EventRef }> {
  const ref = decodeId(id);
  const obj = await ctx.store.fetchObject(ref.account, ref.path);
  const tz = ctx.config.timezone;
  let occ: Occurrence;
  if (ref.rid) occ = expandOne(obj.data, ref.rid, tz);
  else {
    const [first] = expand(obj.data, -8.64e15, 8.64e15, tz);
    if (!first) throw new Error('event not found');
    occ = first;
  }
  return { occ, obj, ref };
}

function assertWritable(cal: CalendarInfo) {
  if (!cal.writable) {
    throw new Error(`Calendar "${cal.id}" is read-only in the user's config (read_only / read_only_calendars in ${configPath()}).`);
  }
}

function resolveScope(ref: EventRef, scope: 'series' | 'instance' | undefined): 'series' | 'instance' {
  if (!ref.rid) return 'series';
  if (!scope) throw new Error('this is a recurring event: pass scope "instance" (just this occurrence) or "series" (all occurrences).');
  return scope;
}

function organizerFor(ctx: Ctx, account: string): string | undefined {
  const user = ctx.store.account(account).username;
  return user.includes('@') ? user : undefined;
}

// ---------------------------------------------------------------- schemas

const timeHelp = 'YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:MM (local to the configured timezone unless it has Z/±HH:MM)';

const eventFields = {
  title: z.string().optional(),
  start: z.string().optional().describe(timeHelp),
  end: z.string().optional().describe(`${timeHelp}. For all-day events the end date is inclusive.`),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  rrule: z.string().nullable().optional().describe('iCalendar RRULE, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10". null removes recurrence.'),
  attendees: z.array(z.string().email()).optional().describe('Email addresses. The server may email invitations.'),
  alarm_minutes: z.number().int().min(0).nullable().optional().describe('Reminder N minutes before start; null removes reminders.'),
  busy: z.boolean().optional().describe('Whether the event blocks time (default: true for timed, false for all-day).'),
};

const scopeField = z
  .enum(['instance', 'series'])
  .optional()
  .describe('Required for recurring events: "instance" = only this occurrence, "series" = every occurrence.');

// ---------------------------------------------------------------- tools

export function registerCalendarTools(server: McpServer, getCtx: () => Ctx) {
  const wrap =
    <A>(fn: (args: A, ctx: Ctx) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return text(await fn(args, getCtx()));
      } catch (e) {
        return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
      }
    };

  server.registerTool(
    'list_calendars',
    {
      description: 'List every calendar across all configured accounts (Nextcloud, iCloud, Google, …), with ids usable in other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async (_args: {}, ctx) => {
      const { calendars, errors } = await ctx.store.calendars();
      return {
        calendars: calendars.map(({ id, name, account, color, writable }) => ({ id, name, account, color, writable })),
        ...(errors.length ? { errors } : {}),
      };
    }),
  );

  server.registerTool(
    'list_events',
    {
      description:
        'Events in a time range, merged across all calendars and sorted by start. Recurring events are expanded into occurrences. Defaults to today through the next 7 days.',
      inputSchema: {
        start: z.string().optional().describe(timeHelp),
        end: z.string().optional().describe(`${timeHelp}. A date-only end includes that whole day.`),
        calendars: z.array(z.string()).optional().describe('Calendar ids or names to limit to (default: all).'),
        accounts: z.array(z.string()).optional().describe('Account ids to limit to (default: all).'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { start?: string; end?: string; calendars?: string[]; accounts?: string[] }, ctx) => {
      const { startMs, endMs } = range(ctx, a.start, a.end, 0, 7);
      const { found, errors } = await collect(ctx, startMs, endMs, a.calendars, a.accounts);
      return listing(ctx, found, errors);
    }),
  );

  server.registerTool(
    'search_events',
    {
      description: 'Find events whose title, location or description contains the query (case-insensitive). Defaults to 90 days back through 365 days ahead.',
      inputSchema: {
        query: z.string().min(1),
        start: z.string().optional().describe(timeHelp),
        end: z.string().optional().describe(timeHelp),
        calendars: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { query: string; start?: string; end?: string; calendars?: string[] }, ctx) => {
      const { startMs, endMs } = range(ctx, a.start, a.end, 90, 365);
      const { found, errors } = await collect(ctx, startMs, endMs, a.calendars);
      const q = a.query.toLowerCase();
      const hits = found.filter(({ occ }) =>
        ['summary', 'location', 'description'].some((p) => String(occ.vevent.getFirstPropertyValue(p) ?? '').toLowerCase().includes(q)),
      );
      return listing(ctx, hits, errors);
    }),
  );

  server.registerTool(
    'get_event',
    {
      description: 'Full details of one event (description, attendees, organizer, recurrence rule).',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { id: string }, ctx) => {
      const found = await loadEvent(ctx, a.id);
      return eventOut(found, ctx.config.timezone, true);
    }),
  );

  server.registerTool(
    'find_free_time',
    {
      description:
        'Free time windows of at least `duration_minutes` across all (or selected) calendars. Events marked free/transparent and cancelled events do not block time.',
      inputSchema: {
        start: z.string().describe(timeHelp),
        end: z.string().describe(`${timeHelp}. A date-only end includes that whole day.`),
        duration_minutes: z.number().int().min(1),
        calendars: z.array(z.string()).optional(),
        accounts: z.array(z.string()).optional(),
        working_hours: z
          .object({
            start: z.string().regex(/^\d{2}:\d{2}$/).describe('HH:MM'),
            end: z.string().regex(/^\d{2}:\d{2}$/).describe('HH:MM'),
            days: z.array(z.number().int().min(1).max(7)).optional().describe('ISO weekdays, 1 = Monday (default 1-5).'),
          })
          .optional()
          .describe('Only return time inside these hours.'),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(
      async (
        a: { start: string; end: string; duration_minutes: number; calendars?: string[]; accounts?: string[]; working_hours?: { start: string; end: string; days?: number[] } },
        ctx,
      ) => {
        const tz = ctx.config.timezone;
        const { startMs, endMs } = range(ctx, a.start, a.end, 0, 0);
        const { found, errors } = await collect(ctx, startMs, endMs, a.calendars, a.accounts);
        const busy = found
          .filter(({ occ }) => describe(occ, tz, false).busy)
          .map(({ occ }) => [occ.startMs, occ.endMs] as const)
          .sort((x, y) => x[0] - y[0]);

        // Candidate windows: whole range, or working hours per day.
        let windows: [number, number][] = [[startMs, endMs]];
        if (a.working_hours) {
          const [sh, sm] = a.working_hours.start.split(':').map(Number);
          const [eh, em] = a.working_hours.end.split(':').map(Number);
          const days = new Set(a.working_hours.days ?? [1, 2, 3, 4, 5]);
          windows = [];
          for (let day = startOfDay(startMs, tz); day < endMs; day = startOfDay(day + 36 * 3600000, tz)) {
            const w = wallAt(day, tz);
            const iso = ((new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7) + 1;
            if (!days.has(iso)) continue;
            const ws = Math.max(startMs, wallToMs({ ...w, hour: sh, minute: sm, second: 0 }, tz));
            const we = Math.min(endMs, wallToMs({ ...w, hour: eh, minute: em, second: 0 }, tz));
            if (we > ws) windows.push([ws, we]);
          }
        }
        const free: { start: string; end: string; minutes: number }[] = [];
        const minMs = a.duration_minutes * 60000;
        for (const [ws, we] of windows) {
          let cursor = ws;
          for (const [bs, be] of busy) {
            if (be <= cursor || bs >= we) continue;
            if (bs - cursor >= minMs) free.push({ start: formatInZone(cursor, tz), end: formatInZone(bs, tz), minutes: Math.round((bs - cursor) / 60000) });
            cursor = Math.max(cursor, be);
            if (cursor >= we) break;
          }
          if (we - cursor >= minMs) free.push({ start: formatInZone(cursor, tz), end: formatInZone(we, tz), minutes: Math.round((we - cursor) / 60000) });
        }
        return { timezone: tz, free: free.slice(0, 200), ...(errors.length ? { errors } : {}) };
      },
    ),
  );

  server.registerTool(
    'create_event',
    {
      description:
        'Create an event. `start` as a date makes an all-day event. Without `end`, timed events last 1 hour and all-day events 1 day.',
      inputSchema: {
        calendar: z.string().describe('Calendar id (from list_calendars) or exact name.'),
        ...eventFields,
        title: z.string().min(1),
        start: z.string().describe(timeHelp),
      },
    },
    wrap(async (a: EventInput & { calendar: string; title: string; start: string }, ctx) => {
      const cal = await ctx.store.findCalendar(a.calendar);
      assertWritable(cal);
      if (a.attendees?.length && !ctx.config.guardrails.allow_invites) {
        throw guardrailError('allow_invites', 'Adding attendees makes the server email invitations.');
      }
      const { calendar: _c, ...input } = a;
      const { uid, ics } = buildEvent(input, ctx.config.timezone, organizerFor(ctx, cal.account));
      const url = await ctx.store.create(cal, uid, ics);
      const obj = { calendar: cal, url, data: ics };
      const [occ] = expand(ics, -8.64e15, 8.64e15, ctx.config.timezone);
      return { created: eventOut({ occ, obj }, ctx.config.timezone, false) };
    }),
  );

  server.registerTool(
    'update_event',
    {
      description:
        'Change an event. Only the fields you pass change; moving `start` alone keeps the duration. For recurring events pass `scope`.',
      inputSchema: { id: z.string(), scope: scopeField, ...eventFields },
    },
    wrap(async (a: EventInput & { id: string; scope?: 'series' | 'instance' }, ctx) => {
      const { occ, obj, ref } = await loadEvent(ctx, a.id);
      assertWritable(obj.calendar);
      const scope = resolveScope(ref, a.scope);
      if (!ctx.config.guardrails.allow_invites) {
        if (a.attendees !== undefined) throw guardrailError('allow_invites', 'Changing attendees makes the server email them.');
        const n = attendeeCount(obj.data);
        if (n > 0) throw guardrailError('allow_invites', `This event has ${n} attendee(s); changing it may email them.`);
      }
      const { id: _i, scope: _s, ...input } = a;
      const tz = ctx.config.timezone;
      const ics = updateEvent(obj.data, input, scope, scope === 'instance' ? ref.rid : undefined, tz);
      await ctx.store.update(obj, ics);
      // Report the updated occurrence (series edits may move it, so re-find by key or fall back to first).
      const updated = { ...obj, data: ics };
      let next: Occurrence = occ;
      try {
        next = ref.rid && scope === 'instance' ? expandOne(ics, ref.rid, tz) : expand(ics, occ.startMs - 400 * DAY_MS, occ.startMs + 400 * DAY_MS, tz)[0] ?? occ;
      } catch {}
      return { updated: eventOut({ occ: next, obj: updated }, tz, false) };
    }),
  );

  server.registerTool(
    'delete_event',
    {
      description: 'Delete an event. For recurring events pass `scope` ("instance" removes one occurrence, "series" removes all).',
      inputSchema: { id: z.string(), scope: scopeField },
      annotations: { destructiveHint: true },
    },
    wrap(async (a: { id: string; scope?: 'series' | 'instance' }, ctx) => {
      if (!ctx.config.guardrails.allow_delete) throw guardrailError('allow_delete', 'Deleting events is not allowed.');
      const { occ, obj, ref } = await loadEvent(ctx, a.id);
      assertWritable(obj.calendar);
      const scope = resolveScope(ref, a.scope);
      if (!ctx.config.guardrails.allow_invites && attendeeCount(obj.data) > 0) {
        throw guardrailError('allow_invites', 'This event has attendees; deleting it may email them a cancellation.');
      }
      const title = describe(occ, ctx.config.timezone, false).title;
      if (scope === 'instance') await ctx.store.update(obj, removeInstance(obj.data, ref.rid!, ctx.config.timezone));
      else await ctx.store.delete(obj);
      return { deleted: { title, scope } };
    }),
  );
}
