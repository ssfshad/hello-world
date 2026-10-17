/**
 * The Notebook's lessons shelf: every lesson as a coloured notebook, grouped
 * by course, plus a button to start a new one.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpenText, Plus, Search } from 'lucide-react';
import type { LessonSummary } from '@/core/types/api';
import { Button, EmptyState, Modal, TextField } from '@/components/ui';
import { useAppState, useLessonMutations, useLessons } from '@/data/queries';
import { formatDay } from '@/lib/format';
import { COVER_COLORS, LESSON_ICONS } from '@/components/lesson/palette';
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

function NewLessonModal({
  open,
  courses,
  onClose,
  onCreated,
}: {
  open: boolean;
  courses: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const lessonM = useLessonMutations();
  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [icon, setIcon] = useState('📘');
  const [color, setColor] = useState<string>('teal');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setError(null);
  };

  const submit = async () => {
    if (!title.trim()) {
      setError(t('lessons.titleRequired'));
      return;
    }
    const l = await lessonM.create.mutateAsync({
      title: title.trim(),
      course: course.trim() || null,
      icon,
      color,
      language_id: app?.languages.find((x) => x.is_primary)?.id ?? null,
    });
    reset();
    onClose();
    onCreated(l.id);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={
        <span className="row" style={{ gap: 8 }}>
          <BookOpenText size={18} /> {t('lessons.new')}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={lessonM.create.isPending}
            onClick={() => void submit()}
          >
            {t('lessons.create')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t('lessons.titleLabel')}
          placeholder={t('lessons.titlePlaceholder')}
          value={title}
          maxLength={200}
          data-autofocus
          error={error}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
        />
        <TextField
          label={t('lessons.course')}
          hint={t('lessons.courseHint')}
          placeholder={t('lessons.coursePlaceholder')}
          list="new-lesson-courses"
          value={course}
          maxLength={120}
          onChange={(e) => setCourse(e.target.value)}
        />
        <datalist id="new-lesson-courses">
          {courses.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="stack" style={{ gap: 6 }}>
          <span className={s.pickerLabel}>{t('lessons.cover.icon')}</span>
          <div className={s.iconGrid} role="group" aria-label={t('lessons.cover.icon')}>
            {LESSON_ICONS.slice(0, 16).map((ic) => (
              <button
                key={ic}
                type="button"
                className={s.iconChoice}
                aria-pressed={ic === icon}
                aria-label={ic}
                onClick={() => setIcon(ic)}
              >
                {ic}
              </button>
            ))}
          </div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className={s.pickerLabel}>{t('lessons.cover.color')}</span>
          <div className={s.colorGrid} role="group" aria-label={t('lessons.cover.color')}>
            {COVER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={s.colorChoice}
                data-color={c}
                aria-pressed={c === color}
                aria-label={t(`lessons.coverColors.${c}`)}
                title={t(`lessons.coverColors.${c}`)}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
