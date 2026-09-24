import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpen, CheckCircle2, Clock, Flame, Play } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Button, Card, EmptyState, Select, StatCard, Tabs, toast } from '@/components/ui';
import { Heatmap, MoodUsefulnessChart, TimeBarChart } from '@/components/charts';
import { InsightCard } from '@/components/domain/InsightCard';
import {
  useAppState,
  useHeatmap,
  useInsightActions,
  useInsights,
  useReviewDue,
  useReviewRecord,
  useStatsDaily,
  useStatsOverview,
  useTimerActions,
} from '@/data/queries';
import { useTimerStore } from '@/stores/timerStore';
import { addDays, lastNDays } from '@/lib/day';
import { formatDuration, signed } from '@/lib/format';
import type { ReviewResult } from '@/core/types/api';
import s from '../pages.module.css';

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: app } = useAppState();
  const today = app?.today ?? '';
  const [lang, setLang] = useState<string>('');
  const [range, setRange] = useState<'14' | '30' | '90'>('14');
  const [heatRange, setHeatRange] = useState<'12w' | '1y'>('12w');
  const langId = lang || null;

  const { data: overview } = useStatsOverview(langId);
  const { data: daily = [] } = useStatsDaily(lastNDays(today, Number(range)), langId, !!today);
  const { data: week = [] } = useStatsDaily(lastNDays(today, 7), langId, !!today);
  const { data: heat = [] } = useHeatmap(heatRange === '12w' ? { from: addDays(today, -83), to: today } : { from: addDays(today, -364), to: today });
  const { data: insights = [] } = useInsights();
  const { data: review = [] } = useReviewDue(5);
  const record = useReviewRecord();
  const insightActions = useInsightActions();
  const timer = useTimerActions();
  const session = useTimerStore((st) => st.session);

  if (!app) return null;
  const top = [...insights].sort((a, b) => b.priority - a.priority)[0];
  const weekDelta = overview ? overview.week_seconds - overview.prev_week_seconds : 0;

  return (
    <>
      <PageHeader
        context={t('dashboard.greeting', { name: app.profile?.display_name ?? '', day: app.journey_day })}
        title={t('dashboard.title')}
        actions={
          <>
            <div style={{ minWidth: 180 }}>
              <Select
                label={t('common.language')}
                hideLabel
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                options={[{ value: '', label: t('common.allLanguages') }, ...app.languages.map((l) => ({ value: l.id, label: l.name }))]}
              />
            </div>
            <Button
              variant="primary"
              icon={<Play size={16} />}
              onClick={() => {
                if (!session) timer.start.mutate(langId ?? app.languages.find((l) => l.is_primary)?.id ?? null);
                navigate('/today');
              }}
            >
              {t('dashboard.startSession')}
            </Button>
          </>
        }
      />

      <div className={s.stats4}>
        <StatCard
          icon={<Clock size={16} aria-hidden="true" />}
          label={t('dashboard.totalTime')}
          value={overview ? formatDuration(overview.total_seconds) : '–'}
          sub={overview && t('dashboard.thisWeek', { delta: signed(weekDelta, (v) => formatDuration(v)) })}
        />
        <StatCard
          icon={<BookOpen size={16} aria-hidden="true" />}
          label={t('dashboard.conceptsLearned')}
          value={overview?.concepts_total ?? '–'}
          sub={overview && t('dashboard.dueForReview', { count: overview.concepts_due })}
        />
        <StatCard
          icon={<CheckCircle2 size={16} aria-hidden="true" />}
          label={t('dashboard.problemsSolved')}
          value={overview?.problems_solved ?? '–'}
          sub={
            overview && (
              <>
                {t('dashboard.solvedSplit', { alone: overview.problems_solved_alone, help: overview.problems_solved_with_help })}
                <br />
                {overview.avg_solve_seconds != null
                  ? t('dashboard.avgTime', { time: formatDuration(overview.avg_solve_seconds) })
                  : t('dashboard.noAvg')}
              </>
            )
          }
        />
        <StatCard
          icon={<Flame size={16} aria-hidden="true" />}
          label={t('dashboard.streak')}
          value={overview ? t('common.days', { count: overview.current_streak }) : '–'}
          sub={overview && t('dashboard.bestStreak', { count: overview.best_streak })}
        />
      </div>

      <div className={s.dash2}>
        <MoodUsefulnessChart
          points={daily}
          actions={
            <Tabs
              label={t('common.range')}
              value={range}
              onChange={setRange}
              options={[
                { value: '14', label: t('common.lastNDays', { n: 14 }) },
                { value: '30', label: t('common.lastNDays', { n: 30 }) },
                { value: '90', label: t('common.lastNDays', { n: 90 }) },
              ]}
            />
          }
        />
        <div className="stack" style={{ gap: 20 }}>
          {top ? (
            <InsightCard
              insight={top}
              onDismiss={() => insightActions.dismiss.mutate({ id: top.id })}
              footer={
                <Button variant="ghost" size="sm" onClick={() => navigate('/insights')}>
                  {t('dashboard.seeAllInsights')}
                </Button>
              }
            />
          ) : (
            <Card title={t('dashboard.insight')}>
              <EmptyState>{t('dashboard.noInsight')}</EmptyState>
            </Card>
          )}
        </div>
      </div>

      <div className={s.dash3}>
        <Heatmap
          cells={heat}
          actions={
            <Tabs
              label={t('common.range')}
              value={heatRange}
              onChange={setHeatRange}
              options={[
                { value: '12w', label: t('common.weeks', { n: 12 }) },
                { value: '1y', label: t('common.year') },
              ]}
            />
          }
        />
        <TimeBarChart points={week} />
        <Card title={t('dashboard.review')}>
          {review.length === 0 ? (
            <EmptyState>{t('dashboard.reviewEmpty')}</EmptyState>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {review.map((r) => (
                <li key={r.concept_id} className={s.reviewRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{r.concept_name}</strong>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>
                      {t('common.days', { count: r.days_since_learned })}
                    </div>
                  </div>
                  <Button size="sm" variant="primary" onClick={() => navigate(`/practice?concept=${r.concept_id}`)}>
                    {t('dashboard.practiceThis')}
                  </Button>
                  <ReviewButtons
                    onRecord={(result) =>
                      record.mutate(
                        { concept_id: r.concept_id, result },
                        { onSuccess: () => toast.info(`${r.concept_name}: ${t(`dashboard.review${result === 'skipped' ? 'Skip' : result[0].toUpperCase() + result.slice(1)}`)}`) },
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function ReviewButtons({ onRecord }: { onRecord: (r: ReviewResult) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-expanded={false}>
        {t('common.more')}
      </Button>
    );
  return (
    <div className="row" role="group" aria-label={t('dashboard.review')}>
      {(['easy', 'ok', 'hard', 'skipped'] as const).map((r) => (
        <Button key={r} size="sm" variant="ghost" onClick={() => onRecord(r)}>
          {t(`dashboard.review${r === 'skipped' ? 'Skip' : r[0].toUpperCase() + r.slice(1)}`)}
        </Button>
      ))}
    </div>
  );
}
