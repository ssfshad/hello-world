/** Formatting helpers. All user-facing numbers/dates go through Intl. */

export function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

/** 5025 → "01:23:45" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s % 60)}`;
}

/** 5700 → "1h 35m"; 300 → "5m"; 0 → "0m" */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return s > 0 && m === 0 ? '<1m' : `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** minutes → "1h 35m" */
export function formatMinutes(minutes: number): string {
  return formatDuration(minutes * 60);
}

/** "09:10" in the user's locale from an ISO timestamp */
export function formatTime(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
}

/** day_key → Date at local noon (safe from DST edge cases) */
export function dayKeyToDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function formatDay(
  dayKey: string,
  opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' },
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, opts).format(dayKeyToDate(dayKey));
}

export function formatShortDay(dayKey: string, locale?: string): string {
  return formatDay(dayKey, { month: 'short', day: 'numeric' }, locale);
}

export function formatNumber(n: number, digits = 0, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
}

export function formatPercent(delta: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(delta);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** "12h 5m" style helper used for "you logged X this week" deltas */
export function signed(n: number, fmt: (v: number) => string = String): string {
  if (n === 0) return '±0';
  return (n > 0 ? '+' : '−') + fmt(Math.abs(n));
}
