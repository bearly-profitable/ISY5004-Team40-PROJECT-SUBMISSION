import type { Event } from '../types';
import { fetchMediaBlob } from '../lib/analysisApi';
import { poseForEvent } from '../lib/lumiScenes';
import type { MovieChapter, MoviePhoto } from './storyboard';

/**
 * Getting photos ready for the movie. The frame renderer reads pixels, which
 * cross-origin images would block, so every photo is fetched once into a
 * same-origin blob: URL, measured, and (if huge) scaled down.
 */

const MAX_SIDE = 2560;

export interface PhotoSource { id: string; url: string }

async function prepareOne(source: PhotoSource, focal: [number, number] | undefined, signal?: AbortSignal): Promise<MoviePhoto> {
  const blob = await fetchMediaBlob(source.url, signal);
  const bitmap = await createImageBitmap(blob);
  let { width, height } = bitmap;
  let out: Blob = blob;
  const k = MAX_SIDE / Math.max(width, height);
  if (k < 1) {
    width = Math.round(width * k);
    height = Math.round(height * k);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    out = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not resize photo.'))), 'image/jpeg', 0.9));
  }
  bitmap.close();
  return { id: source.id, src: URL.createObjectURL(out), width, height, focal };
}

/** Load photos a few at a time; failures are skipped rather than fatal. */
export async function preparePhotos(
  sources: PhotoSource[],
  focal: Map<string, [number, number]>,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string, MoviePhoto>> {
  const out = new Map<string, MoviePhoto>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < sources.length) {
      if (signal?.aborted) return;
      const source = sources[next++];
      try {
        out.set(source.id, await prepareOne(source, focal.get(source.id), signal));
      } catch (err) {
        if (signal?.aborted) return;
        console.warn('[Lumina] Skipping a photo for the video:', err);
      }
      onProgress(++done, sources.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, sources.length) }, worker));
  return out;
}

export function releasePhotos(photos: Iterable<MoviePhoto>): void {
  for (const p of photos) URL.revokeObjectURL(p.src);
}

/** Moments become chapters, in time order; each opens on its best photo. */
export function buildChapters(events: Event[], selected: Set<string>, loaded: Map<string, MoviePhoto>): MovieChapter[] {
  const ordered = [...events].sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
  const chapters: MovieChapter[] = [];
  ordered.forEach((evt) => {
    const score = new Map(evt.members.map((m) => [m.photoId, m.finalScore]));
    const ids = evt.photoIds.filter((id) => selected.has(id) && loaded.has(id));
    if (!ids.length) return;
    const best = ids.includes(evt.topPhotoId)
      ? evt.topPhotoId
      : ids.reduce((a, b) => ((score.get(b) ?? 0) > (score.get(a) ?? 0) ? b : a));
    const rest = ids.filter((id) => id !== best);
    chapters.push({
      title: evt.label,
      dateLabel: evt.dateLabel,
      pose: poseForEvent([evt.label, evt.autoLabel?.label], chapters.length),
      photos: [best, ...rest].map((id) => loaded.get(id)!),
    });
  });
  return chapters;
}

/** "12 Mar 2026", or "12 Mar – 3 Apr 2026" across several moments. */
export function dateSpan(events: Event[]): string {
  const labels = [...events]
    .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity))
    .map((e) => e.dateLabel)
    .filter((d): d is string => Boolean(d));
  if (!labels.length) return '';
  const first = labels[0];
  const last = labels[labels.length - 1];
  return first === last ? first : `${first} – ${last}`;
}
