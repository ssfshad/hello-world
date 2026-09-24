import { formatBytes, formatClock, formatDuration, formatMinutes, signed, truncate } from '@/lib/format';

describe('formatters', () => {
  it('formats clocks', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(5025)).toBe('01:23:45');
    expect(formatClock(-4)).toBe('00:00:00');
  });

  it('formats durations', () => {
    expect(formatDuration(5700)).toBe('1h 35m');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(20)).toBe('<1m');
    expect(formatDuration(0)).toBe('0m');
    expect(formatMinutes(95)).toBe('1h 35m');
  });

  it('truncates, signs and sizes', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('hi', 6)).toBe('hi');
    expect(signed(3)).toBe('+3');
    expect(signed(-3)).toBe('−3');
    expect(signed(0)).toBe('±0');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
