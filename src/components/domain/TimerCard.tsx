import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square } from 'lucide-react';
import type { Language, Session } from '@/core/types/api';
import { Button, Card, Modal, MoodScale, Select, Timer, toast } from '@/components/ui';
import { useTimerStore } from '@/stores/timerStore';
import { useMoodCheckin, useTimerActions } from '@/data/queries';
import { formatDuration, formatTime } from '@/lib/format';
import { elapsedSeconds } from '@/lib/timer';
import { serverNow } from '@/stores/timerStore';
import { useElapsed } from '@/components/ui/Timer';
import s from './domain.module.css';

/** "YYYY-MM-DDTHH:MM" for <input type=datetime-local> from an ISO string. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string {
  return new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type MoodPrompt = { kind: 'session_start' | 'session_end'; session_id: string } | null;

export function TimerCard({
  sessions,
  languages,
  onMoodLogged,
}: {
  sessions: Session[];
  languages: Language[];
  onMoodLogged?: (value: number) => void;
}) {
  const { t } = useTranslation();
  const session = useTimerStore((st) => st.session);
  const actions = useTimerActions();
  const mood = useMoodCheckin();
  const primary = languages.find((l) => l.is_primary)?.id ?? languages[0]?.id ?? null;
  const [lang, setLang] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<MoodPrompt>(null);
  const [longEnd, setLongEnd] = useState<{ elapsed: number } | null>(null);
  const [endAt, setEndAt] = useState('');
  const [announce, setAnnounce] = useState('');
  const liveElapsed = useElapsed(session);

  const running = !!session && !session.ended_at;
  const paused = running && !!session.paused_at;
  const activeLang = running ? session.language_id : (lang ?? primary);

  const doEnd = (opts: { ended_at?: string | null; confirm_long?: boolean }) => {
    const id = session?.id;
    actions.end.mutate(opts, {
      onSuccess: (res) => {
        if (res.needs_confirmation) {
          setLongEnd({ elapsed: res.elapsed_seconds });
          setEndAt(toLocalInput(new Date(serverNow()).toISOString()));
          return;
        }
        setLongEnd(null);
        setAnnounce(t('today.timerStopped'));
        if (id) setPrompt({ kind: 'session_end', session_id: id });
      },
    });
  };

  const total = sessions.reduce((a, x) => a + (x.id === session?.id ? liveElapsed : x.elapsed_seconds), 0);

  return (
    <Card tone="dark" aria-label={t('today.timerCard')}>
      <div className={s.timerCard}>
        <div className={s.timerTop}>
          <span>{t('today.timerCard')}</span>
          <span className="spacer" />
          <span>
            {running
              ? paused
                ? t('today.paused')
                : t('today.startedAt', { time: formatTime(session.started_at) })
              : t('today.notRunning')}
          </span>
        </div>
        <Timer timer={running ? session : null} className={s.timerDisplay} />
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
        <div className={s.timerControls}>
          {!running && (
            <Button
              variant="primary"
              size="lg"
              icon={<Play size={18} />}
              loading={actions.start.isPending}
              onClick={() =>
                actions.start.mutate(activeLang, {
                  onSuccess: (st) => {
                    setAnnounce(t('today.timerStarted'));
                    if (st.session) setPrompt({ kind: 'session_start', session_id: st.session.id });
                  },
                })
              }
            >
              {t('today.start')}
            </Button>
          )}
          {running && !paused && (
            <Button size="lg" className={s.darkBtn} icon={<Pause size={18} />} onClick={() => actions.pause.mutate(undefined)}>
              {t('today.pause')}
            </Button>
          )}
          {running && paused && (
            <Button variant="primary" size="lg" icon={<Play size={18} />} onClick={() => actions.resume.mutate(undefined)}>
              {t('today.resume')}
            </Button>
          )}
          {running && (
            <Button size="lg" className={s.darkBtn} icon={<Square size={16} />} loading={actions.end.isPending} onClick={() => doEnd({})}>
              {t('today.end')}
            </Button>
          )}
        </div>
        {languages.length > 1 && (
          <div className={s.darkSelect}>
            <Select
              label={t('today.sessionLanguage')}
              value={activeLang ?? ''}
              disabled={running}
              onChange={(e) => setLang(e.target.value)}
              options={languages.filter((l) => l.is_active).map((l) => ({ value: l.id, label: l.name }))}
            />
          </div>
        )}
        <div>
          <h3 className="sr-only">{t('today.sessionsToday')}</h3>
          {sessions.length === 0 ? (
            <p className={s.timerTop}>{t('today.noSessions')}</p>
          ) : (
            <ul className={s.ranges}>
              {sessions.map((x) => {
                const live = x.id === session?.id && !x.ended_at;
                const secs = live ? elapsedSeconds(x, serverNow()) : x.elapsed_seconds;
                return (
                  <li key={x.id} className={live ? s.rangeLive : undefined}>
                    <span>
                      {formatTime(x.started_at)} – {x.ended_at ? formatTime(x.ended_at) : '…'}
                    </span>
                    <span>{formatDuration(secs)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className={s.total}>
          <span>{t('today.totalToday')}</span>
          <span className="mono">{formatDuration(total)}</span>
        </div>
      </div>

      <Modal
        open={!!prompt}
        onClose={() => setPrompt(null)}
        title={prompt?.kind === 'session_start' ? t('mood.before') : t('mood.after')}
        footer={
          <Button variant="ghost" onClick={() => setPrompt(null)}>
            {t('mood.skip')}
          </Button>
        }
      >
        <MoodScale
          value={null}
          hideLabel
          label={prompt?.kind === 'session_start' ? t('mood.before') : t('mood.after')}
          onChange={(v) => {
            if (!prompt) return;
            mood.mutate(
              { value: v, kind: prompt.kind, session_id: prompt.session_id },
              {
                onSuccess: () => {
                  toast.info(t('mood.logged', { label: t(`mood.${v}`) }));
                  onMoodLogged?.(v);
                },
              },
            );
            setPrompt(null);
          }}
        />
      </Modal>

      <Modal
        open={!!longEnd}
        onClose={() => setLongEnd(null)}
        title={t('today.longSessionTitle')}
        footer={
          <>
            <Button onClick={() => doEnd({ ended_at: fromLocalInput(endAt), confirm_long: true })}>{t('today.longSessionFix')}</Button>
            <Button variant="primary" onClick={() => doEnd({ confirm_long: true })}>
              {t('today.longSessionKeep')}
            </Button>
          </>
        }
      >
        <p>{t('today.longSessionBody', { duration: formatDuration(longEnd?.elapsed ?? 0) })}</p>
        <label className="stack" style={{ gap: 6 }}>
          <span className="muted">{t('today.staleEndAt')}</span>
          <input
            type="datetime-local"
            value={endAt}
            min={session ? toLocalInput(session.started_at) : undefined}
            onChange={(e) => setEndAt(e.target.value)}
            style={{ minHeight: 40, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--input-border)', background: 'var(--surface)' }}
          />
        </label>
      </Modal>
    </Card>
  );
}

export function StaleSessionModal() {
  const { t } = useTranslation();
  const stale = useTimerStore((st) => st.stale);
  const actions = useTimerActions();
  const initial = stale ? (stale.last_heartbeat ?? stale.session.started_at) : '';
  const [endAt, setEndAt] = useState(() => (initial ? toLocalInput(initial) : ''));
  if (!stale) return null;
  const secs = elapsedSeconds(stale.session, serverNow());
  const value = endAt || toLocalInput(initial);
  return (
    <Modal
      open
      onClose={() => actions.resolveStale.mutate({ action: 'keep' })}
      title={t('today.staleTitle', { duration: formatDuration(secs) })}
      footer={
        <>
          <Button onClick={() => actions.resolveStale.mutate({ action: 'keep' })}>{t('today.staleKeep')}</Button>
          <Button variant="primary" onClick={() => actions.resolveStale.mutate({ action: 'end', ended_at: fromLocalInput(value) })}>
            {t('today.staleEnd')}
          </Button>
        </>
      }
    >
      <p>{t('today.staleBody')}</p>
      <label className="stack" style={{ gap: 6 }}>
        <span className="muted">{t('today.staleEndAt')}</span>
        <input
          type="datetime-local"
          value={value}
          min={toLocalInput(stale.session.started_at)}
          onChange={(e) => setEndAt(e.target.value)}
          style={{ minHeight: 40, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--input-border)', background: 'var(--surface)', color: 'var(--ink)' }}
        />
      </label>
    </Modal>
  );
}
