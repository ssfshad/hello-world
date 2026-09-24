import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTimerStore } from '@/stores/timerStore';
import { useUiStore } from '@/stores/uiStore';
import { useAppState, useTimerActions } from '@/data/queries';
import { toast } from '@/components/ui';

const PAGES = ['/today', '/dashboard', '/notebook', '/practice', '/insights', '/library', '/roadmaps'];

/**
 * App-scoped shortcuts (frontend.md §4):
 * Ctrl/Cmd+Enter start/pause · Ctrl/Cmd+K quick log · Ctrl/Cmd+1…7 pages · Esc closes modals (Modal).
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const actions = useTimerActions();
  const { data: app } = useAppState();
  const setQuickLog = useUiStore((s) => s.setQuickLogOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const session = useTimerStore.getState().session;
        if (!session) {
          const primary = app?.languages.find((l) => l.is_primary)?.id ?? null;
          actions.start.mutate(primary, { onSuccess: () => toast.info(t('today.timerStarted')) });
        } else if (session.paused_at) actions.resume.mutate(undefined);
        else actions.pause.mutate(undefined);
        return;
      }
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickLog(true);
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 7) {
        e.preventDefault();
        navigate(PAGES[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, actions.start, actions.pause, actions.resume, app, setQuickLog, t]);
}
