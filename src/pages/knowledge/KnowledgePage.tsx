import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, Bug, Dumbbell, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import {
  Badge,
  Button,
  Card,
  Chip,
  ChipGroup,
  EmptyState,
  IconButton,
  Modal,
  Select,
  Tabs,
  TextArea,
  TextField,
  toast,
  uiStyles,
} from '@/components/ui';
import { ConceptEditModal } from '@/components/domain/ConceptEditModal';
import { ErrorNoteModal } from '@/components/domain/ErrorNoteModal';
import { GlossaryText } from '@/components/domain/GlossaryText';
import { RecallReview } from '@/components/domain/RecallReview';
import {
  useAppState,
  useConcepts,
  useErrorNoteMutations,
  useErrorNotes,
  useGlossary,
  useGlossaryMutations,
  useProblems,
  useReviewDue,
} from '@/data/queries';
import { daysBetween } from '@/lib/day';
import { formatShortDay } from '@/lib/format';
import type { Concept, ErrorNote, GlossaryTerm, ReviewItem } from '@/core/types/api';
import s from './knowledge.module.css';

type Tab = 'concepts' | 'errors' | 'glossary';
type Status = 'new' | 'due' | 'learning' | 'solid';

export function conceptStatus(c: Concept, today: string): Status {
  if (c.due_day_key && c.due_day_key <= today) return 'due';
  if (!c.review_stage) return 'new';
  return c.review_stage >= 3 ? 'solid' : 'learning';
}

function asReviewItem(c: Concept, today: string): ReviewItem {
  return {
    concept_id: c.id,
    concept_name: c.name,
    language_id: c.language_id,
    stage: c.review_stage ?? 0,
    due_day_key: c.due_day_key ?? today,
    last_result: null,
    learned_day_key: c.learned_day_key,
    days_since_learned: Math.max(0, daysBetween(c.learned_day_key, today)),
    negative_feelings: 0,
  };
}

export default function KnowledgePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { data: app } = useAppState();
  const { data: due = [] } = useReviewDue(20);
  const [recall, setRecall] = useState<ReviewItem[] | null>(null);
  const tab =
    (['concepts', 'errors', 'glossary'] as const).find((x) => x === params.get('tab')) ??
    'concepts';

  if (!app) return null;
  const setTab = (next: Tab) =>
    setParams(next === 'concepts' ? {} : { tab: next }, { replace: true });

  return (
    <>
      <PageHeader
        context={t('knowledge.context')}
        title={t('knowledge.title')}
        actions={
          <Button
            variant={due.length ? 'primary' : 'ghost'}
            icon={<RotateCcw size={16} />}
            disabled={!due.length}
            onClick={() => setRecall(due)}
          >
            {due.length ? t('knowledge.review', { count: due.length }) : t('recall.nothingDue')}
          </Button>
        }
      />
      <div className={s.tabs}>
        <Tabs
          label={t('knowledge.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'concepts', label: t('knowledge.tabs.concepts') },
            { value: 'errors', label: t('knowledge.tabs.errors') },
            { value: 'glossary', label: t('knowledge.tabs.glossary') },
          ]}
        />
      </div>
      {tab === 'concepts' && (
        <ConceptsTab
          today={app.today}
          languages={app.languages}
          onReview={(items) => setRecall(items)}
        />
      )}
      {tab === 'errors' && <ErrorsTab />}
      {tab === 'glossary' && <GlossaryTab />}
      {recall && <RecallReview items={recall} onClose={() => setRecall(null)} />}
    </>
  );
}

// ───────────────────────── Concepts ─────────────────────────

function ConceptsTab({
  today,
  languages,
  onReview,
}: {
  today: string;
  languages: { id: string; name: string; is_primary: boolean }[];
  onReview: (items: ReviewItem[]) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [lang, setLang] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const { data: concepts, isLoading } = useConcepts(null, lang || null);
  const openId = params.get('concept');
  const open = concepts?.find((c) => c.id === openId) ?? null;
  const setOpen = (c: Concept | null) =>
    setParams(
      (p) => {
        if (c) p.set('concept', c.id);
        else p.delete('concept');
        return p;
      },
      { replace: true },
    );

  const noCategory = t('knowledge.uncategorized');
  const categories = useMemo(
    () => [...new Set((concepts ?? []).map((c) => c.category_name ?? noCategory))].sort(),
    [concepts, noCategory],
  );
  // Due first (review is the next action), then newest; categories filter via chips.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (c: Concept) =>
      (!category || (c.category_name ?? noCategory) === category) &&
      (!q || [c.name, c.note, c.example_code].some((x) => x?.toLowerCase().includes(q)));
    const rank = (c: Concept) => (conceptStatus(c, today) === 'due' ? 0 : 1);
    return (concepts ?? []).filter(hit).sort((a, b) => rank(a) - rank(b));
  }, [concepts, query, category, noCategory, today]);

  if (isLoading || !concepts) return null;

  if (concepts.length === 0 && !lang) {
    return (
      <Card>
        <EmptyState
          icon={<BookOpen size={22} />}
          action={
            <Button variant="primary" onClick={() => navigate('/today')}>
              {t('knowledge.goToday')}
            </Button>
          }
        >
          {t('knowledge.emptyConcepts')}
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className={s.toolbar}>
        <div className={s.search}>
          <Search size={16} aria-hidden="true" className={s.searchIcon} />
          <TextField
            label={t('common.search')}
            hideLabel
            placeholder={t('knowledge.searchConcepts')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {languages.length > 1 && (
          <div style={{ minWidth: 170 }}>
            <Select
              label={t('common.language')}
              hideLabel
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              options={[
                { value: '', label: t('common.allLanguages') },
                ...languages.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          </div>
        )}
        <span className="muted" style={{ fontSize: '0.87rem' }}>
          {t('knowledge.count', { count: concepts.length })}
        </span>
      </div>
      {categories.length > 1 && (
        <ChipGroup label={t('knowledge.category')} hideLabel>
          <Chip pressed={!category} onToggle={() => setCategory(null)}>
            {t('common.all')}
          </Chip>
          {categories.map((c) => (
            <Chip
              key={c}
              pressed={category === c}
              onToggle={() => setCategory(category === c ? null : c)}
            >
              {c}
            </Chip>
          ))}
        </ChipGroup>
      )}
      {shown.length === 0 ? (
        <p className="muted">{t('knowledge.noMatch')}</p>
      ) : (
        <ul className={s.grid}>
          {shown.map((c) => (
            <li key={c.id}>
              <ConceptTile concept={c} today={today} onOpen={() => setOpen(c)} />
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ConceptDetail
          concept={open}
          today={today}
          onClose={() => setOpen(null)}
          onReview={() => {
            setOpen(null);
            onReview([asReviewItem(open, today)]);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const { t } = useTranslation();
  return (
    <Badge tone={status === 'due' ? 'feeling' : status === 'solid' ? 'progress' : 'muted'}>
      {t(`knowledge.status.${status}`)}
    </Badge>
  );
}

function ConceptTile({
  concept: c,
  today,
  onOpen,
}: {
  concept: Concept;
  today: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" className={s.tile} onClick={onOpen}>
      <span className={s.tileHead}>
        <strong className={s.tileName}>{c.name}</strong>
        <StatusBadge status={conceptStatus(c, today)} />
      </span>
      {c.note ? (
        <span className={s.tileNote}>{c.note}</span>
      ) : (
        <span className={`muted ${s.tileNote}`}>{t('knowledge.noNote')}</span>
      )}
      {c.example_code && <code className={s.tileCode}>{c.example_code.split('\n')[0]}</code>}
      <span className={s.tileFoot}>
        {c.category_name && <span className={s.tileCategory}>{c.category_name}</span>}
        {t('knowledge.learnedOn', { date: formatShortDay(c.learned_day_key) })}
      </span>
    </button>
  );
}

function ConceptDetail({
  concept: c,
  today,
  onClose,
  onReview,
}: {
  concept: Concept;
  today: string;
  onClose: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<'concept' | 'example' | null>(null);
  const { data: problems = [] } = useProblems({});
  const { data: errors = [] } = useErrorNotes();
  const used = problems.filter((p) => p.concept_ids.includes(c.id));
  const related = errors.filter((e) => e.concept_id === c.id);
  const status = conceptStatus(c, today);

  return (
    <>
      <Modal
        open={!editing}
        onClose={onClose}
        wide
        title={c.name}
        footer={
          <>
            <Button
              variant="ghost"
              icon={<Pencil size={16} />}
              onClick={() => setEditing('concept')}
              style={{ marginRight: 'auto' }}
            >
              {t('common.edit')}
            </Button>
            <Button
              icon={<Dumbbell size={16} />}
              onClick={() => navigate(`/practice?concept=${c.id}`)}
            >
              {t('knowledge.practice')}
            </Button>
            <Button variant="primary" icon={<RotateCcw size={16} />} onClick={onReview}>
              {t('knowledge.reviewNow')}
            </Button>
          </>
        }
      >
        <div className="row-wrap">
          <StatusBadge status={status} />
          {c.category_name && <Badge tone="muted">{c.category_name}</Badge>}
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {t('knowledge.learnedOn', { date: formatShortDay(c.learned_day_key) })}
            {c.due_day_key &&
              status !== 'due' &&
              ` · ${t('knowledge.nextReview', { date: formatShortDay(c.due_day_key) })}`}
          </span>
        </div>
        <section className="stack" style={{ gap: 6 }}>
          <h3 className={s.detailLabel}>{t('knowledge.note')}</h3>
          {c.note ? (
            <p className={s.detailNote}>
              <GlossaryText text={c.note} />
            </p>
          ) : (
            <p className="muted">{t('knowledge.noNote')}</p>
          )}
        </section>
        <section className="stack" style={{ gap: 6 }}>
          <h3 className={s.detailLabel}>{t('knowledge.example')}</h3>
          {c.example_code || c.example_output ? (
            <div className={s.example}>
              <pre className={uiStyles.codeBlock} aria-label={t('today.codeLabel')}>
                <code>{c.example_code ?? ''}</code>
              </pre>
              <pre
                className={`${uiStyles.codeBlock} ${uiStyles.codeBlockOutput}`}
                aria-label={t('today.outputLabel')}
              >
                {c.example_output ?? t('today.exampleNoOutput')}
              </pre>
            </div>
          ) : (
            <div className="row">
              <span className="muted">{t('knowledge.noExample')}</span>
              <Button size="sm" variant="ghost" onClick={() => setEditing('example')}>
                {t('knowledge.addExample')}
              </Button>
            </div>
          )}
        </section>
        {used.length > 0 && (
          <section className="stack" style={{ gap: 6 }}>
            <h3 className={s.detailLabel}>{t('knowledge.problems')}</h3>
            <ul className={s.plainList}>
              {used.map((p) => (
                <li key={p.id}>
                  {p.title} <span className="muted">· {t(`status.${p.status}`)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {related.length > 0 && (
          <section className="stack" style={{ gap: 6 }}>
            <h3 className={s.detailLabel}>{t('knowledge.errors')}</h3>
            <ul className={s.plainList}>
              {related.map((e) => (
                <li key={e.id}>
                  <code className="mono">{e.message.split('\n')[0]}</code>
                  {e.fix && <span className="muted"> · {e.fix}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </Modal>
      {editing && (
        <ConceptEditModal
          concept={c}
          openExample={editing === 'example'}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

// ───────────────────────── Errors ─────────────────────────

function ErrorsTab() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { data: notes, isLoading } = useErrorNotes();
  const { data: concepts = [] } = useConcepts(null, null);
  const m = useErrorNoteMutations();
  const [editing, setEditing] = useState<ErrorNote | 'new' | null>(null);
  const focus = params.get('focus');

  useEffect(() => {
    if (focus && notes?.length)
      document.getElementById(`error-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, notes]);

  if (isLoading || !notes) return null;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className={s.intro}>
        <p className="muted">{t('knowledge.errorsIntro')}</p>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
          {t('knowledge.logError')}
        </Button>
      </div>
      {notes.length === 0 ? (
        <Card>
          <EmptyState icon={<Bug size={22} />}>{t('knowledge.emptyErrors')}</EmptyState>
        </Card>
      ) : (
        <ul className={s.errorList}>
          {notes.map((e) => (
            <li
              key={e.id}
              id={`error-${e.id}`}
              className={[s.errorCard, focus === e.id && s.focused].filter(Boolean).join(' ')}
            >
              <div className={s.errorHead}>
                <code className={s.errorMsg}>{e.message}</code>
                <Badge tone={e.hits > 1 ? 'feeling' : 'muted'}>
                  {t('knowledge.hits', { count: e.hits })}
                </Badge>
              </div>
              <dl className={s.errorBody}>
                {e.cause && (
                  <>
                    <dt>{t('knowledge.cause')}</dt>
                    <dd>{e.cause}</dd>
                  </>
                )}
                <dt>{t('knowledge.fix')}</dt>
                <dd className={e.fix ? undefined : 'muted'}>{e.fix ?? t('knowledge.noFix')}</dd>
              </dl>
              <div className="row">
                {e.concept_name && <Chip>{e.concept_name}</Chip>}
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  {formatShortDay(e.day_key)}
                </span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={() => m.hit.mutate(e.id)}>
                  {t('knowledge.sameAgain')}
                </Button>
                <IconButton aria-label={t('common.edit')} onClick={() => setEditing(e)}>
                  <Pencil size={16} />
                </IconButton>
                <IconButton
                  aria-label={t('common.delete')}
                  onClick={() =>
                    m.remove.mutate(e.id, { onSuccess: () => toast.info(t('knowledge.deleted')) })
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ErrorNoteModal
          initial={editing === 'new' ? null : editing}
          concepts={concepts}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

// ───────────────────────── Glossary ─────────────────────────

function GlossaryTab() {
  const { t } = useTranslation();
  const { data: terms, isLoading } = useGlossary();
  const m = useGlossaryMutations();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<GlossaryTerm | 'new' | null>(null);
  if (isLoading || !terms) return null;
  const q = query.trim().toLowerCase();
  const shown = terms.filter(
    (g) => !q || g.term.toLowerCase().includes(q) || g.definition.toLowerCase().includes(q),
  );
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className={s.intro}>
        <p className="muted">{t('knowledge.glossaryIntro')}</p>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
          {t('knowledge.addTerm')}
        </Button>
      </div>
      <div className={s.search} style={{ maxWidth: 360 }}>
        <Search size={16} aria-hidden="true" className={s.searchIcon} />
        <TextField
          label={t('common.search')}
          hideLabel
          placeholder={t('knowledge.searchGlossary')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="muted">{t('knowledge.emptyGlossary')}</p>
      ) : (
        <dl className={s.glossary}>
          {shown.map((g) => (
            <div key={g.id} className={s.glossaryRow}>
              <dt>
                {g.term}
                {g.is_builtin && (
                  <span className="muted" style={{ fontSize: '0.75rem', fontWeight: 400 }}>
                    {' '}
                    · {t('knowledge.builtin')}
                  </span>
                )}
              </dt>
              <dd>{g.definition}</dd>
              <dd className={s.glossaryActions}>
                <IconButton
                  aria-label={`${t('common.edit')} ${g.term}`}
                  onClick={() => setEditing(g)}
                >
                  <Pencil size={16} />
                </IconButton>
                <IconButton
                  aria-label={`${t('common.delete')} ${g.term}`}
                  onClick={() => m.remove.mutate(g.id)}
                >
                  <Trash2 size={16} />
                </IconButton>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {editing && (
        <GlossaryModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function GlossaryModal({
  initial,
  onClose,
}: {
  initial: GlossaryTerm | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = useGlossaryMutations();
  const [term, setTerm] = useState(initial?.term ?? '');
  const [definition, setDefinition] = useState(initial?.definition ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!term.trim() || !definition.trim()) {
      setError(t('errors.required'));
      return;
    }
    m.save.mutate(
      { id: initial?.id ?? null, term, definition, language_id: initial?.language_id ?? null },
      {
        onSuccess: () => {
          toast.info(t('glossaryTerm.saved'));
          onClose();
        },
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t('glossaryTerm.titleEdit') : t('glossaryTerm.titleNew')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={m.save.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField
        label={t('glossaryTerm.term')}
        value={term}
        maxLength={60}
        error={!term.trim() ? error : null}
        onChange={(e) => setTerm(e.target.value)}
      />
      <TextArea
        label={t('glossaryTerm.definition')}
        value={definition}
        rows={3}
        maxLength={1000}
        error={!definition.trim() ? error : null}
        onChange={(e) => setDefinition(e.target.value)}
      />
    </Modal>
  );
}
