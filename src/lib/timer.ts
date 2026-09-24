/**
 * Timer math. Elapsed time is always derived from timestamps, never by
 * counting ticks, so it survives sleep, reloads and restarts.
 *   elapsed = (ended_at ?? now) − started_at − paused_seconds − (now − paused_at if paused)
 */

export interface TimerLike {
  started_at: string;
  ended_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
}

export function elapsedSeconds(t: TimerLike, nowMs: number): number {
  const start = Date.parse(t.started_at);
  const end = t.ended_at ? Date.parse(t.ended_at) : nowMs;
  let paused = t.paused_seconds;
  if (!t.ended_at && t.paused_at) {
    paused += Math.max(0, (nowMs - Date.parse(t.paused_at)) / 1000);
  }
  return Math.max(0, Math.floor((end - start) / 1000 - paused));
}

/** Offset (ms) to add to the local clock to match the backend clock. */
export function clockOffset(serverNowIso: string, localNowMs: number): number {
  return Date.parse(serverNowIso) - localNowMs;
}

export const LONG_SESSION_SECONDS = 8 * 3600;
