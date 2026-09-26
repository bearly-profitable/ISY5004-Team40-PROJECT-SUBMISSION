/**
 * The library: a signed-in user's permanent, de-duplicated photo collection.
 *
 * Rows live in public.library_photos and files in the private `library`
 * bucket (supabase/migrations/20260927000000_library.sql). The gallery saves
 * each session's best photos here; the same image arriving from two sessions
 * is stored once, keyed by the SHA-256 of its bytes.
 */
import { supabase } from './supabase';

const BUCKET = 'library';
const TABLE = 'library_photos';
const SIGN_TTL_S = 6 * 60 * 60;
const THUMB_MAX_H = 480;
const THUMB_MAX_W = 960;

export interface LibraryPhoto {
  id: string;
  content_hash: string;
  storage_path: string;
  thumb_path: string;
  name: string | null;
  mime_type: string | null;
  bytes: number | null;
  width: number;
  height: number;
  taken_at: string | null;
  event_label: string | null;
  people: string[];
  score: number | null;
  is_best: boolean;
  favourite: boolean;
  source_keys: string[];
  created_at: string;
}

/** A photo from an analysed session, ready to be saved to the library. */
export interface LibrarySyncItem {
  photoId: string;
  name: string;
  /** Where the original bytes can be fetched (blob: or the backend). */
  sourceUrl: string;
  /** Unix seconds, from the event's EXIF time. */
  takenAt: number | null;
  eventLabel: string | null;
  people: string[];
  score: number | null;
  isBest: boolean;
}

export class LibraryUnavailableError extends Error {}

/** Turn Supabase errors into something a person can act on. */
function describe(error: { code?: string; message: string }): Error {
  if (error.code === '42P01' || error.code === 'PGRST205') {
    return new LibraryUnavailableError(
      'The library is not set up in Supabase yet: run supabase/migrations/20260927000000_library.sql.',
    );
  }
  if (/bucket not found/i.test(error.message)) {
    return new LibraryUnavailableError(
      'The library bucket is missing: run supabase/migrations/20260927000000_library.sql.',
    );
  }
  return new Error(error.message);
}

function client() {
  if (!supabase) throw new LibraryUnavailableError('Supabase is not configured for this build.');
  return supabase;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** Every library photo, newest moment first. */
export async function listLibrary(): Promise<LibraryPhoto[]> {
  const sb = client();
  const PAGE = 1000;
  const rows: LibraryPhoto[] = [];
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await sb
      .from(TABLE)
      .select('*')
      .order('taken_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw describe(error);
    rows.push(...(data as LibraryPhoto[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

const signedCache = new Map<string, { url: string; expires: number }>();

/** Signed URLs for private objects, cached until shortly before they expire. */
export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const sb = client();
  const now = Date.now();
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const path of paths) {
    const hit = signedCache.get(path);
    if (hit && hit.expires > now) out[path] = hit.url;
    else missing.push(path);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(chunk, SIGN_TTL_S);
    if (error) throw describe(error);
    for (const entry of data ?? []) {
      if (!entry.path || !entry.signedUrl) continue;
      out[entry.path] = entry.signedUrl;
      signedCache.set(entry.path, { url: entry.signedUrl, expires: now + (SIGN_TTL_S - 300) * 1000 });
    }
  }
  return out;
}

/** A one-off URL that downloads the original under its own file name. */
export async function downloadUrl(photo: LibraryPhoto): Promise<string> {
  const { data, error } = await client().storage
    .from(BUCKET)
    .createSignedUrl(photo.storage_path, 120, { download: photo.name || true });
  if (error) throw describe(error);
  return data.signedUrl;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export async function setFavourite(id: string, favourite: boolean): Promise<void> {
  const { error } = await client().from(TABLE).update({ favourite }).eq('id', id);
  if (error) throw describe(error);
}

/** Remove photos from the library: their files first, then the rows. */
export async function removeFromLibrary(photos: LibraryPhoto[]): Promise<void> {
  if (photos.length === 0) return;
  const sb = client();
  const paths = photos.flatMap((p) => [p.storage_path, p.thumb_path]);
  const { error: storageError } = await sb.storage.from(BUCKET).remove(paths);
  if (storageError) throw describe(storageError);
  const { error } = await sb.from(TABLE).delete().in('id', photos.map((p) => p.id));
  if (error) throw describe(error);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Oriented size plus a small WebP for the grid. */
async function makeThumb(blob: Blob): Promise<{ thumb: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const { width, height } = bitmap;
  const scale = Math.min(1, THUMB_MAX_H / height, THUMB_MAX_W / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const thumb = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  if (!thumb) throw new Error('Could not encode a thumbnail.');
  return { thumb, width, height };
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif',
};

export interface SyncProgress {
  total: number;
  done: number;
  added: number;
  failed: number;
}

/**
 * Save a session's photos to the library. Idempotent: photos already saved
 * from this session are skipped without being downloaded, and an image that
 * is already in the library from another session only gains a source key.
 */
export async function syncToLibrary(
  userId: string,
  jobId: string,
  items: LibrarySyncItem[],
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncProgress> {
  const sb = client();
  const keyOf = (item: LibrarySyncItem) => `${jobId}/${item.photoId}`;

  const { data: known, error: knownError } = await sb
    .from(TABLE)
    .select('source_keys')
    .overlaps('source_keys', items.map(keyOf));
  if (knownError) throw describe(knownError);
  const seen = new Set((known ?? []).flatMap((row) => row.source_keys as string[]));
  const todo = items.filter((item) => !seen.has(keyOf(item)));

  const progress: SyncProgress = { total: todo.length, done: 0, added: 0, failed: 0 };
  onProgress?.({ ...progress });
  if (todo.length === 0) return progress;

  const saveOne = async (item: LibrarySyncItem) => {
    const response = await fetch(item.sourceUrl);
    if (!response.ok) throw new Error(`Could not read ${item.name} (${response.status}).`);
    const blob = await response.blob();
    const hash = await sha256Hex(await blob.arrayBuffer());
    const key = keyOf(item);

    const { data: existing, error: existingError } = await sb
      .from(TABLE).select('id, source_keys').eq('content_hash', hash).maybeSingle();
    if (existingError) throw describe(existingError);
    if (existing) {
      const keys = new Set<string>(existing.source_keys as string[]);
      keys.add(key);
      const { error } = await sb.from(TABLE).update({ source_keys: [...keys] }).eq('id', existing.id);
      if (error) throw describe(error);
      return false;
    }

    const { thumb, width, height } = await makeThumb(blob);
    const mime = blob.type || 'image/jpeg';
    const storagePath = `${userId}/${hash}.${EXT[mime] ?? 'jpg'}`;
    const thumbPath = `${userId}/${hash}_t.webp`;
    const bucket = sb.storage.from(BUCKET);
    const [original, small] = await Promise.all([
      bucket.upload(storagePath, blob, { contentType: mime, upsert: true, cacheControl: '31536000' }),
      bucket.upload(thumbPath, thumb, { contentType: 'image/webp', upsert: true, cacheControl: '31536000' }),
    ]);
    if (original.error) throw describe(original.error);
    if (small.error) throw describe(small.error);

    const { error } = await sb.from(TABLE).upsert({
      user_id: userId,
      content_hash: hash,
      storage_path: storagePath,
      thumb_path: thumbPath,
      name: item.name.slice(0, 255),
      mime_type: mime,
      bytes: blob.size,
      width,
      height,
      taken_at: item.takenAt ? new Date(item.takenAt * 1000).toISOString() : null,
      event_label: item.eventLabel?.slice(0, 120) ?? null,
      people: item.people,
      score: item.score,
      is_best: item.isBest,
      source_keys: [key],
    }, { onConflict: 'user_id,content_hash', ignoreDuplicates: true });
    if (error) throw describe(error);
    return true;
  };

  // A few at a time: fast on a good connection without starving the page.
  let cursor = 0;
  let fatal: Error | null = null;
  const worker = async () => {
    while (cursor < todo.length && !fatal) {
      const item = todo[cursor++];
      try {
        if (await saveOne(item)) progress.added += 1;
      } catch (err) {
        if (err instanceof LibraryUnavailableError) fatal = err;
        progress.failed += 1;
      }
      progress.done += 1;
      onProgress?.({ ...progress });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (fatal) throw fatal;
  return progress;
}
