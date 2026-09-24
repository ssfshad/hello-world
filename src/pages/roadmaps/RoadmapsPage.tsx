import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, GripVertical, Link as LinkIcon, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Badge, Button, Card, Chip, ChipGroup, EmptyState, IconButton, Modal, ProgressBar, TextField, toast } from '@/components/ui';
import { useConcepts, useRoadmap, useRoadmapMutations, useRoadmaps } from '@/data/queries';
import { pickFile, pickSavePath } from '@/data/platform';
import type { NodeStatus, RoadmapDetail, RoadmapNode } from '@/core/types/api';
import s from '../pages.module.css';

const NEXT: Record<NodeStatus, NodeStatus> = { not_started: 'learning', learning: 'done', done: 'not_started' };

export interface TreeNode extends RoadmapNode {
  children: TreeNode[];
}

export function buildTree(nodes: RoadmapNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    const parent = n.parent_id ? map.get(n.parent_id) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (xs: TreeNode[]) => {
    xs.sort((a, b) => a.position - b.position);
    xs.forEach((x) => sort(x.children));
  };
  sort(roots);
  return roots;
}

export default function RoadmapsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams();
  const { data: roadmaps = [] } = useRoadmaps();
  const m = useRoadmapMutations();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const current = id ?? roadmaps[0]?.id ?? null;

  return (
    <>
      <PageHeader
        context={t('roadmaps.context')}
        title={t('roadmaps.title')}
        actions={
          <>
            <Button
              icon={<Upload size={16} />}
              onClick={async () => {
                const paths = await pickFile({ title: t('roadmaps.import'), extensions: [{ name: 'JSON', extensions: ['json'] }] });
                if (paths?.[0]) m.importJson.mutate(paths[0], { onSuccess: (r) => navigate(`/roadmaps/${r.id}`) });
              }}
            >
              {t('roadmaps.import')}
            </Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              {t('roadmaps.new')}
            </Button>
          </>
        }
      />
      <p className="muted" style={{ marginTop: -20, marginBottom: 20, fontSize: '0.85rem' }}>
        {t('roadmaps.importHint')}
      </p>
      {roadmaps.length === 0 ? (
        <EmptyState>{t('roadmaps.empty')}</EmptyState>
      ) : (
        <div className={s.roadmaps}>
          <nav aria-label={t('roadmaps.pick')}>
            <ul className={s.rmList}>
              {roadmaps.map((r) => (
                <li key={r.id}>
                  <button type="button" className={s.rmItem} aria-current={r.id === current} onClick={() => navigate(`/roadmaps/${r.id}`)}>
                    <strong>{r.title}</strong>
                    <ProgressBar value={r.done_count} max={Math.max(1, r.node_count)} label={t('roadmaps.progress', { done: r.done_count, total: r.node_count })} />
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      {t('roadmaps.progress', { done: r.done_count, total: r.node_count })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {current && <RoadmapView id={current} />}
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={t('roadmaps.new')}
        footer={
          <Button
            variant="primary"
            disabled={!title.trim()}
            onClick={() =>
              m.create.mutate(title.trim(), {
                onSuccess: (r) => {
                  setCreating(false);
                  setTitle('');
                  navigate(`/roadmaps/${r.id}`);
                },
              })
            }
          >
            {t('common.save')}
          </Button>
        }
      >
        <TextField label={t('roadmaps.newTitle')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Modal>
    </>
  );
}

function RoadmapView({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useRoadmap(id);
  const m = useRoadmapMutations();
  const [adding, setAdding] = useState<{ parent: string | null } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [renaming, setRenaming] = useState<RoadmapNode | 'roadmap' | null>(null);
  const [renameText, setRenameText] = useState('');
  const [linking, setLinking] = useState<RoadmapNode | null>(null);
  const tree = useMemo(() => buildTree(data?.nodes ?? []), [data?.nodes]);
  if (!data) return null;

  const submitAdd = () => {
    if (!newTitle.trim() || !adding) return;
    m.upsertNode.mutate({ roadmap_id: id, parent_id: adding.parent, title: newTitle.trim() }, { onSuccess: () => setNewTitle('') });
  };

  return (
    <Card
      headline={data.roadmap.title}
      actions={
        <div className="row">
          <IconButton
            aria-label={t('roadmaps.rename')}
            onClick={() => {
              setRenaming('roadmap');
              setRenameText(data.roadmap.title);
            }}
          >
            <Pencil size={16} />
          </IconButton>
          <Button
            size="sm"
            icon={<Download size={14} />}
            onClick={async () => {
              const path = await pickSavePath({ title: t('roadmaps.export'), defaultPath: `${data.roadmap.title}.roadmap.v1.json`, extensions: [{ name: 'JSON', extensions: ['json'] }] });
              if (path) m.exportJson.mutate({ id, path }, { onSuccess: () => toast.info(path) });
            }}
          >
            {t('roadmaps.export')}
          </Button>
          <IconButton
            aria-label={t('common.delete')}
            onClick={() => {
              if (window.confirm(t('roadmaps.deleteConfirm'))) m.remove.mutate(id, { onSuccess: () => navigate('/roadmaps') });
            }}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="row">
          <Badge tone="muted">{t('roadmaps.progress', { done: data.roadmap.done_count, total: data.roadmap.node_count })}</Badge>
          {data.roadmap.source_ref && <span className="muted" style={{ fontSize: '0.8rem' }}>{t('roadmaps.attribution', { ref: data.roadmap.source_ref })}</span>}
        </div>
        <Tree
          nodes={tree}
          detail={data}
          onStatus={(n) => m.setStatus.mutate({ id: n.id, status: NEXT[n.status] })}
          onAddChild={(n) => setAdding({ parent: n.id })}
          onRename={(n) => {
            setRenaming(n);
            setRenameText(n.title);
          }}
          onDelete={(n) => m.deleteNode.mutate(n.id)}
          onLink={setLinking}
          onMove={(nid, parent, position) => m.moveNode.mutate({ id: nid, parent_id: parent, position })}
        />
        <div>
          <Button icon={<Plus size={16} />} onClick={() => setAdding({ parent: null })}>
            {t('roadmaps.addNode')}
          </Button>
        </div>
      </div>

      <Modal
        open={!!adding}
        onClose={() => setAdding(null)}
        title={adding?.parent ? t('roadmaps.addChild', { title: data.nodes.find((n) => n.id === adding.parent)?.title ?? '' }) : t('roadmaps.addNode')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(null)}>
              {t('common.done')}
            </Button>
            <Button variant="primary" disabled={!newTitle.trim()} onClick={submitAdd}>
              {t('common.add')}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitAdd();
          }}
        >
          <TextField label={t('roadmaps.nodeTitle')} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={120} />
        </form>
      </Modal>

      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={t('roadmaps.rename')}
        footer={
          <Button
            variant="primary"
            disabled={!renameText.trim()}
            onClick={() => {
              if (renaming === 'roadmap') m.update.mutate({ id, title: renameText.trim() });
              else if (renaming) m.upsertNode.mutate({ id: renaming.id, roadmap_id: id, parent_id: renaming.parent_id, title: renameText.trim(), concept_ids: renaming.concept_ids });
              setRenaming(null);
            }}
          >
            {t('common.save')}
          </Button>
        }
      >
        <TextField label={t('roadmaps.nodeTitle')} value={renameText} onChange={(e) => setRenameText(e.target.value)} maxLength={120} />
      </Modal>

      {linking && <LinkConceptsModal node={linking} roadmapId={id} onClose={() => setLinking(null)} />}
    </Card>
  );
}

function LinkConceptsModal({ node, roadmapId, onClose }: { node: RoadmapNode; roadmapId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: concepts = [] } = useConcepts(null, null);
  const m = useRoadmapMutations();
  const [ids, setIds] = useState(node.concept_ids);
  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('roadmaps.linkConcepts')}: ${node.title}`}
      footer={
        <Button
          variant="primary"
          onClick={() => {
            m.upsertNode.mutate({ id: node.id, roadmap_id: roadmapId, parent_id: node.parent_id, title: node.title, concept_ids: ids });
            onClose();
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <p className="muted">{t('roadmaps.linkHint')}</p>
      <ChipGroup label={t('roadmaps.linkConcepts')} hideLabel>
        {concepts.map((c) => {
          const on = ids.includes(c.id);
          return (
            <Chip key={c.id} pressed={on} onToggle={() => setIds(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])}>
              {c.name}
            </Chip>
          );
        })}
      </ChipGroup>
    </Modal>
  );
}

interface TreeActions {
  detail: RoadmapDetail;
  onStatus: (n: TreeNode) => void;
  onAddChild: (n: TreeNode) => void;
  onRename: (n: TreeNode) => void;
  onDelete: (n: TreeNode) => void;
  onLink: (n: TreeNode) => void;
  onMove: (id: string, parent: string | null, position: number) => void;
}

function Tree({ nodes, ...actions }: { nodes: TreeNode[] } & TreeActions) {
  const dragId = useRef<string | null>(null);
  const focusId = useRef<string | null>(null);
  const onMove: TreeActions['onMove'] = (id, parent, position) => {
    focusId.current = id;
    actions.onMove(id, parent, position);
  };
  return (
    <ul className={s.tree} role="tree">
      {nodes.map((n, i) => (
        <NodeItem key={n.id} node={n} siblings={nodes} index={i} dragId={dragId} focusId={focusId} {...actions} onMove={onMove} />
      ))}
    </ul>
  );
}

function NodeItem({
  node,
  siblings,
  index,
  dragId,
  focusId,
  ...a
}: {
  node: TreeNode;
  siblings: TreeNode[];
  index: number;
  dragId: React.MutableRefObject<string | null>;
  focusId: React.MutableRefObject<string | null>;
} & TreeActions) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const handleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusId.current === node.id) {
      handleRef.current?.focus();
      focusId.current = null;
    }
  });
  const [over, setOver] = useState(false);
  const parentOf = (id: string | null) => (id ? a.detail.nodes.find((x) => x.id === id) ?? null : null);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      a.onMove(node.id, node.parent_id, index - 1);
    } else if (e.key === 'ArrowDown' && index < siblings.length - 1) {
      e.preventDefault();
      a.onMove(node.id, node.parent_id, index + 1);
    } else if (e.key === 'ArrowRight' && index > 0) {
      e.preventDefault();
      const prev = siblings[index - 1];
      a.onMove(node.id, prev.id, prev.children.length);
    } else if (e.key === 'ArrowLeft' && node.parent_id) {
      e.preventDefault();
      const parent = parentOf(node.parent_id);
      const grand = parent?.parent_id ?? null;
      a.onMove(node.id, grand, (parent?.position ?? 0) + 1);
    }
  };

  return (
    <li role="treeitem" aria-expanded={node.children.length ? open : undefined} aria-label={`${node.title}, ${t(`roadmaps.status.${node.status}`)}`}>
      <div
        className={[s.node, over && s.dropTarget].filter(Boolean).join(' ')}
        onDragOver={(e) => {
          if (dragId.current && dragId.current !== node.id) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const src = dragId.current;
          dragId.current = null;
          if (src && src !== node.id) a.onMove(src, node.parent_id, index);
        }}
      >
        <button
          ref={handleRef}
          type="button"
          className={`${s.handle} ${s.statusBtn}`}
          style={{ border: 0, background: 'none', padding: 4 }}
          draggable
          onDragStart={() => {
            dragId.current = node.id;
          }}
          onKeyDown={onKey}
          aria-label={t('roadmaps.dragHandle', { title: node.title })}
        >
          <GripVertical size={16} />
        </button>
        {node.children.length > 0 ? (
          <IconButton aria-label={open ? t('roadmaps.collapseNode', { title: node.title }) : t('roadmaps.expandNode', { title: node.title })} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </IconButton>
        ) : (
          <span style={{ width: 32 }} />
        )}
        <span className={s.nodeTitle}>
          {node.title}
          {node.concept_ids.length > 0 && (
            <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 8 }}>
              <LinkIcon size={12} aria-hidden="true" /> {node.concept_ids.length}
            </span>
          )}
        </span>
        <button type="button" className={`${s.statusBtn} ${s[`status_${node.status}`]}`} onClick={() => a.onStatus(node)} aria-label={`${node.title}: ${t(`roadmaps.status.${node.status}`)}`}>
          {t(`roadmaps.status.${node.status}`)}
        </button>
        <IconButton aria-label={t('roadmaps.addChild', { title: node.title })} onClick={() => a.onAddChild(node)}>
          <Plus size={15} />
        </IconButton>
        <IconButton aria-label={`${t('roadmaps.linkConcepts')}: ${node.title}`} onClick={() => a.onLink(node)}>
          <LinkIcon size={15} />
        </IconButton>
        <IconButton aria-label={`${t('roadmaps.rename')} ${node.title}`} onClick={() => a.onRename(node)}>
          <Pencil size={15} />
        </IconButton>
        <IconButton aria-label={`${t('common.delete')} ${node.title}`} onClick={() => a.onDelete(node)}>
          <Trash2 size={15} />
        </IconButton>
      </div>
      {open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((c, i) => (
            <NodeItem key={c.id} node={c} siblings={node.children} index={i} dragId={dragId} focusId={focusId} {...a} />
          ))}
        </ul>
      )}
    </li>
  );
}
