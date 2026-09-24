import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pencil, Search } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Badge, Button, Card, EmptyState, IconButton, Select, TextField } from '@/components/ui';
import { DiaryCard } from '@/components/domain/DiaryCard';
import { UsefulnessCard } from '@/components/domain/UsefulnessCard';
import { ConceptInput, ConceptList, type NewConcept } from '@/components/domain/ConceptInput';
import { ConceptEditModal } from '@/components/domain/ConceptEditModal';
import { ProblemRow } from '@/components/domain/ProblemRow';
import { useProblemDetail } from '@/components/domain/useProblemDetail';
import {
  useAppState,
  useCategories,
  useConceptMutations,
  useConcepts,
  useDay,
  useFeelingTags,
  useProblems,
  useSearch,
  useSelfUsefulness,
  useStatsDaily,
} from '@/data/queries';
import { monthGrid } from '@/lib/day';
import { formatDay, formatDuration, formatTime, formatMinutes, pad2 } from '@/lib/format';
import type { Concept, DailyPoint, SearchKind } from '@/core/types/api';
import s from '../pages.module.css';

function moodColor(mood: number | null): string | undefined {
  if (mood == null) return undefined;
  const pct = 25 + (mood - 1) * 18; // 1 → pale, 5 → strong orange
  return `color-mix(in srgb, var(--feeling) ${pct}%, var(--surface))`;
}

export default function NotebookPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const { data: app } = useAppState();
  const today = app?.today ?? '';
  const selected = params.day ?? today;
  const [month, setMonth] = useState(() => {
    const [y, m] = (params.day ?? today ?? '2026-01-01').split('-').map(Number);
    return { y, m: m - 1 };
  });
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<SearchKind | ''>('');
  const [filterLang, setFilterLang] = useState('');
  const [filterConcept, setFilterConcept] = useState('');
  const [filterFeeling, setFilterFeeling] = useState('');
  const [moodMin, setMoodMin] = useState(1);
  const [moodMax, setMoodMax] = useState(5);

  const cells = monthGrid(month.y, month.m);
  const from = `${month.y}-${pad2(month.m + 1)}-01`;
  const to = cells.filter(Boolean).pop() ?? from;
  const { data: points = [] } = useStatsDaily({ from, to }, filterLang || null, !!today);
  const { data: concepts = [] } = useConcepts(null, null);
  const { data: feelings = [] } = useFeelingTags();
  const { data: problems = [] } = useProblems({ include_flagged: true, limit: 2000 });
  const { data: hits = [] } = useSearch(query, { kinds: kinds ? [kinds] : null, limit: 30 });
  const goal = app?.profile?.daily_goal_min ?? 60;

  const byDay = useMemo(() => new Map(points.map((p) => [p.day_key, p])), [points]);

  const matches = (day: string, p: DailyPoint | undefined): boolean => {
    if (p?.mood_avg != null && (p.mood_avg < moodMin || p.mood_avg > moodMax)) return false;
    if ((moodMin > 1 || moodMax < 5) && p?.mood_avg == null) return false;
    if (filterConcept) {
      const learned = concepts.some((c) => c.id === filterConcept && c.learned_day_key === day);
      const practiced = problems.some((pr) => pr.concept_ids.includes(filterConcept) && (pr.day_key === day || pr.created_day_key === day));
      if (!learned && !practiced) return false;
    }
    if (filterFeeling && !problems.some((pr) => pr.feeling_tag_id === filterFeeling && (pr.day_key === day || pr.created_day_key === day))) return false;
    return true;
  };
  const filtering = !!filterConcept || !!filterFeeling || moodMin > 1 || moodMax < 5;

  const weekdays = t('charts.weekdays', { returnObjects: true }) as string[];
  const shiftMonth = (d: number) =>
    setMonth(({ y, m }) => {
      const n = m + d;
      return { y: y + Math.floor(n / 12), m: ((n % 12) + 12) % 12 };
    });

  if (!app) return null;

  return (
    <>
      <PageHeader context={t('notebook.context')} title={t('notebook.title')} />
      <div className={s.notebook}>
        <div className="stack" style={{ gap: 20 }}>
          <Card
            title={new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(month.y, month.m, 1))}
            actions={
              <div className="row">
                <IconButton aria-label={t('notebook.prevMonth')} onClick={() => shiftMonth(-1)}>
                  <ChevronLeft size={18} />
                </IconButton>
                <IconButton aria-label={t('notebook.nextMonth')} onClick={() => shiftMonth(1)}>
                  <ChevronRight size={18} />
                </IconButton>
              </div>
            }
          >
            <div className={s.cal} role="grid" aria-label={t('notebook.title')}>
              {weekdays.map((w) => (
                <div key={w} className={s.calHead} role="columnheader">
                  {w}
                </div>
              ))}
              {cells.map((day, i) => {
                if (!day) return <div key={`e${i}`} />;
                const p = byDay.get(day);
                const minutes = p?.minutes ?? 0;
                const dim = filtering && !matches(day, p);
                const future = day > today;
                return (
                  <button
                    key={day}
                    type="button"
                    className={[s.calDay, day === today && s.calToday].filter(Boolean).join(' ')}
                    aria-pressed={day === selected}
                    disabled={future}
                    style={{ opacity: dim || future ? 0.35 : 1 }}
                    aria-label={t('notebook.dayCell', {
                      date: formatDay(day, { month: 'long', day: 'numeric' }),
                      time: formatMinutes(minutes),
                      mood: p?.mood_avg != null ? t('notebook.moodSuffix', { mood: p.mood_avg }) : '',
                    })}
                    onClick={() => navigate(`/notebook/${day}`)}
                  >
                    <span className={s.calFill} style={{ height: `${Math.min(100, (minutes / goal) * 100)}%` }} />
                    <span className={s.calNum}>{Number(day.slice(8))}</span>
                    {p?.mood_avg != null && <span className={s.calMood} style={{ background: moodColor(p.mood_avg) }} />}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title={t('common.filters')}>
            <div className="stack">
              <Select
                label={t('common.language')}
                value={filterLang}
                onChange={(e) => setFilterLang(e.target.value)}
                options={[{ value: '', label: t('common.allLanguages') }, ...app.languages.map((l) => ({ value: l.id, label: l.name }))]}
              />
              <Select
                label={t('notebook.filterConcept')}
                value={filterConcept}
                onChange={(e) => setFilterConcept(e.target.value)}
                options={[{ value: '', label: t('common.all') }, ...concepts.map((c) => ({ value: c.id, label: c.name }))]}
              />
              <Select
                label={t('notebook.filterFeeling')}
                value={filterFeeling}
                onChange={(e) => setFilterFeeling(e.target.value)}
                options={[{ value: '', label: t('common.all') }, ...feelings.map((f) => ({ value: f.id, label: f.name }))]}
              />
              <div className="row">
                <Select
                  label={`${t('notebook.filterMood')} min`}
                  value={String(moodMin)}
                  onChange={(e) => setMoodMin(Number(e.target.value))}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} · ${t(`mood.${n}`)}` }))}
                />
                <Select
                  label={`${t('notebook.filterMood')} max`}
                  value={String(moodMax)}
                  onChange={(e) => setMoodMax(Number(e.target.value))}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} · ${t(`mood.${n}`)}` }))}
                />
              </div>
            </div>
          </Card>

          <Card title={t('common.search')}>
            <div className="stack">
              <TextField
                label={t('common.search')}
                hideLabel
                type="search"
                placeholder={t('notebook.searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Select
                label={t('library.kind')}
                hideLabel
                value={kinds}
                onChange={(e) => setKinds(e.target.value as SearchKind | '')}
                options={[
                  { value: '', label: t('common.all') },
                  ...(['diary', 'concept', 'problem', 'resource'] as const).map((k) => ({ value: k, label: t(`notebook.kinds.${k}`) })),
                ]}
              />
              {query.trim().length >= 2 && (
                <>
                  <p className="muted" role="status" style={{ fontSize: '0.83rem' }}>
                    {hits.length ? t('notebook.searchResults', { count: hits.length }) : t('notebook.noResults')}
                  </p>
                  <ul className={s.hits}>
                    {hits.map((h) => (
                      <li key={`${h.kind}-${h.ref_id}`}>
                        <button
                          type="button"
                          className={s.hit}
                          onClick={() => (h.kind === 'resource' ? navigate('/library') : h.day_key && navigate(`/notebook/${h.day_key}`))}
                        >
                          <span className="row">
                            <Badge tone="muted">{t(`notebook.kinds.${h.kind}`)}</Badge>
                            <strong style={{ fontSize: '0.9rem' }}>{h.title}</strong>
                            <span className="spacer" />
                            {h.day_key && <span className="muted mono" style={{ fontSize: '0.75rem' }}>{h.day_key}</span>}
                          </span>
                          <Snippet text={h.snippet} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>

        {selected ? <DayPage key={selected} dayKey={selected} /> : <EmptyState icon={<Search size={20} />}>{t('notebook.pickDay')}</EmptyState>}
      </div>
    </>
  );
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(/[«»]/);
  return (
    <span className="muted" style={{ fontSize: '0.85rem' }}>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

function DayPage({ dayKey }: { dayKey: string }) {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const { data: day } = useDay(dayKey);
  const { data: feelings = [] } = useFeelingTags();
  const { data: categories = [] } = useCategories();
  const { data: allConcepts = [] } = useConcepts(null, null);
  const conceptM = useConceptMutations();
  const selfU = useSelfUsefulness();
  const detail = useProblemDetail();
  const [editing, setEditing] = useState(false);
  const [editConcept, setEditConcept] = useState<Concept | null>(null);
  if (!day || !app) return null;
  const primary = app.languages.find((l) => l.is_primary) ?? app.languages[0];
  const empty = !day.sessions.length && !day.concepts.length && !day.problems.length && !day.diary && !day.moods.length;
  const feelingNames = (day.diary?.feeling_tag_ids ?? []).map((id) => feelings.find((f) => f.id === id)?.name).filter(Boolean);

  const title = formatDay(dayKey, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  if (editing) {
    return (
      <div className="stack" style={{ gap: 20 }}>
        <Card headline={title} actions={<Button onClick={() => setEditing(false)}>{t('notebook.stopEdit')}</Button>}>
          <div className="stack" style={{ gap: 16 }}>
            <ConceptInput
              search={(p) => allConcepts.filter((c) => c.name.toLowerCase().includes(p.toLowerCase())).slice(0, 6)}
              categories={categories}
              onAdd={async (c: NewConcept) => {
                if (!primary) return;
                await conceptM.add.mutateAsync({ language_id: primary.id, name: c.name, note: c.note, category_id: c.category_id, day_key: dayKey });
              }}
            />
            <ConceptList concepts={day.concepts} onEdit={setEditConcept} />
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
              {day.problems.map((p) => (
                <ProblemRow key={p.id} problem={p} feelings={feelings} onOpen={() => detail.open(p.id)} />
              ))}
            </ul>
          </div>
        </Card>
        <DiaryCard dayKey={dayKey} diary={day.diary} concepts={day.concepts} feelings={feelings} />
        <UsefulnessCard calc={day.calc} selfValue={day.summary?.self_usefulness ?? null} comparison={day.comparison} onCommit={(v) => selfU.mutate({ day_key: dayKey, value: v })} />
        {editConcept && <ConceptEditModal concept={editConcept} onClose={() => setEditConcept(null)} />}
        {detail.element}
      </div>
    );
  }

  return (
    <Card
      headline={title}
      actions={
        <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
          {t('notebook.edit')}
        </Button>
      }
    >
      {empty ? (
        <EmptyState>{t('notebook.nothingLogged')}</EmptyState>
      ) : (
        <div>
          <section className={s.pageSection}>
            <h3>{t('notebook.sessions')}</h3>
            {day.sessions.length ? (
              <ul className="mono" style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.9rem' }}>
                {day.sessions.map((x) => (
                  <li key={x.id}>
                    {formatTime(x.started_at)} – {x.ended_at ? formatTime(x.ended_at) : '…'} · {formatDuration(x.elapsed_seconds)}
                  </li>
                ))}
                <li style={{ fontWeight: 600, marginTop: 4 }}>
                  {t('today.totalToday')}: {formatDuration(day.focused_seconds)}
                </li>
              </ul>
            ) : (
              <p className="muted">–</p>
            )}
          </section>
          <section className={s.pageSection}>
            <h3>{t('notebook.concepts')}</h3>
            <ConceptList concepts={day.concepts} />
          </section>
          <section className={s.pageSection}>
            <h3>{t('notebook.problems')}</h3>
            {day.problems.length ? (
              <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
                {day.problems.map((p) => (
                  <ProblemRow key={p.id} problem={p} feelings={feelings} onOpen={() => detail.open(p.id)} />
                ))}
              </ul>
            ) : (
              <p className="muted">–</p>
            )}
          </section>
          <section className={s.pageSection}>
            <h3>{t('notebook.diary')}</h3>
            {day.diary?.body ? <p className={s.diaryRead}>{day.diary.body}</p> : <p className="muted">–</p>}
            {feelingNames.length > 0 && (
              <div className="row-wrap">
                {feelingNames.map((n) => (
                  <Badge key={n} tone="feeling">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
            {day.moods.length > 0 && (
              <p className="muted" style={{ fontSize: '0.87rem' }}>
                {day.moods.map((m) => `${formatTime(m.at)} ${t(`mood.${m.value}`)}`).join(' · ')}
              </p>
            )}
          </section>
          <section className={s.pageSection}>
            <h3>{t('notebook.usefulness')}</h3>
            <p>
              {day.summary?.self_usefulness != null ? t('notebook.self', { value: day.summary.self_usefulness }) + ' · ' : ''}
              {t('notebook.calc', { value: day.summary?.calc_usefulness ?? day.calc.score })}
            </p>
          </section>
        </div>
      )}
      {detail.element}
    </Card>
  );
}
