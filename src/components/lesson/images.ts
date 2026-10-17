/**
 * Getting pictures into a lesson: photos of paper notes, tablet drawings,
 * screenshots. Big photos are scaled down before they're stored, so a 12 MP
 * phone photo doesn't fill the disk.
 */
import type { LessonAsset } from '@/core/types/api';
import { fileSrc } from '@/data/platform';

/** Longest side kept for photos; plenty for reading handwriting. */
export const MAX_SIDE = 2400;
const PASS_THROUGH = new Set(['image/gif', 'image/svg+xml']);
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif,image/svg+xml';

export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name);
}

export function extOf(nameOrMime: string): string {
  const m = /\/(png|jpeg|jpg|gif|webp|bmp|avif|svg)/i.exec(nameOrMime);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return (nameOrMime.split('.').pop() ?? '').toLowerCase();
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the picture'));
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open the picture'));
    img.src = url;
  });
}

/**
 * Returns the picture as a data URL ready to upload, scaled so its longest
 * side is at most MAX_SIDE. GIFs (animation) and SVGs are kept as they are.
 */
export async function prepareImage(
  file: Blob & { name?: string },
): Promise<{ dataUrl: string; ext: string }> {
  const type = file.type || `image/${extOf(file.name ?? '')}`;
  const original = await readAsDataUrl(file);
  if (PASS_THROUGH.has(type)) return { dataUrl: original, ext: extOf(type) };
  try {
    const img = await loadImage(original);
    const side = Math.max(img.naturalWidth, img.naturalHeight);
    if (side <= MAX_SIDE && file.size < 4 * 1024 * 1024)
      return { dataUrl: original, ext: extOf(type) };
    const scale = Math.min(1, MAX_SIDE / side);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: original, ext: extOf(type) };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // WebP keeps transparency (drawings) and is small for photos.
    const webp = canvas.toDataURL('image/webp', 0.9);
    if (webp.startsWith('data:image/webp')) return { dataUrl: webp, ext: 'webp' };
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), ext: 'jpg' };
  } catch {
    return { dataUrl: original, ext: extOf(type) };
  }
}

/** A URL the webview can show for a stored lesson image. */
export async function assetUrl(a: Pick<LessonAsset, 'abs_path'>): Promise<string> {
  if (!a.abs_path) return '';
  return fileSrc(a.abs_path);
}

/** Opens the system picker for one or more pictures (works in the app and the browser). */
export function pickImages(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
