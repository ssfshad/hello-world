import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Lightbulb, Plus, X } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Button, Card, EmptyState, IconButton, MoodScale, toast } from '@/components/ui';
import { StaleSessionModal, TimerCard } from '@/components/domain/TimerCard';
import { ConceptInput, ConceptList } from '@/components/domain/ConceptInput';
import { ProblemRow } from '@/components/domain/ProblemRow';
import { ProblemModal } from '@/components/domain/ProblemModal';
import { DiaryCard } from '@/components/domain/DiaryCard';
import { UsefulnessCard } from '@/components/domain/UsefulnessCard';
import { InsightCard } from '@/components/domain/InsightCard';
import { useProblemDetail } from '@/components/domain/useProblemDetail';
import { ConceptEditModal } from '@/components/domain/ConceptEditModal';
import { GettingStarted, type GuideStep } from '@/components/domain/GettingStarted';
import { RecallReview } from '@/components/domain/RecallReview';
import { FocusPill, WeekReviewCard, WelcomeBack } from '@/components/domain/TodayCards';
import {
  useAppState,
  useCategories,
  useConceptMutations,
  useConcepts,
  useDay,
  useDayClose,
  useFeelingTags,
  useGettingStarted,
  useInsights,
  useMoodCheckin,
  useProblemMutations,
  useResources,
  useReviewDue,
  useSelfUsefulness,
  useStatsOverview,
  useTimerActions,
} from '@/data/queries';
import { useUiStore } from '@/stores/uiStore';
import { formatDay, formatDuration } from '@/lib/format';
import { daysBetween } from '@/lib/day';
import { spotlight } from '@/lib/spotlight';
import type { Concept, Insight, Problem, ReviewItem } from '@/core/types/api';
import type { NewConcept } from '@/components/domain/ConceptInput';
import s from '../pages.module.css';

export default function TodayPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: app } = useAppState();
  const dayKey = app?.today ?? '';
  const { data: day } = useDay(dayKey);
  const { data: allConcepts = [] } = useConcepts(null, null);
  const { data: categories = [] } = useCategories();
  const { data: feelings = [] } = useFeelingTags();
  const { data: resources = [] } = useResources({});
  const { data: review = [] } = useReviewDue(1);
  const { data: insights = [] } = useInsights();
  const conceptM = useConceptMutations();
  const problemM = useProblemMutations();
  const timer = useTimerActions();
  const mood = useMoodCheckin();
  const selfU = useSelfUsefulness();
  const close = useDayClose();
  const detail = useProblemDetail();
  const coachSeen = useUiStore((st) => st.coachMarkSeen);
  const setCoachSeen = useUiStore((st) => st.setCoachMarkSeen);
  const guideHidden = useUiStore((st) => st.guideHidden);
  const welcomeDismissed = useUiStore((st) => st.welcomeDismissed);
  const { data: guide } = useGettingStarted();
  const { data: overview } = useStatsOverview(null);
  const [params, setParams] = useSearchParams();

  const [problemModal, setProblemModal] = useState<{ open: boolean; edit: Problem | null }>({ open: false, edit: null });
  const [lowMood, setLowMood] = useState<Insight | null>(null);
  const [editConcept, setEditConcept] = useState<{ concept: Concept; example?: boolean } | null>(null);
  const [recall, setRecall] = useState<ReviewItem[] | null>(null);

  const languages = app?.languages ?? [];
  const primary = languages.find((l) => l.is_primary) ?? languages[0];

  const search = useMemo(() => {
    return (prefix: string) => {
      const p = prefix.toLowerCase();
      return allConcepts
        .filter((c) => (!primary || c.language_id === primary.id) && c.name.toLowerCase().includes(p))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(p)) - Number(!b.name.toLowerCase().startsWith(p)))
        .slice(0, 6);
    };
  }, [allConcepts, primary]);

  /** Guide steps and "Show me" buttons land exactly where the action happens. */
  const goTo = useCallback(
    (step: GuideStep) => {
      switch (step) {
        case 'session':
          spotlight('timer-card', 'button:not([disabled])');
          break;
        case 'concept':
          spotlight('concept-input', 'input');
          break;
        case 'example': {
          const latest = day?.concepts[0] ?? allConcepts[0];
          if (latest) setEditConcept({ concept: latest, example: true });
          else spotlight('concept-input', 'input');
          break;
        }
        case 'problem':
          setProblemModal({ open: true, edit: null });
          break;
        case 'diary':
          spotlight('diary-card', 'textarea');
          break;
        case 'practice':
          navigate('/practice');
          break;
      }
    },
    [day, allConcepts, navigate],
  );

  // Other pages (the Dashboard's guide) link here with ?do=<step>.
  const pending = params.get('do') as GuideStep | null;
  useEffect(() => {
    if (!pending || !day) return;
    setParams({}, { replace: true });
    // Let the page paint before scrolling to the target.
    requestAnimationFrame(() => goTo(pending));
  }, [pending, day, goTo, setParams]);

  if (!app || !day) return null;

  const empty = day.sessions.length === 0 && day.concepts.length === 0 && day.problems.length === 0 && !day.diary && day.moods.length === 0;
  const daysAway = overview?.last_active_day ? daysBetween(overview.last_active_day, dayKey) : 0;
  const showWelcome = empty && daysAway >= 3 && welcomeDismissed !== dayKey;
  const guideOpen = !!guide && !guideHidden && app.journey_day <= 14 && !Object.values(guide).every(Boolean);
  const latestAdhoc = [...day.moods].reverse()[0]?.value ?? null;
  const before = day.moods.find((m) => m.kind === 'session_start')?.value;
  const after = [...day.moods].reverse().find((m) => m.kind === 'session_end')?.value;
  const todaysLowMoodInsight =
    lowMood ??
    (latestAdhoc != null && latestAdhoc <= 2
      ? (insights.find((i) => i.rule_id === 'been_here_before' && i.created_at.slice(0, 10) >= dayKey.slice(0, 10)) ?? null)
      : null);

  const onMood = (value: number, found?: Insight[]) => {
    if (value <= 2) {
      const hit = found?.find((i) => i.rule_id === 'been_here_before') ?? insights.find((i) => i.rule_id === 'been_here_before');
      if (hit) setLowMood(hit);
    }
  };

  const addConcept = async (c: NewConcept) => {
    if (!primary) return;
    let sourceId = c.source_resource_id;
    if (!sourceId && c.source_url) {
      const { call } = await import('@/data/client');
      const r = await call('resource_add_link', { url: c.source_url, concept_ids: [] });
      sourceId = r.id;
    }
    const created = await conceptM.add.mutateAsync({
      language_id: primary.id,
      name: c.name,
      note: c.note,
      example_code: c.example_code,
      example_output: c.example_output,
      category_id: c.category_id,
      source_resource_id: sourceId,
      day_key: dayKey,
    });
    toast.info(t('today.conceptAdded', { name: created.name }));
  };

  const closeDay = () =>
    close.mutate(
      { day_key: dayKey, self_usefulness: day.summary?.self_usefulness ?? null },
      {
        onSuccess: (res) => {
          toast.info(
            t('today.dayClosed', {
              time: formatDuration(res.summary.focused_seconds),
              concepts: res.summary.concepts_count,
              problems: res.summary.problems_solved + res.summary.problems_attempted,
            }),
          );
        },
      },
    );

  return (
    <>
      <PageHeader
        context={`${formatDay(dayKey)} · ${t('today.context', { day: app.journey_day })}`}
        title={t('today.title')}
        actions={
          <Button variant="ghost" icon={<Plus size={16} />} onClick={() => useUiStore.getState().setQuickLogOpen(true)}>
            {t('quickLog.title')} <kbd className="mono muted">Ctrl K</kbd>
          </Button>
        }
      />

      <div className={s.topRow}>
        <FocusPill />
      </div>

      {showWelcome ? (
        <WelcomeBack
          name={app.profile?.display_name ?? ''}
          daysAway={daysAway}
          today={dayKey}
          recent={allConcepts.slice(0, 3)}
          canReview={review.length > 0}
          onReview={() => setRecall(review)}
          onStart={() => goTo('session')}
        />
      ) : (
        <GettingStarted onAction={goTo} />
      )}

      <WeekReviewCard today={dayKey} />

      {empty && !showWelcome && !guideOpen && (
        <div className={s.banner}>
          <Lightbulb size={20} aria-hidden="true" color="var(--progress)" />
          <span>{t('today.empty')}</span>
          {review[0] && (
            <Button variant="ghost" size="sm" onClick={() => setRecall(review)}>
              {t('today.reviewSuggestion', { concept: review[0].concept_name, days: review[0].days_since_learned })}
            </Button>
          )}
        </div>
      )}

      {todaysLowMoodInsight && (
        <div style={{ marginBottom: 20 }}>
          <InsightCard
            insight={{ ...todaysLowMoodInsight }}
            onDismiss={() => setLowMood(null)}
          />
        </div>
      )}

      <div className={s.todayGrid}>
        <div className={s.col}>
          {!coachSeen && !guideOpen && !guide?.has_session && (
            <div className={s.coach} role="note">
              <span style={{ flex: 1 }}>{t('onboarding.coachMark')}</span>
              <IconButton aria-label={t('common.close')} onClick={setCoachSeen}>
                <X size={16} />
              </IconButton>
            </div>
          )}
          <TimerCard sessions={day.sessions} languages={languages} onMoodLogged={(v) => onMood(v)} />
          <Card title={t('today.moodCheckin')}>
            <div className="stack">
              <MoodScale
                value={latestAdhoc}
                hideLabel
                onChange={(v) =>
                  mood.mutate(
                    { value: v, kind: 'adhoc', session_id: null },
                    {
                      onSuccess: (res) => {
                        toast.info(t('mood.logged', { label: t(`mood.${v}`) }));
                        onMood(v, res.insights);
                      },
                    },
                  )
                }
              />
              {(before != null || after != null) && (
                <p className="muted" style={{ fontSize: '0.87rem' }}>
                  {t('today.moodBefore')}: {before != null ? t(`mood.${before}`) : '–'} · {t('today.moodAfter')}:{' '}
                  {after != null ? t(`mood.${after}`) : '–'}
                </p>
              )}
            </div>
          </Card>
        </div>

        <div className={s.col}>
          <Card title={t('today.learnedTitle')}>
            <div className="stack" style={{ gap: 16 }}>
              <div id="concept-input">
                <ConceptInput
                  search={search}
                  categories={categories}
                  resources={resources.map((r) => ({ id: r.id, title: r.title }))}
                  onAdd={addConcept}
                  onPickExisting={(c) => toast.info(t('errors.duplicateConcept', { name: c.name }))}
                  busy={conceptM.add.isPending}
                />
              </div>
              <ConceptList concepts={day.concepts} onEdit={(c) => setEditConcept({ concept: c })} />
            </div>
          </Card>

          <Card
            title={t('today.problemsTitle')}
            actions={
              <Button size="sm" icon={<Plus size={16} />} onClick={() => setProblemModal({ open: true, edit: null })}>
                {t('today.logProblem')}
              </Button>
            }
          >
            {day.problems.length === 0 ? (
              <EmptyState icon={<CheckCircle2 size={22} />}>{t('today.noProblems')}</EmptyState>
            ) : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
                {day.problems.map((p) => (
                  <ProblemRow
                    key={p.id}
                    problem={p}
                    feelings={feelings}
                    onOpen={() => (p.statement ? detail.open(p.id) : setProblemModal({ open: true, edit: p }))}
                    onStart={() => timer.attemptStart.mutate(p.id)}
                    onPause={() => timer.attemptPause.mutate(undefined)}
                    onResume={() => timer.attemptResume.mutate(undefined)}
                    onStop={() => timer.attemptEnd.mutate(undefined)}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className={s.col}>
          <DiaryCard dayKey={dayKey} diary={day.diary} concepts={day.concepts} feelings={feelings} />
          <UsefulnessCard
            calc={day.calc}
            selfValue={day.summary?.self_usefulness ?? null}
            comparison={day.comparison}
            onCommit={(v) => selfU.mutate({ day_key: dayKey, value: v })}
          />
          <Button variant="primary" size="lg" block onClick={closeDay} loading={close.isPending}>
            {t('today.closeDay')}
          </Button>
        </div>
      </div>

      <ProblemModal
        open={problemModal.open}
        onClose={() => setProblemModal({ open: false, edit: null })}
        concepts={[...day.concepts, ...allConcepts.filter((c) => c.language_id === primary?.id && !day.concepts.some((d) => d.id === c.id))].slice(0, 40)}
        feelings={feelings}
        initial={problemModal.edit}
        busy={problemM.add.isPending || problemM.update.isPending}
        onDelete={
          problemModal.edit
            ? () => {
                problemM.remove.mutate(problemModal.edit!.id);
                setProblemModal({ open: false, edit: null });
              }
            : undefined
        }
        onSubmit={async (v) => {
          if (problemModal.edit) {
            const id = problemModal.edit.id;
            await problemM.update.mutateAsync({
              id,
              title: v.title,
              url: v.url || null,
              difficulty: v.difficulty,
              feeling_tag_id: v.feeling_tag_id,
              concept_ids: v.concept_ids,
              solution_text: v.solution_text || null,
              solution_path: v.solution_path || null,
            });
            if (v.status !== problemModal.edit.status) await problemM.setStatus.mutateAsync({ id, status: v.status });
          } else {
            await problemM.add.mutateAsync({
              title: v.title,
              url: v.url || null,
              difficulty: v.difficulty,
              status: v.status,
              feeling_tag_id: v.feeling_tag_id,
              concept_ids: v.concept_ids,
              solution_text: v.solution_text || null,
              solution_path: v.solution_path || null,
              language_id: primary?.id ?? null,
            });
          }
          setProblemModal({ open: false, edit: null });
        }}
      />

      {editConcept && (
        <ConceptEditModal
          concept={editConcept.concept}
          openExample={editConcept.example}
          onClose={() => setEditConcept(null)}
        />
      )}
      {recall && <RecallReview items={recall} onClose={() => setRecall(null)} />}
      {detail.element}
      <StaleSessionModal />
    </>
  );
}
