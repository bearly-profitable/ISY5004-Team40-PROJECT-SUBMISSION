
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Award,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Crown,
  Download,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import { Event, EventMember, Photo } from '../types';
import { REJECT_FLAG_UI, SIGNAL_UI } from '../lib/signals';
import { gsap, prefersReducedMotion } from '../lib/motion';
import { downloadPhoto as saveFile } from './gallery/shared';

export interface LightboxItem {
  photo: Photo;
  event?: Event | null;
  /** Shown in the top bar when there is no event (library photos). */
  subtitle?: string;
}

interface LightboxProps {
  items: LightboxItem[];
  index: number;
  onNavigate: (index: number) => void;
  onClose: () => void;
  onMakeBest?: (eventId: string, photoId: string) => void;
}

function fullSrc(photo: Photo): string {
  return photo.fullUrl ?? photo.url;
}

/** The small version already in the browser cache, shown while the original loads. */
function previewSrc(photo: Photo): string {
  return photo.largeUrl ?? photo.url;
}

function downloadPhoto(photo: Photo) {
  saveFile(photo);
}

const SignalBars: React.FC<{ member: EventMember; compareWith?: EventMember | null }> = ({ member, compareWith }) => (
  <div className="space-y-2.5">
    {SIGNAL_UI.map(({ key, label }) => {
      const value = member.normSignals?.[key] ?? 0;
      const other = compareWith?.normSignals?.[key];
      const delta = other !== undefined ? value - other : null;
      return (
        <div key={key}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-widest text-white/40 font-medium">{label}</span>
            <span className="text-[10px] font-bold tabular-nums text-white/70">
              {Math.round(value * 100)}
              {delta !== null && Math.abs(delta) >= 0.005 && (
                <span className={delta > 0 ? 'text-green-400 ml-1' : 'text-red-400 ml-1'}>
                  {delta > 0 ? '+' : ''}{Math.round(delta * 100)}
                </span>
              )}
            </span>
          </div>
          <div className="h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-lumina-400 to-lumina-500 transition-all duration-500"
              style={{ width: `${Math.round(value * 100)}%` }}
            />
          </div>
        </div>
      );
    })}
  </div>
);

export const Lightbox: React.FC<LightboxProps> = ({ items, index, onNavigate, onClose, onMakeBest }) => {
  const [loaded, setLoaded] = useState(false);
  const [compare, setCompare] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const item = items[index];
  const event = item?.event ?? null;

  const member = useMemo<EventMember | null>(() => {
    if (!item || !event) return null;
    return event.members.find((m) => m.photoId === item.photo.id) ?? null;
  }, [item, event]);

  const rank = useMemo(() => {
    if (!member || !event) return null;
    return event.members.findIndex((m) => m.photoId === member.photoId);
  }, [member, event]);

  const bestMember = useMemo<EventMember | null>(() => {
    if (!event) return null;
    return event.members.find((m) => m.photoId === event.topPhotoId) ?? null;
  }, [event]);

  const bestPhoto = useMemo<Photo | null>(() => {
    if (!event) return null;
    return event.photos.find((p) => p.id === event.topPhotoId) ?? null;
  }, [event]);

  const isTop = event ? item?.photo.id === event.topPhotoId : false;
  const canCompare = Boolean(event && bestMember && bestPhoto && !isTop && member);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const direction = useRef(0);
  const touchX = useRef<number | null>(null);

  const go = useCallback((delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) {
      direction.current = delta;
      setLoaded(false);
      setCompare(false);
      onNavigate(next);
    }
  }, [index, items.length, onNavigate]);

  // Open: the backdrop fades while the photo rises into place.
  useLayoutEffect(() => {
    if (!rootRef.current || prefersReducedMotion()) return;
    const tl = gsap.timeline();
    tl.fromTo(rootRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
      .fromTo(stageRef.current, { scale: 0.94, y: 24 }, { scale: 1, y: 0, duration: 0.6, ease: 'expo.out' }, 0);
    return () => { tl.kill(); };
  }, []);

  // Each new photo slides in from the side it came from.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || direction.current === 0 || prefersReducedMotion()) return;
    gsap.fromTo(stage, { x: 60 * direction.current, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'power3.out' });
  }, [index]);

  // Warm the neighbours so arrowing through feels instant.
  useEffect(() => {
    for (const offset of [1, -1, 2]) {
      const neighbour = items[index + offset];
      if (neighbour) new Image().src = fullSrc(neighbour.photo);
    }
  }, [index, items]);

  const close = useCallback(() => {
    if (!rootRef.current || prefersReducedMotion()) { onClose(); return; }
    gsap.to(stageRef.current, { scale: 0.96, opacity: 0, duration: 0.2, ease: 'power2.in' });
    gsap.to(rootRef.current, { opacity: 0, duration: 0.25, ease: 'power2.in', onComplete: onClose });
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    // Freeze background scroll while open
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [go, close]);

  useEffect(() => { setLoaded(false); }, [item?.photo.id]);

  if (!item) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-[350] flex flex-col"
      style={{ background: 'rgba(14, 10, 22, 0.94)', backdropFilter: 'blur(14px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={item.photo.name}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3.5 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {event ? (
            <span className="flex items-center gap-1.5 text-white/60 text-xs min-w-0">
              <CalendarDays className="w-3.5 h-3.5 flex-shrink-0 text-lumina-300" />
              <span className="font-semibold text-white/80 truncate">{event.label}</span>
              {event.dateLabel && <span className="text-white/40 flex-shrink-0">· {event.dateLabel}</span>}
            </span>
          ) : item.subtitle ? (
            <span className="flex items-center gap-1.5 text-xs min-w-0">
              <CalendarDays className="w-3.5 h-3.5 flex-shrink-0 text-lumina-300" />
              <span className="font-semibold text-white/80 truncate">{item.subtitle}</span>
            </span>
          ) : null}
          <span className="text-white/35 text-[11px] font-bold tabular-nums flex-shrink-0">
            {index + 1} / {items.length}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {canCompare && (
            <button
              onClick={() => setCompare((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors ${
                compare ? 'bg-lumina-500 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
              title="Side-by-side with the event's best shot"
            >
              <Columns2 className="w-3.5 h-3.5" />
              Compare vs best
            </button>
          )}
          {member && (
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest transition-colors ${
                panelOpen ? 'bg-white/20 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              <Info className="w-3.5 h-3.5" />
              Details
            </button>
          )}
          <button
            onClick={() => downloadPhoto(item.photo)}
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/80 hover:bg-white/20 transition-colors"
            title="Download original"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={close}
            className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/80 hover:bg-white/25 transition-colors"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Image area */}
        <div
          className="flex-1 relative flex items-center justify-center min-w-0 px-2 pb-4"
          onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current;
            touchX.current = null;
            if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
          }}
        >
          {!loaded && (
            <Loader2 className="absolute bottom-8 w-5 h-5 text-white/50 animate-spin z-10" />
          )}
          <div ref={stageRef} className="w-full h-full flex items-center justify-center">

          {compare && canCompare && bestPhoto ? (
            <div className="w-full h-full flex gap-2 items-stretch justify-center">
              {[{ photo: bestPhoto, tag: 'Best shot', m: bestMember }, { photo: item.photo, tag: 'This photo', m: member }].map(({ photo, tag, m }) => (
                <div key={photo.id} className="relative flex-1 min-w-0 flex items-center justify-center">
                  <img
                    src={fullSrc(photo)}
                    alt={photo.name}
                    className="max-w-full max-h-full object-contain rounded-xl"
                    onLoad={() => setLoaded(true)}
                    onError={() => setLoaded(true)}
                  />
                  <div className={`absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest backdrop-blur-md ${
                    tag === 'Best shot' ? 'bg-amber-500/80 text-white' : 'bg-white/15 text-white/85'
                  }`}>
                    {tag === 'Best shot' && <Award className="w-3 h-3" />}
                    {tag}
                    {m && <span className="tabular-nums opacity-80">· {m.finalScore.toFixed(2)}</span>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div key={item.photo.id} className="relative w-full h-full flex items-center justify-center">
              {/* The cached thumbnail holds the frame until the original arrives. */}
              {!loaded && previewSrc(item.photo) !== fullSrc(item.photo) && (
                <img
                  src={previewSrc(item.photo)}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-contain blur-[2px]"
                />
              )}
              <img
                src={fullSrc(item.photo)}
                alt={item.photo.name}
                className={`relative max-w-full max-h-full object-contain rounded-xl transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                onLoad={() => setLoaded(true)}
                onError={() => setLoaded(true)}
              />
            </div>
          )}
          </div>

          {/* Nav arrows */}
          {index > 0 && (
            <button
              onClick={() => go(-1)}
              className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/25 transition-all hover:scale-105"
              title="Previous (←)"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          {index < items.length - 1 && (
            <button
              onClick={() => go(1)}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/25 transition-all hover:scale-105"
              title="Next (→)"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Details panel */}
        {panelOpen && member && (
          <div
            className="w-[290px] flex-shrink-0 overflow-y-auto px-5 py-2 pb-6 hidden sm:block"
            data-anim="fade-up"
          >
            {/* Verdict */}
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-4 mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Verdict</span>
                {rank !== null && (
                  <span className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest ${isTop ? 'text-amber-400' : 'text-white/60'}`}>
                    {isTop && <Award className="w-3 h-3" />}
                    {isTop ? 'Best shot' : `#${rank + 1} of ${event?.members.length}`}
                  </span>
                )}
              </div>
              <div className="text-3xl font-light text-white tabular-nums mb-1">
                {member.finalScore.toFixed(2)}
                <span className="text-sm text-white/35 ml-1.5">score</span>
              </div>
              {member.explanation && (
                <p className="text-xs text-white/60 leading-relaxed">{member.explanation.summary}</p>
              )}
            </div>

            {/* Flags */}
            {(member.flags?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {member.flags!.map((flag) => (
                  <span
                    key={flag}
                    title={REJECT_FLAG_UI[flag]?.hint}
                    className="px-2.5 py-1 rounded-full bg-red-500/15 text-red-300 text-[10px] font-bold uppercase tracking-widest"
                  >
                    {REJECT_FLAG_UI[flag]?.label ?? flag}
                  </span>
                ))}
              </div>
            )}

            {/* Signals */}
            <div className="rounded-2xl bg-white/[0.06] border border-white/10 p-4 mb-3">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/40">Signals</span>
                {compare && bestMember && (
                  <span className="text-[9px] font-bold uppercase tracking-widest text-lumina-300">vs best</span>
                )}
              </div>
              <SignalBars member={member} compareWith={compare ? bestMember : null} />
            </div>

            {member.nimaScore > 0 && (
              <p className="text-[10px] text-white/35 uppercase tracking-widest mb-3">
                NIMA aesthetic {member.nimaScore.toFixed(1)} / 10
              </p>
            )}

            {/* Promote */}
            {event && !isTop && onMakeBest && (
              <button
                onClick={() => { onMakeBest(event.id, item.photo.id); close(); }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500/90 text-white text-xs font-bold uppercase tracking-widest hover:bg-amber-500 transition-colors"
              >
                <Crown className="w-3.5 h-3.5" />
                Make best shot
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
