import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Hammer, Sparkles, X } from 'lucide-react';
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
  const navigate = useNavigate();
  const tone = insightTone(insight.rule_id);
  // "Watching vs doing" comes with a way out: build something small.
  const tryProject = insight.rule_id === 'shadowing_warning' && (
    <Button size="sm" icon={<Hammer size={16} />} onClick={() => navigate('/practice?style=project')}>
      {t('insights.tryProject')}
    </Button>
  );
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
      {(onDisableRule || footer || tryProject) && (
        <div className="row">
          {tryProject}
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
