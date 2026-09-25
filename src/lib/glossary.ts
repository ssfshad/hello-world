/**
 * Finds glossary terms inside free text so the UI can underline them. Each
 * term is marked once per text (its first occurrence) to keep notes readable.
 */

export interface TermLike {
  id: string;
  term: string;
}

export type Segment<T> = string | { text: string; term: T };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns a splitter for `terms`; build it once per glossary, not per render. */
export function glossaryMatcher<T extends TermLike>(terms: T[]): (text: string) => Segment<T>[] {
  const usable = terms.filter((t) => t.term.trim().length >= 2);
  if (!usable.length) return (text) => [text];
  const byKey = new Map(usable.map((t) => [t.term.trim().toLowerCase(), t]));
  // Longest first, so "list comprehension" wins over "list".
  const alternatives = [...byKey.keys()].sort((a, b) => b.length - a.length).map(escape);
  // Whole words only; a trailing plural "s" still matches ("loops" → loop).
  const re = new RegExp(`(?<![\\w-])(${alternatives.join('|')})(?:e?s)?(?![\\w-])`, 'gi');
  return (text) => {
    const out: Segment<T>[] = [];
    const seen = new Set<string>();
    let last = 0;
    for (const m of text.matchAll(re)) {
      const key = m[1].toLowerCase();
      const term = byKey.get(key);
      if (!term || seen.has(key)) continue;
      seen.add(key);
      const start = m.index ?? 0;
      if (start > last) out.push(text.slice(last, start));
      out.push({ text: m[0], term });
      last = start + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
}
