import { clockOffset, elapsedSeconds } from '@/lib/timer';

const base = { started_at: '2026-09-24T10:00:00Z', ended_at: null, paused_seconds: 0, paused_at: null };
const at = (iso: string) => Date.parse(iso);

describe('timer math', () => {
  it('computes running elapsed from timestamps', () => {
    expect(elapsedSeconds(base, at('2026-09-24T10:05:00Z'))).toBe(300);
  });

  it('subtracts accumulated pauses', () => {
    expect(elapsedSeconds({ ...base, paused_seconds: 60 }, at('2026-09-24T10:05:00Z'))).toBe(240);
  });

  it('freezes while paused', () => {
    const t = { ...base, paused_at: '2026-09-24T10:02:00Z' };
    expect(elapsedSeconds(t, at('2026-09-24T10:05:00Z'))).toBe(120);
    expect(elapsedSeconds(t, at('2026-09-24T11:00:00Z'))).toBe(120);
  });

  it('uses ended_at when finished, so it survives restarts', () => {
    const t = { ...base, ended_at: '2026-09-24T11:00:00Z', paused_seconds: 600 };
    expect(elapsedSeconds(t, at('2026-09-25T00:00:00Z'))).toBe(3000);
  });

  it('never goes negative', () => {
    expect(elapsedSeconds(base, at('2026-09-24T09:00:00Z'))).toBe(0);
  });

  it('computes clock offsets', () => {
    expect(clockOffset('2026-09-24T10:00:05Z', at('2026-09-24T10:00:00Z'))).toBe(5000);
  });
});
