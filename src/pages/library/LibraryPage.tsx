import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { File, FileImage, FileText, FolderOpen, LayoutGrid, Link2, List, NotebookPen, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Badge, Button, Chip, ChipGroup, EmptyState, IconButton, Modal, Select, Tabs, TextArea, TextField, toast } from '@/components/ui';
import { useAppState, useConcepts, useResourceMutations, useResources } from '@/data/queries';
import { fileSrc, onFileDrop, openUrl, pickFile } from '@/data/platform';
import { isTauri } from '@/data/client';
import { linkSchema } from '@/core/schemas';
import { formatDay } from '@/lib/format';
import type { Concept, Resource, ResourceKind } from '@/core/types/api';
import s from '../pages.module.css';

const KIND_ICON: Record<ResourceKind, typeof File> = { link: Link2, image: FileImage, pdf: FileText, note: NotebookPen, file: File };

export default function LibraryPage() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const [kind, setKind] = useState<ResourceKind | ''>('');
  const [concept, setConcept] = useState('');
  const [lang, setLang] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [hover, setHover] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [note, setNote] = useState<Resource | 'new' | null>(null);
  const [edit, setEdit] = useState<Resource | null>(null);
  const { data: resources = [] } = useResources({ kind: kind || null, concept_id: concept || null, language_id: lang || null, query: query || null });
  const { data: concepts = [] } = useConcepts(null, null);
  const m = useResourceMutations();

  const addPaths = (paths: string[]) => {
    for (const path of paths)
      m.addFile.mutate({ path, concept_ids: [] }, { onSuccess: () => toast.info(t('library.fileAdded')) });
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onFileDrop(addPaths, setHover).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openResource = (r: Resource) => {
    if (r.kind === 'link' && r.url) void openUrl(r.url);
    else if (r.kind === 'note') setNote(r);
    else m.open.mutate(r.id);
  };

  if (!app) return null;

  return (
    <div
      onDragOver={(e) => {
        if (!isTauri()) {
          e.preventDefault();
          setHover(true);
        }
      }}
      onDragLeave={() => !isTauri() && setHover(false)}
      onDrop={(e) => {
        if (isTauri()) return;
        e.preventDefault();
        setHover(false);
        addPaths(Array.from(e.dataTransfer.files).map((f) => f.name));
      }}
    >
      <PageHeader
        context={t('library.context')}
        title={t('library.title')}
        actions={
          <>
            <Button icon={<Link2 size={16} />} onClick={() => setLinkOpen(true)}>
              {t('library.addLink')}
            </Button>
            <Button
              icon={<Upload size={16} />}
              onClick={async () => {
                const paths = await pickFile({ title: t('library.addFile'), multiple: true });
                if (paths) addPaths(paths);
              }}
            >
              {t('library.addFile')}
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setNote('new')}>
              {t('library.newNote')}
            </Button>
            <Button variant="ghost" icon={<FolderOpen size={16} />} onClick={() => m.openFolder.mutate(undefined)}>
              {t('library.openFolder')}
            </Button>
          </>
        }
      />
      <div className={s.filterBar}>
        <TextField label={t('common.search')} type="search" placeholder={t('library.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select
          label={t('library.kind')}
          value={kind}
          onChange={(e) => setKind(e.target.value as ResourceKind | '')}
          options={[{ value: '', label: t('common.all') }, ...(['link', 'image', 'pdf', 'note', 'file'] as const).map((k) => ({ value: k, label: t(`library.kinds.${k}`) }))]}
        />
        <Select
          label={t('library.concepts')}
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          options={[{ value: '', label: t('common.all') }, ...concepts.map((c) => ({ value: c.id, label: c.name }))]}
        />
        <Select
          label={t('common.language')}
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          options={[{ value: '', label: t('common.allLanguages') }, ...app.languages.map((l) => ({ value: l.id, label: l.name }))]}
        />
        <span className="spacer" />
        <Tabs
          label={t('library.title')}
          value={view}
          onChange={setView}
          options={[
            { value: 'grid', label: t('library.grid') },
            { value: 'list', label: t('library.list') },
          ]}
        />
      </div>
      <p className="muted" style={{ marginBottom: 16, fontSize: '0.87rem' }}>
        {view === 'grid' ? <LayoutGrid size={14} aria-hidden="true" /> : <List size={14} aria-hidden="true" />} {t('library.dropHint')}
      </p>

      {resources.length === 0 ? (
        <EmptyState icon={<Upload size={22} />}>{t('library.empty')}</EmptyState>
      ) : (
        <ul className={view === 'grid' ? s.libGrid : s.libList} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {resources.map((r) => (
            <ResourceCard
              key={r.id}
              r={r}
              concepts={concepts}
              compact={view === 'list'}
              onOpen={() => openResource(r)}
              onEdit={() => (r.kind === 'note' ? setNote(r) : setEdit(r))}
              onDelete={() => m.remove.mutate(r.id)}
            />
          ))}
        </ul>
      )}

      {hover && (
        <div className={s.drop} aria-hidden="true">
          {t('library.dropHere')}
        </div>
      )}
      <LinkModal open={linkOpen} onClose={() => setLinkOpen(false)} concepts={concepts} />
      {note && <NoteModal resource={note === 'new' ? null : note} concepts={concepts} onClose={() => setNote(null)} />}
      {edit && <EditModal resource={edit} concepts={concepts} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ResourceCard({
  r,
  concepts,
  compact,
  onOpen,
  onEdit,
  onDelete,
}: {
  r: Resource;
  concepts: Concept[];
  compact: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const Icon = KIND_ICON[r.kind];
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (r.kind === 'image' && r.abs_path && isTauri()) void fileSrc(r.abs_path).then(setSrc);
  }, [r.kind, r.abs_path]);
  const names = r.concept_ids.map((id) => concepts.find((c) => c.id === id)?.name).filter(Boolean) as string[];
  return (
    <li className={s.resCard} style={compact ? { flexDirection: 'row', alignItems: 'center' } : undefined}>
      {!compact && src && <img src={src} alt="" className={s.resThumb} />}
      <div className="row" style={{ flex: compact ? 1 : undefined, minWidth: 0 }}>
        <Icon size={18} aria-label={t(`library.kinds.${r.kind}`)} color="var(--progress)" style={{ flex: 'none' }} />
        <button type="button" className={s.resTitle} onClick={onOpen}>
          {r.title}
        </button>
      </div>
      {!compact && r.kind === 'note' && r.body && (
        <p className="muted" style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
          {r.body.length > 140 ? `${r.body.slice(0, 139)}…` : r.body}
        </p>
      )}
      {names.length > 0 && (
        <div className="row-wrap">
          {names.map((n) => (
            <Badge key={n}>{n}</Badge>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: compact ? 0 : 'auto' }}>
        <span className="muted" style={{ fontSize: '0.8rem', flex: 1 }}>
          {t('library.added', { date: formatDay(r.created_at.slice(0, 10), { dateStyle: 'medium' }) })}
        </span>
        <IconButton aria-label={`${t('common.edit')} ${r.title}`} onClick={onEdit}>
          <Pencil size={15} />
        </IconButton>
        <IconButton aria-label={`${t('common.delete')} ${r.title}`} onClick={onDelete}>
          <Trash2 size={15} />
        </IconButton>
      </div>
    </li>
  );
}

function ConceptPicker({ concepts, value, onChange }: { concepts: Concept[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <ChipGroup label={t('library.concepts')}>
      {concepts.slice(0, 40).map((c) => {
        const on = value.includes(c.id);
        return (
          <Chip key={c.id} pressed={on} onToggle={() => onChange(on ? value.filter((x) => x !== c.id) : [...value, c.id])}>
            {c.name}
          </Chip>
        );
      })}
    </ChipGroup>
  );
}

function LinkModal({ open, onClose, concepts }: { open: boolean; onClose: () => void; concepts: Concept[] }) {
  const { t } = useTranslation();
  const m = useResourceMutations();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setUrl('');
    setTitle('');
    setIds([]);
    setError(null);
    onClose();
  };
  const save = () => {
    const parsed = linkSchema.safeParse({ url, title });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    m.addLink.mutate({ url: url.trim(), title: title.trim() || null, concept_ids: ids }, { onSuccess: close });
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('library.addLink')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} loading={m.addLink.isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField label={t('library.url')} placeholder="https://" value={url} error={error} onChange={(e) => setUrl(e.target.value)} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <TextField label={t('library.title_')} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <Button
          disabled={!/^https?:\/\//.test(url)}
          loading={m.fetchTitle.isPending}
          onClick={() => m.fetchTitle.mutate(url.trim(), { onSuccess: (v) => v && setTitle(v) })}
        >
          {t('library.fetchTitle')}
        </Button>
      </div>
      <ConceptPicker concepts={concepts} value={ids} onChange={setIds} />
    </Modal>
  );
}

function NoteModal({ resource, concepts, onClose }: { resource: Resource | null; concepts: Concept[]; onClose: () => void }) {
  const { t } = useTranslation();
  const m = useResourceMutations();
  const [title, setTitle] = useState(resource?.title ?? '');
  const [body, setBody] = useState(resource?.body ?? '');
  const [ids, setIds] = useState<string[]>(resource?.concept_ids ?? []);
  const save = () => {
    if (resource) m.update.mutate({ id: resource.id, title, body, concept_ids: ids }, { onSuccess: onClose });
    else m.addNote.mutate({ title, body, concept_ids: ids }, { onSuccess: onClose });
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={resource ? resource.title : t('library.newNote')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!title.trim()} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField label={t('library.noteTitle')} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <TextArea label={t('library.noteBody')} value={body} rows={10} onChange={(e) => setBody(e.target.value)} />
      <ConceptPicker concepts={concepts} value={ids} onChange={setIds} />
    </Modal>
  );
}

function EditModal({ resource, concepts, onClose }: { resource: Resource; concepts: Concept[]; onClose: () => void }) {
  const { t } = useTranslation();
  const m = useResourceMutations();
  const [title, setTitle] = useState(resource.title);
  const [ids, setIds] = useState<string[]>(resource.concept_ids);
  return (
    <Modal
      open
      onClose={onClose}
      title={resource.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!title.trim()} onClick={() => m.update.mutate({ id: resource.id, title, concept_ids: ids }, { onSuccess: onClose })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <TextField label={t('library.title_')} value={title} onChange={(e) => setTitle(e.target.value)} />
      <ConceptPicker concepts={concepts} value={ids} onChange={setIds} />
    </Modal>
  );
}
