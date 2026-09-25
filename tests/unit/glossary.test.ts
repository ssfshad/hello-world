import { glossaryMatcher } from '@/lib/glossary';

const terms = [
  { id: 'loop', term: 'loop' },
  { id: 'list', term: 'list' },
  { id: 'lc', term: 'list comprehension' },
  { id: 'fs', term: 'f-string' },
  { id: 'x', term: 'x' },
];

describe('glossaryMatcher', () => {
  const split = glossaryMatcher(terms);

  it('marks whole words once, keeping the original text', () => {
    const segs = split('A loop repeats. Loops inside loops!');
    expect(segs.map((s) => (typeof s === 'string' ? s : `[${s.text}]`)).join('')).toBe(
      'A [loop] repeats. Loops inside loops!',
    );
  });

  it('prefers the longest term and keeps hyphenated terms whole', () => {
    const segs = split('Use a list comprehension or an f-string.');
    const marked = segs
      .filter((s) => typeof s !== 'string')
      .map((s) => (s as { term: { id: string } }).term.id);
    expect(marked).toEqual(['lc', 'fs']);
  });

  it('does not match inside other words and skips one-letter terms', () => {
    expect(split('The playlist has x items')).toEqual(['The playlist has x items']);
    expect(glossaryMatcher([])('anything')).toEqual(['anything']);
  });

  it('matches plurals', () => {
    const segs = split('two lists');
    expect(segs[1]).toMatchObject({ text: 'lists', term: { id: 'list' } });
  });
});
