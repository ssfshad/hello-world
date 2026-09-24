import { useTranslation } from 'react-i18next';

export function PageLoading() {
  const { t } = useTranslation();
  return (
    <div role="status" style={{ padding: 44, color: 'var(--muted)' }}>
      {t('app.loading')}
    </div>
  );
}
