/* Design-system primitives (frontend.md §3.4). */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ───────────────────────── Button ─────────────────────────
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'feeling';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, icon, loading, className, children, type, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(s.btn, s[variant], size !== 'md' && s[size], block && s.block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
  size?: 'md' | 'lg';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size = 'md', type, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      title={title ?? rest['aria-label']}
      className={cx(s.iconBtn, size === 'lg' && s.iconBtnLg, className)}
      {...rest}
    />
  );
});

// ───────────────────────── Card ─────────────────────────
export function Card({
  title,
  headline,
  actions,
  tone,
  className,
  children,
  as: As = 'section',
  ...rest
}: {
  title?: ReactNode;
  headline?: ReactNode;
  actions?: ReactNode;
  tone?: 'warm' | 'dark';
  className?: string;
  children?: ReactNode;
  as?: 'section' | 'div' | 'article';
  'aria-label'?: string;
  id?: string;
}) {
  const hid = useId();
  const labelled = title || headline ? hid : undefined;
  return (
    <As
      className={cx(s.card, tone === 'warm' && s.cardWarm, tone === 'dark' && s.cardDark, className)}
      aria-labelledby={rest['aria-label'] ? undefined : labelled}
      {...rest}
    >
      {(title || headline || actions) && (
        <header className={s.cardHeader}>
          {title && (
            <h2 id={hid} className={s.cardTitle}>
              {title}
            </h2>
          )}
          {headline && (
            <h2 id={hid} className={s.cardHeadline}>
              {headline}
            </h2>
          )}
          <span className="spacer" />
          {actions}
        </header>
      )}
      {children}
    </As>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <Card as="div">
      <div className={s.stat}>
        <span className={s.statLabel}>
          {icon}
          {label}
        </span>
        <span className={s.statValue}>{value}</span>
        {sub && <span className={s.statSub}>{sub}</span>}
      </div>
    </Card>
  );
}

// ───────────────────────── Chips ─────────────────────────
export function Chip({
  pressed,
  onToggle,
  tone = 'progress',
  children,
  dashed,
  className,
  ...rest
}: {
  pressed?: boolean;
  onToggle?: () => void;
  tone?: 'progress' | 'feeling';
  children: ReactNode;
  dashed?: boolean;
  className?: string;
  'aria-label'?: string;
  title?: string;
}) {
  if (!onToggle) {
    return (
      <span className={cx(s.chip, s.chipStatic, tone === 'feeling' && s.chipFeeling, className)} {...rest}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cx(s.chip, tone === 'feeling' && s.chipFeeling, dashed && s.chipDashed, className)}
      aria-pressed={pressed ?? false}
      onClick={onToggle}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ChipGroup({
  label,
  hideLabel,
  children,
}: {
  label: string;
  hideLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="stack" style={{ gap: 6 }}>
      {!hideLabel && <span className={s.label}>{label}</span>}
      <div className={s.chipGroup}>{children}</div>
    </div>
  );
}

// ───────────────────────── Fields ─────────────────────────
interface FieldShell {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
}

function FieldWrap({
  id,
  label,
  hint,
  error,
  hideLabel,
  className,
  children,
}: FieldShell & { id: string; className?: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className={cx(s.field, className)}>
      {label && (
        <label htmlFor={id} className={cx(s.label, hideLabel && 'sr-only')}>
          {label}
        </label>
      )}
      {children}
      {hint && !error && (
        <span id={`${id}-hint`} className={s.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className={s.error} role="alert">
          {error.startsWith('errors.') ? t(error) : error}
        </span>
      )}
    </div>
  );
}

function describedBy(id: string, hint?: ReactNode, error?: string | null) {
  return error ? `${id}-err` : hint ? `${id}-hint` : undefined;
}

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldShell>(
  function TextField({ label, hint, error, hideLabel, id, className, ...rest }, ref) {
    const auto = useId();
    const fid = id ?? auto;
    return (
      <FieldWrap id={fid} label={label} hint={hint} error={error} hideLabel={hideLabel}>
        <input
          ref={ref}
          id={fid}
          className={cx(s.input, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          {...rest}
        />
      </FieldWrap>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldShell>(
  function TextArea({ label, hint, error, hideLabel, id, className, ...rest }, ref) {
    const auto = useId();
    const fid = id ?? auto;
    return (
      <FieldWrap id={fid} label={label} hint={hint} error={error} hideLabel={hideLabel}>
        <textarea
          ref={ref}
          id={fid}
          className={cx(s.textarea, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          {...rest}
        />
      </FieldWrap>
    );
  },
);

/**
 * Monospace code canvas with line numbers. Tab indents (Shift+Tab outdents);
 * press Esc first to Tab out of the field. The "output" variant is a
 * terminal-style box for pasting what a compiler printed. `fill` stretches the
 * canvas to its flex parent's height (used by the full-size example editor).
 */
export function CodeCanvas({
  label,
  hint,
  error,
  hideLabel,
  id,
  value,
  onChange,
  variant = 'code',
  placeholder,
  maxLength,
  minRows = 6,
  autoFocus,
  fill,
}: FieldShell & {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  variant?: 'code' | 'output';
  placeholder?: string;
  maxLength?: number;
  minRows?: number;
  autoFocus?: boolean;
  fill?: boolean;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const ref = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const escaped = useRef(false);
  const isCode = variant === 'code';
  const lines = Math.max(minRows, value.split('\n').length);

  const replace = (start: number, end: number, text: string, caretStart: number, caretEnd = caretStart) => {
    const next = value.slice(0, start) + text + value.slice(end);
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    requestAnimationFrame(() => ref.current?.setSelectionRange(caretStart, caretEnd));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      escaped.current = true;
      return;
    }
    if (e.key !== 'Tab' || !isCode || escaped.current) {
      escaped.current = false;
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = el;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    if (!e.shiftKey && a === b) {
      replace(a, b, '    ', a + 4);
      return;
    }
    // Indent / outdent every selected line.
    const block = value.slice(lineStart, b);
    const changed = e.shiftKey
      ? block.replace(/^( {1,4}|\t)/gm, '')
      : block.replace(/^/gm, '    ');
    const firstShift = e.shiftKey ? -(block.match(/^( {1,4}|\t)/)?.[0].length ?? 0) : 4;
    replace(lineStart, b, changed, Math.max(lineStart, a + firstShift), lineStart + changed.length);
  };

  return (
    <FieldWrap
      id={fid}
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      className={fill ? s.fieldFill : undefined}
    >
      <div className={cx(s.code, !isCode && s.codeOutput, fill && s.codeFill)}>
        {isCode && (
          <div ref={gutter} className={s.codeGutter} aria-hidden="true">
            {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
          </div>
        )}
        <textarea
          ref={ref}
          id={fid}
          className={s.codeArea}
          value={value}
          rows={minRows}
          placeholder={placeholder}
          maxLength={maxLength}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(fid, hint, error)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
    </FieldWrap>
  );
}

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldShell & { options: { value: string; label: string }[] }
>(function Select({ label, hint, error, hideLabel, id, className, options, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldWrap id={fid} label={label} hint={hint} error={error} hideLabel={hideLabel}>
      <select
        ref={ref}
        id={fid}
        className={cx(s.select, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(fid, hint, error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldWrap>
  );
});

export function Slider({
  label,
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  tone = 'progress',
  valueText,
  hideLabel,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  tone?: 'progress' | 'feeling';
  valueText?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id} className={cx(s.label, hideLabel && 'sr-only')}>
        {label}
      </label>
      <input
        id={id}
        type="range"
        className={cx(s.slider, tone === 'feeling' && s.sliderFeeling)}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

// ───────────────────────── Modal ─────────────────────────
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  full,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Near-fullscreen workspace, e.g. the example code editor. */
  full?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // A field marked data-autofocus wins; otherwise the first control after the close button.
    const first =
      node?.querySelector<HTMLElement>('[data-autofocus]') ??
      focusables().find((el) => !el.dataset.modalClose) ??
      focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const els = focusables();
        if (els.length === 0) return;
        const a = els[0];
        const b = els[els.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    node?.addEventListener('keydown', onKey);
    return () => {
      node?.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className={s.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(s.modal, wide && s.modalWide, full && s.modalFull)}
      >
        <div className={s.modalHeader}>
          <h2 id={titleId} className={s.modalTitle}>
            {title}
          </h2>
          <IconButton aria-label={t('common.close')} onClick={onClose} data-modal-close="1">
            <X size={18} />
          </IconButton>
        </div>
        <div className={s.modalBody}>{children}</div>
        {footer && <div className={s.modalFooter}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ───────────────────────── Empty / progress / tabs / tooltip ─────────────────────────
export function EmptyState({ icon, children, action }: { icon?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      {icon && <span className={s.emptyIcon}>{icon}</span>}
      <div>{children}</div>
      {action}
    </div>
  );
}

export function ProgressBar({
  value,
  max = 100,
  label,
  tone = 'progress',
}: {
  value: number;
  max?: number;
  label: string;
  tone?: 'progress' | 'feeling';
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={s.progressTrack}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
    >
      <div className={cx(s.progressFill, tone === 'feeling' && s.progressFeeling)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" aria-label={label} className={s.tabs}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          className={s.tab}
          aria-selected={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
            onChange(options[n].value);
            refs.current[n]?.focus();
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <span
      className={s.tooltipWrap}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
      aria-describedby={id}
    >
      {children}
      <span id={id} role="tooltip" className={cx(s.tooltip, !show && 'sr-only')}>
        {content}
      </span>
    </span>
  );
}

export function Badge({ children, tone = 'progress' }: { children: ReactNode; tone?: 'progress' | 'feeling' | 'muted' }) {
  return (
    <span className={cx(s.badge, tone === 'feeling' && s.badgeFeeling, tone === 'muted' && s.badgeMuted)}>
      {children}
    </span>
  );
}

export { MoodScale } from './MoodScale';
export { DifficultyPicker } from './DifficultyPicker';
export { Timer } from './Timer';
export { ToastHost, toast } from './Toast';
export const uiStyles = s;
