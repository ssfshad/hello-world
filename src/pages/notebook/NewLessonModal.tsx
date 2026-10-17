/**
 * "New lesson" dialog, used by the Notebook shelf and by "What I learned"
 * (which starts a lesson already linked to a concept).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpenText } from 'lucide-react';
import { Button, Modal, TextField } from '@/components/ui';
import { useAppState, useLessonMutations } from '@/data/queries';
import { COVER_COLORS, LESSON_ICONS } from '@/components/lesson/palette';
import s from './notebook.module.css';

export function NewLessonModal({
  open,
  courses,
  onClose,
  onCreated,
  initialTitle = '',
  conceptIds,
}: {
  open: boolean;
  courses: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
  /** prefill, e.g. the concept's name */
  initialTitle?: string;
  /** "What I learned" concepts to link straight away */
  conceptIds?: string[];
}) {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const lessonM = useLessonMutations();
  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [icon, setIcon] = useState('📘');
  const [color, setColor] = useState<string>('teal');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setTitle(initialTitle);
  }, [open, initialTitle]);

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
      concept_ids: conceptIds ?? [],
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
