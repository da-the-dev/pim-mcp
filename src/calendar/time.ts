// Timezone helpers built on Intl, so any IANA zone works without VTIMEZONE data.

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time in `tz` at instant `ms`. */
export function wallAt(ms: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** Offset of `tz` from UTC at instant `ms`, in minutes. */
export function offsetAt(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Instant (ms) for wall-clock time `w` in `tz`. Nonexistent DST-gap times resolve forward. */
export function wallToMs(w: Wall, tz: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let ms = guess - offsetAt(guess, tz) * 60000;
  const second = guess - offsetAt(ms, tz) * 60000;
  if (second !== ms) ms = Math.max(ms, second);
  return ms;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatDate(w: Pick<Wall, 'year' | 'month' | 'day'>): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-25T14:00:00+01:00 */
export function formatInZone(ms: number, tz: string): string {
  const w = wallAt(ms, tz);
  const off = offsetAt(ms, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${formatDate(w)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export type UserTime = { allDay: true; date: Wall } | { allDay: false; ms: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse agent input: `YYYY-MM-DD` (all-day) or ISO datetime; no offset means `tz`. */
export function parseUserTime(input: string, tz: string): UserTime {
  const s = input.trim();
  let m = DATE_RE.exec(s);
  if (m) return { allDay: true, date: { year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 } };
  m = DATETIME_RE.exec(s);
  if (!m) throw new Error(`can't parse time "${input}" (use YYYY-MM-DD or YYYY-MM-DDTHH:MM, optionally with Z or ±HH:MM)`);
  const w: Wall = { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 };
  const zone = m[7];
  if (!zone) return { allDay: false, ms: wallToMs(w, tz) };
  const utc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  if (zone === 'Z') return { allDay: false, ms: utc };
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  return { allDay: false, ms: utc - off * 60000 };
}

/** Parse a time that must be an instant (date-only means midnight in tz). */
export function parseInstant(input: string, tz: string): number {
  const t = parseUserTime(input, tz);
  return t.allDay ? wallToMs(t.date, tz) : t.ms;
}

export function addDays(w: Wall, days: number): Wall {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function startOfDay(ms: number, tz: string): number {
  const w = wallAt(ms, tz);
  return wallToMs({ ...w, hour: 0, minute: 0, second: 0 }, tz);
}
