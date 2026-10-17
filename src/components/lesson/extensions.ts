/**
 * Editor extensions for lesson pages: a coloured callout box and images that
 * remember which stored lesson picture they show.
 */
import { mergeAttributes, Node, type JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import type { CalloutKind } from './palette';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the selection in a callout, switches its kind, or removes it. */
      toggleCallout: (kind: CalloutKind) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'tip',
        parseHTML: (el) => el.getAttribute('data-callout') ?? 'tip',
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'lesson-callout' }), 0];
  },

  addCommands() {
    return {
      toggleCallout:
        (kind) =>
        ({ editor, commands }) => {
          if (editor.isActive('callout', { kind })) return commands.lift('callout');
          if (editor.isActive('callout')) return commands.updateAttributes('callout', { kind });
          return commands.wrapIn('callout', { kind });
        },
    };
  },
});

/** Images keep `asset` (the stored picture's id); `src` is filled in when the page opens. */
export const LessonImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      asset: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-asset'),
        renderHTML: (attrs) => (attrs.asset ? { 'data-asset': attrs.asset as string } : {}),
      },
    };
  },
}).configure({
  inline: false,
  allowBase64: false,
  resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 80, minHeight: 40 },
});

function mapImages(
  doc: JSONContent,
  fn: (attrs: Record<string, unknown>) => Record<string, unknown>,
): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const next: JSONContent = { ...n };
    if (n.type === 'image' && n.attrs) next.attrs = fn({ ...n.attrs });
    if (n.content) next.content = n.content.map(walk);
    return next;
  };
  return walk(doc);
}

/** Before showing a saved page: point each picture at where its file lives on this device. */
export function hydrateDoc(doc: JSONContent, urls: Map<string, string>): JSONContent {
  return mapImages(doc, (a) =>
    typeof a.asset === 'string' && urls.has(a.asset) ? { ...a, src: urls.get(a.asset) } : a,
  );
}

/** Before saving: drop device-specific picture URLs; the asset id is enough. */
export function dehydrateDoc(doc: JSONContent): JSONContent {
  return mapImages(doc, (a) => (typeof a.asset === 'string' && a.asset ? { ...a, src: '' } : a));
}

/** Asset ids used by a saved page, so their URLs can be prepared first. */
export function assetIdsIn(doc: JSONContent): string[] {
  const out: string[] = [];
  mapImages(doc, (a) => {
    if (typeof a.asset === 'string') out.push(a.asset);
    return a;
  });
  return out;
}
