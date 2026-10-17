/**
 * The rules for pages on the lesson canvas that need no drawing library:
 * how a page card is linked to its text, and which old pages count as written.
 */
import type { JSONContent } from '@tiptap/core';
import { assetIdsIn, docText } from './extensions';

export const PAGE_LINK = 'hw-page:';
export const CARD_W = 640;
export const CARD_H = 760;

export const pageIdOf = (el: { link?: string | null }): string | null =>
  typeof el.link === 'string' && el.link.startsWith(PAGE_LINK)
    ? el.link.slice(PAGE_LINK.length)
    : null;

/** A page written before pages moved onto the board, if it has any words. */
export function legacyDoc(raw: string | null): JSONContent | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as JSONContent;
    if (!d || d.type !== 'doc') return null;
    return docText(d) || assetIdsIn(d).length ? d : null;
  } catch {
    return null;
  }
}
