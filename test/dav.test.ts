import { describe, expect, it } from 'vitest';
import { slug } from '../src/calendar/dav.js';

describe('slug', () => {
  it('keeps letters of any script', () => {
    expect(slug('Важное')).toBe('важное');
    expect(slug('Дни рождения')).toBe('дни-рождения');
    expect(slug('Yerevan → Spain')).toBe('yerevan-spain');
    expect(slug('Café & Crème')).toBe('café-crème');
    expect(slug('日本の祝日')).toBe('日本の祝日');
  });

  it('falls back when nothing is left', () => {
    expect(slug('→ ←')).toBe('calendar');
  });
});
