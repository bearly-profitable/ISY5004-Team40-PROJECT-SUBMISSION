/**
 * Small thumbnails for freshly picked photos.
 *
 * A phone photo is 12+ megapixels; showing thirty of them as grid tiles makes
 * the browser decode and hold every original (~50 MB of bitmap each), which is
 * what made the upload and processing pages stutter. Each file is decoded once
 * here (off the main thread, via createImageBitmap) into a ~400px JPEG.
 */

const THUMB_EDGE = 400;
const CONCURRENCY = 3;

async function makeThumb(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    // Let the decoder scale while it decodes, where the browser supports it.
    bitmap = await createImageBitmap(file, { resizeWidth: THUMB_EDGE, resizeQuality: 'medium' });
  } catch {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return null; // HEIC and friends: the grid falls back to the original.
    }
  }
  try {
    const scale = Math.min(1, THUMB_EDGE / Math.min(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}

/** Make thumbnails a few at a time, reporting each as it's ready
 *  (null when this browser can't make one, so the caller can fall back). */
export async function makeThumbnails(
  items: Array<{ id: string; file: File }>,
  onThumb: (id: string, url: string | null) => void,
): Promise<void> {
  if (typeof createImageBitmap !== 'function') {
    items.forEach((item) => onThumb(item.id, null));
    return;
  }
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      onThumb(item.id, await makeThumb(item.file));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}
