import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';

/** 5 buttons, number + word label, as an ARIA radiogroup (frontend.md §10). */
export function MoodScale({
  value,
  onChange,
  label,
  hideLabel,
  disabled,
}: {
  value: number | null;
  onChange: (v: number) => void;
  label?: string;
  hideLabel?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusIdx = value ? value - 1 : 0;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span id={id} className={hideLabel ? 'sr-only' : s.label}>
        {label ?? t('mood.label')}
      </span>
      <div role="radiogroup" aria-labelledby={id} className={s.mood}>
        {[1, 2, 3, 4, 5].map((n, i) => (
          <button
            key={n}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} ${t(`mood.${n}`)}`}
            tabIndex={i === focusIdx ? 0 : -1}
            disabled={disabled}
            className={s.moodBtn}
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
            <span className={s.moodNum}>{n}</span>
            <span className={s.moodWord}>{t(`mood.${n}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
