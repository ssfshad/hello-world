import { computeStreaks } from '@/lib/streak';

const st = (current: number, best: number, rest_days: number) => ({ current, best, rest_days });

// Mirrors the Rust tests in stats.rs. 2026-09-21 is a Monday.
describe('streaks with rest days', () => {
  const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];

  it('keeps the streak while today is not logged yet', () => {
    expect(computeStreaks(days, '2026-09-24')).toEqual(st(4, 4, 0));
    expect(computeStreaks([...days, '2026-09-24'], '2026-09-24')).toEqual(st(5, 5, 0));
  });

  it('forgives a missed yesterday as a rest day', () => {
    expect(computeStreaks(days, '2026-09-25')).toEqual(st(4, 4, 1));
  });

  it('breaks after two missed days but keeps the best', () => {
    expect(computeStreaks(days, '2026-09-26')).toEqual(st(0, 4, 0));
    expect(computeStreaks([], '2026-09-26')).toEqual(st(0, 0, 0));
  });

  it('allows one rest day per week', () => {
    expect(computeStreaks(['2026-09-21', '2026-09-23', '2026-09-25'], '2026-09-25')).toEqual(
      st(1, 2, 0),
    );
    expect(computeStreaks(['2026-09-26', '2026-09-27', '2026-09-29'], '2026-09-29')).toEqual(
      st(3, 3, 1),
    );
  });
});
