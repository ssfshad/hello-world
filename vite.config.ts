import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';

/**
 * The lesson board (Excalidraw) loads its fonts at runtime. Serve them from
 * the app itself so they work offline and under the app's CSP, instead of the
 * public CDN. The large CJK font (Xiaolai) is left out; the system font is
 * used for those characters.
 */
function excalidrawFonts(): Plugin {
  const src = path.resolve(import.meta.dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
  const prefix = '/excalidraw-assets/fonts/';
  const skip = new Set(['Xiaolai']);
  return {
    name: 'excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!url.startsWith(prefix)) return next();
        const file = path.resolve(src, url.slice(prefix.length));
        if (!file.startsWith(src + path.sep) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      if (!fs.existsSync(src)) return;
      for (const family of fs.readdirSync(src)) {
        if (skip.has(family)) continue;
        for (const f of fs.readdirSync(path.join(src, family))) {
          this.emitFile({
            type: 'asset',
            fileName: `excalidraw-assets/fonts/${family}/${f}`,
            source: fs.readFileSync(path.join(src, family, f)),
          });
        }
      }
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  clearScreen: false,
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/component/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
  },
});
