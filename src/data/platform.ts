/**
 * Thin wrappers over Tauri plugins with browser fallbacks, so pages never
 * import plugin packages directly.
 */
import { isTauri } from './client';

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export async function pickFile(opts: {
  title?: string;
  extensions?: { name: string; extensions: string[] }[];
  multiple?: boolean;
}): Promise<string[] | null> {
  if (!isTauri()) {
    const p = window.prompt(opts.title ?? 'Path to file');
    return p ? [p] : null;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({
    title: opts.title,
    multiple: opts.multiple ?? false,
    directory: false,
    filters: opts.extensions,
  });
  if (res == null) return null;
  return Array.isArray(res) ? res : [res];
}

export async function pickDirectory(title?: string): Promise<string | null> {
  if (!isTauri()) return window.prompt(title ?? 'Folder path');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({ title, directory: true, multiple: false });
  return typeof res === 'string' ? res : null;
}

export async function pickSavePath(opts: {
  title?: string;
  defaultPath?: string;
  extensions?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!isTauri()) return window.prompt(opts.title ?? 'Save as', opts.defaultPath ?? '');
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ title: opts.title, defaultPath: opts.defaultPath, filters: opts.extensions });
}

export async function openUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { openUrl: open } = await import('@tauri-apps/plugin-opener');
  await open(url);
}

export async function fileSrc(absPath: string): Promise<string> {
  if (!isTauri()) return absPath;
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return convertFileSrc(absPath);
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  const n = await import('@tauri-apps/plugin-notification');
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === 'granted';
  if (granted) n.sendNotification({ title, body });
}

export interface UpdateCheck {
  available: boolean;
  version?: string;
  notes?: string;
  install?: () => Promise<void>;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) return { available: false };
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return { available: false };
  return {
    available: true,
    version: update.version,
    notes: update.body,
    install: async () => {
      await update.downloadAndInstall();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

/** Subscribe to files dropped onto the window. Returns an unsubscribe fn. */
export async function onFileDrop(
  handler: (paths: string[]) => void,
  onHover?: (hovering: boolean) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === 'over' || p.type === 'enter') onHover?.(true);
    else if (p.type === 'leave') onHover?.(false);
    else if (p.type === 'drop') {
      onHover?.(false);
      handler(p.paths);
    }
  });
}
