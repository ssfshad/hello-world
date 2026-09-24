import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { useLocation } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, Plug, Star, Trash2 } from 'lucide-react';
import { PageHeader } from '@/app/PageHeader';
import { Badge, Button, Card, IconButton, Modal, Select, Tabs, TextField, toast } from '@/components/ui';
import {
  useAppState,
  useBackups,
  useDataActions,
  useDataInfo,
  useLanguageMutations,
  useProfileUpdate,
  useProviderMutations,
  useProviders,
  useSettingsUpdate,
} from '@/data/queries';
import { checkForUpdate, pickDirectory, pickSavePath, type UpdateCheck } from '@/data/platform';
import { profileSchema, providerSchema, type ProfileForm, type ProviderForm } from '@/core/schemas';
import { formatBytes, formatDay } from '@/lib/format';
import type { AiProvider, AiProviderKind, AppSettings, FontSize, Theme } from '@/core/types/api';
import s from '../pages.module.css';

const SECTIONS = ['profile', 'languages', 'appearance', 'ai', 'data', 'reminders', 'about'] as const;

export default function SettingsPage() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const location = useLocation();
  useEffect(() => {
    const id = location.hash.replace('#', '');
    if (id) document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' });
  }, [location.hash, app]);
  if (!app) return null;
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className={s.settings}>
        <nav className={s.settingsNav} aria-label={t('settings.title')}>
          {SECTIONS.map((k) => (
            <a
              key={k}
              href={`#${k}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(`settings-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {t(`settings.${k === 'ai' ? 'ai' : k}`)}
            </a>
          ))}
        </nav>
        <div className="stack" style={{ gap: 20 }}>
          <ProfileSection />
          <LanguagesSection />
          <AppearanceSection settings={app.settings} />
          <AiSection settings={app.settings} />
          <DataSection />
          <RemindersSection settings={app.settings} />
          <AboutSection version={app.app_version} settings={app.settings} />
        </div>
      </div>
    </>
  );
}

function ProfileSection() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const update = useProfileUpdate();
  const p = app!.profile!;
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    reset,
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { display_name: p.display_name, daily_goal_min: p.daily_goal_min, day_boundary: p.day_boundary },
  });
  const [tz, setTz] = useState(p.timezone);
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [p.timezone];
  return (
    <Card title={t('settings.profile')} id="settings-profile">
      <form
        className="stack"
        onSubmit={handleSubmit((v) =>
          update.mutate({ ...v, timezone: tz }, { onSuccess: () => (reset(v), toast.info(t('common.saved'))) }),
        )}
      >
        <div className={s.formGrid}>
          <TextField label={t('settings.name')} error={errors.display_name?.message} {...register('display_name')} />
          <TextField label={t('settings.dailyGoal')} type="number" min={5} max={720} error={errors.daily_goal_min?.message} {...register('daily_goal_min', { valueAsNumber: true })} />
          <TextField label={t('settings.dayBoundary')} type="time" hint={t('onboarding.boundaryHint')} error={errors.day_boundary?.message} {...register('day_boundary')} />
          <Select label={t('settings.timezone')} value={tz} onChange={(e) => setTz(e.target.value)} options={zones.map((z) => ({ value: z, label: z }))} />
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={!isDirty && tz === p.timezone} loading={update.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function LanguagesSection() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const m = useLanguageMutations();
  const [name, setName] = useState('');
  return (
    <Card title={t('settings.languages')} id="settings-languages">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {app!.languages.map((l) => (
          <li key={l.id} className={s.langRow} style={{ opacity: l.is_active ? 1 : 0.6 }}>
            <strong style={{ flex: 1 }}>{l.name}</strong>
            {l.is_primary ? (
              <Badge>
                <Star size={12} aria-hidden="true" /> {t('settings.primary')}
              </Badge>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => m.setPrimary.mutate(l.id)}>
                {t('settings.setPrimary')}
              </Button>
            )}
            {!l.is_primary && (
              <Button size="sm" variant="ghost" onClick={() => m.update.mutate({ id: l.id, is_active: !l.is_active })}>
                {l.is_active ? t('settings.archive') : t('settings.unarchive')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row"
        style={{ marginTop: 12, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) m.add.mutate(name.trim(), { onSuccess: () => setName('') });
        }}
      >
        <div style={{ flex: 1 }}>
          <TextField label={t('settings.addLanguage')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" disabled={!name.trim()}>
          {t('common.add')}
        </Button>
      </form>
    </Card>
  );
}

function AppearanceSection({ settings }: { settings: AppSettings }) {
  const { t } = useTranslation();
  const update = useSettingsUpdate();
  return (
    <Card title={t('settings.appearance')} id="settings-appearance">
      <div className="stack" style={{ gap: 16 }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.87rem', fontWeight: 600 }}>
            {t('settings.theme')}
          </span>
          <Tabs<Theme>
            label={t('settings.theme')}
            value={settings.theme}
            onChange={(v) => update.mutate({ theme: v })}
            options={(['light', 'dark', 'system'] as const).map((v) => ({ value: v, label: t(`settings.themes.${v}`) }))}
          />
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: '0.87rem', fontWeight: 600 }}>
            {t('settings.fontSize')}
          </span>
          <Tabs<FontSize>
            label={t('settings.fontSize')}
            value={settings.font_size}
            onChange={(v) => update.mutate({ font_size: v })}
            options={(['s', 'm', 'l'] as const).map((v) => ({ value: v, label: t(`settings.fontSizes.${v}`) }))}
          />
        </div>
        <Toggle label={t('settings.reducedMotion')} checked={settings.reduced_motion} onChange={(v) => update.mutate({ reduced_motion: v })} />
        <div style={{ maxWidth: 260 }}>
          <Select
            label={t('settings.openOn')}
            value={settings.open_on}
            onChange={(e) => update.mutate({ open_on: e.target.value as AppSettings['open_on'] })}
            options={[
              { value: 'today', label: t('nav.today') },
              { value: 'dashboard', label: t('nav.dashboard') },
            ]}
          />
        </div>
      </div>
    </Card>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={s.toggle}>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && (
          <>
            <br />
            <small className="muted">{hint}</small>
          </>
        )}
      </span>
    </label>
  );
}

const DEFAULT_URLS: Partial<Record<AiProviderKind, string>> = {
  ollama: 'http://localhost:11434',
  openai_compatible: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
};

function AiSection({ settings }: { settings: AppSettings }) {
  const { t } = useTranslation();
  const { data: providers = [] } = useProviders();
  const m = useProviderMutations();
  const update = useSettingsUpdate();
  const [editing, setEditing] = useState<AiProvider | 'new' | null>(null);
  const [keyFor, setKeyFor] = useState<AiProvider | null>(null);
  const [key, setKey] = useState('');
  return (
    <Card title={t('settings.ai')} id="settings-ai">
      <div className="stack" style={{ gap: 12 }}>
        <p className="muted">{t('settings.aiIntro')}</p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {providers.map((p) => (
            <li key={p.id} className={s.providerRow}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <strong>{p.label}</strong>{' '}
                {p.is_default && <Badge>{t('settings.default')}</Badge>}
                <div className="muted" style={{ fontSize: '0.83rem' }}>
                  {t(`settings.kinds.${p.kind}`)} · {p.model}
                  {p.kind !== 'ollama' && ` · ${p.key_hint ?? t('settings.noKey')}`}
                </div>
              </div>
              {p.kind !== 'ollama' && (
                <Button size="sm" icon={<KeyRound size={14} />} onClick={() => setKeyFor(p)}>
                  {p.has_key ? t('settings.replaceKey') : t('settings.apiKey')}
                </Button>
              )}
              <Button
                size="sm"
                icon={<Plug size={14} />}
                loading={m.test.isPending && m.test.variables === p.id}
                onClick={() =>
                  m.test.mutate(p.id, {
                    onSuccess: (r) => (r.ok ? toast.info(t('settings.testOk', { ms: r.latency_ms })) : toast.error(r.message)),
                  })
                }
              >
                {t('settings.testConnection')}
              </Button>
              {!p.is_default && (
                <Button size="sm" variant="ghost" onClick={() => m.save.mutate({ ...p, is_default: true })}>
                  {t('settings.makeDefault')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                {t('common.edit')}
              </Button>
              <IconButton aria-label={`${t('common.delete')} ${p.label}`} onClick={() => m.remove.mutate(p.id)}>
                <Trash2 size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
        <div>
          <Button onClick={() => setEditing('new')}>{t('settings.addProvider')}</Button>
        </div>
        <Toggle
          label={t('settings.allowDiary')}
          hint={t('settings.allowDiaryHint')}
          checked={settings.allow_diary_to_ai}
          onChange={(v) => update.mutate({ allow_diary_to_ai: v })}
        />
      </div>
      {editing && <ProviderModal provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <Modal
        open={!!keyFor}
        onClose={() => {
          setKeyFor(null);
          setKey('');
        }}
        title={`${t('settings.apiKey')} · ${keyFor?.label ?? ''}`}
        footer={
          <Button
            variant="primary"
            disabled={!key.trim()}
            onClick={() =>
              keyFor &&
              m.setKey.mutate(
                { id: keyFor.id, key: key.trim() },
                {
                  onSuccess: () => {
                    setKeyFor(null);
                    setKey('');
                  },
                },
              )
            }
          >
            {t('settings.saveKey')}
          </Button>
        }
      >
        <TextField label={t('settings.apiKey')} type="password" autoComplete="off" hint={t('settings.apiKeyHint')} value={key} onChange={(e) => setKey(e.target.value)} />
      </Modal>
    </Card>
  );
}

function ProviderModal({ provider, onClose }: { provider: AiProvider | null; onClose: () => void }) {
  const { t } = useTranslation();
  const m = useProviderMutations();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ProviderForm>({
    resolver: zodResolver(providerSchema),
    defaultValues: {
      kind: provider?.kind ?? 'ollama',
      label: provider?.label ?? 'Local model',
      base_url: provider?.base_url ?? DEFAULT_URLS.ollama ?? '',
      model: provider?.model ?? '',
      is_default: provider?.is_default ?? false,
    },
  });
  const kind = watch('kind');
  useEffect(() => {
    if (!provider) setValue('base_url', DEFAULT_URLS[kind] ?? '');
  }, [kind, provider, setValue]);
  return (
    <Modal
      open
      onClose={onClose}
      title={provider ? provider.label : t('settings.addProvider')}
      footer={
        <Button variant="primary" type="submit" form="provider-form" loading={m.save.isPending}>
          {t('common.save')}
        </Button>
      }
    >
      <form
        id="provider-form"
        className="stack"
        onSubmit={handleSubmit((v) =>
          m.save.mutate({ id: provider?.id ?? null, kind: v.kind, label: v.label, base_url: v.base_url || null, model: v.model, is_default: v.is_default }, { onSuccess: onClose }),
        )}
      >
        <Select
          label={t('settings.providerKind')}
          {...register('kind')}
          options={(['ollama', 'openai_compatible', 'gemini', 'anthropic', 'openrouter'] as const).map((k) => ({ value: k, label: t(`settings.kinds.${k}`) }))}
        />
        <TextField label={t('settings.label')} error={errors.label?.message} {...register('label')} />
        {kind !== 'gemini' && kind !== 'anthropic' && <TextField label={t('settings.baseUrl')} {...register('base_url')} />}
        <TextField label={t('settings.model')} placeholder={kind === 'ollama' ? 'llama3.1:8b' : ''} error={errors.model?.message} {...register('model')} />
        <label className={s.toggle}>
          <input type="checkbox" {...register('is_default')} />
          <span>{t('settings.makeDefault')}</span>
        </label>
      </form>
    </Modal>
  );
}

function DataSection() {
  const { t } = useTranslation();
  const { data: info } = useDataInfo();
  const { data: backups = [] } = useBackups();
  const a = useDataActions();
  const [includeLibrary, setIncludeLibrary] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [restoreId, setRestoreId] = useState<string | null>(null);
  return (
    <Card title={t('settings.data')} id="settings-data">
      <div className="stack" style={{ gap: 16 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600, fontSize: '0.87rem' }}>{t('settings.dataFolder')}</div>
            <code className="mono muted" style={{ fontSize: '0.83rem', wordBreak: 'break-all' }}>
              {info?.data_dir}
            </code>
            {info && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                {t('settings.dbSize', { size: formatBytes(info.db_size_bytes), v: info.schema_version })}
              </div>
            )}
          </div>
          <Button
            onClick={async () => {
              const dir = await pickDirectory(t('settings.dataFolder'));
              if (dir) a.moveDir.mutate(dir, { onSuccess: () => toast.info(t('common.saved')) });
            }}
          >
            {t('settings.moveFolder')}
          </Button>
        </div>
        <div className="row-wrap">
          <Button variant="primary" loading={a.backupNow.isPending} onClick={() => a.backupNow.mutate(undefined, { onSuccess: () => toast.info(t('settings.backupDone')) })}>
            {t('settings.backupNow')}
          </Button>
          <Button
            onClick={async () => {
              const path = await pickSavePath({ title: t('settings.exportAll'), defaultPath: 'hello-world-export.json', extensions: [{ name: 'JSON', extensions: ['json'] }] });
              if (path) a.exportAll.mutate({ path, include_library: includeLibrary }, { onSuccess: (p) => toast.info(t('settings.exported', { path: p })) });
            }}
          >
            {t('settings.exportAll')}
          </Button>
          <label className={s.toggle} style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={includeLibrary} onChange={(e) => setIncludeLibrary(e.target.checked)} />
            <span>{t('settings.includeLibrary')}</span>
          </label>
        </div>
        <div>
          <h3 style={{ fontSize: '0.93rem', marginBottom: 6 }}>{t('settings.backups')}</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflow: 'auto' }}>
            {backups.map((b) => (
              <li key={b.id} className={s.backupRow}>
                <span className="mono" style={{ flex: 1, fontSize: '0.83rem' }}>
                  {formatDay(b.created_at.slice(0, 10), { dateStyle: 'medium' })} {b.created_at.slice(11, 16)}
                </span>
                <Badge tone="muted">{b.kind}</Badge>
                <span className="muted" style={{ fontSize: '0.8rem', width: 70, textAlign: 'right' }}>
                  {formatBytes(b.size_bytes)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setRestoreId(b.id)}>
                  {t('settings.restore')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line-soft)', paddingTop: 16 }}>
          <p className="muted">{t('settings.deleteAllHint')}</p>
          <div>
            <Button variant="danger" onClick={() => setDeleteOpen(true)}>
              {t('settings.deleteAll')}
            </Button>
          </div>
        </div>
      </div>
      <Modal
        open={!!restoreId}
        onClose={() => setRestoreId(null)}
        title={t('settings.restore')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={a.restore.isPending}
              onClick={() => restoreId && a.restore.mutate(restoreId, { onSuccess: () => (setRestoreId(null), toast.info(t('settings.restored'))) })}
            >
              {t('settings.restore')}
            </Button>
          </>
        }
      >
        <p>{t('settings.restoreConfirm')}</p>
      </Modal>
      <Modal
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setPhrase('');
        }}
        title={t('settings.deleteAll')}
        footer={
          <Button
            variant="danger"
            disabled={phrase !== 'DELETE'}
            loading={a.deleteAll.isPending}
            onClick={() =>
              a.deleteAll.mutate(phrase, {
                onSuccess: () => {
                  toast.info(t('settings.deleted'));
                  window.location.hash = '#/onboarding';
                },
              })
            }
          >
            {t('settings.deleteAll')}
          </Button>
        }
      >
        <p>{t('settings.deleteAllHint')}</p>
        <TextField label={t('settings.deletePhrase')} value={phrase} autoComplete="off" onChange={(e) => setPhrase(e.target.value)} />
      </Modal>
    </Card>
  );
}

function RemindersSection({ settings }: { settings: AppSettings }) {
  const { t } = useTranslation();
  const update = useSettingsUpdate();
  const on = settings.reminder_time != null;
  return (
    <Card title={t('settings.reminders')} id="settings-reminders">
      <div className="stack">
        <Toggle label={t('settings.reminderTime')} hint={t('settings.reminderHint')} checked={on} onChange={(v) => update.mutate({ reminder_time: v ? '19:00' : null })} />
        {on && (
          <div style={{ maxWidth: 180 }}>
            <TextField label={t('settings.reminderTime')} type="time" value={settings.reminder_time ?? ''} onChange={(e) => update.mutate({ reminder_time: e.target.value || null })} />
          </div>
        )}
      </div>
    </Card>
  );
}

function AboutSection({ version, settings }: { version: string; settings: AppSettings }) {
  const { t } = useTranslation();
  const update = useSettingsUpdate();
  const a = useDataActions();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <Card title={t('settings.about')} id="settings-about">
      <div className="stack" style={{ gap: 14 }}>
        <p>
          <strong>{t('app.name')}</strong> · {t('settings.version', { v: version })}
          <br />
          <span className="muted">{t('app.madeBy')}</span>
        </p>
        <div className="row-wrap">
          <Button
            loading={checking}
            onClick={async () => {
              setChecking(true);
              try {
                setCheck(await checkForUpdate());
              } catch (e) {
                toast.error(String(e));
              } finally {
                setChecking(false);
              }
            }}
          >
            {t('settings.checkUpdates')}
          </Button>
          {check && !check.available && <span className="muted">{t('settings.upToDate')}</span>}
          {check?.available && (
            <>
              <span>{t('settings.updateAvailable', { v: check.version })}</span>
              <Button variant="primary" onClick={() => void check.install?.()}>
                {t('settings.installUpdate')}
              </Button>
            </>
          )}
        </div>
        <Toggle label={t('settings.autoUpdate')} checked={settings.auto_update} onChange={(v) => update.mutate({ auto_update: v })} />
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          {t('settings.licenses')}
        </p>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('settings.debug')}</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <div style={{ maxWidth: 200 }}>
              <Select
                label={t('settings.logLevel')}
                value={settings.log_level}
                onChange={(e) => update.mutate({ log_level: e.target.value as AppSettings['log_level'] })}
                options={['error', 'warn', 'info', 'debug', 'trace'].map((v) => ({ value: v, label: v }))}
              />
            </div>
            <div className="row-wrap">
              <Button
                onClick={async () => {
                  const path = await pickSavePath({ title: t('settings.diagnostics'), defaultPath: 'hello-world-diagnostics.txt', extensions: [{ name: 'Text', extensions: ['txt'] }] });
                  if (path) a.diagnostics.mutate(path, { onSuccess: (p) => toast.info(p) });
                }}
              >
                {t('settings.diagnostics')}
              </Button>
            </div>
            <small className="muted">{t('settings.diagnosticsHint')}</small>
          </div>
        </details>
      </div>
    </Card>
  );
}
