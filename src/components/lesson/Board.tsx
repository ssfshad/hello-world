/**
 * The lesson's creative board: a free canvas for shapes, arrows, drawing,
 * text in different fonts, colours, stickers, sticky notes and photos.
 * Built on Excalidraw. Pictures are stored as lesson images (files), and the
 * saved scene only remembers which picture goes where.
 */
import './excalidrawAssets';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
import { ImagePlus, StickyNote } from 'lucide-react';
import { call, toAppError } from '@/data/client';
import { toast } from '@/components/ui';
import { SymbolPicker } from './SymbolPicker';
import { pickImages } from './images';
import type { Uploaded } from './PageEditor';
import s from './lesson.module.css';

/** What's stored in `lessons.board`. */
export interface SavedBoard {
  type: 'hello-world-board';
  version: 1;
  elements: readonly ExcalidrawElement[];
  appState: { viewBackgroundColor?: string; gridModeEnabled?: boolean };
  /** board file id → lesson image id */
  files: Record<string, string>;
}

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
    onChange: (board: string | null) => void;
    upload: (file: File) => Promise<Uploaded>;
  }
>(function Board({ lessonId, initial, onChange, upload }, ref) {
  const { t } = useTranslation();
  const theme = useDocumentTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] = useState<{
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
  } | null>(null);
  const saved = useRef<SavedBoard | null>(null);
  /** board file id → lesson image id, for every picture already stored */
  const fileMap = useRef<Record<string, string>>({});
  const uploading = useRef(new Map<string, Promise<void>>());
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
    (async () => {
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
      lastVersion.current = getSceneVersion(b?.elements ?? []);
      lastBg.current = b?.appState.viewBackgroundColor ?? '#fffdf8';
      setInitialData({
        elements: b?.elements ?? [],
        appState: {
          // The board draws dark mode by inverting colours, so light paper works for both.
          viewBackgroundColor: b?.appState.viewBackgroundColor ?? '#fffdf8',
          gridModeEnabled: b?.appState.gridModeEnabled ?? false,
          currentItemFontFamily: 5,
          currentItemRoughness: 0,
        },
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
      onChangeRef.current(null);
      return;
    }
    const used = new Set(live.flatMap((e) => (e.type === 'image' && e.fileId ? [e.fileId] : [])));
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(fileMap.current)) if (used.has(k as never)) map[k] = v;
    const board: SavedBoard = {
      type: 'hello-world-board',
      version: 1,
      elements: live,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridModeEnabled: appState.gridModeEnabled,
      },
      files: map,
    };
    onChangeRef.current(JSON.stringify(board));
  };

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
    const els = convertToExcalidrawElements(skeletons, { regenerateIds: true });
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

  useImperativeHandle(ref, () => ({ insertImages }));

  if (!initialData) return <div className={s.boardWrap} aria-busy="true" />;

  return (
    <div className={s.boardWrap} data-no-app-shortcuts="">
      <div className={s.shelf} role="toolbar" aria-label={t('lessons.board.shelf')}>
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
          initialData={{ ...initialData, scrollToContent: true }}
          onChange={handleChange}
          theme={theme}
          langCode="en"
          aiEnabled={false}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: null,
              export: false,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
});
