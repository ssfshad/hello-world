import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isTauri } from '@/data/client';
import { useTranslation } from 'react-i18next';
import { useAppState, useInsightActions } from '@/data/queries';
import { checkForUpdate, notify } from '@/data/platform';
import { toast } from '@/components/ui';

const WEEKLY_KEY = 'hw-last-weekly-eval';
const REMINDER_KEY = 'hw-last-reminder';

function getLs(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function setLs(k: string, v: string) {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* per-viewer convenience only */
  }
}

/** App-opened / weekly insight evaluation, daily reminder, and update check. */
export function useBackgroundTasks() {
  const { t } = useTranslation();
  const { data: app } = useAppState();
  const { evaluate } = useInsightActions();
  const ran = useRef(false);
  const qc = useQueryClient();

  // The Rust core emits "day-changed" when the day boundary passes.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('day-changed', () => {
        qc.invalidateQueries({ queryKey: ['app'] });
        qc.invalidateQueries({ queryKey: ['day'] });
        qc.invalidateQueries({ queryKey: ['stats'] });
        qc.invalidateQueries({ queryKey: ['review'] });
      }).then((u) => {
        if (alive) unlisten = u;
        else u();
      }),
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [qc]);

  useEffect(() => {
    if (!app || ran.current) return;
    ran.current = true;
    evaluate.mutate('app_opened');
    const last = getLs(WEEKLY_KEY);
    if (!last || Date.now() - Number(last) > 7 * 86_400_000) {
      evaluate.mutate('weekly');
      setLs(WEEKLY_KEY, String(Date.now()));
    }
    if (app.settings.auto_update) {
      checkForUpdate()
        .then((u) => {
          if (u.available && u.install)
            toast.info(t('settings.updateAvailable', { v: u.version }), {
              label: t('settings.installUpdate'),
              onClick: () => void u.install?.(),
            });
        })
        .catch(() => {});
    }
  }, [app, evaluate, t]);

  const reminder = app?.settings.reminder_time ?? null;
  const today = app?.today;
  useEffect(() => {
    if (!reminder || !today) return;
    const tick = () => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (hhmm >= reminder && getLs(REMINDER_KEY) !== today) {
        setLs(REMINDER_KEY, today);
        void notify(t('app.name'), t('settings.reminderBody'));
      }
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [reminder, today, t]);
}
