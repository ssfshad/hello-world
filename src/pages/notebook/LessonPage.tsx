/**
 * One lesson: a cover (icon, colour, title, course, date), the "What I
 * learned" concepts that came out of it, and one big canvas for notes: written
 * pages, drawings, stickers and photos together. Everything saves as you go.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CloudOff,
  Loader2,
  NotebookPen,
  Palette,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Concept, Lesson, LessonUpdate } from '@/core/types/api';
import { Button, Chip, EmptyState, Modal, cx, toast } from '@/components/ui';
import { ConceptInput, type NewConcept } from '@/components/domain/ConceptInput';
import { ConceptEditModal } from '@/components/domain/ConceptEditModal';
import { call, toAppError } from '@/data/client';
import { onFileDrop } from '@/data/platform';
import {
  qk,
  useAppState,
  useCategories,
  useConceptMutations,
  useConcepts,
  useLesson,
  useLessonMutations,
  useLessons,
} from '@/data/queries';
import { COVER_COLORS, LESSON_ICONS } from '@/components/lesson/palette';
import { Popover } from '@/components/lesson/Popover';
import { assetUrl, prepareImage } from '@/components/lesson/images';
import type { Uploaded } from '@/components/lesson/PageEditor';
import type { BoardHandle } from '@/components/lesson/Board';
import s from './notebook.module.css';

const Board = lazy(() => import('@/components/lesson/Board').then((m) => ({ default: m.Board })));

type Status = 'saved' | 'pending' | 'saving' | 'error';

/**
 * Collects edits and saves them in one call after a short pause, and right
 * away when the lesson is closed.
 */
function useAutosave(id: string) {
  const pending = useRef<Partial<LessonUpdate>>({});
  const timer = useRef<number | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<Status>('saved');
  const queryClient = useQueryClient();

  const saveOnce = useCallback(async (): Promise<void> => {
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    setStatus('saving');
    try {
      const saved = await call('lesson_update', { input: { ...patch, id } });
      queryClient.setQueryData(qk.lesson(id), (old: Lesson | undefined) =>
        // Keep the assets list we may have grown locally.
        old
          ? {
              ...saved,
              assets: saved.assets.length >= old.assets.length ? saved.assets : old.assets,
            }
          : saved,
      );
      queryClient.invalidateQueries({ queryKey: ['lessons', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['search'] });
      setStatus(Object.keys(pending.current).length ? 'pending' : 'saved');
    } catch (e) {
      // Put the edits back so the next try includes them.
      pending.current = { ...patch, ...pending.current };
      setStatus('error');
      toast.error(toAppError(e).message);
    }
  }, [id, queryClient]);

  /** Saves pending edits; saves run one after another, never overlapping. */
  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    queue.current = queue.current.then(saveOnce);
    return queue.current;
  }, [saveOnce]);

  const schedule = useCallback(
    (patch: Partial<LessonUpdate>, delay = 900) => {
      pending.current = { ...pending.current, ...patch };
      setStatus('pending');
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  // Save whatever is left when leaving the lesson.
  useEffect(() => () => void flush(), [flush]);

  return { schedule, flush, status };
}

export default function LessonPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: lesson, isLoading, error } = useLesson(id);

  if (isLoading) return <div className={s.lessonLoading} aria-busy="true" />;
  if (error || !lesson) {
    return (
      <EmptyState
        icon={<NotebookPen size={20} />}
        action={
          <Button onClick={() => navigate('/notebook')} icon={<ArrowLeft size={16} />}>
            {t('lessons.backToNotebook')}
          </Button>
        }
      >
        {t('lessons.notFound')}
      </EmptyState>
    );
  }
  return <LessonEditor key={lesson.id} lesson={lesson} />;
}

function LessonEditor({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: app } = useAppState();
  const { data: allLessons = [] } = useLessons();
  const lessonM = useLessonMutations();
  const { schedule, flush, status } = useAutosave(lesson.id);

  // Cover fields are edited locally and saved in the background.
  const [title, setTitle] = useState(lesson.title);
  const [course, setCourse] = useState(lesson.course ?? '');
  const [icon, setIcon] = useState(lesson.icon ?? '📘');
  const [color, setColor] = useState(lesson.color ?? 'teal');
  const [day, setDay] = useState(lesson.day_key);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dropping, setDropping] = useState(false);

  const boardRef = useRef<BoardHandle>(null);

  const courses = useMemo(
    () => [...new Set(allLessons.map((l) => l.course).filter((c): c is string => !!c))].sort(),
    [allLessons],
  );

  const upload = useCallback(
    async (file: File): Promise<Uploaded> => {
      const { dataUrl, ext } = await prepareImage(file);
      const asset = await lessonM.addAsset.mutateAsync({
        lesson_id: lesson.id,
        data_base64: dataUrl,
        ext,
      });
      return { asset, url: await assetUrl(asset) };
    },
    [lesson.id, lessonM.addAsset],
  );

  // In the desktop app, files dropped on the window arrive as paths.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let alive = true;
    void onFileDrop(
      async (paths) => {
        const images = paths.filter((p) => /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(p));
        if (!images.length) {
          toast.error(t('lessons.onlyPictures'));
          return;
        }
        const ups: Uploaded[] = [];
        for (const path of images) {
          try {
            const asset = await lessonM.addAsset.mutateAsync({ lesson_id: lesson.id, path });
            ups.push({ asset, url: await assetUrl(asset) });
          } catch {
            // shown by the mutation's error toast
          }
        }
        if (!ups.length) return;
        await boardRef.current?.insertImages(ups);
      },
      (hovering) => setDropping(hovering),
    ).then((u) => {
      if (alive) unsub = u;
      else u();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [lesson.id, lessonM.addAsset, t]);

  const statusLabel =
    status === 'saved'
      ? t('common.saved')
      : status === 'error'
        ? t('lessons.saveFailed')
        : t('common.saving');

  return (
    <div className={s.lesson}>
      <div className={s.lessonTop}>
        <Button
          variant="ghost"
          icon={<ArrowLeft size={16} />}
          onClick={async () => {
            await flush();
            navigate('/notebook');
          }}
        >
          {t('lessons.backToNotebook')}
        </Button>
        <span className="spacer" />
        <span
          className={cx(s.saveState, status === 'error' && s.saveError)}
          role="status"
          aria-live="polite"
        >
          {status === 'saved' ? (
            <Check size={14} />
          ) : status === 'error' ? (
            <CloudOff size={14} />
          ) : (
            <Loader2 size={14} className={s.spin} />
          )}
          {statusLabel}
        </span>
        {status === 'error' && (
          <Button size="sm" onClick={() => void flush()}>
            {t('lessons.retry')}
          </Button>
        )}
        <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
          {t('common.delete')}
        </Button>
      </div>

      <header className={s.cover} data-color={color}>
        <Popover
          label={t('lessons.cover.change')}
          className={s.coverIconBtn}
          trigger={<span className={s.coverIcon}>{icon}</span>}
        >
          {(close) => (
            <div className={s.coverPicker}>
              <span className={s.pickerLabel}>{t('lessons.cover.icon')}</span>
              <div className={s.iconGrid}>
                {LESSON_ICONS.map((ic) => (
                  <button
                    key={ic}
                    type="button"
                    className={s.iconChoice}
                    aria-pressed={ic === icon}
                    aria-label={ic}
                    onClick={() => {
                      setIcon(ic);
                      schedule({ icon: ic }, 200);
                      close();
                    }}
                  >
                    {ic}
                  </button>
                ))}
              </div>
              <span className={s.pickerLabel}>
                <Palette size={13} /> {t('lessons.cover.color')}
              </span>
              <div className={s.colorGrid}>
                {COVER_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={s.colorChoice}
                    data-color={c}
                    aria-pressed={c === color}
                    aria-label={t(`lessons.coverColors.${c}`)}
                    title={t(`lessons.coverColors.${c}`)}
                    onClick={() => {
                      setColor(c);
                      schedule({ color: c }, 200);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </Popover>
        <div className={s.coverText}>
          <input
            className={s.titleInput}
            value={title}
            aria-label={t('lessons.titleLabel')}
            placeholder={t('lessons.titlePlaceholder')}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) schedule({ title: e.target.value });
            }}
            onBlur={() => {
              if (!title.trim()) setTitle(lesson.title);
            }}
          />
          <div className={s.coverMeta}>
            <label className={s.metaField}>
              <span>{t('lessons.course')}</span>
              <input
                list="lesson-courses"
                value={course}
                placeholder={t('lessons.coursePlaceholder')}
                maxLength={120}
                onChange={(e) => {
                  setCourse(e.target.value);
                  schedule({ course: e.target.value.trim() || null });
                }}
              />
              <datalist id="lesson-courses">
                {courses.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className={s.metaField}>
              <span>{t('lessons.date')}</span>
              <input
                type="date"
                value={day}
                max={app?.today}
                onChange={(e) => {
                  if (!e.target.value) return;
                  setDay(e.target.value);
                  schedule({ day_key: e.target.value }, 300);
                }}
              />
            </label>
          </div>
        </div>
      </header>

      <LearnedRow lesson={lesson} onChange={(ids) => schedule({ concept_ids: ids }, 0)} />

      <Suspense fallback={<div className={s.lessonLoading} aria-busy="true" />}>
        <Board
          ref={boardRef}
          lessonId={lesson.id}
          initial={lesson.board}
          legacyPage={lesson.page}
          assets={lesson.assets}
          upload={upload}
          onChange={(board, text) => schedule({ board, page_text: text }, 1200)}
        />
      </Suspense>

      {dropping && (
        <div className={s.dropOverlay} aria-hidden>
          <span>🖼️ {t('lessons.dropHere')}</span>
        </div>
      )}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('lessons.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={lessonM.remove.isPending}
              onClick={async () => {
                await lessonM.remove.mutateAsync(lesson.id);
                navigate('/notebook');
              }}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p>{t('lessons.deleteBody', { title: lesson.title })}</p>
      </Modal>
    </div>
  );
}

/** The "What I learned" concepts that came out of this lesson. */
function LearnedRow({ lesson, onChange }: { lesson: Lesson; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const { data: all = [] } = useConcepts(null, null);
  const { data: categories = [] } = useCategories();
  const conceptM = useConceptMutations();
  const [ids, setIds] = useState<string[]>(lesson.concept_ids);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Concept | null>(null);
  const byId = new Map(all.map((c) => [c.id, c]));
  const linked = ids.map((id) => byId.get(id)).filter((c): c is Concept => !!c);
  const language =
    lesson.language_id ?? app?.languages.find((l) => l.is_primary)?.id ?? app?.languages[0]?.id;

  const update = (next: string[]) => {
    setIds(next);
    onChange(next);
  };

  return (
    <section className={s.learned} aria-label={t('lessons.learned')}>
      <span className={s.learnedLabel}>🧠 {t('lessons.learned')}</span>
      <div className={s.learnedChips}>
        {linked.map((c) => (
          <span key={c.id} className={s.learnedChip}>
            <Chip onToggle={() => setEditing(c)} title={t('lessons.openConcept')}>
              {c.name}
            </Chip>
            <button
              type="button"
              className={s.unlink}
              aria-label={t('lessons.unlinkConcept', { name: c.name })}
              title={t('lessons.unlinkConcept', { name: c.name })}
              onClick={() => update(ids.filter((x) => x !== c.id))}
            >
              ×
            </button>
          </span>
        ))}
        {!linked.length && (
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('lessons.learnedEmpty')}
          </span>
        )}
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          {t('lessons.addLearned')}
        </Button>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t('lessons.addLearnedTitle')}
        wide
      >
        <p className="muted" style={{ marginTop: 0 }}>
          {t('lessons.addLearnedHint')}
        </p>
        <ConceptInput
          search={(p) =>
            all
              .filter((c) => !ids.includes(c.id) && c.name.toLowerCase().includes(p.toLowerCase()))
              .slice(0, 6)
          }
          categories={categories}
          busy={conceptM.add.isPending}
          onPickExisting={(c) => {
            if (!ids.includes(c.id)) update([...ids, c.id]);
            setAdding(false);
          }}
          onAdd={async (c: NewConcept) => {
            if (!language) return;
            const created = await conceptM.add.mutateAsync({
              language_id: language,
              name: c.name,
              note: c.note,
              example_code: c.example_code,
              example_output: c.example_output,
              category_id: c.category_id,
              day_key: lesson.day_key,
            });
            update([...ids, created.id]);
            setAdding(false);
          }}
        />
      </Modal>
      {editing && <ConceptEditModal concept={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
