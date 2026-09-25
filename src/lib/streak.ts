import { addDays, weekStart } from './day';

export interface Streaks {
  current: number;
  best: number;
  /** rest days inside the current streak */
  rest_days: number;
}

/**
 * Same rule as the Rust core (stats::streaks): consecutive logged days, where
 * one missed day per Monday–Sunday week counts as a rest day instead of
 * breaking the streak. Rest days don't add to the count. Today not being
 * logged yet never breaks it, nor does a missed yesterday while today can
 * still be logged.
 */
export function computeStreaks(activeDays: Iterable<string>, today: string): Streaks {
  const set = new Set(activeDays);
  if (set.size === 0) return { current: 0, best: 0, rest_days: 0 };
  let day = [...set].sort()[0];
  let run = 0;
  let best = 0;
  let rests = 0;
  const restWeeks = new Set<string>();
  while (day <= today) {
    const next = addDays(day, 1);
    if (set.has(day)) {
      run++;
    } else if (day !== today) {
      const nextOk = set.has(next) || next === today;
      const week = weekStart(day);
      if (run > 0 && nextOk && !restWeeks.has(week)) {
        restWeeks.add(week);
        rests++;
      } else {
        run = 0;
        rests = 0;
        restWeeks.clear();
      }
    }
    best = Math.max(best, run);
    day = next;
  }
  return { current: run, best, rest_days: rests };
}
