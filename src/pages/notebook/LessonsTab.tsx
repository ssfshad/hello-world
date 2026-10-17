/**
 * The Notebook's lessons shelf: every lesson as a coloured notebook, grouped
 * by course, plus a button to start a new one. Filters (course, when, concept,
 * what's inside) and sorting are remembered between visits.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, SlidersHorizontal } from 'lucide-react';
import type { LessonSummary } from '@/core/types/api';
import { Button, EmptyState, Select, TextField, uiStyles } from '@/components/ui';
import { useAppState, useConcepts, useLessons } from '@/data/queries';
import { addDays } from '@/lib/day';
import { formatDay } from '@/lib/format';
import { DEFAULT_LESSON_FILTERS, useUiStore, type LessonFilters } from '@/stores/uiStore';
import { NewLessonModal } from './NewLessonModal';
import s from './notebook.module.css';

export function LessonsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { data: lessons = [], isLoading } = useLessons(query);
  const { data: everything = [] } = useLessons();
  const [creating, setCreating] = useState(false);
  const filters = useUiStore((st) => st.lessonFilters);
  const setFilters = useUiStore((st) => st.setLessonFilters);
  const { data: app } = useAppState();
  const { data: allConcepts = [] } = useConcepts(null, null);
  const active = activeFilterCount(filters);
  const [showFilters, setShowFilters] = useState(false);
  // The row stays open while any filter is on, so nothing is hidden by surprise.
  const filtersOpen = showFilters || active > 0;
  const grouped = filters.sort === 'course';

  const shown = useMemo(
    () => sortLessons(filterLessons(lessons, filters, app?.today ?? null), filters.sort),
    [lessons, filters, app?.today],
  );

  // Only concepts that are in at least one lesson are worth filtering by.
  const conceptOptions = useMemo(() => {
    const linked = new Set(everything.flatMap((l) => l.concept_ids));
    return allConcepts
      .filter((c) => linked.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ value: c.id, label: c.name }));
  }, [everything, allConcepts]);

  const groups = useMemo(() => {
    const map = new Map<string, LessonSummary[]>();
    for (const l of shown) {
      const key = l.course ?? '';
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    // Courses in the order they were last worked on; lessons inside a course in learning order.
    return [...map.entries()]
      .map(([course, items]) => ({
        course,
        items: [...items].sort(
          (a, b) => a.day_key.localeCompare(b.day_key) || a.created_at.localeCompare(b.created_at),
        ),
        latest: items.reduce((m, l) => (l.updated_at > m ? l.updated_at : m), ''),
      }))
      .sort((a, b) =>
        a.course === '' ? 1 : b.course === '' ? -1 : b.latest.localeCompare(a.latest),
      );
  }, [shown]);

  const courses = useMemo(
    () => [...new Set(everything.map((l) => l.course).filter((c): c is string => !!c))].sort(),
    [everything],
  );

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className={s.shelfBar}>
        <div className={s.shelfSearch}>
          <TextField
            label={t('common.search')}
            hideLabel
            type="search"
            placeholder={t('lessons.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {everything.length > 0 && (
          <Button
            icon={<SlidersHorizontal size={16} />}
            aria-expanded={filtersOpen}
            aria-controls="lesson-filters"
            onClick={() => setShowFilters(!filtersOpen)}
          >
            {t('lessons.filters.button')}
            {active > 0 && (
              <span
                className={uiStyles.badge}
                aria-label={t('lessons.filters.activeCount', { count: active })}
              >
                {active}
              </span>
            )}
          </Button>
        )}
        <span className="spacer" />
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
          {t('lessons.new')}
        </Button>
      </div>

      {!isLoading && !everything.length ? (
        <div className={s.welcome}>
          <div className={s.welcomeArt} aria-hidden>
            <span>📓</span>
            <span>✏️</span>
            <span>🎨</span>
          </div>
          <h2>{t('lessons.welcomeTitle')}</h2>
          <p>{t('lessons.welcomeBody')}</p>
          <ul className={s.welcomeList}>
            <li>📝 {t('lessons.welcomePage')}</li>
            <li>🎨 {t('lessons.welcomeBoard')}</li>
            <li>📸 {t('lessons.welcomePhotos')}</li>
            <li>🧠 {t('lessons.welcomeLearned')}</li>
          </ul>
          <Button
            variant="primary"
            size="lg"
            icon={<Plus size={18} />}
            onClick={() => setCreating(true)}
          >
            {t('lessons.startFirst')}
          </Button>
        </div>
      ) : (
        <>
          {filtersOpen && (
            <div
              id="lesson-filters"
              className={s.filterRow}
              role="group"
              aria-label={t('lessons.filters.button')}
            >
              <Select
                label={t('lessons.course')}
                value={filters.course}
                onChange={(e) => setFilters({ course: e.target.value })}
                options={[
                  { value: '', label: t('lessons.filters.allCourses') },
                  ...courses.map((c) => ({ value: c, label: c })),
                  { value: '__none', label: t('lessons.filters.noCourse') },
                ]}
              />
              <Select
                label={t('lessons.filters.when')}
                value={filters.when}
                onChange={(e) => setFilters({ when: e.target.value as LessonFilters['when'] })}
                options={(['any', '7', '30', '90', '365'] as const).map((v) => ({
                  value: v,
                  label: t(`lessons.filters.when_${v}`),
                }))}
              />
              {conceptOptions.length > 0 && (
                <Select
                  label={t('lessons.filters.concept')}
                  value={filters.concept}
                  onChange={(e) => setFilters({ concept: e.target.value })}
                  options={[{ value: '', label: t('lessons.filters.anyConcept') }, ...conceptOptions]}
                />
              )}
              <Select
                label={t('lessons.filters.has')}
                value={filters.has}
                onChange={(e) => setFilters({ has: e.target.value as LessonFilters['has'] })}
                options={(['any', 'pictures', 'concepts', 'empty'] as const).map((v) => ({
                  value: v,
                  label: t(`lessons.filters.has_${v}`),
                }))}
              />
              <Select
                label={t('lessons.filters.sort')}
                value={filters.sort}
                onChange={(e) => setFilters({ sort: e.target.value as LessonFilters['sort'] })}
                options={(['course', 'newest', 'oldest', 'edited', 'az'] as const).map((v) => ({
                  value: v,
                  label: t(`lessons.filters.sort_${v}`),
                }))}
              />
            </div>
          )}
          {active > 0 && (
            <div className={s.filterSummary} role="status">
              <span>
                {t('lessons.filters.showing', { shown: shown.length, total: lessons.length })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setFilters(null)}>
                {t('lessons.filters.clear')}
              </Button>
            </div>
          )}
          {!isLoading && !lessons.length ? (
            <EmptyState icon={<Search size={20} />}>{t('notebook.noResults')}</EmptyState>
          ) : !isLoading && !shown.length ? (
            <EmptyState icon={<SlidersHorizontal size={20} />}>
              <span className="stack" style={{ gap: 8, alignItems: 'center' }}>
                {t('lessons.filters.none')}
                <Button size="sm" onClick={() => setFilters(null)}>
                  {t('lessons.filters.clear')}
                </Button>
              </span>
            </EmptyState>
          ) : grouped ? (
            groups.map((g) => (
              <section
                key={g.course || '_none'}
                className={s.course}
                aria-label={g.course || t('lessons.noCourse')}
              >
                <h2 className={s.courseTitle}>
                  {g.course || t('lessons.noCourse')}
                  <span className={s.courseCount}>
                    {t('lessons.count', { count: g.items.length })}
                  </span>
                </h2>
                <ul className={s.cards}>
                  {g.items.map((l, i) => (
                    <li key={l.id}>
                      <LessonCard
                        lesson={l}
                        number={g.course ? i + 1 : null}
                        onOpen={() => navigate(`/notebook/lessons/${l.id}`)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <ul className={s.cards} aria-label={t('lessons.filters.results')}>
              {shown.map((l) => (
                <li key={l.id}>
                  <LessonCard
                    lesson={l}
                    number={null}
                    onOpen={() => navigate(`/notebook/lessons/${l.id}`)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <NewLessonModal
        open={creating}
        courses={courses}
        onClose={() => setCreating(false)}
        onCreated={(id) => navigate(`/notebook/lessons/${id}`)}
      />
    </div>
  );
}

/** How many filters differ from "show everything" (sorting doesn't count). */
export function activeFilterCount(f: LessonFilters): number {
  return (['course', 'when', 'concept', 'has'] as const).filter(
    (k) => f[k] !== DEFAULT_LESSON_FILTERS[k],
  ).length;
}

export function filterLessons(
  lessons: LessonSummary[],
  f: LessonFilters,
  today: string | null,
): LessonSummary[] {
  const since = f.when !== 'any' && today ? addDays(today, -Number(f.when)) : null;
  return lessons.filter(
    (l) =>
      (f.course === '' || (f.course === '__none' ? !l.course : l.course === f.course)) &&
      (!since || l.day_key >= since) &&
      (!f.concept || l.concept_ids.includes(f.concept)) &&
      (f.has === 'any' ||
        (f.has === 'pictures' && l.image_count > 0) ||
        (f.has === 'concepts' && l.concept_ids.length > 0) ||
        (f.has === 'empty' && !l.excerpt && !l.image_count)),
  );
}

/** "By course" keeps the grouped shelf's own order; the others make one flat list. */
export function sortLessons(
  lessons: LessonSummary[],
  sort: LessonFilters['sort'],
): LessonSummary[] {
  const byDay = (a: LessonSummary, b: LessonSummary) =>
    a.day_key.localeCompare(b.day_key) || a.created_at.localeCompare(b.created_at);
  const out = [...lessons];
  if (sort === 'newest') out.sort((a, b) => byDay(b, a));
  else if (sort === 'oldest') out.sort(byDay);
  else if (sort === 'edited') out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  else if (sort === 'az')
    out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return out;
}

function LessonCard({
  lesson,
  number,
  onOpen,
}: {
  lesson: LessonSummary;
  number: number | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className={s.card} data-color={lesson.color ?? 'teal'} onClick={onOpen}>
      <span className={s.cardSpine} aria-hidden />
      <span className={s.cardTop}>
        <span className={s.cardIcon} aria-hidden>
          {lesson.icon ?? '📘'}
        </span>
        {number != null && (
          <span className={s.cardNumber}>{t('lessons.lessonNumber', { n: number })}</span>
        )}
      </span>
      <span className={s.cardTitle}>{lesson.title}</span>
      <span className={s.cardDate}>
        {formatDay(lesson.day_key, { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
      {lesson.excerpt ? (
        <span className={s.cardExcerpt}>{lesson.excerpt}</span>
      ) : (
        <span className={s.cardExcerptEmpty}>{t('lessons.emptyLesson')}</span>
      )}
      <span className={s.cardBadges}>
        {(lesson.has_page || lesson.has_board) && <span title={t('lessons.canvasTitle')}>🎨</span>}
        {lesson.image_count > 0 && (
          <span title={t('lessons.pictures', { count: lesson.image_count })}>
            🖼️ {lesson.image_count}
          </span>
        )}
        {lesson.concept_ids.length > 0 && (
          <span title={t('lessons.learnedCount', { count: lesson.concept_ids.length })}>
            🧠 {lesson.concept_ids.length}
          </span>
        )}
      </span>
    </button>
  );
}
