import type { TFunction } from 'i18next';
import type { Insight } from '@/core/types/api';

/** Message text lives in i18n keyed by rule_id; the backend supplies payload values. */
export function insightMessage(t: TFunction, insight: Insight): string {
  const p = insight.payload;
  if (insight.rule_id === 'first_milestones') {
    return t(`insights.first_milestones.${String(p.kind ?? 'concepts')}`, { value: p.value });
  }
  const moodLabel = typeof p.mood === 'number' ? t(`mood.${p.mood}`).toLowerCase() : '';
  return t(`insights.${insight.rule_id}`, { ...p, moodLabel });
}

export function insightTone(ruleId: string): 'feeling' | 'progress' {
  return ruleId === 'comeback' || ruleId === 'been_here_before' || ruleId === 'mood_lift' ? 'feeling' : 'progress';
}
