import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Crown, Download, Loader2, Trash2 } from 'lucide-react';
import type { Event, EventMember, FaceBox, Identity, Photo, RejectFlag } from '../../types';
import type { LightboxItem } from '../Lightbox';
import { REJECT_FLAG_UI } from '../../lib/signals';
import { lumiSrc } from '../Lumi';
import { FaceRing, Img, downloadPhoto, useFocal } from './shared';
import { useReveal } from './motion';

/* ------------------------------------------------
   Which photos count as "the gallery"
   ------------------------------------------------ */

/** An event's keepers: everything not flagged as a duplicate, blink, blur or
 *  low quality, plus its best shot and each person's best shot no matter what. */
export function keeperIds(evt: Event): Set<string> {
  const members = new Map<string, EventMember>(evt.members.map((m) => [m.photoId, m]));
  const keep = new Set<string>();
  for (const photo of evt.photos) {
    if (!(members.get(photo.id)?.flags?.length)) keep.add(photo.id);
  }
  keep.add(evt.topPhotoId);
  evt.bestByPerson?.forEach((b) => keep.add(b.photoId));
  return keep;
}

/** A delete that needs a second click within a few seconds. */
function useArmed(): [boolean, (armed: boolean) => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return [armed, setArmed];
}

const DeleteButton: React.FC<{ label: string; busy?: boolean; onConfirm: () => void }> = ({ label, busy, onConfirm }) => {
  const [armed, setArmed] = useArmed();
  return (
    <button
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      disabled={busy}
      className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-sm font-bold transition-colors disabled:opacity-50 flex-shrink-0 ${
        armed ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-slate-900/[0.05] text-slate-600 hover:bg-red-50 hover:text-red-600'
      }`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
      {armed ? 'Click again to delete' : label}
    </button>
  );
};

/* ------------------------------------------------
   One square tile
   ------------------------------------------------ */
export interface TileProps {
  photo: Photo;
  onOpen: () => void;
  isBest?: boolean;
  flags?: RejectFlag[];
  caption?: string;
  faceBox?: FaceBox | null;
  onMakeBest?: () => void;
  /** Delete for good (asks for a second click). */
  onDelete?: () => void;
  deleting?: boolean;
  eager?: boolean;
  className?: string;
  /** Use the sharper thumbnail (large tiles). */
  large?: boolean;
  children?: React.ReactNode;
}

export const PhotoTile: React.FC<TileProps> = ({
  photo, onOpen, isBest, flags, caption, faceBox, onMakeBest, onDelete, deleting, eager, className = '', large, children,
}) => {
  const [aspect, setAspect] = useState<number | null>(null);
  const [armed, setArmed] = useArmed();
  const focal = useFocal(photo.id);
  return (
    <div
      className={`g-tile group relative overflow-hidden rounded-xl bg-slate-100 cursor-zoom-in transition-opacity ${deleting ? 'opacity-40 pointer-events-none' : ''} ${className}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      aria-label={`Open ${photo.name}`}
    >
      <Img
        src={(large && photo.largeUrl) || photo.url}
        alt={photo.name}
        eager={eager}
        focal={focal}
        onAspect={faceBox ? setAspect : undefined}
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
      />
      {faceBox && <FaceRing bbox={faceBox} imageAspect={aspect} focal={focal} />}
      <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/0 to-black/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

      {isBest && (
        <span className="absolute top-2 left-2 z-[4] w-6 h-6 rounded-full bg-white/90 text-amber-500 flex items-center justify-center shadow-sm" title="Best shot of this moment">
          <Crown className="w-3.5 h-3.5" />
        </span>
      )}
      {(flags?.length ?? 0) > 0 && (
        <div className="absolute bottom-2 left-2 z-[4] flex gap-1 pointer-events-none">
          {flags!.slice(0, 2).map((flag) => (
            <span key={flag} className="px-1.5 py-0.5 rounded-md bg-slate-900/70 backdrop-blur-sm text-white text-[10px] font-bold">
              {REJECT_FLAG_UI[flag]?.label ?? flag}
            </span>
          ))}
        </div>
      )}
      {caption && (
        <p className="absolute bottom-2 left-2 right-10 z-[4] text-[11px] font-semibold text-white truncate opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
          {caption}
        </p>
      )}

      <div className={`absolute top-2 right-2 z-[5] flex gap-1.5 transition-opacity duration-300 ${
        armed || deleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
      }`}>
        {onMakeBest && !isBest && (
          <button
            onClick={(e) => { e.stopPropagation(); onMakeBest(); }}
            className="w-8 h-8 rounded-full bg-white/90 text-slate-700 hover:text-amber-500 flex items-center justify-center shadow-sm transition-colors"
            title="Make this the best shot (Lumina learns your taste)"
            aria-label="Make best shot"
          >
            <Crown className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); downloadPhoto(photo); }}
          className="w-8 h-8 rounded-full bg-white/90 text-slate-700 hover:text-slate-900 flex items-center justify-center shadow-sm transition-colors"
          title="Download"
          aria-label="Download"
        >
          <Download className="w-4 h-4" />
        </button>
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (armed) { setArmed(false); onDelete(); } else setArmed(true);
            }}
            className={`h-8 rounded-full flex items-center justify-center gap-1 shadow-sm transition-all ${
              armed ? 'px-2.5 bg-red-500 text-white text-xs font-bold' : 'w-8 bg-white/90 text-slate-700 hover:text-red-500'
            }`}
            title={armed ? 'Click again to delete for good' : 'Delete'}
            aria-label={armed ? 'Confirm delete' : 'Delete'}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {armed && 'Delete?'}
          </button>
        )}
      </div>
      {children}
    </div>
  );
};

/* ------------------------------------------------
   A plain responsive grid of tiles
   ------------------------------------------------ */
export interface GridEntry {
  photo: Photo;
  event?: Event | null;
  flags?: RejectFlag[];
  isBest?: boolean;
  caption?: string;
}

export const PhotoGrid: React.FC<{
  entries: GridEntry[];
  onOpen: (index: number) => void;
  onMakeBest?: (eventId: string, photoId: string) => void;
  onDelete?: (photoId: string) => void;
  deleting?: ReadonlySet<string>;
  highlightPerson?: Identity | null;
  eagerCount?: number;
  className?: string;
}> = ({ entries, onOpen, onMakeBest, onDelete, deleting, highlightPerson, eagerCount = 0, className = '' }) => {
  const ref = useRef<HTMLDivElement>(null);
  useReveal(ref, '.g-tile', [entries.length], { y: 18, scale: 0.97 });
  return (
    <div
      ref={ref}
      className={`grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-1 sm:gap-1.5 ${className}`}
    >
      {entries.map((entry, i) => (
        <PhotoTile
          key={entry.photo.id}
          photo={entry.photo}
          className="aspect-square"
          eager={i < eagerCount}
          isBest={entry.isBest}
          flags={entry.flags}
          caption={entry.caption}
          faceBox={highlightPerson?.faceBoxes?.[entry.photo.id] ?? null}
          onOpen={() => onOpen(i)}
          onMakeBest={onMakeBest && entry.event ? () => onMakeBest(entry.event!.id, entry.photo.id) : undefined}
          onDelete={onDelete ? () => onDelete(entry.photo.id) : undefined}
          deleting={deleting?.has(entry.photo.id)}
        />
      ))}
    </div>
  );
};

/* ------------------------------------------------
   All photos — every shot, or each moment's best
   ------------------------------------------------ */
export const AllPhotosView: React.FC<{
  events: Event[];
  person: Identity | null;
  highlightPerson: Identity | null;
  onOpenItems: (items: LightboxItem[], index: number) => void;
  onMakeBest: (eventId: string, photoId: string) => void;
}> = ({ events, person, highlightPerson, onOpenItems, onMakeBest }) => {
  const [mode, setMode] = useState<'all' | 'best'>('best');

  const flat = useMemo(() => {
    const personPhotos = person ? new Set(person.photoIds) : null;
    const out: GridEntry[] = [];
    for (const evt of events) {
      const keep = keeperIds(evt);
      const members = new Map<string, EventMember>(evt.members.map((m) => [m.photoId, m]));
      // The moment's best shot, or with a person picked, their best shot in it.
      const best = person
        ? evt.bestByPerson?.find((b) => b.personId === person.id)?.photoId
          ?? (personPhotos?.has(evt.topPhotoId) ? evt.topPhotoId : undefined)
        : evt.topPhotoId;
      for (const photo of evt.photos) {
        if (personPhotos && !personPhotos.has(photo.id)) continue;
        if (mode === 'best' && photo.id !== best) continue;
        out.push({
          photo,
          event: evt,
          isBest: photo.id === evt.topPhotoId,
          flags: keep.has(photo.id) ? undefined : members.get(photo.id)?.flags,
          caption: evt.label,
        });
      }
    }
    return out;
  }, [events, person, mode]);

  const total = flat.length;
  const open = (index: number) => onOpenItems(flat.map((e) => ({ photo: e.photo, event: e.event })), index);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <p className="text-sm text-slate-500">
          <span className="font-bold text-slate-800">{total} {total === 1 ? 'photo' : 'photos'}</span>
          {person && <> with <span className="font-bold text-slate-800">{person.label}</span></>}
          {mode === 'best' && <> · the best shot of each moment</>}
        </p>
        <div className="inline-flex rounded-full bg-slate-900/[0.05] p-1" role="group" aria-label="Which photos to show">
          {([['best', 'Best shots'], ['all', 'Show all']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={`h-7 px-3.5 rounded-full text-sm font-bold transition-colors ${
                mode === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <PhotoGrid
        entries={flat}
        eagerCount={12}
        highlightPerson={highlightPerson}
        onMakeBest={onMakeBest}
        onOpen={open}
      />
    </div>
  );
};

/* ------------------------------------------------
   Cleanup — what Lumina thinks you can delete
   ------------------------------------------------ */
const FLAG_ORDER: RejectFlag[] = ['duplicate', 'eyes_closed', 'blurry', 'low_quality'];

export const CleanupView: React.FC<{
  rejects: Array<{ photo: Photo; member: EventMember; event: Event }>;
  onOpenItems: (items: LightboxItem[], index: number) => void;
  /** Deletes photos for good; absent when the session is not saved. */
  onDelete?: (photoIds: string[]) => Promise<void>;
}> = ({ rejects, onOpenItems, onDelete }) => {
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const remove = async (photoIds: string[]) => {
    if (!onDelete) return;
    setDeleting((prev) => new Set([...prev, ...photoIds]));
    try {
      await onDelete(photoIds);
    } finally {
      setDeleting((prev) => new Set([...prev].filter((id) => !photoIds.includes(id))));
    }
  };

  const groups = useMemo(() => FLAG_ORDER
    .map((flag) => ({
      flag,
      entries: rejects.filter((r) => (r.member.flags ?? [])[0] === flag),
    }))
    .filter((g) => g.entries.length > 0), [rejects]);

  if (rejects.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-16">
        <img src={lumiSrc('celebrate')} alt="" aria-hidden className="lumi-sprite h-32 w-auto mb-4" />
        <h3 className="font-display text-2xl font-semibold text-slate-900">Nothing to clean up</h3>
        <p className="text-sm text-slate-500 mt-1">No duplicates, blinks or blurry shots in this batch.</p>
      </div>
    );
  }

  const flat = groups.flatMap((g) => g.entries);
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-8">
        <div className="flex items-center gap-4 max-w-2xl">
          <img src={lumiSrc('sort')} alt="" aria-hidden className="lumi-sprite h-16 w-auto flex-shrink-0" />
          <p className="text-sm text-slate-500 leading-relaxed">
            Lumi set aside <span className="font-bold text-slate-800">{flat.length} {flat.length === 1 ? 'photo' : 'photos'}</span> that
            a better shot already covers. Nothing is deleted until you say so, and deleting can&apos;t be undone.
          </p>
        </div>
        {onDelete && (
          <div className="sm:ml-auto">
            <DeleteButton
              label={`Delete all ${flat.length}`}
              busy={flat.some((r) => deleting.has(r.photo.id))}
              onConfirm={() => remove(flat.map((r) => r.photo.id))}
            />
          </div>
        )}
      </div>
      <div className="space-y-10">
        {groups.map((group) => {
          const offset = flat.indexOf(group.entries[0]);
          return (
            <section key={group.flag}>
              <header className="flex items-center gap-3 mb-3">
                <div className="flex flex-wrap items-baseline gap-x-3 min-w-0">
                  <h3 className="font-display text-lg sm:text-xl font-semibold text-slate-900">{REJECT_FLAG_UI[group.flag].label}</h3>
                  <span className="text-xs text-slate-400">{REJECT_FLAG_UI[group.flag].hint} · {group.entries.length}</span>
                </div>
                {onDelete && groups.length > 1 && (
                  <div className="ml-auto">
                    <DeleteButton
                      label="Delete these"
                      busy={group.entries.some((r) => deleting.has(r.photo.id))}
                      onConfirm={() => remove(group.entries.map((r) => r.photo.id))}
                    />
                  </div>
                )}
              </header>
              <PhotoGrid
                entries={group.entries.map((r) => ({ photo: r.photo, event: r.event, caption: r.event.label }))}
                onOpen={(i) => onOpenItems(flat.map((r) => ({ photo: r.photo, event: r.event })), offset + i)}
                onDelete={onDelete ? (photoId) => remove([photoId]) : undefined}
                deleting={deleting}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
};
