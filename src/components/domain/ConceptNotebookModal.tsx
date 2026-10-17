/**
 * "Put this concept in my notebook": from a "What I learned" item, start a new
 * lesson about it or add it to a lesson that already exists. Either way the
 * concept is linked to the lesson (so it shows in the lesson and in recall).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpenText, Check, Plus } from 'lucide-react';
import type { Concept, LessonSummary } from '@/core/types/api';
import { Button, Modal, TextField, toast } from '@/components/ui';
import { useLessonMutations, useLessons } from '@/data/queries';
import { formatDay } from '@/lib/format';
import { NewLessonModal } from '@/pages/notebook/NewLessonModal';
import s from './domain.module.css';

/** Lessons a concept is linked to (shared with the "What I learned" list). */
export function useConceptLessons(conceptId: string): LessonSummary[] {
  const { data: lessons = [] } = useLessons();
  return useMemo(() => lessons.filter((l) => l.concept_ids.includes(conceptId)), [lessons, conceptId]);
}

export function ConceptNotebookModal({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: lessons = [] } = useLessons();
  const lessonM = useLessonMutations();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const linked = lessons.filter((l) => l.concept_ids.includes(concept.id));
  const courses = useMemo(
    () => [...new Set(lessons.map((l) => l.course).filter((c): c is string => !!c))].sort(),
    [lessons],
  );
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lessons
      .filter((l) => !l.concept_ids.includes(concept.id))
      .filter(
        (l) =>
          !q ||
          l.title.toLowerCase().includes(q) ||
          (l.course ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [lessons, concept.id, query]);

  const open = (id: string) => {
    onClose();
    navigate(`/notebook/lessons/${id}`);
  };

  const addTo = async (l: LessonSummary) => {
    setBusyId(l.id);
    try {
      await lessonM.update.mutateAsync({ id: l.id, concept_ids: [...l.concept_ids, concept.id] });
      toast.info(t('conceptNotebook.added', { name: concept.name, lesson: l.title }));
      open(l.id);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Modal
        open={!creating}
        onClose={onClose}
        title={
          <span className="row" style={{ gap: 8 }}>
            <BookOpenText size={18} /> {t('conceptNotebook.title', { name: concept.name })}
          </span>
        }
        footer={
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        }
      >
        <div className="stack" style={{ gap: 18 }}>
          {linked.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <span className={s.pickHeading}>{t('conceptNotebook.alreadyIn')}</span>
              <ul className={s.pickList}>
                {linked.map((l) => (
                  <li key={l.id}>
                    <button type="button" className={s.pickRow} onClick={() => open(l.id)}>
                      <LessonLabel lesson={l} />
                      <span className={s.pickAction}>
                        <Check size={14} aria-hidden /> {t('common.open')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            {t('conceptNotebook.newLesson')}
          </Button>

          <div className="stack" style={{ gap: 8 }}>
            <span className={s.pickHeading}>{t('conceptNotebook.existing')}</span>
            {lessons.length === linked.length ? (
              <p className="muted">{linked.length ? t('conceptNotebook.noOthers') : t('conceptNotebook.noLessons')}</p>
            ) : (
              <>
                {lessons.length - linked.length > 5 && (
                  <TextField
                    label={t('common.search')}
                    hideLabel
                    type="search"
                    placeholder={t('lessons.searchPlaceholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
                {others.length === 0 ? (
                  <p className="muted">{t('notebook.noResults')}</p>
                ) : (
                  <ul className={s.pickList} style={{ maxHeight: 280, overflowY: 'auto' }}>
                    {others.map((l) => (
                      <li key={l.id}>
                        <button
                          type="button"
                          className={s.pickRow}
                          disabled={busyId !== null}
                          onClick={() => void addTo(l)}
                        >
                          <LessonLabel lesson={l} />
                          <span className={s.pickAction}>
                            {busyId === l.id ? t('common.saving') : t('conceptNotebook.addHere')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>
      <NewLessonModal
        open={creating}
        courses={courses}
        initialTitle={concept.name}
        conceptIds={[concept.id]}
        onClose={() => setCreating(false)}
        onCreated={(id) => open(id)}
      />
    </>
  );
}

function LessonLabel({ lesson }: { lesson: LessonSummary }) {
  return (
    <span className={s.pickLabel}>
      <span className={s.pickIcon} data-color={lesson.color ?? 'teal'} aria-hidden>
        {lesson.icon ?? '📘'}
      </span>
      <span style={{ minWidth: 0 }}>
        <strong className={s.pickTitle}>{lesson.title}</strong>
        <small className="muted">
          {[lesson.course, formatDay(lesson.day_key, { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ')}
        </small>
      </span>
    </span>
  );
}
