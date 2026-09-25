import { useTranslation } from 'react-i18next';
import { Check, Compass, X } from 'lucide-react';
import type { GettingStarted as Progress } from '@/core/types/api';
import { Button, IconButton, ProgressBar } from '@/components/ui';
import { useAppState, useGettingStarted } from '@/data/queries';
import { useUiStore } from '@/stores/uiStore';
import s from './domain.module.css';

export type GuideStep = 'session' | 'concept' | 'example' | 'problem' | 'diary' | 'practice';

const STEPS: { key: GuideStep; done: keyof Progress }[] = [
  { key: 'session', done: 'has_session' },
  { key: 'concept', done: 'has_concept' },
  { key: 'example', done: 'has_example' },
  { key: 'problem', done: 'has_problem' },
  { key: 'diary', done: 'has_diary' },
  { key: 'practice', done: 'has_practice' },
];

/** The guide is for newcomers: after two weeks it steps aside on its own. */
const GUIDE_DAYS = 14;

/**
 * First-weeks checklist: six small steps that cover the whole app. Each step's
 * button takes the learner to exactly where it happens. Finished steps tick
 * themselves off from real data; the card goes away once everything is done,
 * the learner hides it, or they're past their first two weeks.
 */
export function GettingStarted({ onAction }: { onAction: (step: GuideStep) => void }) {
  const { t } = useTranslation();
  const { data } = useGettingStarted();
  const { data: app } = useAppState();
  const hidden = useUiStore((st) => st.guideHidden);
  const hide = useUiStore((st) => st.setGuideHidden);
  if (!data || !app || hidden || app.journey_day > GUIDE_DAYS) return null;
  const done = STEPS.filter((st) => data[st.done]).length;
  if (done === STEPS.length) return null;
  const next = STEPS.find((st) => !data[st.done]);

  return (
    <section className={s.guide} aria-labelledby="guide-title">
      <header className={s.guideHead}>
        <Compass size={18} aria-hidden="true" />
        <h2 id="guide-title" className={s.guideTitle}>
          {t('guide.title')}
        </h2>
        <span className="muted">{t('guide.progress', { done, total: STEPS.length })}</span>
        <span className="spacer" />
        <IconButton aria-label={t('guide.hide')} title={t('guide.hide')} onClick={() => hide(true)}>
          <X size={16} />
        </IconButton>
      </header>
      <ProgressBar
        value={done}
        max={STEPS.length}
        label={t('guide.progress', { done, total: STEPS.length })}
      />
      <ol className={s.guideSteps}>
        {STEPS.map((st) => {
          const isDone = data[st.done];
          const isNext = st === next;
          return (
            <li
              key={st.key}
              className={[s.guideStep, isDone && s.guideDone, isNext && s.guideNext]
                .filter(Boolean)
                .join(' ')}
            >
              <span className={s.guideCheck} aria-hidden="true">
                {isDone && <Check size={14} />}
              </span>
              <div className={s.guideText}>
                <strong>
                  {t(`guide.steps.${st.key}.title`)}
                  {isDone && <span className="sr-only"> ✓</span>}
                </strong>
                {isNext && <span className="muted">{t(`guide.steps.${st.key}.body`)}</span>}
              </div>
              {!isDone && (
                <Button
                  size="sm"
                  variant={isNext ? 'primary' : 'ghost'}
                  onClick={() => onAction(st.key)}
                >
                  {t(`guide.steps.${st.key}.action`)}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
