import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import type { Concept, ConceptCategory } from '@/core/types/api';
import { Button, Chip, ChipGroup, Select, TextArea, TextField, uiStyles } from '@/components/ui';
import { conceptNameSchema } from '@/core/schemas';
import s from './domain.module.css';

export interface NewConcept {
  name: string;
  note: string | null;
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
}: {
  /** returns matches for the prefix */
  search: (prefix: string) => Concept[];
  categories: ConceptCategory[];
  resources?: { id: string; title: string }[];
  onAdd: (c: NewConcept) => Promise<unknown> | void;
  onPickExisting?: (c: Concept) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
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
    setCategory(null);
    setSource('');
    setSourceRes('');
    setExpanded(false);
    setError(null);
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
    await onAdd({
      name: name.trim(),
      note: note.trim() || null,
      category_id: category,
      source_resource_id: sourceRes || null,
      source_url: source.trim() || null,
    });
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
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={reset}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={busy}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConceptList({ concepts, onEdit }: { concepts: Concept[]; onEdit?: (c: Concept) => void }) {
  const { t } = useTranslation();
  if (!concepts.length) return <p className="muted">{t('today.noConcepts')}</p>;
  return (
    <ul className={s.list}>
      {concepts.map((c) => (
        <li key={c.id} className={s.conceptItem}>
          <div className="row">
            <strong>{c.name}</strong>
            {c.category_name && <span className={uiStyles.badge}>{c.category_name}</span>}
            <span className="spacer" />
            {onEdit && (
              <Button size="sm" variant="ghost" onClick={() => onEdit(c)}>
                {t('common.edit')}
              </Button>
            )}
          </div>
          {c.note && <p className={s.conceptNote}>{c.note}</p>}
        </li>
      ))}
    </ul>
  );
}
