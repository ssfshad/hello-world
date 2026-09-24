import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';

export function DifficultyPicker({
  value,
  onChange,
  label,
}: {
  value: number | null;
  onChange: (v: number) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIdx = value ? value - 1 : 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span id={id} className={s.label}>
        {label ?? t('problem.difficulty')}
      </span>
      <div role="radiogroup" aria-labelledby={id} className={s.diff}>
        {[1, 2, 3, 4, 5].map((n, i) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            tabIndex={i === focusIdx ? 0 : -1}
            className={s.diffBtn}
            title={t(`difficulty.def${n}`)}
            aria-description={t(`difficulty.def${n}`)}
            onClick={() => onChange(n)}
            onKeyDown={(e) => {
              let next = -1;
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(4, i + 1);
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1);
              if (next >= 0) {
                e.preventDefault();
                refs.current[next]?.focus();
                onChange(next + 1);
              }
            }}
          >
            <span className="mono" style={{ fontSize: '1rem' }}>
              {n}
            </span>
            <span>{t(`difficulty.${n}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
