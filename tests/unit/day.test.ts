import {
  addDays,
  dayKeyForOffset,
  dayRange,
  daysBetween,
  monthGrid,
  parseBoundary,
  weekStart,
  weekdayIndex,
} from '@/lib/day';

describe('day boundary helper', () => {
  it('counts late-night time toward the previous day', () => {
    // 01:30 local (UTC) on the 25th with a 04:00 boundary → the 24th.
    expect(dayKeyForOffset('2026-09-25T01:30:00Z', 0, '04:00')).toBe('2026-09-24');
    expect(dayKeyForOffset('2026-09-25T04:00:00Z', 0, '04:00')).toBe('2026-09-25');
    expect(dayKeyForOffset('2026-09-25T03:59:00Z', 0, '04:00')).toBe('2026-09-24');
  });

  it('uses the local offset', () => {
    // UTC+6: 20:00Z = 02:00 local next day → still the 24th.
    expect(dayKeyForOffset('2026-09-24T20:00:00Z', 360, '04:00')).toBe('2026-09-24');
    expect(dayKeyForOffset('2026-09-24T22:30:00Z', 360, '04:00')).toBe('2026-09-25');
  });

  it('treats a midnight boundary as the calendar day', () => {
    expect(dayKeyForOffset('2026-09-24T23:59:00Z', 0, '00:00')).toBe('2026-09-24');
  });

  it('validates boundaries', () => {
    expect(parseBoundary('04:00')).toBe(240);
    expect(() => parseBoundary('25:00')).toThrow();
    expect(() => parseBoundary('4pm')).toThrow();
  });

  it('does day arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-09-01', '2026-09-24')).toBe(23);
    expect(dayRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(weekdayIndex('2026-09-21')).toBe(0); // Monday
    expect(weekStart('2026-09-24')).toBe('2026-09-21');
  });

  it('builds month grids starting on Monday', () => {
    const g = monthGrid(2026, 8); // September 2026 starts on a Tuesday
    expect(g[0]).toBeNull();
    expect(g[1]).toBe('2026-09-01');
    expect(g.length % 7).toBe(0);
  });
});
