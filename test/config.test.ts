import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { parseKeychainRef, resolveSecret, secretKind } from '../src/secrets.js';
import { formatInZone, parseUserTime, wallToMs } from '../src/calendar/time.js';

describe('config', () => {
  it('applies defaults', () => {
    const cfg = parseConfig(`
timezone = "Europe/Amsterdam"
[[accounts]]
id = "icloud"
provider = "icloud"
username = "me@icloud.com"
password = "env:X"
`);
    expect(cfg.guardrails).toEqual({ allow_delete: false, allow_invites: false });
    expect(cfg.accounts[0]).toMatchObject({ read_only: false, hide_calendars: [] });
  });

  it('reports missing fields per provider', () => {
    expect(() =>
      parseConfig(`
[[accounts]]
id = "nc"
provider = "nextcloud"
username = "me"
password = "env:X"
[[accounts]]
id = "g"
provider = "google"
username = "me@gmail.com"
`),
    ).toThrow(/accounts\.0\.url[\s\S]*accounts\.1\.client_id/);
  });

  it('rejects bad timezones and duplicate ids', () => {
    const acc = `[[accounts]]\nid = "a"\nprovider = "icloud"\nusername = "u"\npassword = "p"\n`;
    expect(() => parseConfig(`timezone = "Mars/Base"\n${acc}`)).toThrow(/timezone/);
    expect(() => parseConfig(acc + acc)).toThrow(/duplicate/);
  });
});

describe('secrets', () => {
  it('resolves env and cmd refs', async () => {
    process.env.CALMCP_TEST = 's3cret';
    expect(await resolveSecret('env:CALMCP_TEST')).toBe('s3cret');
    expect(await resolveSecret('cmd:printf hello')).toBe('hello');
    await expect(resolveSecret('env:CALMCP_MISSING')).rejects.toThrow(/not set/);
  });

  it('parses keychain refs', () => {
    expect(secretKind('keychain:calendar-mcp/icloud')).toBe('keychain');
    expect(parseKeychainRef('keychain:a/b/c')).toEqual({ service: 'a/b', account: 'c' });
    expect(() => parseKeychainRef('keychain:nope')).toThrow();
  });
});

describe('time', () => {
  it('parses user input in the configured zone', () => {
    const t = parseUserTime('2026-07-01T09:00', 'Europe/Amsterdam');
    expect(t).toEqual({ allDay: false, ms: Date.parse('2026-07-01T07:00:00Z') });
    expect(parseUserTime('2026-07-01T09:00+05:30', 'Europe/Amsterdam')).toEqual({ allDay: false, ms: Date.parse('2026-07-01T03:30:00Z') });
    expect(parseUserTime('2026-07-01', 'Europe/Amsterdam').allDay).toBe(true);
  });

  it('handles DST gaps by moving forward', () => {
    const ms = wallToMs({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, 'Europe/Amsterdam');
    expect(formatInZone(ms, 'Europe/Amsterdam')).toBe('2026-03-29T03:30:00+02:00');
  });
});
