/**
 * A written page on the lesson board: a notebook page with headings, fonts,
 * colours, highlighter, lists, checklists, callouts, code, symbols and pictures.
 * The formatting toolbar is shared and works on whichever page is being written.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Code,
  Highlighter,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Minus,
  Redo2,
  Smile,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
  Eraser,
} from 'lucide-react';
import type { LessonAsset } from '@/core/types/api';
import { cx } from '@/components/ui';
import { openUrl } from '@/data/platform';
import { Callout, LessonImage, dehydrateDoc, hydrateDoc } from './extensions';
import {
  CALLOUTS,
  FONTS,
  HIGHLIGHTS,
  SIZES,
  TEXT_COLORS,
  highlightColor,
  textColor,
} from './palette';
import { Popover } from './Popover';
import { SymbolPicker } from './SymbolPicker';
import { isImageFile } from './images';
import s from './lesson.module.css';
import './lessonFonts';

export interface Uploaded {
  asset: LessonAsset;
  url: string;
}

/** What the board needs to know about the page card being written on. */
export interface ActivePage {
  editor: Editor;
  /** Adds pictures at the cursor. */
  insertFiles: (files: File[]) => Promise<void>;
}

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** A page on the board: a written notebook page with its own text editor. */
export function PageCard({
  initial,
  urls,
  upload,
  onChange,
  onFocus,
  onGone,
  paper,
}: {
  /** the saved document, with picture ids instead of device paths */
  initial: JSONContent | null;
  /** the card's background colour picked on the board ('transparent' = plain paper) */
  paper?: string;
  urls: Map<string, string>;
  upload: (file: File) => Promise<Uploaded>;
  onChange: (doc: JSONContent | null, text: string) => void;
  onFocus: (page: ActivePage) => void;
  onGone: (editor: Editor) => void;
}) {
  const { t } = useTranslation();
  const callbacks = useRef({ onChange, onFocus, onGone, upload });
  useEffect(() => {
    callbacks.current = { onChange, onFocus, onGone, upload };
  });
  // The editor owns the text after it opens; later changes flow out, never back in.
  const [content] = useState(() => hydrateDoc(initial ?? EMPTY_DOC, urls));
  const editorRef = useRef<Editor | null>(null);

  const insertFiles = async (editor: Editor, files: File[], pos?: number) => {
    let at = pos;
    for (const f of files.filter(isImageFile)) {
      try {
        const up = await callbacks.current.upload(f);
        const node = {
          type: 'image',
          attrs: { src: up.url, asset: up.asset.id, alt: f.name || null },
        };
        const chain = editor.chain().focus();
        if (at != null) {
          chain.insertContentAt(at, node).run();
          at = undefined;
        } else {
          chain.insertContent(node).run();
        }
      } catch {
        // The upload hook already showed why (e.g. not a picture).
      }
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Callout,
      LessonImage,
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading'
            ? t('lessons.page.headingPlaceholder')
            : t('lessons.page.placeholder'),
      }),
    ],
    content,
    editorProps: {
      attributes: {
        class: 'lesson-page',
        'aria-label': t('lessons.page.label'),
        spellcheck: 'true',
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.some(isImageFile) || !editorRef.current) return false;
        void insertFiles(editorRef.current, files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.some(isImageFile) || !editorRef.current) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertFiles(editorRef.current, files, pos);
        return true;
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement | null)?.closest('a');
        if (a && (event.ctrlKey || event.metaKey) && a.href) {
          void openUrl(a.href);
          return true;
        }
        return false;
      },
    },
    onFocus: ({ editor }) => {
      callbacks.current.onFocus({
        editor,
        insertFiles: (files) => insertFiles(editor, files),
      });
    },
    onUpdate: ({ editor }) => {
      const text = editor.getText({ blockSeparator: '\n' }).trim();
      callbacks.current.onChange(editor.isEmpty ? null : dehydrateDoc(editor.getJSON()), text);
    },
  });
  editorRef.current = editor;

  useEffect(
    () => () => {
      if (editorRef.current) callbacks.current.onGone(editorRef.current);
    },
    [],
  );

  // The board listens for keys, pastes and drops too; typing here is not for it.
  const keep = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className={cx(s.paper, s.pageCard)}
      data-paper={paper && paper !== 'transparent' ? '' : undefined}
      style={paper && paper !== 'transparent' ? ({ '--page-bg': paper } as React.CSSProperties) : undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') e.stopPropagation();
      }}
      onKeyUp={keep}
      onPaste={keep}
      onCopy={keep}
      onCut={keep}
      onDrop={keep}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolBtn({
  label,
  on,
  onClick,
  children,
  disabled,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(s.toolBtn, on && s.toolBtnOn)}
      aria-label={label}
      title={label}
      aria-pressed={on ?? undefined}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Toolbar({
  editor,
  onPickImages,
  uploading,
}: {
  editor: Editor;
  onPickImages: () => void;
  uploading: boolean;
}) {
  const { t } = useTranslation();
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : 'p',
      font: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      size: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? '',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      highlight: e.isActive('highlight'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      code: e.isActive('codeBlock'),
      callout: e.isActive('callout'),
      align: e.isActive({ textAlign: 'center' })
        ? 'center'
        : e.isActive({ textAlign: 'right' })
          ? 'right'
          : 'left',
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const fontKey = FONTS.find((f) => f.css && st.font.includes(f.css))?.key ?? '';
  const sizeKey = SIZES.find((x) => x.css && x.css === st.size)?.key ?? '';

  return (
    <div className={s.toolbar} role="toolbar" aria-label={t('lessons.page.toolbar')}>
      <div className={s.toolGroup}>
        <ToolBtn
          label={t('common.undo')}
          onClick={() => chain().undo().run()}
          disabled={!st.canUndo}
        >
          <Undo2 size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.redo')}
          onClick={() => chain().redo().run()}
          disabled={!st.canRedo}
        >
          <Redo2 size={16} />
        </ToolBtn>
      </div>

      <div className={s.toolGroup}>
        <select
          className={s.toolSelect}
          aria-label={t('lessons.page.style')}
          value={st.block}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'p') chain().setParagraph().run();
            else
              chain()
                .setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 })
                .run();
          }}
        >
          <option value="p">{t('lessons.page.text')}</option>
          <option value="h1">{t('lessons.page.h1')}</option>
          <option value="h2">{t('lessons.page.h2')}</option>
          <option value="h3">{t('lessons.page.h3')}</option>
        </select>
        <select
          className={s.toolSelect}
          aria-label={t('lessons.page.font')}
          value={fontKey}
          onChange={(e) => {
            const f = FONTS.find((x) => x.key === e.target.value);
            if (!f?.css) chain().unsetFontFamily().run();
            else chain().setFontFamily(f.css).run();
          }}
        >
          {FONTS.map((f) => (
            <option key={f.key} value={f.key} style={f.css ? { fontFamily: f.css } : undefined}>
              {t(`lessons.fonts.${f.key || 'normal'}`, { defaultValue: f.label })}
            </option>
          ))}
        </select>
        <select
          className={s.toolSelect}
          aria-label={t('lessons.page.size')}
          value={sizeKey}
          onChange={(e) => {
            const z = SIZES.find((x) => x.key === e.target.value);
            if (!z?.css) chain().unsetFontSize().run();
            else chain().setFontSize(z.css).run();
          }}
        >
          {SIZES.map((z) => (
            <option key={z.key} value={z.key}>
              {t(`lessons.sizes.${z.key || 'normal'}`, { defaultValue: z.label })}
            </option>
          ))}
        </select>
      </div>

      <div className={s.toolGroup}>
        <ToolBtn
          label={t('lessons.page.bold')}
          on={st.bold}
          onClick={() => chain().toggleBold().run()}
        >
          <Bold size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.italic')}
          on={st.italic}
          onClick={() => chain().toggleItalic().run()}
        >
          <Italic size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.underline')}
          on={st.underline}
          onClick={() => chain().toggleUnderline().run()}
        >
          <UnderlineIcon size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.strike')}
          on={st.strike}
          onClick={() => chain().toggleStrike().run()}
        >
          <Strikethrough size={16} />
        </ToolBtn>
        <Popover
          label={t('lessons.page.color')}
          trigger={
            <span className={s.colorTrigger}>
              A<span className={s.colorBar} style={{ background: st.color || 'var(--ink)' }} />
            </span>
          }
        >
          {(close) => (
            <div className={s.swatches}>
              <button
                type="button"
                className={cx(s.swatch, s.swatchNone)}
                aria-label={t('lessons.page.defaultColor')}
                title={t('lessons.page.defaultColor')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  chain().unsetColor().run();
                  close();
                }}
              >
                A
              </button>
              {TEXT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={s.swatch}
                  style={{ color: textColor(c.key) }}
                  aria-label={t(`lessons.colors.${c.key}`, { defaultValue: c.label })}
                  title={t(`lessons.colors.${c.key}`, { defaultValue: c.label })}
                  aria-pressed={st.color === textColor(c.key)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    chain().setColor(textColor(c.key)).run();
                    close();
                  }}
                >
                  A
                </button>
              ))}
            </div>
          )}
        </Popover>
        <Popover
          label={t('lessons.page.highlight')}
          trigger={<Highlighter size={16} />}
          active={st.highlight}
        >
          {(close) => (
            <div className={s.swatches}>
              <button
                type="button"
                className={cx(s.swatch, s.swatchNone)}
                aria-label={t('lessons.page.noHighlight')}
                title={t('lessons.page.noHighlight')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  chain().unsetHighlight().run();
                  close();
                }}
              >
                <Eraser size={14} />
              </button>
              {HIGHLIGHTS.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  className={s.swatch}
                  style={{ background: highlightColor(h.key) }}
                  aria-label={t(`lessons.highlights.${h.key}`, { defaultValue: h.label })}
                  title={t(`lessons.highlights.${h.key}`, { defaultValue: h.label })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    chain()
                      .setHighlight({ color: highlightColor(h.key) })
                      .run();
                    close();
                  }}
                />
              ))}
            </div>
          )}
        </Popover>
      </div>

      <div className={s.toolGroup}>
        <ToolBtn
          label={t('lessons.page.bullets')}
          on={st.bullet}
          onClick={() => chain().toggleBulletList().run()}
        >
          <List size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.numbers')}
          on={st.ordered}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.checklist')}
          on={st.task}
          onClick={() => chain().toggleTaskList().run()}
        >
          <CheckSquare size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.align', { side: st.align })}
          onClick={() => {
            const next = st.align === 'left' ? 'center' : st.align === 'center' ? 'right' : 'left';
            chain().setTextAlign(next).run();
          }}
        >
          {st.align === 'center' ? (
            <AlignCenter size={16} />
          ) : st.align === 'right' ? (
            <AlignRight size={16} />
          ) : (
            <AlignLeft size={16} />
          )}
        </ToolBtn>
      </div>

      <div className={s.toolGroup}>
        <Popover
          label={t('lessons.page.callout')}
          trigger={<span className={s.toolEmoji}>💡</span>}
          active={st.callout}
        >
          {(close) => (
            <div className={s.menu}>
              {CALLOUTS.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  className={s.menuItem}
                  data-callout-kind={c.kind}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    chain().toggleCallout(c.kind).run();
                    close();
                  }}
                >
                  <span aria-hidden>{c.emoji}</span>{' '}
                  {t(`lessons.callouts.${c.kind}`, { defaultValue: c.label })}
                </button>
              ))}
            </div>
          )}
        </Popover>
        <ToolBtn
          label={t('lessons.page.code')}
          on={st.code}
          onClick={() => chain().toggleCodeBlock().run()}
        >
          <Code size={16} />
        </ToolBtn>
        <ToolBtn
          label={t('lessons.page.divider')}
          onClick={() => chain().setHorizontalRule().run()}
        >
          <Minus size={16} />
        </ToolBtn>
        <Popover label={t('lessons.symbols')} trigger={<Smile size={16} />} align="end">
          {() => <SymbolPicker onPick={(sym) => chain().insertContent(sym).run()} />}
        </Popover>
        <ToolBtn label={t('lessons.page.picture')} onClick={onPickImages} disabled={uploading}>
          <ImagePlus size={16} />
        </ToolBtn>
      </div>
      {uploading && (
        <span className={s.toolNote} role="status">
          {t('lessons.page.uploading')}
        </span>
      )}
    </div>
  );
}
