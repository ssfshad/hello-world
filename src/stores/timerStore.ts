import { create } from 'zustand';
import type { ActiveState, Attempt, Session, StaleSession } from '@/core/types/api';
import { clockOffset, elapsedSeconds } from '@/lib/timer';

interface TimerState {
  session: Session | null;
  attempt: Attempt | null;
  stale: StaleSession | null;
  /** ms to add to Date.now() to match backend time */
  offsetMs: number;
  setActive: (s: ActiveState) => void;
  clear: () => void;
}

export const useTimerStore = create<TimerState>((set) => ({
  session: null,
  attempt: null,
  stale: null,
  offsetMs: 0,
  setActive: (s) =>
    set({
      session: s.session,
      attempt: s.attempt,
      stale: s.stale,
      offsetMs: clockOffset(s.server_now, Date.now()),
    }),
  clear: () => set({ session: null, attempt: null, stale: null }),
}));

/** Backend-aligned "now" in ms. */
export function serverNow(): number {
  return Date.now() + useTimerStore.getState().offsetMs;
}

export function sessionElapsed(now = serverNow()): number {
  const s = useTimerStore.getState().session;
  return s ? elapsedSeconds(s, now) : 0;
}

export function attemptElapsed(now = serverNow()): number {
  const a = useTimerStore.getState().attempt;
  return a ? elapsedSeconds(a, now) : 0;
}
