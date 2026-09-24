import { useTranslation } from 'react-i18next';
import { Sparkles, X } from 'lucide-react';
import type { Insight } from '@/core/types/api';
import { Button, IconButton } from '@/components/ui';
import { insightMessage, insightTone } from './insightText';
import s from './domain.module.css';

export function InsightCard({
  insight,
  onDismiss,
  onDisableRule,
  footer,
}: {
  insight: Insight;
  onDismiss?: () => void;
  onDisableRule?: () => void;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const tone = insightTone(insight.rule_id);
  return (
    <article className={[s.insight, tone === 'progress' && s.insightProgress].filter(Boolean).join(' ')}>
      <div className={s.insightLabel}>
        <Sparkles size={14} aria-hidden="true" />
        {t(`insights.rules.${insight.rule_id}`)}
        <span className="spacer" />
        {onDismiss && (
          <IconButton aria-label={t('insights.dismiss')} onClick={onDismiss}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      <p className={s.insightQuote}>{insightMessage(t, insight)}</p>
      {(onDisableRule || footer) && (
        <div className="row">
          {footer}
          <span className="spacer" />
          {onDisableRule && (
            <Button variant="ghost" size="sm" onClick={onDisableRule}>
              {t('insights.dontShowType')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
