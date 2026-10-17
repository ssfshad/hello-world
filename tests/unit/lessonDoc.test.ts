import { assetIdsIn, dehydrateDoc, hydrateDoc } from '@/components/lesson/extensions';

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
