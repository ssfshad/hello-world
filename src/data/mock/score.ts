/** Usefulness score v1 (backend §6) — shared by the mock backend and tests. */
import type { UsefulnessBreakdown, UsefulnessComparison } from '@/core/types/api';

export interface ScoreInput {
  focusedMinutes: number;
  goalMinutes: number;
  concepts: number;
  solved: number; // already weighted (with-help × 0.7)
  attempted: number;
  reflected: boolean;
}

export const SCORE_VERSION = 1;

export function usefulness(i: ScoreInput): UsefulnessBreakdown {
  const time = Math.min(i.focusedMinutes / Math.max(1, i.goalMinutes), 1);
  const learning = Math.min(i.concepts / 2, 1);
  const practice = Math.min((i.solved + 0.5 * i.attempted) / 3, 1);
  const reflect = i.reflected ? 1 : 0;
  let score = Math.round(35 * time + 20 * learning + 35 * practice + 10 * reflect);
  const shadowing = i.focusedMinutes >= 90 && i.solved + i.attempted === 0;
  if (shadowing) score = Math.min(score, 60);
  return {
    score,
    score_version: SCORE_VERSION,
    time,
    learning,
    practice,
    reflect,
    focused_minutes: Math.round(i.focusedMinutes),
    goal_minutes: i.goalMinutes,
    concepts: i.concepts,
    solved: i.solved,
    attempted: i.attempted,
    reflected: i.reflected,
    shadowing_capped: shadowing && score === 60,
  };
}

export function compare(self: number, calc: UsefulnessBreakdown, summary: string): UsefulnessComparison {
  const gap = self - calc.score;
  const tone = gap <= -20 ? 'harder' : gap >= 20 ? 'higher' : 'agree';
  const parts: [string, number][] = [
    ['time', 35 * calc.time],
    ['concepts', 20 * calc.learning],
    ['problems', 35 * calc.practice],
    ['reflection', 10 * calc.reflect],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  return { gap, tone, summary, dominant_activity: parts[0][0] };
}
