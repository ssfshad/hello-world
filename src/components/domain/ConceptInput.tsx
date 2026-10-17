import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpenText, Plus } from 'lucide-react';
import type { Concept, ConceptCategory, LessonSummary } from '@/core/types/api';
import { Button, Chip, ChipGroup, Select, TextArea, TextField, toast, uiStyles } from '@/components/ui';
import { conceptNameSchema } from '@/core/schemas';
import { useLessonMutations, useLessons } from '@/data/queries';
import { ConceptNotebookModal, useConceptLessons } from './ConceptNotebookModal';
import { ExampleField } from './ExampleEditor';
import { GlossaryText } from './GlossaryText';
import s from './domain.module.css';

export interface NewConcept {
  name: string;
  note: string | null;
  example_code: string | null;
  example_output: string | null;
  category_id: string | null;
  source_resource_id: string | null;
  source_url: string | null;
}

/**
 * Single-line concept input with autocomplete from the user's concept list
 * (prevents "for loop" / "for-loops" duplicates), then an inline expander for
 * note, category and source.
 */
export function ConceptInput({
  search,
  categories,
  resources,
  onAdd,
  onPickExisting,
  busy,
  linkToNotebook,
}: {
  /** returns matches for the prefix */
  search: (prefix: string) => Concept[];
  categories: ConceptCategory[];
  resources?: { id: string; title: string }[];
  /** resolve with the created concept so it can be put in a notebook lesson */
  onAdd: (c: NewConcept) => Promise<Concept | void> | void;
  onPickExisting?: (c: Concept) => void;
  busy?: boolean;
  /** show "Put it in your notebook" (new or existing lesson) in the form */
  linkToNotebook?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lessonM = useLessonMutations();
  const [notebook, setNotebook] = useState<NotebookPick>(NO_NOTEBOOK);
  const listId = useId();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
  const [code, setCode] = useState('');
  const [output, setOutput] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [sourceRes, setSourceRes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const matches = name.trim() ? search(name.trim()) : [];
  const norm = (x: string) => x.toLowerCase().replace(/[-_\s]+/g, ' ').replace(/s\b/g, '').trim();
  const exact = matches.find((m) => norm(m.name) === norm(name));

  useEffect(() => {
    setActive(-1);
  }, [name]);

  const reset = () => {
    setName('');
    setNote('');
    setCode('');
    setOutput('');
    setCategory(null);
    setSource('');
    setSourceRes('');
    setExpanded(false);
    setError(null);
    setNotebook(NO_NOTEBOOK);
  };

  /** Link a just-saved concept to a new or existing lesson (shows on the Notebook shelf). */
  const putInNotebook = async (c: Concept) => {
    const pick = notebook;
    if (pick.mode === 'none' || (pick.mode === 'existing' && !pick.lesson)) return;
    try {
      const lesson =
        pick.mode === 'new'
          ? await lessonM.create.mutateAsync({
              title: c.name,
              course: pick.course.trim() || null,
              icon: '📘',
              color: 'teal',
              language_id: c.language_id,
              concept_ids: [c.id],
            })
          : await lessonM.update.mutateAsync({
              id: pick.lesson!.id,
              concept_ids: [...new Set([...pick.lesson!.concept_ids, c.id])],
            });
      toast.info(t('conceptNotebook.added', { name: c.name, lesson: lesson.title }), {
        label: t('conceptNotebook.openShort'),
        onClick: () => navigate(`/notebook/lessons/${lesson.id}`),
      });
    } catch {
      // the concept itself is saved; linking can be retried from its Notebook button
      toast.error(t('conceptNotebook.linkFailed', { name: c.name }));
    }
  };

  const begin = () => {
    const parsed = conceptNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (exact) {
      setError(t('errors.duplicateConcept', { name: exact.name }));
      return;
    }
    setError(null);
    setOpen(false);
    setExpanded(true);
  };

  const save = async () => {
    const created = await onAdd({
      name: name.trim(),
      note: note.trim() || null,
      example_code: code.trim() ? code : null,
      example_output: output.trim() ? output : null,
      category_id: category,
      source_resource_id: sourceRes || null,
      source_url: source.trim() || null,
    });
    if (linkToNotebook && created) await putInNotebook(created);
    reset();
  };

  const pick = (c: Concept) => {
    setOpen(false);
    onPickExisting?.(c);
    reset();
  };

  return (
    <div className="stack">
      <div className={s.conceptBox}>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (active >= 0 && matches[active]) pick(matches[active]);
            else if (expanded) void save();
            else begin();
          }}
        >
          <div style={{ flex: 1 }}>
            <TextField
              label={t('today.learnedTitle')}
              hideLabel
              placeholder={t('today.learnedPlaceholder')}
              value={name}
              maxLength={60}
              error={error}
              role="combobox"
              aria-expanded={open && matches.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setOpen(true);
                setError(null);
              }}
              onBlur={() => setTimeout(() => setOpen(false), 120)}
              onKeyDown={(e) => {
                if (!open || !matches.length) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((i) => Math.min(matches.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((i) => Math.max(-1, i - 1));
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          </div>
          {!expanded && (
            <Button type="submit" variant="primary" icon={<Plus size={16} />} disabled={!name.trim()}>
              {t('today.learnedAdd')}
            </Button>
          )}
        </form>
        {open && matches.length > 0 && !expanded && (
          <ul id={listId} role="listbox" className={s.suggest} aria-label={t('today.learnedTitle')}>
            {matches.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
              >
                <span>{t('today.useExisting', { name: m.name })}</span>
                {m.category_name && <span className="muted">{m.category_name}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {expanded && (
        <div className={s.expander}>
          <strong>{name.trim()}</strong>
          <TextArea
            label={t('today.noteLabel')}
            placeholder={t('today.notePlaceholder')}
            value={note}
            rows={2}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            style={{ minHeight: 64 }}
            autoFocus
          />
          <ExampleField
            name={name}
            code={code}
            output={output}
            onCodeChange={setCode}
            onOutputChange={setOutput}
          />
          <ChipGroup label={t('today.categoryLabel')}>
            {categories.map((c) => (
              <Chip key={c.id} pressed={category === c.id} onToggle={() => setCategory(category === c.id ? null : c.id)}>
                {c.name}
              </Chip>
            ))}
          </ChipGroup>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TextField
                label={t('today.sourceLabel')}
                placeholder={t('today.sourcePlaceholder')}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                disabled={!!sourceRes}
              />
            </div>
            {resources && resources.length > 0 && (
              <div style={{ flex: 1 }}>
                <Select
                  label={t('today.sourceFromLibrary')}
                  value={sourceRes}
                  onChange={(e) => setSourceRes(e.target.value)}
                  options={[{ value: '', label: '—' }, ...resources.map((r) => ({ value: r.id, label: r.title }))]}
                />
              </div>
            )}
          </div>
          {linkToNotebook && <NotebookChoice name={name.trim()} value={notebook} onChange={setNotebook} />}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={reset}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              loading={busy || lessonM.create.isPending || lessonM.update.isPending}
              disabled={notebook.mode === 'existing' && !notebook.lesson}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type NotebookPick =
  | { mode: 'none' }
  | { mode: 'new'; course: string }
  | { mode: 'existing'; lesson: LessonSummary | null };

const NO_NOTEBOOK: NotebookPick = { mode: 'none' };

/** "Put it in your notebook": not now / a new lesson named after it / a lesson you already have. */
function NotebookChoice({
  name,
  value,
  onChange,
}: {
  name: string;
  value: NotebookPick;
  onChange: (v: NotebookPick) => void;
}) {
  const { t } = useTranslation();
  const { data: lessons = [] } = useLessons();
  const sorted = useMemo(() => [...lessons].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [lessons]);
  const courses = useMemo(
    () => [...new Set(lessons.map((l) => l.course).filter((c): c is string => !!c))].sort(),
    [lessons],
  );
  const listId = useId();

  return (
    <div className="stack" style={{ gap: 8 }}>
      <ChipGroup label={t('conceptNotebook.pickLabel')}>
        <Chip pressed={value.mode === 'none'} onToggle={() => onChange(NO_NOTEBOOK)}>
          {t('conceptNotebook.pickNone')}
        </Chip>
        <Chip pressed={value.mode === 'new'} onToggle={() => onChange({ mode: 'new', course: '' })}>
          {t('conceptNotebook.pickNew')}
        </Chip>
        {lessons.length > 0 && (
          <Chip
            pressed={value.mode === 'existing'}
            onToggle={() => onChange({ mode: 'existing', lesson: sorted[0] ?? null })}
          >
            {t('conceptNotebook.pickExisting')}
          </Chip>
        )}
      </ChipGroup>
      {value.mode === 'new' && (
        <>
          <TextField
            label={t('lessons.course')}
            hint={t('conceptNotebook.newHint', { name })}
            placeholder={t('lessons.coursePlaceholder')}
            list={listId}
            value={value.course}
            maxLength={120}
            onChange={(e) => onChange({ mode: 'new', course: e.target.value })}
          />
          <datalist id={listId}>
            {courses.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </>
      )}
      {value.mode === 'existing' && (
        <Select
          label={t('conceptNotebook.pickLesson')}
          value={value.lesson?.id ?? ''}
          onChange={(e) =>
            onChange({ mode: 'existing', lesson: sorted.find((l) => l.id === e.target.value) ?? null })
          }
          options={sorted.map((l) => ({
            value: l.id,
            label: `${l.icon ?? '📘'} ${l.title}${l.course ? ` · ${l.course}` : ''}`,
          }))}
        />
      )}
    </div>
  );
}

export function ConceptList({ concepts, onEdit }: { concepts: Concept[]; onEdit?: (c: Concept) => void }) {
  const { t } = useTranslation();
  const [notebookFor, setNotebookFor] = useState<Concept | null>(null);
  if (!concepts.length) return <p className="muted">{t('today.noConcepts')}</p>;
  return (
    <>
      <ul className={s.list}>
        {concepts.map((c) => (
          <ConceptItem key={c.id} concept={c} onEdit={onEdit} onNotebook={() => setNotebookFor(c)} />
        ))}
      </ul>
      {notebookFor && <ConceptNotebookModal concept={notebookFor} onClose={() => setNotebookFor(null)} />}
    </>
  );
}

function ConceptItem({
  concept: c,
  onEdit,
  onNotebook,
}: {
  concept: Concept;
  onEdit?: (c: Concept) => void;
  onNotebook: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lessons = useConceptLessons(c.id);
  return (
    <li className={s.conceptItem}>
      <div className={s.conceptHead}>
        <button type="button" className={s.conceptName} onClick={onNotebook} title={t('conceptNotebook.open')}>
          {c.name}
        </button>
        {c.category_name && <span className={uiStyles.badge}>{c.category_name}</span>}
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={<BookOpenText size={14} />}
          onClick={onNotebook}
          title={t('conceptNotebook.open')}
        >
          {t('conceptNotebook.button')}
        </Button>
        {onEdit && (
          <Button size="sm" variant="ghost" onClick={() => onEdit(c)}>
            {t('common.edit')}
          </Button>
        )}
      </div>
      {lessons.length > 0 && (
        <div className={s.conceptLessons} aria-label={t('conceptNotebook.alreadyIn')}>
          {lessons.map((l) => (
            <button
              key={l.id}
              type="button"
              className={s.conceptLesson}
              onClick={() => navigate(`/notebook/lessons/${l.id}`)}
              title={t('conceptNotebook.openLesson', { title: l.title })}
            >
              <span aria-hidden>{l.icon ?? '📘'}</span>
              <span>{l.title}</span>
            </button>
          ))}
        </div>
      )}
      {c.note && (
        <p className={s.conceptNote}>
          <GlossaryText text={c.note} />
        </p>
      )}
      <ConceptExample concept={c} />
    </li>
  );
}

/** The saved worked example: code plus the output pasted from a compiler. */
export function ConceptExample({ concept, open }: { concept: Concept; open?: boolean }) {
  const { t } = useTranslation();
  if (!concept.example_code && !concept.example_output) return null;
  return (
    <details className={s.example} open={open}>
      <summary>{t('today.exampleToggle')}</summary>
      <div className="stack" style={{ gap: 6 }}>
        {concept.example_code && (
          <pre className={uiStyles.codeBlock} aria-label={t('today.codeLabel')}>
            <code>{concept.example_code}</code>
          </pre>
        )}
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          {t('today.outputLabel')}
        </span>
        <pre className={`${uiStyles.codeBlock} ${uiStyles.codeBlockOutput}`} aria-label={t('today.outputLabel')}>
          {concept.example_output ?? t('today.exampleNoOutput')}
        </pre>
      </div>
    </details>
  );
}
