import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsefulnessBreakdown, UsefulnessComparison } from '@/core/types/api';
import { Card, ProgressBar, Slider } from '@/components/ui';
import { formatDuration } from '@/lib/format';
import s from './domain.module.css';

export function comparisonText(t: (k: string, o?: Record<string, unknown>) => string, c: UsefulnessComparison): string {
  return t(`usefulness.compare.${c.tone}`, {
    summary: c.summary.charAt(0).toUpperCase() + c.summary.slice(1),
    dominant: t(`usefulness.dominant.${c.dominant_activity}`),
  });
}

/** Local mirror of the §6.3 comparison so the sentence updates while dragging. */
export function localComparison(self: number, calc: UsefulnessBreakdown, summary: string): UsefulnessComparison {
  const gap = self - calc.score;
  const parts: [string, number][] = [
    ['time', 35 * calc.time],
    ['concepts', 20 * calc.learning],
    ['problems', 35 * calc.practice],
    ['reflection', 10 * calc.reflect],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  return { gap, tone: gap <= -20 ? 'harder' : gap >= 20 ? 'higher' : 'agree', summary, dominant_activity: parts[0][0] };
}

export function UsefulnessCard({
  calc,
  selfValue,
  comparison,
  onCommit,
}: {
  calc: UsefulnessBreakdown;
  selfValue: number | null;
  comparison: UsefulnessComparison | null;
  onCommit: (v: number) => void;
}) {
  const { t } = useTranslation();
  const [v, setV] = useState<number>(selfValue ?? 50);
  const [touched, setTouched] = useState(selfValue != null);
  useEffect(() => {
    if (selfValue != null) {
      setV(selfValue);
      setTouched(true);
    }
  }, [selfValue]);
  const summary =
    comparison?.summary ??
    t('usefulness.summary', {
      time: formatDuration(calc.focused_minutes * 60),
      concepts: calc.concepts,
      problems: Math.ceil(calc.solved) + calc.attempted,
    });
  const cmp = touched ? localComparison(v, calc, summary) : null;

  return (
    <Card title={t('today.usefulTitle')}>
      <div className="stack" style={{ gap: 14 }}>
        <div className={s.useRow}>
          <span>{t('today.selfRating')}</span>
          <Slider
            label={t('today.selfRating')}
            hideLabel
            value={v}
            onChange={(x) => {
              setV(x);
              setTouched(true);
            }}
            onCommit={onCommit}
            valueText={`${v} / 100`}
          />
          <span className={s.useValue}>{touched ? v : '–'}</span>
        </div>
        <div className={s.useRow}>
          <span>{t('today.calcScore')}</span>
          <ProgressBar value={calc.score} label={t('today.calcScore')} />
          <span className={s.useValue}>{calc.score}</span>
        </div>
        <p className="muted" style={{ fontSize: '0.83rem' }}>
          {t('usefulness.breakdown', {
            time: Math.round(calc.time * 100),
            learning: Math.round(calc.learning * 100),
            practice: Math.round(calc.practice * 100),
            reflect: Math.round(calc.reflect * 100),
          })}
        </p>
        {calc.shadowing_capped && <p className="muted">{t('usefulness.shadowingCapped')}</p>}
        {cmp && (
          <p className={s.compare} aria-live="polite">
            {comparisonText(t, cmp)}
          </p>
        )}
      </div>
    </Card>
  );
}
