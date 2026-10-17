import { assetIdsIn, dehydrateDoc, docText, hydrateDoc } from '@/components/lesson/extensions';
import { PAGE_LINK, legacyDoc, pageIdOf } from '@/components/lesson/boardModel';

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
    {
      type: 'image',
      attrs: { src: 'asset://localhost/C%3A/old/path.png', asset: 'a1', alt: null },
    },
    {
      type: 'callout',
      attrs: { kind: 'tip' },
      content: [{ type: 'image', attrs: { src: 'https://example.com/x.png', asset: null } }],
    },
  ],
};

describe('lesson page documents', () => {
  it('stores pictures by id, not by device path', () => {
    const out = dehydrateDoc(doc);
    expect(out.content![1].attrs).toMatchObject({ asset: 'a1', src: '' });
    // A picture without a stored copy keeps its URL.
    expect(out.content![2].content![0].attrs).toMatchObject({ src: 'https://example.com/x.png' });
    // The input is not changed.
    expect(doc.content[1].attrs?.src).toContain('old/path');
  });

  it('points pictures at this device when opening', () => {
    const urls = new Map([['a1', 'asset://localhost/new.png']]);
    const out = hydrateDoc(dehydrateDoc(doc), urls);
    expect(out.content![1].attrs!.src).toBe('asset://localhost/new.png');
    expect(assetIdsIn(doc)).toEqual(['a1']);
  });
});

describe('pages on the lesson canvas', () => {
  it('reads the words of a page for search', () => {
    expect(docText(doc)).toBe('hi');
    expect(docText(null)).toBe('');
    const two = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Loops' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'repeat things' }] },
      ],
    };
    expect(docText(two)).toBe('Loops\nrepeat things');
  });

  it('knows which canvas elements are pages', () => {
    expect(pageIdOf({ link: `${PAGE_LINK}abc` })).toBe('abc');
    expect(pageIdOf({ link: 'https://example.com' })).toBeNull();
    expect(pageIdOf({ link: null })).toBeNull();
    expect(pageIdOf({})).toBeNull();
  });

  it('turns an old page into a card only when it has something written', () => {
    expect(legacyDoc(null)).toBeNull();
    expect(legacyDoc('not json')).toBeNull();
    expect(legacyDoc('[1]')).toBeNull();
    expect(legacyDoc(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }))).toBeNull();
    expect(legacyDoc(JSON.stringify(doc))).toMatchObject({ type: 'doc' });
    // A page with only a picture still counts.
    const pic = { type: 'doc', content: [{ type: 'image', attrs: { src: '', asset: 'a9' } }] };
    expect(legacyDoc(JSON.stringify(pic))).not.toBeNull();
  });
});
