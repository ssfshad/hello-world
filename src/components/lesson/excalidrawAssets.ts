// The board's fonts ship with the app (see vite.config.ts), not from a CDN.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
if (typeof window !== 'undefined') window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
export {};
