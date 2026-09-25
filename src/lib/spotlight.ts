/**
 * Scrolls to an element, briefly highlights it and focuses the first control
 * inside, so a "Show me" button lands the learner exactly where to act.
 */
export function spotlight(
  id: string,
  focusSelector = 'input, textarea, button:not([disabled])',
): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  const reduced =
    document.documentElement.dataset.reducedMotion === 'true' ||
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  el.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('spotlight');
  // Restart the animation if it is already running.
  void el.offsetWidth;
  el.classList.add('spotlight');
  window.setTimeout(() => el.classList.remove('spotlight'), 1700);
  const target = el.matches(focusSelector) ? el : el.querySelector<HTMLElement>(focusSelector);
  target?.focus({ preventScroll: true });
  return true;
}
