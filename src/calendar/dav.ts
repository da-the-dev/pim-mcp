import { DAVClient, type DAVCalendar } from 'tsdav';
import type { AccountConfig, Config } from '../config.js';
import { GOOGLE_TOKEN_URL, serverUrl } from '../providers.js';
import { resolveSecret } from '../secrets.js';

export interface CalendarInfo {
  id: string; // "<account>/<slug of name>"
  account: string;
  name: string;
  color?: string;
  writable: boolean;
  url: string;
  dav: DAVCalendar;
}

export interface CalendarObject {
  calendar: CalendarInfo;
  url: string;
  etag?: string;
  data: string;
}

export interface AccountError {
  account: string;
  error: string;
}

/** URL-ish id from a calendar name, keeping letters of any script ("Важное" → "важное"). */
export function slug(s: string): string {
  return (
    s
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'calendar'
  );
}

function displayName(cal: DAVCalendar): string {
  if (typeof cal.displayName === 'string' && cal.displayName.trim()) return cal.displayName.trim();
  const parts = new URL(cal.url).pathname.split('/').filter(Boolean);
  const last = decodeURIComponent(parts.at(-1) ?? 'calendar');
  return last === 'events' && parts.length > 1 ? decodeURIComponent(parts.at(-2)!) : last;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function checkResponse(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  const hints: Record<number, string> = {
    401: 'credentials were rejected',
    403: 'the server does not allow this (read-only or shared calendar?)',
    404: 'not found (deleted elsewhere?)',
    412: 'the event changed elsewhere since it was read; fetch it again and retry',
  };
  const body = (await res.text().catch(() => '')).slice(0, 300);
  throw new Error(`${action} failed: HTTP ${res.status}${hints[res.status] ? ` — ${hints[res.status]}` : ''}${body ? `\n${body}` : ''}`);
}

export class CalendarStore {
  private clients = new Map<string, Promise<DAVClient>>();
  private calendarCache = new Map<string, Promise<CalendarInfo[]>>();

  constructor(readonly config: Config) {}

  account(id: string): AccountConfig {
    const acc = this.config.accounts.find((a) => a.id === id);
    if (!acc) throw new Error(`unknown account "${id}" (configured: ${this.config.accounts.map((a) => a.id).join(', ')})`);
    return acc;
  }

  client(account: AccountConfig): Promise<DAVClient> {
    let p = this.clients.get(account.id);
    if (!p) {
      p = connect(account);
      this.clients.set(account.id, p);
      p.catch(() => this.clients.delete(account.id)); // allow retry after fixing config/network
    }
    return p;
  }

  private accountCalendars(account: AccountConfig): Promise<CalendarInfo[]> {
    let p = this.calendarCache.get(account.id);
    if (!p) {
      p = this.discover(account);
      this.calendarCache.set(account.id, p);
      p.catch(() => this.calendarCache.delete(account.id));
    }
    return p;
  }

  private async discover(account: AccountConfig): Promise<CalendarInfo[]> {
    const client = await this.client(account);
    const hidden = new Set(account.hide_calendars.map((n) => n.toLowerCase()));
    const readOnly = new Set(account.read_only_calendars.map((n) => n.toLowerCase()));
    const cals = (await client.fetchCalendars()).filter((c) => !c.components || c.components.includes('VEVENT'));
    const seen = new Map<string, number>();
    const out: CalendarInfo[] = [];
    for (const cal of cals) {
      const name = displayName(cal);
      if (hidden.has(name.toLowerCase())) continue;
      let s = slug(name);
      const n = (seen.get(s) ?? 0) + 1;
      seen.set(s, n);
      if (n > 1) s = `${s}-${n}`;
      out.push({
        id: `${account.id}/${s}`,
        account: account.id,
        name,
        color: cal.calendarColor?.slice(0, 7),
        writable: !account.read_only && !readOnly.has(name.toLowerCase()),
        url: cal.url,
        dav: cal,
      });
    }
    return out;
  }

  /** Calendars of the given accounts (all by default). Failing accounts are reported, not thrown. */
  async calendars(accountIds?: string[]): Promise<{ calendars: CalendarInfo[]; errors: AccountError[] }> {
    const accounts = accountIds?.length ? accountIds.map((id) => this.account(id)) : this.config.accounts;
    const results = await Promise.allSettled(accounts.map((a) => this.accountCalendars(a)));
    const calendars: CalendarInfo[] = [];
    const errors: AccountError[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') calendars.push(...r.value);
      else errors.push({ account: accounts[i].id, error: errorMessage(r.reason) });
    });
    return { calendars, errors };
  }

  /** Resolve a calendar by id ("icloud/work") or by name ("Work"), case-insensitive. */
  async findCalendar(ref: string): Promise<CalendarInfo> {
    const { calendars, errors } = await this.calendars();
    const r = ref.trim().toLowerCase();
    const byId = calendars.find((c) => c.id.toLowerCase() === r);
    if (byId) return byId;
    const byName = calendars.filter((c) => c.name.toLowerCase() === r);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`calendar name "${ref}" is ambiguous; use one of: ${byName.map((c) => c.id).join(', ')}`);
    const failed = errors.length ? ` (unreachable accounts: ${errors.map((e) => e.account).join(', ')})` : '';
    throw new Error(`no calendar "${ref}"; available: ${calendars.map((c) => c.id).join(', ')}${failed}`);
  }

  async filterCalendars(refs?: string[], accountIds?: string[]): Promise<{ calendars: CalendarInfo[]; errors: AccountError[] }> {
    if (refs?.length) {
      const calendars = await Promise.all(refs.map((r) => this.findCalendar(r)));
      return { calendars, errors: [] };
    }
    return this.calendars(accountIds);
  }

  async fetchRange(cal: CalendarInfo, startMs: number, endMs: number): Promise<CalendarObject[]> {
    const client = await this.client(this.account(cal.account));
    const objects = await client.fetchCalendarObjects({
      calendar: cal.dav,
      timeRange: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    });
    return objects
      .filter((o) => typeof o.data === 'string' && o.data.includes('BEGIN:VEVENT'))
      .map((o) => ({ calendar: cal, url: o.url, etag: o.etag, data: o.data }));
  }

  async fetchObject(accountId: string, path: string): Promise<CalendarObject> {
    const { calendars } = await this.calendars([accountId]);
    const calendar = calendars
      .filter((c) => path.startsWith(new URL(c.url).pathname))
      .sort((a, b) => b.url.length - a.url.length)[0];
    if (!calendar) throw new Error('the calendar for this event is no longer available');
    const url = new URL(path, calendar.url).toString();
    const client = await this.client(this.account(accountId));
    const [obj] = await client.fetchCalendarObjects({ calendar: calendar.dav, objectUrls: [url] });
    if (!obj || typeof obj.data !== 'string' || !obj.data.includes('BEGIN:VCALENDAR')) {
      throw new Error('event not found (it may have been deleted)');
    }
    return { calendar, url: obj.url ?? url, etag: obj.etag, data: obj.data };
  }

  async create(cal: CalendarInfo, uid: string, ics: string): Promise<string> {
    const client = await this.client(this.account(cal.account));
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({ calendar: cal.dav, filename, iCalString: ics });
    await checkResponse(res, 'create');
    return new URL(filename, cal.url.endsWith('/') ? cal.url : cal.url + '/').toString();
  }

  async update(obj: CalendarObject, ics: string): Promise<void> {
    const client = await this.client(this.account(obj.calendar.account));
    const res = await client.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: ics } });
    await checkResponse(res, 'update');
  }

  async delete(obj: CalendarObject): Promise<void> {
    const client = await this.client(this.account(obj.calendar.account));
    const res = await client.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
    await checkResponse(res, 'delete');
  }
}

export async function connect(account: AccountConfig): Promise<DAVClient> {
  const url = serverUrl(account);
  let client: DAVClient;
  if (account.provider === 'google') {
    if (!account.refresh_token) {
      throw new Error(`account "${account.id}" has no refresh_token yet; run: pim-mcp auth google --account ${account.id}`);
    }
    client = new DAVClient({
      serverUrl: url,
      authMethod: 'Oauth',
      defaultAccountType: 'caldav',
      credentials: {
        username: account.username,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientId: await resolveSecret(account.client_id!),
        clientSecret: await resolveSecret(account.client_secret!),
        refreshToken: await resolveSecret(account.refresh_token),
      },
    });
  } else {
    client = new DAVClient({
      serverUrl: url,
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      credentials: { username: account.username, password: await resolveSecret(account.password!) },
    });
  }
  try {
    await client.login();
  } catch (e) {
    throw new Error(`could not connect to ${account.id} (${url}): ${errorMessage(e)}`);
  }
  return client;
}
