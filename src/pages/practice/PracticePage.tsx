import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardPaste, Copy, Flag, Info, Play, Sparkles } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import {
  Badge,
  Button,
  Card,
  Chip,
  ChipGroup,
  DifficultyPicker,
  EmptyState,
  Select,
  TextField,
  Tooltip,
  toast,
} from '@/components/ui';
import { PasteResponseModal } from '@/components/domain/PasteResponseModal';
import { ReportButtons } from '@/components/domain/ReportButtons';
import { useProblemDetail } from '@/components/domain/useProblemDetail';
import {
  useAppState,
  useBuiltPrompt,
  useConcepts,
  usePracticeActions,
  useProblemMutations,
  useProblems,
  useProviders,
  useReliability,
  useTimerActions,
} from '@/data/queries';
import { call } from '@/data/client';
import { copyText } from '@/data/platform';
import { addDays } from '@/lib/day';
import type { Concept, GenerateResult, PracticeConfig, ProblemStyle } from '@/core/types/api';
import { useUiStore, type PracticeSettings } from '@/stores/uiStore';
import s from '../pages.module.css';
import d from '@/components/domain/domain.module.css';

type RangeKind = PracticeSettings['range'];
type QueueStatus = '' | 'queued' | 'in_progress' | 'revisit';

/** Concepts without a category are grouped under this key. */
const NO_CATEGORY = '__none';
const catOf = (c: Concept) => c.category_name ?? NO_CATEGORY;

export default function PracticePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: app } = useAppState();
  const today = app?.today ?? '';
  const preselect = params.get('concept');

  // The setup is remembered between visits.
  const settings = useUiStore((st) => st.practiceSettings);
  const setSettings = useUiStore((st) => st.setPracticeSettings);
  const { difficulty, count, style, mode, struggles } = settings;
  /** Opened from "Practice" on a review item: list every concept so it can be preselected. */
  const [rangeOverride, setRangeOverride] = useState<RangeKind | null>(preselect ? 'all' : null);
  const rangeKind = rangeOverride ?? settings.range;
  const allTime = rangeKind === 'all';
  const customTo = settings.customTo && settings.customTo <= today ? settings.customTo : today;
  const customFrom =
    settings.customFrom && settings.customFrom <= customTo
      ? settings.customFrom
      : addDays(customTo || '2026-01-01', -29);
  const [langId, setLangId] = useState<string>('');
  const [selected, setSelected] = useState<string[] | null>(preselect ? [preselect] : null);
  const [category, setCategory] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>('');
  const [queueLevel, setQueueLevel] = useState('');

  // "Mini project" links from elsewhere pick that style.
  const styleParam = params.get('style');
  useEffect(() => {
    if (styleParam === 'project') setSettings({ style: 'project' });
  }, [styleParam, setSettings]);

  const primary = app?.languages.find((l) => l.is_primary) ?? app?.languages[0];
  const language = langId || primary?.id || '';

  const range = useMemo(() => {
    if (rangeKind === 'today') return { from: today, to: today };
    if (rangeKind === '3') return { from: addDays(today, -2), to: today };
    if (rangeKind === 'custom') return { from: customFrom, to: customTo };
    // "All time" still needs a range for the report buttons; the concept list ignores it.
    return { from: addDays(today, -6), to: today };
  }, [rangeKind, today, customFrom, customTo]);

  const pickRange = (k: RangeKind) => {
    setRangeOverride(null);
    setSettings({ range: k });
    setSelected(null);
    setCategory('');
  };

  const { data: rangeConcepts = [] } = useConcepts(allTime ? null : range, language || null);
  const { data: providers = [] } = useProviders();
  const { data: queue = [] } = useProblems({ origin: 'generated', status: ['queued', 'in_progress', 'revisit'], include_flagged: true });
  const { data: reliability = [] } = useReliability();
  const practice = usePracticeActions();
  const problemM = useProblemMutations();
  const timer = useTimerActions();
  const detail = useProblemDetail({ goToTodayOnStart: true });

  // All concepts in range are preselected; the user can toggle.
  useEffect(() => {
    if (selected === null && rangeConcepts.length) setSelected(rangeConcepts.map((c) => c.id));
  }, [rangeConcepts, selected]);

  // Concepts grouped by category; the category filter narrows what's sent too.
  const categories = useMemo(
    () =>
      [...new Set(rangeConcepts.map(catOf))].sort((a, b) =>
        a === NO_CATEGORY ? 1 : b === NO_CATEGORY ? -1 : a.localeCompare(b),
      ),
    [rangeConcepts],
  );
  const catLabel = (c: string) => (c === NO_CATEGORY ? t('practice.noCategory') : c);
  const visible = category ? rangeConcepts.filter((c) => catOf(c) === category) : rangeConcepts;
  const conceptIds = (selected ?? []).filter((id) => visible.some((c) => c.id === id));
  const setAll = (on: boolean) => {
    const ids = new Set(visible.map((c) => c.id));
    const rest = (selected ?? []).filter((id) => !ids.has(id));
    setSelected(on ? [...rest, ...ids] : rest);
  };

  const filteredQueue = queue.filter(
    (p) => (!queueStatus || p.status === queueStatus) && (!queueLevel || String(p.difficulty) === queueLevel),
  );
  const next = filteredQueue.find((p) => p.status !== 'in_progress') ?? filteredQueue[0];

  const defaultProvider = providers.find((p) => p.is_default) ?? providers[0];
  const config: PracticeConfig | null = language
    ? {
        language_id: language,
        concept_ids: conceptIds,
        difficulty,
        count,
        style,
        include_struggles: struggles,
        provider_id: mode === 'api' ? (defaultProvider?.id ?? null) : null,
      }
    : null;
  const { data: built, isFetching: building } = useBuiltPrompt(config);

  if (!app) return null;

  const generate = () => {
    if (!config) return;
    practice.generate.mutate(config, { onSuccess: (r) => setGenerated(r) });
  };

  const importRaw = async (raw: string, m: 'copy_prompt' | 'api', provider?: string, model?: string) => {
    if (!config) return;
    const res = await practice.importResponse.mutateAsync({ config, raw_text: raw, mode: m, provider: provider ?? null, model: model ?? null });
    toast.info(t('practice.added', { count: res.problems.length }));
  };

  return (
    <>
      <PageHeader context={t('practice.context')} title={t('practice.title')} />
      <div className={s.practice}>
        <Card>
          <div className="stack" style={{ gap: 20 }}>
            {app.languages.length > 1 && (
              <Select
                label={t('common.language')}
                value={language}
                onChange={(e) => {
                  setLangId(e.target.value);
                  setSelected(null);
                }}
                options={app.languages.map((l) => ({ value: l.id, label: l.name }))}
              />
            )}
            <ChipGroup label={t('practice.conceptsFrom')}>
              {(
                [
                  ['today', t('practice.today')],
                  ['3', t('practice.last3')],
                  ['7', t('practice.last7')],
                  ['all', t('practice.allTime')],
                  ['custom', t('practice.custom')],
                ] as [RangeKind, string][]
              ).map(([k, label]) => (
                <Chip key={k} pressed={rangeKind === k} onToggle={() => pickRange(k)}>
                  {label}
                </Chip>
              ))}
            </ChipGroup>
            {rangeKind === 'custom' && (
              <div className="row">
                <TextField label={t('practice.from')} type="date" value={customFrom} max={customTo} onChange={(e) => { setSettings({ customFrom: e.target.value }); setSelected(null); }} />
                <TextField label={t('practice.to')} type="date" value={customTo} min={customFrom} max={today} onChange={(e) => { setSettings({ customTo: e.target.value }); setSelected(null); }} />
              </div>
            )}
            {rangeConcepts.length === 0 ? (
              <div className={s.practiceEmpty} role="status">
                <p className="muted" style={{ margin: 0 }}>
                  {allTime ? t('practice.noConceptsAtAll') : t('practice.noConceptsInRange')}
                </p>
                <div className="row-wrap">
                  {!allTime && (
                    <Button size="sm" variant="primary" onClick={() => pickRange('all')}>
                      {t('practice.tryAllTime')}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => navigate('/today')}>
                    {t('practice.logOnToday')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row-wrap" style={{ alignItems: 'flex-end' }}>
                  {categories.length > 1 && (
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <Select
                        label={t('practice.category')}
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        options={[
                          { value: '', label: t('practice.allCategories') },
                          ...categories.map((c) => ({ value: c, label: catLabel(c) })),
                        ]}
                      />
                    </div>
                  )}
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => setAll(true)} disabled={conceptIds.length === visible.length}>
                    {t('practice.selectAll')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAll(false)} disabled={conceptIds.length === 0}>
                    {t('practice.selectNone')}
                  </Button>
                </div>
                {(category ? [category] : categories).map((cat) => {
                  const items = visible.filter((c) => catOf(c) === cat);
                  if (!items.length) return null;
                  return (
                    <ChipGroup key={cat} label={catLabel(cat)} hideLabel={categories.length < 2}>
                      {items.map((c) => {
                        const on = conceptIds.includes(c.id);
                        return (
                          <Chip key={c.id} pressed={on} onToggle={() => setSelected(on ? (selected ?? []).filter((x) => x !== c.id) : [...(selected ?? []), c.id])}>
                            {c.name}
                          </Chip>
                        );
                      })}
                    </ChipGroup>
                  );
                })}
                <small className="muted">{t('practice.selectedCount', { count: conceptIds.length, total: visible.length })}</small>
              </div>
            )}

            <DifficultyPicker
              value={difficulty}
              onChange={(v) => setSettings({ difficulty: v })}
              label={t('practice.difficulty')}
              labelExtra={
                <Tooltip
                  content={[1, 2, 3, 4, 5].map((n) => (
                    <div key={n}>
                      <strong>{n}</strong> {t(`difficulty.def${n}`)}
                    </div>
                  ))}
                >
                  <Info size={15} tabIndex={0} aria-label={t('practice.difficultyHelp')} color="var(--muted)" />
                </Tooltip>
              }
            />

            <div className="row">
              <div style={{ width: 110 }}>
                <Select
                  label={t('practice.howMany')}
                  value={String(count)}
                  onChange={(e) => setSettings({ count: Number(e.target.value) })}
                  options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label={t('practice.style')}
                  value={style}
                  onChange={(e) => setSettings({ style: e.target.value as ProblemStyle })}
                  options={(['beginner', 'story', 'cf', 'project'] as const).map((v) => ({ value: v, label: t(`practice.styles.${v}`) }))}
                />
              </div>
            </div>

            <div className="stack" style={{ gap: 6 }}>
              <span id="gen-with" style={{ fontSize: '0.87rem', fontWeight: 600, color: 'var(--ink-soft)' }}>
                {t('practice.generateWith')}
              </span>
              <div role="radiogroup" aria-labelledby="gen-with" className={s.modeCard}>
                {(
                  [
                    ['copy_prompt', t('practice.copyMode'), t('practice.copyModeHint')],
                    ['api', t('practice.apiMode'), defaultProvider ? `${defaultProvider.label} · ${defaultProvider.model}` : t('practice.apiModeHint')],
                  ] as const
                ).map(([v, label, hint]) => (
                  <button key={v} type="button" role="radio" aria-checked={mode === v} className={s.modeBtn} onClick={() => setSettings({ mode: v })}>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
              {mode === 'api' && !defaultProvider && (
                <p className="muted" style={{ fontSize: '0.85rem' }}>
                  {t('practice.noProvider')}{' '}
                  <Button size="sm" variant="ghost" onClick={() => navigate('/settings#ai')}>
                    {t('nav.settings')}
                  </Button>
                </p>
              )}
            </div>

            <label className="row" style={{ alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={struggles} onChange={(e) => setSettings({ struggles: e.target.checked })} style={{ width: 18, height: 18, marginTop: 3, accentColor: 'var(--progress)' }} />
              <span>
                {t('practice.struggles')}
                <br />
                <small className="muted">{t('practice.strugglesHint')}</small>
              </span>
            </label>
          </div>
        </Card>

        <div className="stack" style={{ gap: 20 }}>
          <Card
            title={t('practice.promptPreview')}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                {expanded ? t('practice.collapse') : t('practice.expand')}
              </Button>
            }
          >
            <div className="stack">
              {mode === 'api' && <p className="muted" style={{ fontSize: '0.85rem' }}>{t('practice.showPrompt')}</p>}
              {conceptIds.length ? (
                <pre className={[s.prompt, expanded && s.promptOpen].filter(Boolean).join(' ')} aria-busy={building} tabIndex={0}>
                  {built?.prompt ?? t('app.loading')}
                </pre>
              ) : (
                <EmptyState icon={<Sparkles size={22} />}>{t('practice.pickConceptsFirst')}</EmptyState>
              )}
              <div className="row-wrap">
                {mode === 'copy_prompt' ? (
                  <>
                    <Button
                      variant="primary"
                      icon={<Copy size={16} />}
                      disabled={!built}
                      onClick={async () => {
                        if (!built) return;
                        await copyText(built.prompt);
                        toast.info(t('practice.promptCopied'));
                      }}
                    >
                      {t('practice.copyPrompt')}
                    </Button>
                    <Button icon={<ClipboardPaste size={16} />} disabled={!config || !conceptIds.length} onClick={() => setPasteOpen(true)}>
                      {t('practice.pasteResponse')}
                    </Button>
                  </>
                ) : practice.generate.isPending ? (
                  <>
                    <Button variant="primary" loading>
                      {t('practice.generating')}
                    </Button>
                    <Button onClick={() => practice.cancel.mutate(undefined)}>{t('practice.cancel')}</Button>
                  </>
                ) : (
                  <Button variant="primary" icon={<Sparkles size={16} />} disabled={!built || !defaultProvider} onClick={generate}>
                    {t('practice.generate')}
                  </Button>
                )}
              </div>
              <div role="status" aria-live="polite" className="sr-only">
                {practice.generate.isPending ? t('practice.generating') : ''}
              </div>
              <hr style={{ border: 0, borderTop: '1px solid var(--line-soft)', width: '100%' }} />
              <ReportButtons range={range} languageId={language || null} />
            </div>
          </Card>

          <Card
            title={t('practice.queue')}
            actions={
              next && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Play size={14} />}
                  title={next.title}
                  onClick={() => timer.attemptStart.mutate(next.id, { onSuccess: () => navigate('/today') })}
                >
                  {t('practice.startNext')}
                </Button>
              )
            }
          >
            {queue.length > 0 && (
              <div className="row-wrap" style={{ marginBottom: 12 }}>
                <div style={{ minWidth: 150 }}>
                  <Select
                    label={t('practice.queueStatus')}
                    value={queueStatus}
                    onChange={(e) => setQueueStatus(e.target.value as QueueStatus)}
                    options={[
                      { value: '', label: t('practice.anyStatus') },
                      ...(['queued', 'in_progress', 'revisit'] as const).map((v) => ({ value: v, label: t(`status.${v}`) })),
                    ]}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <Select
                    label={t('practice.queueLevel')}
                    value={queueLevel}
                    onChange={(e) => setQueueLevel(e.target.value)}
                    options={[
                      { value: '', label: t('practice.anyLevel') },
                      ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: t('common.level', { n }) })),
                    ]}
                  />
                </div>
              </div>
            )}
            {queue.length === 0 ? (
              <EmptyState icon={<Sparkles size={22} />}>{t('practice.queueEmpty')}</EmptyState>
            ) : filteredQueue.length === 0 ? (
              <EmptyState icon={<Sparkles size={22} />}>{t('practice.queueNoMatch')}</EmptyState>
            ) : (
              <ul className={d.list}>
                {filteredQueue.map((p) => (
                  <li key={p.id} className={[d.row, p.flagged_bad && d.flagged].filter(Boolean).join(' ')}>
                    <span className={[d.dot, d[`dot_${p.status}`]].join(' ')} aria-hidden="true" />
                    <div className={d.rowMain}>
                      <button
                        type="button"
                        className={d.rowTitle}
                        style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }}
                        onClick={() => detail.open(p.id)}
                      >
                        {p.title}
                      </button>
                      <div className={d.rowMeta}>
                        {p.difficulty && <Badge>{t('common.level', { n: p.difficulty })}</Badge>}
                        {p.concept_names.map((c) => (
                          <Badge key={c} tone="muted">
                            {c}
                          </Badge>
                        ))}
                        <span>{t(`status.${p.status}`)}</span>
                        {p.flagged_bad && <Badge tone="feeling">{t('problem.reportedBad')}</Badge>}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => detail.open(p.id)}>
                      {t('practice.details')}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Play size={14} />}
                      onClick={() => timer.attemptStart.mutate(p.id, { onSuccess: () => navigate('/today') })}
                    >
                      {t('practice.startTimer')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Flag size={14} />}
                      aria-label={p.flagged_bad ? t('problem.unreport') : t('problem.reportBad')}
                      onClick={() => problemM.flag.mutate({ id: p.id, flagged: !p.flagged_bad })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {reliability.length > 0 && (
            <Card title={t('practice.reliability')}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {reliability.map((r) => (
                  <li key={`${r.provider}-${r.model}`} className="muted">
                    {t('practice.reliabilityRow', { ...r })}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {config && (
        <PasteResponseModal
          open={pasteOpen}
          onClose={() => setPasteOpen(false)}
          config={config}
          validate={(raw, cfg) => call('practice_validate_response', { raw_text: raw, config: cfg })}
          fixupPrompt={(raw) => call('practice_fixup_prompt', { raw_text: raw })}
          onImport={(raw) => importRaw(raw, 'copy_prompt')}
        />
      )}
      {config && generated && (
        <PasteResponseModal
          key={generated.raw_text}
          open
          onClose={() => setGenerated(null)}
          config={config}
          initialRaw={generated.raw_text}
          initialPreview={generated.preview}
          validate={(raw, cfg) => call('practice_validate_response', { raw_text: raw, config: cfg })}
          fixupPrompt={(raw) => call('practice_fixup_prompt', { raw_text: raw })}
          onImport={(raw) => importRaw(raw, 'api', generated.provider, generated.model)}
        />
      )}
      {detail.element}
    </>
  );
}
