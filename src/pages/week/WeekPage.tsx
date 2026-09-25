import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Bug,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CalendarDays,
  Sunrise,
} from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import {
  Button,
  Card,
  Chip,
  IconButton,
  StatCard,
  TextArea,
  TextField,
  toast,
} from '@/components/ui';
import { useAppState, useWeekReview, useWeekReviewSave } from '@/data/queries';
import { addDays, weekStart } from '@/lib/day';
import { formatDay, formatDuration, formatShortDay } from '@/lib/format';
import { useUiStore } from '@/stores/uiStore';
import type { WeekReview } from '@/core/types/api';
import s from './week.module.css';

export default function WeekPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { data: app } = useAppState();
  const start = params.get('start');
  const { data: week } = useWeekReview(start);
  if (!app || !week) return null;
  const thisWeek = weekStart(app.today);
  const go = (n: number) =>
    setParams({ start: addDays(week.week_start, n * 7) }, { replace: true });

  return (
    <>
      <PageHeader
        context={t('week.range', {
          from: formatShortDay(week.week_start),
          to: formatShortDay(week.week_end),
        })}
        title={t('week.title')}
        actions={
          <div className="row">
            <IconButton aria-label={t('week.prev')} title={t('week.prev')} onClick={() => go(-1)}>
              <ChevronLeft size={18} />
            </IconButton>
            <IconButton
              aria-label={t('week.next')}
              title={t('week.next')}
              onClick={() => go(1)}
              disabled={week.week_start >= thisWeek}
            >
              <ChevronRight size={18} />
            </IconButton>
          </div>
        }
      />
      {week.days_logged === 0 ? (
        <Card>
          <p className="muted">{t('week.empty')}</p>
        </Card>
      ) : (
        <WeekBody key={week.week_start} week={week} />
      )}
    </>
  );
}

function WeekBody({ week }: { week: WeekReview }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const save = useWeekReviewSave();
  const dismissCard = useUiStore((st) => st.setWeekCardDismissed);
  const [clicked, setClicked] = useState(week.clicked ?? '');
  const [fuzzy, setFuzzy] = useState(week.fuzzy ?? '');
  const [focus, setFocus] = useState(week.focus ?? '');

  const day = (d: string) => formatDay(d, { weekday: 'long' });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className={s.stats}>
        <StatCard
          icon={<Clock size={16} aria-hidden="true" />}
          label={t('week.time')}
          value={formatDuration(week.focused_seconds)}
        />
        <StatCard
          icon={<CalendarDays size={16} aria-hidden="true" />}
          label={t('week.days')}
          value={`${week.days_logged} / 7`}
        />
        <StatCard
          icon={<CheckCircle2 size={16} aria-hidden="true" />}
          label={t('week.solved')}
          value={week.solved_alone + week.solved_with_help}
          sub={t('week.solvedSplit', { alone: week.solved_alone, help: week.solved_with_help })}
        />
        <StatCard
          icon={<Bug size={16} aria-hidden="true" />}
          label={t('week.errors')}
          value={week.errors_logged}
        />
      </div>

      <div className={s.two}>
        <Card title={t('week.learned')}>
          {week.concepts.length === 0 ? (
            <p className="muted">{t('week.noConcepts')}</p>
          ) : (
            <div className="row-wrap">
              {week.concepts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={s.conceptLink}
                  onClick={() => navigate(`/knowledge?concept=${c.id}`)}
                >
                  <Chip>{c.name}</Chip>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card title={t('week.story')} tone="warm">
          <div className={s.story}>
            <Sunrise size={20} aria-hidden="true" color="var(--feeling)" />
            {week.hardest_day ? (
              <p>
                {t('week.hardest', {
                  day: day(week.hardest_day.day_key),
                  mood: week.hardest_day.mood,
                })}{' '}
                {week.after_hardest
                  ? t('week.after', {
                      day: day(week.after_hardest.day_key),
                      concepts: week.after_hardest.concepts,
                      solved: week.after_hardest.solved,
                    })
                  : t('week.afterNone')}
              </p>
            ) : (
              <p>{t('week.noHard')}</p>
            )}
          </div>
        </Card>
      </div>

      <Card title={t('week.questions')}>
        <form
          className="stack"
          style={{ gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { week_start: week.week_start, clicked, fuzzy, focus },
              {
                onSuccess: () => {
                  dismissCard(week.week_start);
                  toast.info(t('week.saved'));
                },
              },
            );
          }}
        >
          <TextArea
            label={t('week.clicked')}
            placeholder={t('week.clickedPh')}
            value={clicked}
            rows={2}
            maxLength={2000}
            onChange={(e) => setClicked(e.target.value)}
          />
          <TextArea
            label={t('week.fuzzy')}
            placeholder={t('week.fuzzyPh')}
            value={fuzzy}
            rows={2}
            maxLength={2000}
            onChange={(e) => setFuzzy(e.target.value)}
          />
          <TextField
            label={t('week.focus')}
            hint={t('week.focusHint')}
            placeholder={t('week.focusPh')}
            value={focus}
            maxLength={200}
            onChange={(e) => setFocus(e.target.value)}
          />
          <div className="row">
            {week.saved_at && (
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                {t('week.savedAt', { date: formatShortDay(week.saved_at.slice(0, 10)) })}
              </span>
            )}
            <span className="spacer" />
            <Button type="submit" variant="primary" loading={save.isPending}>
              {t('week.save')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
