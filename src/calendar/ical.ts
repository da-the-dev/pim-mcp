import ICAL from 'ical.js';
import { randomUUID } from 'node:crypto';
import {
  addDays,
  formatDate,
  formatInZone,
  isValidTimeZone,
  offsetAt,
  parseUserTime,
  wallAt,
  wallToMs,
  type UserTime,
  type Wall,
} from './time.js';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
type Property = InstanceType<typeof ICAL.Property>;

const MAX_ITERATIONS = 20000;
const DAY_MS = 86400000;

/** One concrete occurrence of an event, with times already resolved. */
export interface Occurrence {
  vevent: Component; // the master or the exception that defines this occurrence
  allDay: boolean;
  startMs: number; // for all-day: midnight in the default zone
  endMs: number;
  startDate?: Wall; // all-day only
  endDate?: Wall; // all-day only, exclusive
  recurring: boolean;
  rid?: string; // recurrence key, present for occurrences of recurring events
  rrule?: string;
}

// ---------------------------------------------------------------- parsing

export function parseCalendar(ics: string): Component {
  const vcal = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of vcal.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) {
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    }
  }
  return vcal;
}

/** Map vendor TZIDs like "/freeassociation.sourceforge.net/Europe/Amsterdam" to IANA names. */
function ianaZone(tzid: string | undefined): string | undefined {
  if (!tzid) return undefined;
  const clean = tzid.replace(/^"|"$/g, '');
  if (isValidTimeZone(clean)) return clean;
  const parts = clean.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (isValidTimeZone(candidate)) return candidate;
  }
  return undefined;
}

function wallOf(t: Time): Wall {
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
}

function isUtc(t: Time): boolean {
  return t.zone === ICAL.Timezone.utcTimezone;
}

/** Resolve an ICAL.Time to an instant. `tzid` is the property's TZID parameter. */
export function timeToMs(t: Time, tzid: string | undefined, defaultTz: string): number {
  if (t.isDate) return wallToMs({ ...wallOf(t), hour: 0, minute: 0, second: 0 }, defaultTz);
  if (isUtc(t)) return t.toUnixTime() * 1000;
  const iana = ianaZone(tzid);
  if (iana) return wallToMs(wallOf(t), iana);
  if (tzid && ICAL.TimezoneService.has(tzid)) {
    const c = t.clone();
    c.zone = ICAL.TimezoneService.get(tzid)!;
    return c.toUnixTime() * 1000;
  }
  return wallToMs(wallOf(t), defaultTz); // floating
}

function propTime(vevent: Component, name: string): { time: Time; tzid?: string } | undefined {
  const prop = vevent.getFirstProperty(name);
  if (!prop) return undefined;
  const time = prop.getFirstValue() as Time;
  const tzid = prop.getParameter('tzid');
  return { time, tzid: typeof tzid === 'string' ? tzid : undefined };
}

/** Stable key for a recurrence instance: UTC instant for timed events, date for all-day. */
function ridKey(t: Time, tzid: string | undefined, defaultTz: string): string {
  if (t.isDate) return formatDate(t).replace(/-/g, '');
  const iso = new Date(timeToMs(t, tzid, defaultTz)).toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
}

interface Span {
  allDay: boolean;
  startMs: number;
  endMs: number;
  startDate?: Wall;
  endDate?: Wall;
}

/** Start/end of a single VEVENT as written (DTEND or DURATION, with RFC defaults). */
function spanOf(vevent: Component, defaultTz: string): Span {
  const start = propTime(vevent, 'dtstart');
  if (!start) throw new Error('VEVENT without DTSTART');
  const end = propTime(vevent, 'dtend');
  const duration = vevent.getFirstPropertyValue('duration') as InstanceType<typeof ICAL.Duration> | null;
  if (start.time.isDate) {
    const startDate = wallOf(start.time);
    let endDate: Wall;
    if (end) endDate = wallOf(end.time);
    else if (duration) endDate = addDays(startDate, Math.max(1, Math.round(duration.toSeconds() / 86400)));
    else endDate = addDays(startDate, 1);
    return {
      allDay: true,
      startDate,
      endDate,
      startMs: wallToMs(startDate, defaultTz),
      endMs: wallToMs(endDate, defaultTz),
    };
  }
  const startMs = timeToMs(start.time, start.tzid, defaultTz);
  let endMs = startMs;
  if (end) endMs = timeToMs(end.time, end.tzid, defaultTz);
  else if (duration) endMs = startMs + duration.toSeconds() * 1000;
  return { allDay: false, startMs, endMs };
}

function isCancelled(vevent: Component): boolean {
  return String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function splitEvents(vcal: Component): { master?: Component; exceptions: Component[] } {
  const events = vcal.getAllSubcomponents('vevent');
  return {
    master: events.find((e) => !e.hasProperty('recurrence-id')),
    exceptions: events.filter((e) => e.hasProperty('recurrence-id')),
  };
}

/** All occurrences of the event(s) in one calendar object that overlap [rangeStart, rangeEnd). */
export function expand(ics: string, rangeStart: number, rangeEnd: number, defaultTz: string): Occurrence[] {
  const vcal = parseCalendar(ics);
  const { master, exceptions } = splitEvents(vcal);
  const overlaps = (s: Span) => s.endMs > rangeStart && s.startMs < rangeEnd || (s.startMs === s.endMs && s.startMs >= rangeStart && s.startMs < rangeEnd);
  const out: Occurrence[] = [];

  if (!master || !master.hasProperty('rrule') && !master.hasProperty('rdate')) {
    // Plain event, or orphaned instances we were invited to individually.
    for (const ve of master ? [master] : exceptions) {
      if (isCancelled(ve)) continue;
      const span = spanOf(ve, defaultTz);
      if (overlaps(span)) out.push({ vevent: ve, ...span, recurring: false });
    }
    return out;
  }

  const masterStart = propTime(master, 'dtstart')!;
  const masterSpan = spanOf(master, defaultTz);
  const rrule = master.getFirstProperty('rrule')?.toICALString().replace(/^RRULE:/, '');

  const byRid = new Map<string, Component>();
  for (const ex of exceptions) {
    const rid = propTime(ex, 'recurrence-id')!;
    byRid.set(ridKey(rid.time, rid.tzid, defaultTz), ex);
  }
  const exdates = new Set<string>();
  for (const prop of master.getAllProperties('exdate')) {
    const tzid = prop.getParameter('tzid');
    for (const v of prop.getValues() as Time[]) exdates.add(ridKey(v, typeof tzid === 'string' ? tzid : undefined, defaultTz));
  }

  const used = new Set<string>();
  const emit = (key: string, span: Span, vevent: Component) => {
    if (overlaps(span)) out.push({ vevent, ...span, recurring: true, rid: key, rrule });
  };

  const it = new ICAL.Event(master).iterator();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const t = it.next();
    if (!t) break;
    const key = ridKey(t, masterStart.tzid, defaultTz);
    const startMs = timeToMs(t, masterStart.tzid, defaultTz);
    if (startMs >= rangeEnd) break;
    if (exdates.has(key)) continue;
    const ex = byRid.get(key);
    if (ex) {
      used.add(key);
      if (!isCancelled(ex)) emit(key, spanOf(ex, defaultTz), ex);
      continue;
    }
    if (t.isDate) {
      const days = Math.round((masterSpan.endMs - masterSpan.startMs) / DAY_MS);
      const startDate = wallOf(t);
      const endDate = addDays(startDate, Math.max(1, days));
      emit(key, { allDay: true, startDate, endDate, startMs: wallToMs(startDate, defaultTz), endMs: wallToMs(endDate, defaultTz) }, master);
    } else {
      emit(key, { allDay: false, startMs, endMs: startMs + (masterSpan.endMs - masterSpan.startMs) }, master);
    }
  }
  // Instances moved into the range from an original slot we didn't iterate to.
  for (const [key, ex] of byRid) {
    if (!used.has(key) && !exdates.has(key) && !isCancelled(ex)) emit(key, spanOf(ex, defaultTz), ex);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------- describing

export interface Attendee {
  email: string;
  name?: string;
  status?: string;
  role?: string;
}

export interface EventFields {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  status?: string;
  busy: boolean;
  recurring: boolean;
  rrule?: string;
  url?: string;
  organizer?: string;
  attendees?: Attendee[];
}

function mailto(v: unknown): string {
  return String(v ?? '').replace(/^mailto:/i, '');
}

function attendeesOf(vevent: Component): Attendee[] {
  return vevent.getAllProperties('attendee').map((p) => {
    const a: Attendee = { email: mailto(p.getFirstValue()) };
    const cn = p.getParameter('cn');
    const partstat = p.getParameter('partstat');
    const role = p.getParameter('role');
    if (cn) a.name = String(cn);
    if (partstat) a.status = String(partstat).toLowerCase();
    if (role && role !== 'REQ-PARTICIPANT') a.role = String(role).toLowerCase();
    return a;
  });
}

export function describe(occ: Occurrence, tz: string, detailed: boolean): EventFields {
  const ve = occ.vevent;
  const str = (name: string) => {
    const v = ve.getFirstPropertyValue(name);
    return v == null || v === '' ? undefined : String(v);
  };
  const status = str('status')?.toLowerCase();
  const transp = str('transp')?.toUpperCase();
  const fields: EventFields = {
    uid: str('uid') ?? '',
    title: str('summary') ?? '(no title)',
    // All-day end is reported inclusive (last day of the event).
    start: occ.allDay ? formatDate(occ.startDate!) : formatInZone(occ.startMs, tz),
    end: occ.allDay ? formatDate(addDays(occ.endDate!, -1)) : formatInZone(occ.endMs, tz),
    allDay: occ.allDay,
    location: str('location'),
    status: status && status !== 'confirmed' ? status : undefined,
    // RFC default is opaque, but clients treat all-day events without TRANSP as free.
    busy: transp ? transp === 'OPAQUE' : !occ.allDay,
    recurring: occ.recurring,
  };
  if (detailed) {
    fields.description = str('description');
    fields.rrule = occ.rrule;
    fields.url = str('url');
    const organizer = ve.getFirstPropertyValue('organizer');
    if (organizer) fields.organizer = mailto(organizer);
    const attendees = attendeesOf(ve);
    if (attendees.length) fields.attendees = attendees;
  } else {
    const d = str('description');
    if (d) fields.description = d.length > 200 ? d.slice(0, 200) + '…' : d;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as EventFields;
}

export function attendeeCount(ics: string): number {
  const vcal = parseCalendar(ics);
  return Math.max(0, ...vcal.getAllSubcomponents('vevent').map((e) => e.getAllProperties('attendee').length));
}

// ---------------------------------------------------------------- writing

export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  location?: string | null;
  description?: string | null;
  rrule?: string | null;
  attendees?: string[];
  alarm_minutes?: number | null;
  busy?: boolean;
}

/** Minimal VTIMEZONE for an IANA zone, derived from Intl's transitions in `year`. */
export function buildVTimezone(tz: string, year: number): Component {
  const vtz = new ICAL.Component('vtimezone');
  vtz.addPropertyWithValue('tzid', tz);
  const fmtOffset = (min: number) => {
    const sign = min < 0 ? '-' : '+';
    const a = Math.abs(min);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
  };
  // Find transitions: daily scan, then binary search to the minute.
  const transitions: { at: number; from: number; to: number }[] = [];
  let prevMs = Date.UTC(year, 0, 1);
  let prevOff = offsetAt(prevMs, tz);
  for (let d = 1; d <= 366; d++) {
    const ms = Date.UTC(year, 0, 1) + d * DAY_MS;
    const off = offsetAt(ms, tz);
    if (off !== prevOff) {
      let lo = prevMs;
      let hi = ms;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 120000) * 60000;
        if (offsetAt(mid, tz) === prevOff) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, from: prevOff, to: off });
    }
    prevMs = ms;
    prevOff = off;
  }
  if (transitions.length !== 2) {
    const std = new ICAL.Component('standard');
    const off = fmtOffset(offsetAt(Date.UTC(year, 6, 1), tz));
    std.addPropertyWithValue('dtstart', ICAL.Time.fromDateTimeString('1970-01-01T00:00:00'));
    std.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromString(off));
    std.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromString(off));
    vtz.addSubcomponent(std);
    return vtz;
  }
  for (const tr of transitions) {
    const sub = new ICAL.Component(tr.to > tr.from ? 'daylight' : 'standard');
    const local = wallAt(tr.at + (tr.from - tr.to) * 60000, tz); // wall time in the "from" offset
    const daysInMonth = new Date(Date.UTC(local.year, local.month, 0)).getUTCDate();
    const weekday = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()];
    const nth = local.day + 7 > daysInMonth ? -1 : Math.ceil(local.day / 7);
    sub.addPropertyWithValue('dtstart', ICAL.Time.fromData({ ...local, isDate: false }));
    sub.addPropertyWithValue('rrule', ICAL.Recur.fromString(`FREQ=YEARLY;BYMONTH=${local.month};BYDAY=${nth}${weekday}`));
    sub.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromString(fmtOffset(tr.from)));
    sub.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromString(fmtOffset(tr.to)));
    vtz.addSubcomponent(sub);
  }
  return vtz;
}

function ensureVTimezone(vcal: Component, tz: string, year: number) {
  const has = vcal.getAllSubcomponents('vtimezone').some((c) => c.getFirstPropertyValue('tzid') === tz);
  if (!has) {
    const vtz = buildVTimezone(tz, year);
    // VTIMEZONE must precede components that reference it.
    const first = vcal.getFirstSubcomponent('vevent');
    vcal.addSubcomponent(vtz);
    if (first) {
      vcal.removeSubcomponent(first);
      vcal.addSubcomponent(first);
      for (const other of vcal.getAllSubcomponents('vevent').filter((e) => e !== first)) {
        vcal.removeSubcomponent(other);
        vcal.addSubcomponent(other);
      }
    }
  }
}

function setTimeProp(vevent: Component, name: string, value: { allDay: true; date: Wall } | { allDay: false; ms: number }, tz: string) {
  vevent.removeAllProperties(name);
  let prop: Property;
  if (value.allDay) {
    prop = new ICAL.Property(name);
    prop.setValue(ICAL.Time.fromData({ year: value.date.year, month: value.date.month, day: value.date.day, isDate: true }));
  } else {
    const w = wallAt(value.ms, tz);
    prop = new ICAL.Property(name);
    prop.setValue(ICAL.Time.fromData({ ...w, isDate: false }));
    prop.setParameter('tzid', tz);
  }
  vevent.addProperty(prop);
}

function nowUtc(): Time {
  return ICAL.Time.fromJSDate(new Date(), true);
}

/** Apply start/end changes to a VEVENT, keeping its duration when only start moves. */
function applyTimes(vcal: Component, vevent: Component, input: EventInput, tz: string, defaultTz: string) {
  if (input.start === undefined && input.end === undefined) return;
  const current = vevent.hasProperty('dtstart') ? spanOf(vevent, defaultTz) : undefined;
  const start: UserTime | undefined = input.start !== undefined ? parseUserTime(input.start, tz) : undefined;
  const endIn: UserTime | undefined = input.end !== undefined ? parseUserTime(input.end, tz) : undefined;
  const allDay = start ? start.allDay : endIn ? endIn.allDay : current!.allDay;
  if (start && endIn && start.allDay !== endIn.allDay) throw new Error('start and end must both be dates (all-day) or both be date-times');
  if (current && !start && endIn && endIn.allDay !== current.allDay) throw new Error('end must match the event type (date for all-day events, date-time otherwise); pass start too to change the type');

  if (allDay) {
    const startDate = start && start.allDay ? start.date : current!.startDate!;
    let endExcl: Wall;
    if (endIn && endIn.allDay) endExcl = addDays(endIn.date, 1); // input end is inclusive
    else if (current?.allDay && start) {
      const days = Math.round((current.endMs - current.startMs) / DAY_MS);
      endExcl = addDays(startDate, Math.max(1, days));
    } else if (current?.allDay) endExcl = current.endDate!;
    else endExcl = addDays(startDate, 1);
    if (wallToMs(endExcl, 'UTC') <= wallToMs(startDate, 'UTC')) throw new Error('end is before start');
    setTimeProp(vevent, 'dtstart', { allDay: true, date: startDate }, tz);
    setTimeProp(vevent, 'dtend', { allDay: true, date: endExcl }, tz);
  } else {
    const startMs = start && !start.allDay ? start.ms : current!.startMs;
    let endMs: number;
    if (endIn && !endIn.allDay) endMs = endIn.ms;
    else if (current && !current.allDay) endMs = startMs + (current.endMs - current.startMs);
    else endMs = startMs + 3600000;
    if (endMs < startMs) throw new Error('end is before start');
    ensureVTimezone(vcal, tz, wallAt(startMs, tz).year);
    setTimeProp(vevent, 'dtstart', { allDay: false, ms: startMs }, tz);
    setTimeProp(vevent, 'dtend', { allDay: false, ms: endMs }, tz);
  }
  vevent.removeAllProperties('duration');
}

function setText(vevent: Component, name: string, value: string | null | undefined) {
  if (value === undefined) return;
  vevent.removeAllProperties(name);
  if (value !== null && value !== '') vevent.addPropertyWithValue(name, value);
}

function applyFields(vcal: Component, vevent: Component, input: EventInput, tz: string, defaultTz: string, isMaster: boolean) {
  if (input.title !== undefined) setText(vevent, 'summary', input.title);
  setText(vevent, 'location', input.location);
  setText(vevent, 'description', input.description);
  applyTimes(vcal, vevent, input, tz, defaultTz);
  if (input.rrule !== undefined) {
    if (!isMaster) throw new Error('rrule can only be changed on the whole series');
    vevent.removeAllProperties('rrule');
    if (input.rrule) vevent.addPropertyWithValue('rrule', ICAL.Recur.fromString(input.rrule.replace(/^RRULE:/i, '')));
  }
  if (input.busy !== undefined) {
    vevent.removeAllProperties('transp');
    vevent.addPropertyWithValue('transp', input.busy ? 'OPAQUE' : 'TRANSPARENT');
  }
  if (input.attendees !== undefined) {
    vevent.removeAllProperties('attendee');
    for (const email of input.attendees) {
      const p = new ICAL.Property('attendee');
      p.setValue(`mailto:${email}`);
      p.setParameter('role', 'REQ-PARTICIPANT');
      p.setParameter('partstat', 'NEEDS-ACTION');
      p.setParameter('rsvp', 'TRUE');
      vevent.addProperty(p);
    }
  }
  if (input.alarm_minutes !== undefined) {
    for (const a of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(a);
    if (input.alarm_minutes !== null) {
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', 'Reminder');
      alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-input.alarm_minutes * 60));
      vevent.addSubcomponent(alarm);
    }
  }
}

function touch(vevent: Component) {
  const now = nowUtc();
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  const seq = Number(vevent.getFirstPropertyValue('sequence') ?? 0);
  vevent.updatePropertyWithValue('sequence', seq + 1);
}

export function buildEvent(input: EventInput & { title: string; start: string }, tz: string, organizer?: string): { uid: string; ics: string } {
  const vcal = new ICAL.Component('vcalendar');
  vcal.addPropertyWithValue('version', '2.0');
  vcal.addPropertyWithValue('prodid', '-//calendar-mcp//EN');
  vcal.addPropertyWithValue('calscale', 'GREGORIAN');
  const vevent = new ICAL.Component('vevent');
  const uid = randomUUID();
  vevent.addPropertyWithValue('uid', uid);
  vevent.addPropertyWithValue('dtstamp', nowUtc());
  vevent.addPropertyWithValue('created', nowUtc());
  vcal.addSubcomponent(vevent);
  applyFields(vcal, vevent, input, tz, tz, true);
  if (input.attendees?.length && organizer) {
    const p = new ICAL.Property('organizer');
    p.setValue(`mailto:${organizer}`);
    vevent.addProperty(p);
  }
  return { uid, ics: vcal.toString() };
}

function findMaster(vcal: Component): Component {
  const { master } = splitEvents(vcal);
  if (!master) throw new Error('this event has no master component; edit it with scope "instance"');
  return master;
}

/** Write a RECURRENCE-ID/EXDATE value in the same form as the master's DTSTART. */
function ridProperty(name: string, master: Component, rid: string, defaultTz: string): Property {
  const start = propTime(master, 'dtstart')!;
  const prop = new ICAL.Property(name);
  if (start.time.isDate || /^\d{8}$/.test(rid)) {
    prop.setValue(ICAL.Time.fromData({ year: +rid.slice(0, 4), month: +rid.slice(4, 6), day: +rid.slice(6, 8), isDate: true }));
    return prop;
  }
  const ms = Date.UTC(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8), +rid.slice(9, 11), +rid.slice(11, 13), +rid.slice(13, 15));
  const iana = ianaZone(start.tzid);
  if (isUtc(start.time) || !start.tzid) {
    prop.setValue(isUtc(start.time) ? ICAL.Time.fromJSDate(new Date(ms), true) : ICAL.Time.fromData({ ...wallAt(ms, defaultTz), isDate: false }));
  } else if (iana) {
    prop.setValue(ICAL.Time.fromData({ ...wallAt(ms, iana), isDate: false }));
    prop.setParameter('tzid', start.tzid);
  } else {
    prop.setValue(ICAL.Time.fromJSDate(new Date(ms), true));
  }
  return prop;
}

function findException(vcal: Component, rid: string, defaultTz: string): Component | undefined {
  return splitEvents(vcal).exceptions.find((ex) => {
    const r = propTime(ex, 'recurrence-id')!;
    return ridKey(r.time, r.tzid, defaultTz) === rid;
  });
}

/**
 * Patch an event. scope "series" edits the master; "instance" edits (or creates)
 * the override for one occurrence identified by `rid`.
 */
export function updateEvent(ics: string, input: EventInput, scope: 'series' | 'instance', rid: string | undefined, tz: string): string {
  const vcal = parseCalendar(ics);
  let target: Component;
  if (scope === 'instance' && rid) {
    const existing = findException(vcal, rid, tz);
    if (existing) target = existing;
    else {
      const master = findMaster(vcal);
      const occ = expandOne(vcal.toString(), rid, tz);
      target = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
      for (const p of ['rrule', 'rdate', 'exdate']) target.removeAllProperties(p);
      target.addProperty(ridProperty('recurrence-id', master, rid, tz));
      // Pin the original occurrence times before applying the patch.
      if (occ.allDay) {
        setTimeProp(target, 'dtstart', { allDay: true, date: occ.startDate! }, tz);
        setTimeProp(target, 'dtend', { allDay: true, date: occ.endDate! }, tz);
      } else {
        ensureVTimezone(vcal, tz, wallAt(occ.startMs, tz).year);
        setTimeProp(target, 'dtstart', { allDay: false, ms: occ.startMs }, tz);
        setTimeProp(target, 'dtend', { allDay: false, ms: occ.endMs }, tz);
      }
      target.removeAllProperties('duration');
      vcal.addSubcomponent(target);
    }
    applyFields(vcal, target, input, tz, tz, false);
  } else {
    target = findMaster(vcal);
    applyFields(vcal, target, input, tz, tz, true);
  }
  touch(target);
  return vcal.toString();
}

/** Remove one occurrence: EXDATE on the master, drop any override. */
export function removeInstance(ics: string, rid: string, tz: string): string {
  const vcal = parseCalendar(ics);
  const master = findMaster(vcal);
  const ex = findException(vcal, rid, tz);
  if (ex) vcal.removeSubcomponent(ex);
  master.addProperty(ridProperty('exdate', master, rid, tz));
  touch(master);
  return vcal.toString();
}

/** The occurrence for `rid`, searched in a window around the recurrence instant. */
export function expandOne(ics: string, rid: string, tz: string): Occurrence {
  const isDate = /^\d{8}$/.test(rid);
  const ms = isDate
    ? Date.UTC(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8))
    : Date.UTC(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8), +rid.slice(9, 11), +rid.slice(11, 13), +rid.slice(13, 15));
  // Overrides may move an instance anywhere, so search wide and match on the key.
  const occs = expand(ics, ms - 400 * DAY_MS, ms + 400 * DAY_MS, tz);
  const occ = occs.find((o) => o.rid === rid);
  if (!occ) throw new Error('that occurrence no longer exists');
  return occ;
}
