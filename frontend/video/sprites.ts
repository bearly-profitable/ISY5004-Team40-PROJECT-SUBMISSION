/**
 * Soft shapes drawn once into tiny images. Live CSS blur on big elements is by
 * far the most expensive thing the frame exporter can draw, so glows, orbs and
 * shadows are sprites stretched to size instead.
 */

const cache = new Map<string, string>();

/** A round glow fading from `color` at the centre to transparent. */
export function softDot(color: string): string {
  const key = `dot:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.45, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  // Fade the colour itself, not towards black.
  ctx.fillStyle = g;
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, size, size);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

/** A heavily blurred, darkened copy of a photo for backdrops (made once). */
export async function blurredCopy(bitmap: ImageBitmap): Promise<string> {
  const w = 64;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // Where canvas filters exist, soften further; the 64 px size already blurs.
  if ('filter' in ctx) ctx.filter = 'blur(2px) saturate(1.3)';
  ctx.drawImage(bitmap, -4, -4, w + 8, h + 8);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blur failed'))), 'image/jpeg', 0.85));
  return URL.createObjectURL(blob);
}
