import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Crosshair, HeartHandshake, Play, RotateCcw, X } from 'lucide-react';
import type { Concept } from '@/core/types/api';
import { Button, Chip, IconButton } from '@/components/ui';
import { useWeekFocus, useWeekReview } from '@/data/queries';
import { useUiStore } from '@/stores/uiStore';
import { weekdayIndex } from '@/lib/day';
import s from './domain.module.css';

/**
 * Shown on an empty Today after 3+ days away: no broken-streak guilt, just
 * where they left off and one easy way back in.
 */
export function WelcomeBack({
  name,
  daysAway,
  today,
  recent,
  canReview,
  onReview,
  onStart,
}: {
  name: string;
  daysAway: number;
  today: string;
  recent: Concept[];
  canReview: boolean;
  onReview: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const dismiss = useUiStore((st) => st.setWelcomeDismissed);
  return (
    <section className={s.welcome} aria-labelledby="welcome-title">
      <HeartHandshake size={22} aria-hidden="true" className={s.welcomeIcon} />
      <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
        <h2 id="welcome-title" className={s.welcomeTitle}>
          {t('welcome.title', { name })}
        </h2>
        <p>{t('welcome.body', { count: daysAway })}</p>
        {recent.length > 0 && (
          <div className="row-wrap" aria-label={t('welcome.leftOff')}>
            <span className="muted" style={{ fontSize: '0.87rem' }}>
              {t('welcome.leftOff')}:
            </span>
            {recent.map((c) => (
              <Chip key={c.id}>{c.name}</Chip>
            ))}
          </div>
        )}
        <div className="row-wrap">
          <Button variant="primary" icon={<Play size={16} />} onClick={onStart}>
            {t('welcome.start')}
          </Button>
          {canReview ? (
            <Button icon={<RotateCcw size={16} />} onClick={onReview}>
              {t('welcome.review')}
            </Button>
          ) : (
            recent[0] && (
              <Button
                icon={<RotateCcw size={16} />}
                onClick={() => navigate(`/practice?concept=${recent[0].id}`)}
              >
                {t('welcome.review')}
              </Button>
            )
          )}
        </div>
      </div>
      <IconButton aria-label={t('common.close')} onClick={() => dismiss(today)}>
        <X size={16} />
      </IconButton>
    </section>
  );
}

/**
 * "Your week in review is ready": from Friday to Tuesday, for the week that's
 * due, until the learner saves the review or puts it off.
 */
export function WeekReviewCard({ today }: { today: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: week } = useWeekReview(null);
  const dismissed = useUiStore((st) => st.weekCardDismissed);
  const dismiss = useUiStore((st) => st.setWeekCardDismissed);
  const wd = weekdayIndex(today);
  const inWindow = wd >= 4 || wd <= 1;
  if (
    !week ||
    !inWindow ||
    week.saved_at ||
    week.days_logged === 0 ||
    dismissed === week.week_start
  )
    return null;
  return (
    <section className={s.weekCard} aria-labelledby="week-card-title">
      <CalendarCheck size={20} aria-hidden="true" color="var(--progress)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 id="week-card-title" className={s.weekCardTitle}>
          {t('week.cardTitle')}
        </h2>
        <span className="muted" style={{ fontSize: '0.87rem' }}>
          {t('week.cardBody', { days: week.days_logged, concepts: week.concepts.length })}
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={() => dismiss(week.week_start)}>
        {t('week.later')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => navigate(`/week?start=${week.week_start}`)}
      >
        {t('week.open')}
      </Button>
    </section>
  );
}

/** The focus the learner chose in their last weekly review. */
export function FocusPill() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: focus } = useWeekFocus();
  if (!focus) return null;
  return (
    <button
      type="button"
      className={s.focusPill}
      onClick={() => navigate(`/week?start=${focus.week_start}`)}
    >
      <Crosshair size={14} aria-hidden="true" />
      {t('week.focusPill', { focus: focus.focus })}
    </button>
  );
}
