import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, CloudUpload, Download, Heart, Loader2, LogIn, Search, Trash2, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import {
  LibraryUnavailableError, downloadUrl, listLibrary, removeFromLibrary, setFavourite, signedUrls,
  type LibraryPhoto, type SyncProgress,
} from '../../lib/library';
import type { LightboxItem } from '../Lightbox';
import { lumiSrc } from '../Lumi';
import { gsap, prefersReducedMotion } from '../../lib/motion';
import { Img } from './shared';
import { useReveal } from './motion';

export type SyncState =
  | { status: 'idle' }
  | { status: 'syncing'; progress: SyncProgress }
  | { status: 'done'; progress: SyncProgress }
  | { status: 'error'; message: string };

const PAGE = 240;
const GAP = 4;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const monthKey = (p: LibraryPhoto) => {
  const d = new Date(p.taken_at ?? p.created_at);
  return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
};

/** Pack photos into rows that fill the width exactly, like Google Photos. */
function justify(photos: LibraryPhoto[], width: number, target: number) {
  const rows: Array<{ photos: LibraryPhoto[]; height: number }> = [];
  let row: LibraryPhoto[] = [];
  let aspectSum = 0;
  const aspect = (p: LibraryPhoto) => Math.min(3, Math.max(0.45, p.width / p.height));
  for (const photo of photos) {
    row.push(photo);
    aspectSum += aspect(photo);
    const height = (width - GAP * (row.length - 1)) / aspectSum;
    if (height <= target) {
      rows.push({ photos: row, height });
      row = [];
      aspectSum = 0;
    }
  }
  if (row.length) rows.push({ photos: row, height: Math.min(target, (width - GAP * (row.length - 1)) / aspectSum) });
  return { rows, aspect };
}

/* ------------------------------------------------
   One month of photos
   ------------------------------------------------ */
const MonthGrid: React.FC<{
  photos: LibraryPhoto[];
  width: number;
  thumbs: Record<string, string>;
  selecting: boolean;
  selected: Set<string>;
  onTile: (photo: LibraryPhoto, e: React.MouseEvent) => void;
  onToggleSelect: (photo: LibraryPhoto) => void;
  onFavourite: (photo: LibraryPhoto) => void;
}> = ({ photos, width, thumbs, selecting, selected, onTile, onToggleSelect, onFavourite }) => {
  const ref = useRef<HTMLDivElement>(null);
  const target = width < 640 ? 128 : width < 1024 ? 180 : 230;
  const { rows, aspect } = useMemo(() => justify(photos, width, target), [photos, width, target]);
  useReveal(ref, '.g-ltile', [photos.length, width > 0], { y: 16, scale: 0.97 });

  if (width <= 0) return null;
  return (
    <div ref={ref} className="flex flex-col" style={{ gap: GAP }}>
      {rows.map((row, ri) => (
        <div key={ri} className="flex" style={{ gap: GAP, height: row.height }}>
          {row.photos.map((photo) => {
            const isSelected = selected.has(photo.id);
            return (
              <div
                key={photo.id}
                className={`g-ltile group relative overflow-hidden rounded-lg bg-slate-100 cursor-pointer flex-shrink-0 ${isSelected ? 'is-selected' : ''}`}
                style={{ width: Math.floor(aspect(photo) * row.height) }}
                onClick={(e) => onTile(photo, e)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onTile(photo, e as unknown as React.MouseEvent); }}
                aria-label={photo.name ?? 'Photo'}
                aria-pressed={selecting ? isSelected : undefined}
              >
                {thumbs[photo.thumb_path] && (
                  <Img
                    src={thumbs[photo.thumb_path]}
                    alt={photo.name ?? ''}
                    className={`absolute inset-0 w-full h-full object-cover transition-transform duration-500 ease-out ${isSelected ? 'scale-[0.86] rounded-md' : 'group-hover:scale-[1.03]'}`}
                  />
                )}
                <div className={`absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/25 transition-opacity duration-300 pointer-events-none ${selecting ? 'opacity-60' : 'opacity-0 group-hover:opacity-100'}`} />

                <button
                  onClick={(e) => { e.stopPropagation(); onToggleSelect(photo); }}
                  className={`absolute top-2 left-2 z-[4] w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 ${
                    isSelected ? 'bg-lumina-500 text-white opacity-100 scale-100'
                      : `bg-white/25 ring-2 ring-white text-transparent ${selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
                  }`}
                  aria-label={isSelected ? 'Deselect' : 'Select'}
                >
                  <Check className="w-3.5 h-3.5" strokeWidth={3} />
                </button>

                {!selecting && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onFavourite(photo); }}
                    className={`absolute top-1.5 right-1.5 z-[4] w-8 h-8 rounded-full flex items-center justify-center transition-opacity duration-200 ${
                      photo.favourite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    aria-label={photo.favourite ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <Heart className={`w-[18px] h-[18px] drop-shadow ${photo.favourite ? 'fill-white text-white' : 'text-white'}`} />
                  </button>
                )}
                {photo.event_label && !selecting && (
                  <p className="absolute bottom-1.5 left-2 right-2 z-[4] text-[11px] font-semibold text-white truncate opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
                    {photo.event_label}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------
   The library
   ------------------------------------------------ */
export const LibraryView: React.FC<{
  sync: SyncState;
  reloadKey: number;
  onNotify: (message: string, kind?: 'success' | 'error' | 'info') => void;
  onOpenItems: (items: LightboxItem[], index: number) => void;
  onGoToPhotos?: () => void;
}> = ({ sync, reloadKey, onNotify, onOpenItems, onGoToPhotos }) => {
  const { user, enabled, loading: authLoading, signInWithGoogle } = useAuth();
  const [rows, setRows] = useState<LibraryPhoto[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; setup: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(PAGE);
  const [width, setWidth] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const list = await listLibrary();
      setRows(list);
      setError(null);
      const signed = await signedUrls(list.flatMap((p) => [p.thumb_path, p.storage_path]));
      setUrls(signed);
    } catch (err) {
      setRows((prev) => prev ?? []);
      setError({
        message: err instanceof Error ? err.message : 'Could not load your library.',
        setup: err instanceof LibraryUnavailableError,
      });
    }
  }, [user]);

  useEffect(() => { load(); }, [load, reloadKey]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [rows !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (rows ?? []).filter((p) => {
      if (favouritesOnly && !p.favourite) return false;
      if (!q) return true;
      return [p.event_label, p.name, ...p.people].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, filter, favouritesOnly]);

  useEffect(() => { setVisible(PAGE); }, [filter, favouritesOnly]);

  // Render more as the end comes into view; big libraries stay quick.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visible >= filtered.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible((v) => v + PAGE);
    }, { rootMargin: '800px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, filtered.length]);

  const months = useMemo(() => {
    const out: Array<{ key: string; label: string; photos: LibraryPhoto[] }> = [];
    for (const photo of filtered.slice(0, visible)) {
      const m = monthKey(photo);
      const last = out[out.length - 1];
      if (last?.key === m.key) last.photos.push(photo);
      else out.push({ ...m, photos: [photo] });
    }
    return out;
  }, [filtered, visible]);

  const selecting = selected.size > 0;

  // Slide the selection bar in and out.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || prefersReducedMotion()) return;
    gsap.fromTo(bar, { yPercent: 140, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.55, ease: 'expo.out' });
  }, [selecting]);

  const toggleSelect = (photo: LibraryPhoto, range = false) => {
    setConfirmRemove(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && lastClicked.current) {
        const a = filtered.findIndex((p) => p.id === lastClicked.current);
        const b = filtered.findIndex((p) => p.id === photo.id);
        if (a >= 0 && b >= 0) {
          filtered.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((p) => next.add(p.id));
          return next;
        }
      }
      if (next.has(photo.id)) next.delete(photo.id);
      else next.add(photo.id);
      return next;
    });
    lastClicked.current = photo.id;
  };

  const openPhoto = (photo: LibraryPhoto, e: React.MouseEvent) => {
    if (selecting || e.shiftKey) { toggleSelect(photo, e.shiftKey); return; }
    const index = filtered.findIndex((p) => p.id === photo.id);
    onOpenItems(filtered.map((p) => ({
      photo: {
        id: p.id,
        url: urls[p.thumb_path] ?? '',
        largeUrl: urls[p.thumb_path],
        fullUrl: urls[p.storage_path],
        name: p.name ?? 'photo.jpg',
        size: p.bytes ? formatBytes(p.bytes) : '',
      },
      subtitle: [p.event_label, new Date(p.taken_at ?? p.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })]
        .filter(Boolean).join(' · '),
    })), index);
  };

  const toggleFavourite = async (photo: LibraryPhoto) => {
    const next = !photo.favourite;
    setRows((prev) => prev?.map((p) => (p.id === photo.id ? { ...p, favourite: next } : p)) ?? prev);
    try {
      await setFavourite(photo.id, next);
    } catch (err) {
      setRows((prev) => prev?.map((p) => (p.id === photo.id ? { ...p, favourite: !next } : p)) ?? prev);
      onNotify(err instanceof Error ? err.message : 'Could not update favourite.', 'error');
    }
  };

  const chosen = () => (rows ?? []).filter((p) => selected.has(p.id));

  const downloadSelected = async () => {
    const photos = chosen();
    setBusy(true);
    try {
      for (const photo of photos) {
        const a = document.createElement('a');
        a.href = await downloadUrl(photo);
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        await new Promise((r) => setTimeout(r, 350));
      }
      onNotify(`Downloading ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Download failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    const photos = chosen();
    setBusy(true);
    try {
      await removeFromLibrary(photos);
      const gone = new Set(photos.map((p) => p.id));
      setRows((prev) => prev?.filter((p) => !gone.has(p.id)) ?? prev);
      setSelected(new Set());
      setConfirmRemove(false);
      onNotify(`Removed ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} from your library.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Could not remove those photos.', 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ---- states before there is anything to show ---- */

  if (!enabled || (!user && !authLoading)) {
    return (
      <EmptyCard
        pose="present"
        title="Keep every best shot, forever"
        body={enabled
          ? 'Sign in and Lumi saves the best photos from every batch you analyse into one private library: no duplicates, no blinks, sorted by when they happened.'
          : 'The library needs Supabase. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the frontend environment.'}
        action={enabled ? (
          <button onClick={() => { signInWithGoogle().catch(() => onNotify('Sign-in failed.', 'error')); }} className="btn-jelly">
            <LogIn className="w-4 h-4" /> Sign in with Google
          </button>
        ) : null}
      />
    );
  }

  if (rows === null) {
    return (
      <div ref={wrapRef} className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 gap-1" aria-busy>
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="aspect-square rounded-lg g-ph" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    );
  }

  if (error?.setup) {
    return <EmptyCard pose="think" title="One step left" body={error.message} />;
  }

  const totalBytes = (rows ?? []).reduce((n, p) => n + (p.bytes ?? 0), 0);

  return (
    <div>
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <p className="text-sm text-slate-500">
            <span className="font-bold text-slate-800">{rows.length} {rows.length === 1 ? 'photo' : 'photos'}</span>
            {totalBytes > 0 && <> · {formatBytes(totalBytes)}</>}
          </p>
          <SyncBadge sync={sync} />
        </div>
        <div className="flex items-center gap-2">
          <label className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by moment or person"
              className="w-full h-9 pl-9 pr-3 rounded-full bg-white/85 ring-1 ring-slate-200/80 text-sm outline-none focus:ring-lumina-300 transition-shadow"
            />
          </label>
          <button
            onClick={() => setFavouritesOnly((v) => !v)}
            className={`h-9 px-3.5 rounded-full text-sm font-bold flex items-center gap-1.5 transition-colors flex-shrink-0 ${
              favouritesOnly ? 'bg-slate-900 text-white' : 'bg-slate-900/[0.05] text-slate-600 hover:bg-slate-900/[0.08]'
            }`}
            aria-pressed={favouritesOnly}
          >
            <Heart className={`w-4 h-4 ${favouritesOnly ? 'fill-white' : ''}`} />
            <span className="hidden sm:inline">Favourites</span>
          </button>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-red-500">{error.message}</p>}

      <div ref={wrapRef}>
        {rows.length === 0 ? (
          <EmptyCard
            pose="carry"
            title="Your library is empty"
            body={sync.status === 'syncing'
              ? 'Lumi is carrying this batch in right now.'
              : 'Analyse a batch of photos and its best shots land here automatically.'}
            action={onGoToPhotos ? <button onClick={onGoToPhotos} className="btn-jelly btn-jelly-sm"><CloudUpload className="w-4 h-4" /> Add photos</button> : null}
          />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-500 py-12 text-center">Nothing matches that filter.</p>
        ) : (
          <div className="space-y-8">
            {months.map((month) => (
              <section key={month.key}>
                <h3 className="flex items-baseline gap-2.5 mb-3 font-display text-lg font-semibold text-slate-900">
                  {month.label}
                  <span className="font-sans text-xs font-semibold text-slate-400">
                    {month.photos.length} {month.photos.length === 1 ? 'photo' : 'photos'}
                  </span>
                </h3>
                <MonthGrid
                  photos={month.photos}
                  width={width}
                  thumbs={urls}
                  selecting={selecting}
                  selected={selected}
                  onTile={openPhoto}
                  onToggleSelect={(p) => toggleSelect(p)}
                  onFavourite={toggleFavourite}
                />
              </section>
            ))}
            {visible < filtered.length && (
              <div ref={sentinelRef} className="flex justify-center py-6 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selection bar */}
      {selecting && (
        <div className="fixed inset-x-0 bottom-5 z-[320] flex justify-center px-4 pointer-events-none">
          <div ref={barRef} className="pointer-events-auto flex items-center gap-1 sm:gap-2 rounded-full bg-slate-900 text-white pl-2 pr-2 py-1.5 shadow-2xl shadow-slate-900/30 max-w-full">
            <button onClick={() => { setSelected(new Set()); setConfirmRemove(false); }} className="w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center" aria-label="Clear selection">
              <X className="w-4 h-4" />
            </button>
            {confirmRemove ? (
              <>
                <span className="text-sm font-semibold px-1 whitespace-nowrap">Delete {selected.size} stored {selected.size === 1 ? 'copy' : 'copies'}?</span>
                <button onClick={() => setConfirmRemove(false)} className="h-9 px-3 rounded-full text-sm font-bold hover:bg-white/10">Keep</button>
                <button onClick={removeSelected} disabled={busy} className="h-9 px-3.5 rounded-full text-sm font-bold bg-red-500 hover:bg-red-600 flex items-center gap-1.5 disabled:opacity-60">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete
                </button>
              </>
            ) : (
              <>
                <span className="text-sm font-bold tabular-nums px-1 whitespace-nowrap">{selected.size} selected</span>
                <button onClick={downloadSelected} disabled={busy} className="h-9 px-3.5 rounded-full text-sm font-bold hover:bg-white/10 flex items-center gap-1.5 disabled:opacity-60">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  <span className="hidden sm:inline">Download</span>
                </button>
                <button onClick={() => setConfirmRemove(true)} className="h-9 px-3.5 rounded-full text-sm font-bold hover:bg-white/10 flex items-center gap-1.5 text-red-300">
                  <Trash2 className="w-4 h-4" />
                  <span className="hidden sm:inline">Remove</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SyncBadge: React.FC<{ sync: SyncState }> = ({ sync }) => {
  if (sync.status === 'syncing') {
    const { done, total } = sync.progress;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return (
      <span className="inline-flex items-center gap-2 h-7 pl-2 pr-3 rounded-full bg-lumina-500/10 text-lumina-600 text-xs font-bold" title="Saving this batch's best photos to your library">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Saving {done}/{total}
        <span className="w-12 h-1 rounded-full bg-lumina-500/20 overflow-hidden">
          <span className="block h-full bg-lumina-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </span>
      </span>
    );
  }
  if (sync.status === 'done' && sync.progress.added > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-emerald-500/10 text-emerald-600 text-xs font-bold">
        <CheckCircle2 className="w-3.5 h-3.5" /> {sync.progress.added} new saved
      </span>
    );
  }
  if (sync.status === 'error') {
    return <span className="text-xs text-red-500 truncate" title={sync.message}>Couldn&rsquo;t save this batch</span>;
  }
  return null;
};

const EmptyCard: React.FC<{ pose: Parameters<typeof lumiSrc>[0]; title: string; body: string; action?: React.ReactNode }> = ({
  pose, title, body, action,
}) => (
  <div className="flex flex-col items-center text-center py-14 px-4">
    <img src={lumiSrc(pose)} alt="" aria-hidden className="lumi-sprite h-32 w-auto mb-5" data-anim="pop" />
    <h3 className="font-display text-2xl sm:text-3xl font-semibold text-slate-900">{title}</h3>
    <p className="text-sm text-slate-500 mt-2 max-w-md leading-relaxed">{body}</p>
    {action && <div className="mt-6">{action}</div>}
  </div>
);
