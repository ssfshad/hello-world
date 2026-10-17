/**
 * The lesson canvas: one big board holding written pages, shapes, arrows,
 * drawing, stickers, sticky notes and photos. Built on Excalidraw. A written
 * page is a card on the board with its own text editor (see PageEditor), so
 * writing and drawing live side by side. Pictures are stored as lesson images
 * (files), and the saved scene only remembers which picture goes where.
 */
import './excalidrawAssets';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  getSceneVersion,
  MainMenu,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  AppState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import '@excalidraw/excalidraw/index.css';
import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { FilePlus2, ImagePlus, StickyNote } from 'lucide-react';
import { call, toAppError } from '@/data/client';
import { toast } from '@/components/ui';
import { SymbolPicker } from './SymbolPicker';
import { assetUrl, pickImages } from './images';
import { PageCard, Toolbar, type ActivePage, type Uploaded } from './PageEditor';
import { assetIdsIn, docText } from './extensions';
import { CARD_H, CARD_W, PAGE_LINK, legacyDoc, pageIdOf } from './boardModel';
import type { LessonAsset } from '@/core/types/api';
import s from './lesson.module.css';

/** What's stored in `lessons.board`. */
export interface SavedBoard {
  type: 'hello-world-board';
  /** 1 had no written pages; 2 keeps them in `pages` */
  version: 1 | 2;
  elements: readonly ExcalidrawElement[];
  appState: { viewBackgroundColor?: string; gridModeEnabled?: boolean };
  /** board file id → lesson image id */
  files: Record<string, string>;
  /** written pages by id; each is a card on the board whose link is `hw-page:<id>` */
  pages?: Record<string, SavedPage>;
}

export interface SavedPage {
  doc: JSONContent | null;
  text: string;
}

/**
 * A page card: an "embeddable" element whose link points at the page. Excalidraw's
 * skeletons cannot describe embeddables, so a rectangle is made and retyped.
 */
const pageCard = (id: string, x: number, y: number): ExcalidrawElement => {
  const [rect] = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x,
      y,
      width: CARD_W,
      height: CARD_H,
      strokeColor: '#b9b29c',
      backgroundColor: 'transparent',
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
    },
  ]);
  return { ...rect, type: 'embeddable', link: PAGE_LINK + id } as ExcalidrawElement;
};

export interface BoardHandle {
  insertImages: (items: Uploaded[]) => Promise<void>;
}

const NOTE_COLORS = ['#ffec99', '#b2f2bb', '#a5d8ff', '#ffc9c9', '#eebefa', '#ffd8a8'];

function parseBoard(raw: string | null): SavedBoard | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as SavedBoard;
    return b && Array.isArray(b.elements)
      ? { ...b, files: b.files ?? {}, appState: b.appState ?? {} }
      : null;
  } catch {
    return null;
  }
}

function useDocumentTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = dataUrl;
  });
}

export const Board = forwardRef<
  BoardHandle,
  {
    lessonId: string;
    initial: string | null;
    /** a page saved before pages moved onto the board; it becomes a card */
    legacyPage: string | null;
    assets: LessonAsset[];
    /** the board as JSON plus its words for search, or null when it is empty */
    onChange: (board: string | null, text: string | null) => void;
    upload: (file: File) => Promise<Uploaded>;
  }
>(function Board({ lessonId, initial, legacyPage, assets, onChange, upload }, ref) {
  const { t } = useTranslation();
  const theme = useDocumentTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] = useState<{
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
    scrollToContent: boolean;
    files: BinaryFiles;
  } | null>(null);
  const saved = useRef<SavedBoard | null>(null);
  /** board file id → lesson image id, for every picture already stored */
  const fileMap = useRef<Record<string, string>>({});
  const uploading = useRef(new Map<string, Promise<void>>());
  /** the written pages by id; the editors report into this, it never reads from them */
  const pages = useRef(new Map<string, SavedPage>());
  /** lesson image id → displayable address, for pictures inside pages */
  const urls = useRef(new Map<string, string>());
  const [active, setActive] = useState<ActivePage | null>(null);
  const [busy, setBusy] = useState(0);
  const seq = useRef(0);
  const lastVersion = useRef<number>(-1);
  const lastBg = useRef<string | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Load the saved scene and its pictures before showing the canvas.
  useEffect(() => {
    let alive = true;
    const b = parseBoard(initial);
    saved.current = b;
    fileMap.current = { ...(b?.files ?? {}) };
    pages.current = new Map(Object.entries(b?.pages ?? {}));
    (async () => {
      // A lesson from before pages lived on the board gets its page as a card
      // beside what was already there; a brand new lesson starts with a blank page.
      let elements: readonly ExcalidrawElement[] = b?.elements ?? [];
      if (!b || b.version < 2) {
        const old = legacyDoc(legacyPage);
        if (old || !b) {
          const id = crypto.randomUUID();
          pages.current.set(id, { doc: old, text: docText(old) });
          const live = elements.filter((e) => !e.isDeleted);
          const x = live.length ? Math.min(...live.map((e) => e.x)) - CARD_W - 60 : 0;
          const y = live.length ? Math.min(...live.map((e) => e.y)) : 0;
          elements = [pageCard(id, x, y), ...elements];
        }
      }
      // Pictures written into pages need an address before the editors open.
      const wanted = new Set(
        [...pages.current.values()].flatMap((p) => (p.doc ? assetIdsIn(p.doc) : [])),
      );
      await Promise.all(
        assets
          .filter((a) => wanted.has(a.id))
          .map(async (a) => {
            try {
              urls.current.set(a.id, await assetUrl(a));
            } catch {
              // A missing picture shows as a broken image; the page still opens.
            }
          }),
      );
      const files: BinaryFiles = {};
      for (const [fileId, assetId] of Object.entries(fileMap.current)) {
        try {
          const dataURL = await call('lesson_asset_data', { id: assetId });
          const mimeType = dataURL.slice(5, dataURL.indexOf(';')) as BinaryFileData['mimeType'];
          files[fileId] = {
            id: fileId as BinaryFileData['id'],
            dataURL: dataURL as BinaryFileData['dataURL'],
            mimeType,
            created: Date.now(),
          };
        } catch {
          // A missing picture shows as an empty frame; the rest of the board still opens.
        }
      }
      if (!alive) return;
      lastVersion.current = getSceneVersion(elements);
      lastBg.current = b?.appState.viewBackgroundColor ?? '#fffdf8';
      // Open with the first page at the top left; with no pages, show everything.
      const first = elements
        .filter((e) => !e.isDeleted && pageIdOf(e))
        .sort((p, q) => p.x - q.x || p.y - q.y)[0];
      setInitialData({
        elements,
        appState: {
          // The board draws dark mode by inverting colours, so light paper works for both.
          viewBackgroundColor: b?.appState.viewBackgroundColor ?? '#fffdf8',
          gridModeEnabled: b?.appState.gridModeEnabled ?? false,
          currentItemFontFamily: 5,
          currentItemRoughness: 0,
          ...(first ? { scrollX: 32 - first.x, scrollY: 88 - first.y } : {}),
        },
        scrollToContent: !first,
        files,
      });
    })();
    return () => {
      alive = false;
    };
    // Load once per lesson.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  /** Stores any new pictures, then reports the scene. */
  const persist = async (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const mine = ++seq.current;
    const live = elements.filter((e) => !e.isDeleted);
    for (const el of live) {
      if (el.type !== 'image' || !el.fileId) continue;
      const fid = el.fileId;
      if (fileMap.current[fid]) continue;
      // Another change may already be storing this picture; wait for it.
      const running = uploading.current.get(fid);
      if (running) {
        await running;
        continue;
      }
      const f = files[fid];
      if (!f?.dataURL) continue;
      const job = (async () => {
        try {
          const ext =
            f.mimeType.split('/')[1]?.replace('svg+xml', 'svg').replace('jpeg', 'jpg') ?? '';
          const asset = await call('lesson_asset_add', {
            lesson_id: lessonId,
            data_base64: f.dataURL,
            ext,
          });
          fileMap.current[fid] = asset.id;
        } catch (e) {
          toast.error(toAppError(e).message);
        } finally {
          uploading.current.delete(fid);
        }
      })();
      uploading.current.set(fid, job);
      await job;
    }
    // A newer change arrived while pictures were uploading; it will report instead.
    if (mine !== seq.current) return;
    if (!live.length) {
      onChangeRef.current(null, null);
      return;
    }
    const used = new Set(live.flatMap((e) => (e.type === 'image' && e.fileId ? [e.fileId] : [])));
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(fileMap.current)) if (used.has(k as never)) map[k] = v;
    // Pages whose card was deleted drop out here; the editor text stays in memory
    // so undoing the delete brings the page back as it was.
    const keep: Record<string, SavedPage> = {};
    for (const el of live) {
      const id = pageIdOf(el);
      const p = id ? pages.current.get(id) : null;
      if (id && p) keep[id] = p;
    }
    const words = [
      ...Object.values(keep).map((p) => p.text),
      ...live.flatMap((e) =>
        e.type === 'text' && e.text.trim().length > 2 ? [e.text.trim()] : [],
      ),
    ]
      .filter(Boolean)
      .join('\n');
    const board: SavedBoard = {
      type: 'hello-world-board',
      version: 2,
      pages: keep,
      elements: live,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridModeEnabled: appState.gridModeEnabled,
      },
      files: map,
    };
    onChangeRef.current(JSON.stringify(board), words || null);
  };

  /** Saves again after a page changed; the drawing itself did not move. */
  const persistNow = () => {
    if (api) void persist(api.getSceneElements(), api.getAppState(), api.getFiles());
  };
  const persistNowRef = useRef(persistNow);
  useEffect(() => {
    persistNowRef.current = persistNow;
  });

  const handleChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const v = getSceneVersion(elements);
    if (v === lastVersion.current && appState.viewBackgroundColor === lastBg.current) return;
    lastVersion.current = v;
    lastBg.current = appState.viewBackgroundColor;
    void persist(elements, appState, files);
  };

  /** Centre of what's on screen, in scene coordinates. */
  const viewCenter = () => {
    const st = api!.getAppState();
    return {
      x: st.width / 2 / st.zoom.value - st.scrollX,
      y: st.height / 2 / st.zoom.value - st.scrollY,
    };
  };

  /**
   * Top-left corner for a new w×h item: the middle of the screen if it's
   * free, otherwise the nearest free spot around it, so new things never
   * land on top of what's already there.
   */
  const freeSpot = (w: number, h: number) => {
    const c = viewCenter();
    const taken = api!
      .getSceneElements()
      .filter((e) => !e.isDeleted)
      .map((e) => ({ x: e.x, y: e.y, w: Math.abs(e.width), h: Math.abs(e.height) }));
    const gap = 16;
    const hits = (x: number, y: number) =>
      taken.some(
        (r) => x < r.x + r.w + gap && x + w + gap > r.x && y < r.y + r.h + gap && y + h + gap > r.y,
      );
    const step = Math.max(40, Math.min(w, h) / 2);
    for (let ring = 0; ring < 14; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [
          [i, -ring],
          [i, ring],
          [-ring, i],
          [ring, i],
        ]) {
          const x = c.x - w / 2 + dx * step;
          const y = c.y - h / 2 + dy * step;
          if (!hits(x, y)) return { x, y };
        }
      }
    }
    return { x: c.x - w / 2, y: c.y - h / 2 };
  };

  const addElements = (skeletons: Parameters<typeof convertToExcalidrawElements>[0]) => {
    if (!api) return;
    place(convertToExcalidrawElements(skeletons, { regenerateIds: true }));
  };

  const place = (els: readonly ExcalidrawElement[]) => {
    if (!api) return;
    api.updateScene({
      elements: [...api.getSceneElements(), ...els],
      appState: {
        selectedElementIds: Object.fromEntries(
          els.filter((e) => !('containerId' in e && e.containerId)).map((e) => [e.id, true]),
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.setActiveTool({ type: 'selection' });
    // Bring the new item into view if it landed off screen.
    api.scrollToContent(els, { animate: true, duration: 300 });
  };

  const addSticker = (sym: string) => {
    const size = sym.length > 2 ? 36 : 56;
    const p = freeSpot(size * Math.max(1, sym.length * 0.6), size * 1.25);
    addElements([{ type: 'text', x: p.x, y: p.y, text: sym, fontSize: size, fontFamily: 5 }]);
  };

  const addNote = (color: string) => {
    const p = freeSpot(220, 160);
    addElements([
      {
        type: 'rectangle',
        x: p.x,
        y: p.y,
        width: 220,
        height: 160,
        backgroundColor: color,
        strokeColor: '#00000033',
        fillStyle: 'solid',
        roughness: 0,
        roundness: { type: 3 },
        label: {
          text: t('lessons.board.noteText'),
          fontSize: 22,
          fontFamily: 5,
          strokeColor: '#1e1e1e',
        },
      },
    ]);
  };

  const insertImages = async (items: Uploaded[]) => {
    if (!api) return;
    for (const up of items) {
      try {
        const dataURL = await call('lesson_asset_data', { id: up.asset.id });
        const fileId = up.asset.id as BinaryFileData['id'];
        fileMap.current[fileId] = up.asset.id;
        api.addFiles([
          {
            id: fileId,
            dataURL: dataURL as BinaryFileData['dataURL'],
            mimeType: up.asset.mime as BinaryFileData['mimeType'],
            created: Date.now(),
          },
        ]);
        const { w, h } = await imageSize(dataURL);
        const scale = Math.min(1, 520 / Math.max(w, h));
        const p = freeSpot(w * scale, h * scale);
        addElements([
          { type: 'image', fileId, x: p.x, y: p.y, width: w * scale, height: h * scale },
        ]);
      } catch (e) {
        toast.error(toAppError(e).message);
      }
    }
  };

  const addPage = () => {
    const id = crypto.randomUUID();
    pages.current.set(id, { doc: null, text: '' });
    // New pages go to the right of everything, level with the first page.
    const live = api?.getSceneElements().filter((e) => !e.isDeleted) ?? [];
    const cards = live.filter((e) => pageIdOf(e));
    const x = live.length ? Math.max(...live.map((e) => e.x + Math.abs(e.width))) + 60 : 0;
    const y = cards.length ? Math.min(...cards.map((e) => e.y)) : 0;
    place([pageCard(id, x, y)]);
  };

  useImperativeHandle(ref, () => ({ insertImages }));

  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });
  /** Pictures written into a page; remembers their address for when the page reopens. */
  const pageUpload = useCallback(async (file: File): Promise<Uploaded> => {
    setBusy((n) => n + 1);
    try {
      const up = await uploadRef.current(file);
      urls.current.set(up.asset.id, up.url);
      return up;
    } finally {
      setBusy((n) => n - 1);
    }
  }, []);

  /** Draws each written-page card. Only cards with a page link are ever valid embeds. */
  const renderEmbeddable = useCallback(
    (el: { link: string | null }) => {
      const id = pageIdOf(el);
      if (!id) return null;
      return (
        <PageCard
          initial={pages.current.get(id)?.doc ?? null}
          urls={urls.current}
          upload={pageUpload}
          onChange={(doc, text) => {
            pages.current.set(id, { doc, text });
            persistNowRef.current();
          }}
          onFocus={setActive}
          onGone={(editor: Editor) => setActive((a) => (a?.editor === editor ? null : a))}
        />
      );
    },
    [pageUpload],
  );
  const validateEmbeddable = useCallback((link: string) => link.startsWith(PAGE_LINK), []);

  const menu = useMemo(
    () => (
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
    ),
    [],
  );

  if (!initialData) return <div className={s.boardWrap} aria-busy="true" />;

  return (
    <div className={s.boardOuter} data-no-app-shortcuts="">
      {active && !active.editor.isDestroyed ? (
        <Toolbar
          editor={active.editor}
          uploading={busy > 0}
          onPickImages={async () => {
            const files = await pickImages(true);
            if (files.length) await active.insertFiles(files);
          }}
        />
      ) : (
        <p className={s.textBarHint} role="status">
          ✍️ {t('lessons.board.writeHint')}
        </p>
      )}
      <div className={s.boardWrap}>
        <div className={s.shelf} role="toolbar" aria-label={t('lessons.board.shelf')}>
          <span className={s.shelfTitle}>{t('lessons.board.pages')}</span>
          <button type="button" className={s.shelfPhoto} onClick={addPage}>
            <FilePlus2 size={16} /> {t('lessons.board.addPage')}
          </button>
          <span className={s.shelfTitle}>{t('lessons.board.stickers')}</span>
          <SymbolPicker big onPick={addSticker} />
          <span className={s.shelfTitle}>{t('lessons.board.notes')}</span>
          <div className={s.noteRow}>
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={s.noteBtn}
                style={{ background: c }}
                aria-label={t('lessons.board.addNote')}
                title={t('lessons.board.addNote')}
                onClick={() => addNote(c)}
              >
                <StickyNote size={16} color="#1e1e1e" />
              </button>
            ))}
          </div>
          <button
            type="button"
            className={s.shelfPhoto}
            onClick={async () => {
              const files = await pickImages(true);
              const ups: Uploaded[] = [];
              for (const f of files) {
                try {
                  ups.push(await upload(f));
                } catch {
                  // upload already explained the problem
                }
              }
              if (ups.length) await insertImages(ups);
            }}
          >
            <ImagePlus size={16} /> {t('lessons.board.addPhoto')}
          </button>
          <p className={s.shelfHint}>{t('lessons.board.hint')}</p>
        </div>
        <div className={s.canvas}>
          <Excalidraw
            excalidrawAPI={setApi}
            initialData={initialData}
            onChange={handleChange}
            theme={theme}
            langCode="en"
            aiEnabled={false}
            validateEmbeddable={validateEmbeddable}
            renderEmbeddable={renderEmbeddable}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: null,
                export: false,
              },
            }}
          >
            {menu}
          </Excalidraw>
        </div>
      </div>
    </div>
  );
});
