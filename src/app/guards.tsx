import { useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppState } from '@/data/queries';
import { PageLoading } from './PageLoading';
import { Button } from '@/components/ui';

export function RequireOnboarding({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useAppState();
  useApplyAppearance(data?.settings);
  if (isLoading) return <PageLoading />;
  if (error || !data)
    return (
      <div role="alert" style={{ padding: 44 }} className="stack">
        <p>{t('app.error')}</p>
        <div>
          <Button onClick={() => refetch()}>{t('app.retry')}</Button>
        </div>
      </div>
    );
  if (!data.onboarding_done) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export function StartRedirect() {
  const { data } = useAppState();
  return <Navigate to={data?.settings.open_on === 'dashboard' ? '/dashboard' : '/today'} replace />;
}

/** Applies theme, font size and reduced motion to <html>. */
export function useApplyAppearance(
  settings: { theme: string; font_size: string; reduced_motion: boolean } | undefined,
) {
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && !!mq?.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    root.dataset.fontSize = settings.font_size;
    root.dataset.reducedMotion = String(settings.reduced_motion);
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [settings]);
}
