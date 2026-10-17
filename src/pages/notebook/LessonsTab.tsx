/**
 * The Notebook's lessons shelf: every lesson as a coloured notebook, grouped
 * by course, plus a button to start a new one.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import type { LessonSummary } from '@/core/types/api';
import { Button, EmptyState, TextField } from '@/components/ui';
import { useLessons } from '@/data/queries';
import { formatDay } from '@/lib/format';
import { NewLessonModal } from './NewLessonModal';
import s from './notebook.module.css';

export function LessonsTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { data: lessons = [], isLoading } = useLessons(query);
  const { data: everything = [] } = useLessons();
  const [creating, setCreating] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<string, LessonSummary[]>();
    for (const l of lessons) {
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
  }, [lessons]);

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
      ) : !isLoading && !lessons.length ? (
        <EmptyState icon={<Search size={20} />}>{t('notebook.noResults')}</EmptyState>
      ) : (
        groups.map((g) => (
          <section
            key={g.course || '_none'}
            className={s.course}
            aria-label={g.course || t('lessons.noCourse')}
          >
            <h2 className={s.courseTitle}>
              {g.course || t('lessons.noCourse')}
              <span className={s.courseCount}>{t('lessons.count', { count: g.items.length })}</span>
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
