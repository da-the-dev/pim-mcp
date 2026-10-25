import { describe as suite, expect, it } from 'vitest';
import { buildEvent, buildVTimezone, describe, expand, expandOne, removeInstance, updateEvent } from '../src/calendar/ical.js';

const TZ = 'Europe/Amsterdam';
const ms = (iso: string) => Date.parse(iso);
const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n${body.trim().replace(/\n/g, '\r\n')}\r\nEND:VCALENDAR\r\n`;

const weekly = cal(`
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/Amsterdam:20261019T100000
DTEND;TZID=Europe/Amsterdam:20261019T110000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=Europe/Amsterdam:20261026T100000
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20261102T090000Z
DTSTART;TZID=Europe/Amsterdam:20261102T140000
DTEND;TZID=Europe/Amsterdam:20261102T150000
SUMMARY:Standup (moved)
END:VEVENT
`);

suite('expand', () => {
  it('resolves TZID without VTIMEZONE via Intl, across DST', () => {
    const occ = expand(weekly, ms('2026-10-01T00:00:00Z'), ms('2026-12-01T00:00:00Z'), TZ);
    // Oct 19 is CEST (+2), Nov 9 is CET (+1): wall-clock 10:00 stays 10:00.
    expect(occ.map((o) => describe(o, TZ, false).start)).toEqual([
      '2026-10-19T10:00:00+02:00',
      '2026-11-02T14:00:00+01:00',
      '2026-11-09T10:00:00+01:00',
    ]);
  });

  it('applies EXDATE and matches UTC RECURRENCE-ID against a TZID master', () => {
    const occ = expand(weekly, ms('2026-10-01T00:00:00Z'), ms('2026-12-01T00:00:00Z'), TZ);
    expect(occ.map((o) => describe(o, TZ, false).title)).toEqual(['Standup', 'Standup (moved)', 'Standup']);
    expect(occ[1].rid).toBe('20261102T090000Z');
  });

  it('only returns occurrences overlapping the range', () => {
    const occ = expand(weekly, ms('2026-11-05T00:00:00Z'), ms('2026-11-12T00:00:00Z'), TZ);
    expect(occ).toHaveLength(1);
  });

  it('handles all-day events with inclusive end in output', () => {
    const ics = cal(`
BEGIN:VEVENT
UID:trip
DTSTART;VALUE=DATE:20261224
DTEND;VALUE=DATE:20261227
SUMMARY:Trip
END:VEVENT
`);
    const [o] = expand(ics, ms('2026-12-01T00:00:00Z'), ms('2027-01-01T00:00:00Z'), TZ);
    const d = describe(o, TZ, false);
    expect(d).toMatchObject({ start: '2026-12-24', end: '2026-12-26', allDay: true, busy: false });
  });

  it('skips cancelled instances and UTC events work', () => {
    const ics = cal(`
BEGIN:VEVENT
UID:x
DTSTART:20261020T080000Z
DURATION:PT30M
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:x
RECURRENCE-ID:20261021T080000Z
DTSTART:20261021T080000Z
DURATION:PT30M
STATUS:CANCELLED
SUMMARY:Daily
END:VEVENT
`);
    const occ = expand(ics, ms('2026-10-01T00:00:00Z'), ms('2026-11-01T00:00:00Z'), TZ);
    expect(occ.map((o) => describe(o, TZ, false).start)).toEqual(['2026-10-20T10:00:00+02:00', '2026-10-22T10:00:00+02:00']);
    expect(occ[0].endMs - occ[0].startMs).toBe(30 * 60000);
  });
});

suite('writing', () => {
  it('builds an event with TZID + generated VTIMEZONE that round-trips', () => {
    const { ics } = buildEvent({ title: 'Lunch', start: '2026-11-10T12:30', alarm_minutes: 10 }, TZ);
    expect(ics).toContain('DTSTART;TZID=Europe/Amsterdam:20261110T123000');
    expect(ics).toContain('DTEND;TZID=Europe/Amsterdam:20261110T133000');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(ics.indexOf('BEGIN:VEVENT'));
    expect(ics).toContain('TRIGGER:-PT10M');
    const [o] = expand(ics, ms('2026-11-01T00:00:00Z'), ms('2026-12-01T00:00:00Z'), TZ);
    expect(describe(o, TZ, false)).toMatchObject({ title: 'Lunch', start: '2026-11-10T12:30:00+01:00', end: '2026-11-10T13:30:00+01:00' });
  });

  it('generates DST rules for the VTIMEZONE', () => {
    const vtz = buildVTimezone(TZ, 2026).toString();
    expect(vtz).toContain('BEGIN:DAYLIGHT');
    expect(vtz).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(vtz).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    expect(vtz).toContain('TZOFFSETTO:+0200');
    expect(buildVTimezone('Asia/Tokyo', 2026).toString()).toContain('TZOFFSETTO:+0900');
  });

  it('all-day create takes an inclusive end', () => {
    const { ics } = buildEvent({ title: 'Holiday', start: '2026-12-24', end: '2026-12-26' }, TZ);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261224');
    expect(ics).toContain('DTEND;VALUE=DATE:20261227');
  });

  it('moving start keeps duration and bumps SEQUENCE', () => {
    const { ics } = buildEvent({ title: 'Call', start: '2026-11-10T09:00', end: '2026-11-10T09:45' }, TZ);
    const next = updateEvent(ics, { start: '2026-11-11T15:00' }, 'series', undefined, TZ);
    const [o] = expand(next, 0, 8.64e15, TZ);
    expect(describe(o, TZ, false)).toMatchObject({ start: '2026-11-11T15:00:00+01:00', end: '2026-11-11T15:45:00+01:00' });
    expect(next).toContain('SEQUENCE:1');
  });

  it('instance edit creates an override, leaving other occurrences alone', () => {
    const rid = expand(weekly, ms('2026-11-08T00:00:00Z'), ms('2026-11-10T00:00:00Z'), TZ)[0].rid!;
    const next = updateEvent(weekly, { title: 'Retro', start: '2026-11-09T16:00' }, 'instance', rid, TZ);
    const occ = expand(next, ms('2026-10-01T00:00:00Z'), ms('2026-12-01T00:00:00Z'), TZ);
    expect(occ.map((o) => [describe(o, TZ, false).title, describe(o, TZ, false).start])).toEqual([
      ['Standup', '2026-10-19T10:00:00+02:00'],
      ['Standup (moved)', '2026-11-02T14:00:00+01:00'],
      ['Retro', '2026-11-09T16:00:00+01:00'],
    ]);
    expect(expandOne(next, rid, TZ).startMs).toBe(ms('2026-11-09T15:00:00Z'));
  });

  it('removeInstance adds an EXDATE and drops the override', () => {
    const next = removeInstance(weekly, '20261102T090000Z', TZ);
    expect(next).not.toContain('Standup (moved)');
    const occ = expand(next, ms('2026-10-01T00:00:00Z'), ms('2026-12-01T00:00:00Z'), TZ);
    expect(occ.map((o) => describe(o, TZ, false).start)).toEqual(['2026-10-19T10:00:00+02:00', '2026-11-09T10:00:00+01:00']);
  });

  it('rejects mixing all-day and timed', () => {
    expect(() => buildEvent({ title: 'x', start: '2026-11-10', end: '2026-11-10T10:00' }, TZ)).toThrow(/both/);
  });
});
