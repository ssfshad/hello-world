import {
  heatGrid,
  moodDelta,
  moodUsefulnessSummary,
  pivotSpeed,
  shadowDays,
  stackFeelings,
  timeSummary,
} from '@/components/charts/transforms';
import type { DailyPoint } from '@/core/types/api';

const pt = (day_key: string, over: Partial<DailyPoint> = {}): DailyPoint => ({
  day_key,
  minutes: 0,
  usefulness: null,
  mood_avg: null,
  mood_before: null,
  mood_after: null,
  concepts: 0,
  solved: 0,
  attempted: 0,
  comeback: false,
  diary_snippet: null,
  ...over,
});

describe('chart transforms', () => {
  it('summarises mood and usefulness from first/last known values', () => {
    const s = moodUsefulnessSummary([
      pt('2026-09-01'),
      pt('2026-09-02', { mood_avg: 2, usefulness: 40 }),
      pt('2026-09-03', { mood_avg: 4, usefulness: 80 }),
    ]);
    expect(s).toEqual({ moodFrom: 2, moodTo: 4, useFrom: 40, useTo: 80, days: 3 });
  });

  it('finds the busiest day', () => {
    const s = timeSummary([
      { day_key: 'a', minutes: 10 },
      { day_key: 'b', minutes: 50 },
    ]);
    expect(s.total).toBe(60);
    expect(s.best?.day_key).toBe('b');
  });

  it('lays heat cells into Monday-first week columns', () => {
    const cells = ['2026-09-23', '2026-09-24', '2026-09-28'].map((d) => ({ day_key: d, minutes: 30, bucket: 2 as const }));
    const g = heatGrid(cells);
    expect(g.length).toBe(2);
    expect(g[0][0]).toBeNull(); // Mon 21st is before the range
    expect(g[0][2]?.day_key).toBe('2026-09-23');
    expect(g[0][4]?.minutes).toBe(0); // the 25th is filled with zero
    expect(g[1][0]?.day_key).toBe('2026-09-28');
  });

  it('pivots speed rows per level', () => {
    const { levels, data } = pivotSpeed([
      { week_start: '2026-09-07', level: 1, avg_minutes: 12, count: 2 },
      { week_start: '2026-09-14', level: 2, avg_minutes: 20, count: 1 },
    ]);
    expect(levels).toEqual([1, 2]);
    expect(data[0]).toEqual({ week_start: '2026-09-07', L1: 12, L2: null });
  });

  it('stacks feelings with a stable key set', () => {
    const { keys, data } = stackFeelings([
      { concept_id: 'a', concept: 'loops', counts: { Stuck: 2 } },
      { concept_id: 'b', concept: 'lists', counts: { Proud: 1 } },
    ]);
    expect(keys).toEqual(['Stuck', 'Proud']);
    expect(data[1]).toEqual({ concept: 'lists', Stuck: 0, Proud: 1 });
  });

  it('computes mood delta and shadow days', () => {
    expect(
      moodDelta([
        { week_start: 'w', before: 2, after: 3 },
        { week_start: 'x', before: 3, after: 3.5 },
      ]),
    ).toBe(0.8);
    expect(moodDelta([])).toBeNull();
    expect(
      shadowDays([
        { day_key: 'a', minutes: 120, attempted: 0 },
        { day_key: 'b', minutes: 120, attempted: 1 },
      ]),
    ).toBe(1);
  });
});
