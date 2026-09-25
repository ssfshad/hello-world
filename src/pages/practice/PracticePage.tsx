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
import type { GenerateResult, PracticeConfig, ProblemStyle } from '@/core/types/api';
import s from '../pages.module.css';
import d from '@/components/domain/domain.module.css';

type RangeKind = 'today' | '3' | '7' | 'custom';

export default function PracticePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: app } = useAppState();
  const today = app?.today ?? '';
  const preselect = params.get('concept');

  const [rangeKind, setRangeKind] = useState<RangeKind>('7');
  /** Opened from "Practice" on a review item: list every concept so it can be preselected. */
  const [allTime, setAllTime] = useState(!!preselect);
  const [customFrom, setCustomFrom] = useState(() => addDays(today || '2026-01-01', -29));
  const [customTo, setCustomTo] = useState(today);
  const [langId, setLangId] = useState<string>('');
  const [selected, setSelected] = useState<string[] | null>(preselect ? [preselect] : null);
  const [difficulty, setDifficulty] = useState(2);
  const [count, setCount] = useState(3);
  const [style, setStyle] = useState<ProblemStyle>(() => (params.get('style') === 'project' ? 'project' : 'beginner'));
  const [mode, setMode] = useState<'copy_prompt' | 'api'>('copy_prompt');
  const [struggles, setStruggles] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [generated, setGenerated] = useState<GenerateResult | null>(null);

  const primary = app?.languages.find((l) => l.is_primary) ?? app?.languages[0];
  const language = langId || primary?.id || '';

  const range = useMemo(() => {
    if (rangeKind === 'today') return { from: today, to: today };
    if (rangeKind === '3') return { from: addDays(today, -2), to: today };
    if (rangeKind === '7') return { from: addDays(today, -6), to: today };
    return { from: customFrom, to: customTo };
  }, [rangeKind, today, customFrom, customTo]);

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
  const conceptIds = (selected ?? []).filter((id) => rangeConcepts.some((c) => c.id === id));

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
                  ['custom', t('practice.custom')],
                ] as [RangeKind, string][]
              ).map(([k, label]) => (
                <Chip
                  key={k}
                  pressed={!allTime && rangeKind === k}
                  onToggle={() => {
                    setRangeKind(k);
                    setAllTime(false);
                    setSelected(null);
                  }}
                >
                  {label}
                </Chip>
              ))}
            </ChipGroup>
            {!allTime && rangeKind === 'custom' && (
              <div className="row">
                <TextField label={t('practice.from')} type="date" value={customFrom} max={customTo} onChange={(e) => { setCustomFrom(e.target.value); setSelected(null); }} />
                <TextField label={t('practice.to')} type="date" value={customTo} min={customFrom} max={today} onChange={(e) => { setCustomTo(e.target.value); setSelected(null); }} />
              </div>
            )}
            {rangeConcepts.length === 0 ? (
              <p className="muted">{t('practice.noConcepts')}</p>
            ) : (
              <ChipGroup label={t('problem.concepts')} hideLabel>
                {rangeConcepts.map((c) => {
                  const on = conceptIds.includes(c.id);
                  return (
                    <Chip key={c.id} pressed={on} onToggle={() => setSelected(on ? conceptIds.filter((x) => x !== c.id) : [...conceptIds, c.id])}>
                      {c.name}
                    </Chip>
                  );
                })}
              </ChipGroup>
            )}

            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <span style={{ flex: 1 }} />
                <Tooltip
                  content={[1, 2, 3, 4, 5].map((n) => (
                    <div key={n}>
                      <strong>{n}</strong> {t(`difficulty.def${n}`)}
                    </div>
                  ))}
                >
                  <Info size={16} tabIndex={0} aria-label={t('practice.difficulty')} color="var(--muted)" />
                </Tooltip>
              </div>
              <DifficultyPicker value={difficulty} onChange={setDifficulty} label={t('practice.difficulty')} />
            </div>

            <div className="row">
              <div style={{ width: 110 }}>
                <Select
                  label={t('practice.howMany')}
                  value={String(count)}
                  onChange={(e) => setCount(Number(e.target.value))}
                  options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label={t('practice.style')}
                  value={style}
                  onChange={(e) => setStyle(e.target.value as ProblemStyle)}
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
                  <button key={v} type="button" role="radio" aria-checked={mode === v} className={s.modeBtn} onClick={() => setMode(v)}>
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
              <input type="checkbox" checked={struggles} onChange={(e) => setStruggles(e.target.checked)} style={{ width: 18, height: 18, marginTop: 3, accentColor: 'var(--progress)' }} />
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
              <pre className={[s.prompt, expanded && s.promptOpen].filter(Boolean).join(' ')} aria-busy={building} tabIndex={0}>
                {built?.prompt ?? (conceptIds.length ? t('app.loading') : t('practice.noConcepts'))}
              </pre>
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

          <Card title={t('practice.queue')}>
            {queue.length === 0 ? (
              <EmptyState icon={<Sparkles size={22} />}>{t('practice.queueEmpty')}</EmptyState>
            ) : (
              <ul className={d.list}>
                {queue.map((p) => (
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
