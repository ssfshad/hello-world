import { useEffect, useState } from 'react';
import { elapsedSeconds, type TimerLike } from '@/lib/timer';
import { formatClock } from '@/lib/format';
import { serverNow } from '@/stores/timerStore';
import s from './ui.module.css';

/**
 * Display-only timer. Re-renders itself once per second while running; the
 * value is always recomputed from timestamps. Screen readers are not told
 * about every tick (aria-live off) — start/stop are announced elsewhere.
 */
export function Timer({ timer, small, className }: { timer: TimerLike | null; small?: boolean; className?: string }) {
  const [, setTick] = useState(0);
  const running = !!timer && !timer.ended_at && !timer.paused_at;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const secs = timer ? elapsedSeconds(timer, serverNow()) : 0;
  return (
    <span className={[s.timer, small && s.timerSm, className].filter(Boolean).join(' ')} aria-live="off" role="timer">
      {formatClock(secs)}
    </span>
  );
}

/** Hook variant for places that need the number, not the display. */
export function useElapsed(timer: TimerLike | null): number {
  const [, setTick] = useState(0);
  const running = !!timer && !timer.ended_at && !timer.paused_at;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return timer ? elapsedSeconds(timer, serverNow()) : 0;
}
