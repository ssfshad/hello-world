import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/components/ui';
import s from './lesson.module.css';

/**
 * A toolbar button that opens a small panel (colours, symbols…). Closes on
 * Escape, on a click outside, or when the panel calls `close()`.
 */
export function Popover({
  label,
  trigger,
  children,
  align = 'start',
  className,
  active,
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    wrap.current?.addEventListener('keydown', onKey);
    const node = wrap.current;
    return () => {
      document.removeEventListener('mousedown', onDown);
      node?.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className={s.popWrap}>
      <button
        ref={btn}
        type="button"
        className={cx(s.toolBtn, (open || active) && s.toolBtnOn, className)}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // Keep the editor's selection while opening the panel.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={cx(s.pop, align === 'end' && s.popEnd)}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
