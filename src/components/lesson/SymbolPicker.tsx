import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '@/components/ui';
import { SYMBOL_GROUPS } from './palette';
import s from './lesson.module.css';

/** Emoji, arrows, math signs and code brackets, in tabs. */
export function SymbolPicker({ onPick, big }: { onPick: (symbol: string) => void; big?: boolean }) {
  const { t } = useTranslation();
  const [group, setGroup] = useState(SYMBOL_GROUPS[0].key);
  const items = SYMBOL_GROUPS.find((g) => g.key === group)?.items ?? [];
  return (
    <div className={s.symbols}>
      <div className={s.symbolTabs} role="tablist" aria-label={t('lessons.symbols')}>
        {SYMBOL_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={g.key === group}
            className={s.symbolTab}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setGroup(g.key)}
          >
            {t(`lessons.symbolGroups.${g.key}`, { defaultValue: g.label })}
          </button>
        ))}
      </div>
      <div className={cx(s.symbolGrid, big && s.symbolGridBig)} role="tabpanel">
        {items.map((sym) => (
          <button
            key={sym}
            type="button"
            className={s.symbol}
            title={sym}
            aria-label={sym}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(sym)}
          >
            {sym}
          </button>
        ))}
      </div>
    </div>
  );
}
