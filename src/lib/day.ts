/**
 * Day-boundary helper for the UI. The backend's `day_key()` is authoritative
 * for stored rows; this mirror is used for display ranges and the mock backend.
 * A moment belongs to the day of (local time − boundary).
 */

import { pad2 } from './format';

export function parseBoundary(boundary: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(boundary.trim());
  if (!m) throw new Error(`invalid boundary ${boundary}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid boundary ${boundary}`);
  return h * 60 + min;
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-timezone day key for a moment, honouring the day boundary. */
export function dayKeyFor(date: Date, boundary = '04:00'): string {
  const shifted = new Date(date.getTime());
  shifted.setMinutes(shifted.getMinutes() - parseBoundary(boundary));
  return keyOf(shifted);
}

/** Pure variant with an explicit UTC offset (minutes east of UTC); used in tests. */
export function dayKeyForOffset(isoUtc: string, offsetMinutes: number, boundary = '04:00'): string {
  const t = Date.parse(isoUtc) + (offsetMinutes - parseBoundary(boundary)) * 60_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round(
    (Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86_400_000,
  );
}

/** Inclusive list of day keys */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

export function lastNDays(today: string, n: number): { from: string; to: string } {
  return { from: addDays(today, -(n - 1)), to: today };
}

/** Monday = 0 … Sunday = 6 */
export function weekdayIndex(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function weekStart(dayKey: string): string {
  return addDays(dayKey, -weekdayIndex(dayKey));
}

export function monthGrid(year: number, month0: number): (string | null)[] {
  const first = `${year}-${pad2(month0 + 1)}-01`;
  const lead = weekdayIndex(first);
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${year}-${pad2(month0 + 1)}-${pad2(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
