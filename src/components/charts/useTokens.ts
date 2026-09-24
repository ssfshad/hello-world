import { useEffect, useState } from 'react';

const NAMES = [
  'progress',
  'progress-deep',
  'progress-tint',
  'feeling',
  'feeling-deep',
  'feeling-tint',
  'muted',
  'ink',
  'ink-soft',
  'line',
  'line-soft',
  'surface',
  'heat-0',
  'heat-1',
  'heat-2',
  'heat-3',
  'heat-4',
] as const;
export type Tokens = Record<(typeof NAMES)[number], string>;

function read(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Tokens;
  for (const n of NAMES) out[n] = cs.getPropertyValue(`--${n}`).trim() || '#888';
  return out;
}

/** Resolved token colors for SVG attributes; re-reads when the theme changes. */
export function useTokens(): Tokens {
  const [tokens, setTokens] = useState<Tokens>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTokens(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return tokens;
}

/** Extra categorical colors for multi-series charts (levels, feeling tags). */
export function seriesColors(t: Tokens): string[] {
  return [t.progress, t.feeling, t['progress-deep'], t['feeling-deep'], t['heat-2'], t.muted, t['heat-3'], t['ink-soft']];
}
