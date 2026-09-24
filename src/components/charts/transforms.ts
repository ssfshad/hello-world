/** Pure chart data transforms (unit-tested). */
import type { DailyPoint, HeatCell, InsightCharts } from '@/core/types/api';
import { addDays, weekdayIndex } from '@/lib/day';

export const MIN_POINTS = 3;

/** Points with at least one real value; charts show an empty state below MIN_POINTS. */
export function countDataPoints<T>(rows: T[], has: (r: T) => boolean): number {
  return rows.filter(has).length;
}

export function firstLast<T>(rows: T[], pick: (r: T) => number | null): [number | null, number | null] {
  const vals = rows.map(pick).filter((v): v is number => v != null);
  return vals.length ? [vals[0], vals[vals.length - 1]] : [null, null];
}

export function moodUsefulnessSummary(points: DailyPoint[]) {
  const [moodFrom, moodTo] = firstLast(points, (p) => p.mood_avg);
  const [useFrom, useTo] = firstLast(points, (p) => p.usefulness);
  return { moodFrom, moodTo, useFrom, useTo, days: points.length };
}

export function timeSummary(points: { day_key: string; minutes: number }[]) {
  const total = points.reduce((a, p) => a + p.minutes, 0);
  const best = points.reduce<{ day_key: string; minutes: number } | null>(
    (b, p) => (p.minutes > (b?.minutes ?? 0) ? p : b),
    null,
  );
  return { total, best, days: points.length };
}

/**
 * Lay out heat cells into week columns (Mon..Sun rows), oldest week first.
 * Missing days are null.
 */
export function heatGrid(cells: HeatCell[]): (HeatCell | null)[][] {
  if (!cells.length) return [];
  const byDay = new Map(cells.map((c) => [c.day_key, c]));
  const first = cells[0].day_key;
  const last = cells[cells.length - 1].day_key;
  const start = addDays(first, -weekdayIndex(first));
  const weeks: (HeatCell | null)[][] = [];
  let cursor = start;
  while (cursor <= last) {
    const col: (HeatCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const key = addDays(cursor, d);
      col.push(key < first || key > last ? null : (byDay.get(key) ?? { day_key: key, minutes: 0, bucket: 0 }));
    }
    weeks.push(col);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** Pivot speed rows into [{week_start, L1, L2…}] for a multi-line chart. */
export function pivotSpeed(rows: InsightCharts['speed_by_difficulty']) {
  const levels = [...new Set(rows.map((r) => r.level))].sort();
  const weeks = [...new Set(rows.map((r) => r.week_start))].sort();
  const data = weeks.map((w) => {
    const row: Record<string, string | number | null> = { week_start: w };
    for (const l of levels) row[`L${l}`] = rows.find((r) => r.week_start === w && r.level === l)?.avg_minutes ?? null;
    return row;
  });
  return { levels, data };
}

/** Flatten feelings-per-concept into stacked-bar rows with a stable key set. */
export function stackFeelings(rows: InsightCharts['feelings_per_concept']) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.counts)))];
  const data = rows.map((r) => {
    const row: Record<string, string | number> = { concept: r.concept };
    for (const k of keys) row[k] = r.counts[k] ?? 0;
    return row;
  });
  return { keys, data };
}

export function moodDelta(rows: InsightCharts['mood_before_after_weekly']): number | null {
  const pairs = rows.filter((r) => r.before != null && r.after != null);
  if (!pairs.length) return null;
  return Math.round((pairs.reduce((a, r) => a + (r.after! - r.before!), 0) / pairs.length) * 10) / 10;
}

export function shadowDays(rows: InsightCharts['time_vs_attempts']): number {
  return rows.filter((r) => r.minutes >= 90 && r.attempted === 0).length;
}
