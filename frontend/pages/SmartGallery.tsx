
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BestByPerson, Event, EventMember, Explanation, FaceBox, Identity, MmrMode, NormSignals, Photo, RejectFlag } from '../types';
import { Lightbox, LightboxItem } from '../components/Lightbox';
import { REJECT_FLAG_UI, SIGNAL_UI } from '../lib/signals';
import {
  applyCorrection,
  deleteEnhanced,
  downloadCollage,
  enhancePhoto,
  enhancedPhotoUrl,
  exportAlbum,
  getCollageThemes,
  getPreferences,
  rescoreWithPreferences,
  resetPreferences,
  searchPhotos,
  submitFeedback,
} from '../lib/analysisApi';
import type { CollageTheme, EnhanceStyle } from '../lib/analysisApi';
import {
  Sparkles,
  Trash2,
  Filter,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Award,
  Zap,
  Download,
  User,
  Pencil,
  AlertTriangle,
  Check,
  X,
  CalendarDays,
  Users,
  Search,
  Info,
  Crown,
  SlidersHorizontal,
  GitMerge,
  RotateCcw,
  Loader2,
  Image as ImageIcon,
  Wand2,
  Pin,
  ScanFace,
  FileText,
  Undo2,
} from 'lucide-react';

/* ------------------------------------------------
   Enhancement state, shared with the cards

   Threading enhance state through every intermediate component would mean
   prop-drilling five levels for a feature only the cards use, so it travels
   by context instead.
   ------------------------------------------------ */
export interface EnhanceEntry {
  url: string;
  identityScore?: number | null;
  warning?: string | null;
}

interface EnhanceContextValue {
  enabled: boolean;
  entries: Record<string, EnhanceEntry>;
  pending: Record<string, boolean>;
  showOriginal: Record<string, boolean>;
  enhance: (photoId: string, style?: EnhanceStyle) => void;
  revert: (photoId: string) => void;
  toggleOriginal: (photoId: string) => void;
}

const EnhanceContext = React.createContext<EnhanceContextValue>({
  enabled: false,
  entries: {},
  pending: {},
  showOriginal: {},
  enhance: () => {},
  revert: () => {},
  toggleOriginal: () => {},
});

const useEnhance = () => React.useContext(EnhanceContext);

/* ------------------------------------------------
   useInView
   ------------------------------------------------ */
const useInView = (threshold = 0.1) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
};

/* ------------------------------------------------
   downloadPhoto helper
   ------------------------------------------------ */
function downloadPhoto(photo: Photo, index: number) {
  const a = document.createElement('a');
  a.href = photo.url;
  a.download = photo.name?.trim() || `photo-${index + 1}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ------------------------------------------------
   Toasts (portaled to <body> so ancestor transforms /
   backdrop-filters can never trap or offset them)
   ------------------------------------------------ */
type Toast = { id: number; message: string; kind: 'success' | 'error' | 'info' };

const ToastStack: React.FC<{ toasts: Toast[] }> = ({ toasts }) => createPortal(
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[400] flex flex-col items-center gap-2 pointer-events-none">
    {toasts.map((toast) => (
      <div
        key={toast.id}
        className={`liquid-glass-heavy rounded-full px-5 py-2.5 shadow-xl shadow-black/10 flex items-center gap-2 text-sm font-medium ${
          toast.kind === 'error' ? 'text-red-500' : 'text-slate-700'
        }`}
        style={{ animation: 'scaleInBounce 0.35s cubic-bezier(0.34,1.56,0.64,1) both' }}
      >
        {toast.kind === 'success' && <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />}
        {toast.kind === 'error' && <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />}
        {toast.kind === 'info' && <Sparkles className="w-4 h-4 text-lumina-500 flex-shrink-0" />}
        {toast.message}
      </div>
    ))}
  </div>,
  document.body,
);

/* ------------------------------------------------
   FaceRing — spotlight circle over a person's face.
   bbox is normalised [x1,y1,x2,y2]; the overlay replicates
   the object-fit: cover mapping of the underlying <img>, so
   it stays glued to the face at any container size.
   ------------------------------------------------ */
interface FaceRingProps {
  bbox: FaceBox;
  imageAspect: number | null; // naturalWidth / naturalHeight
}

const FaceRing: React.FC<FaceRingProps> = ({ bbox, imageAspect }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [ring, setRing] = useState<{ left: number; top: number; size: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !imageAspect) return;

    const compute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const ca = cw / ch;
      // object-fit: cover — image scaled to fill, centred, overflow cropped
      const dispW = imageAspect > ca ? ch * imageAspect : cw;
      const dispH = imageAspect > ca ? ch : cw / imageAspect;
      const offX = (cw - dispW) / 2;
      const offY = (ch - dispH) / 2;
      const [x1, y1, x2, y2] = bbox;
      const cx = offX + ((x1 + x2) / 2) * dispW;
      const cy = offY + ((y1 + y2) / 2) * dispH;
      const size = Math.max((x2 - x1) * dispW, (y2 - y1) * dispH) * 1.6;
      setRing({ left: cx - size / 2, top: cy - size / 2, size });
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bbox, imageAspect]);

  if (!imageAspect) return null;

  return (
    <div ref={ref} className="absolute inset-0 pointer-events-none z-[3]">
      {ring && (
        <div
          className="absolute rounded-full"
          style={{
            left: ring.left,
            top: ring.top,
            width: ring.size,
            height: ring.size,
            border: '2.5px solid rgba(255,255,255,0.95)',
            // Spotlight: dim everything outside the circle (clipped by the
            // container's overflow-hidden rounded corners)
            boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.38), 0 0 18px rgba(255,255,255,0.55), inset 0 0 12px rgba(255,255,255,0.25)',
            animation: 'scaleIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both',
          }}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------
   Face avatar
   ------------------------------------------------ */
interface FaceAvatarProps {
  faceThumb?: string | null;
  label: string;
  size?: 'sm' | 'md';
}

const FaceAvatar: React.FC<FaceAvatarProps> = ({ faceThumb, label, size = 'md' }) => {
  const dim = size === 'md' ? 'w-12 h-12 sm:w-14 sm:h-14' : 'w-9 h-9 sm:w-10 sm:h-10';
  const iconDim = size === 'md' ? 'w-5 h-5 sm:w-6 sm:h-6' : 'w-4 h-4 sm:w-5 sm:h-5';

  if (faceThumb) {
    return (
      <div className={`${dim} rounded-full overflow-hidden flex-shrink-0 ring-2 ring-lumina-400/40 shadow-lg shadow-lumina-500/10`}>
        <img src={faceThumb} alt={label} className="w-full h-full object-cover" />
      </div>
    );
  }

  return (
    <div className={`${dim} rounded-full flex-shrink-0 flex items-center justify-center liquid-glass`}>
      <User className={`${iconDim} text-lumina-400`} />
    </div>
  );
};

/* ------------------------------------------------
   Explanation panel — "why this photo?"
   ------------------------------------------------ */
const ExplanationPanel: React.FC<{ explanation: Explanation; normSignals?: NormSignals }> = ({ explanation, normSignals }) => (
  <div
    className="liquid-glass rounded-2xl p-4 sm:p-5"
    style={{ animation: 'scaleIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) both', transformOrigin: 'top' }}
  >
    <div className="flex items-start gap-2.5 mb-3">
      <div className="w-7 h-7 rounded-lg bg-lumina-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Info className="w-3.5 h-3.5 text-lumina-500" />
      </div>
      <p className="text-sm text-slate-700 leading-relaxed">{explanation.summary}</p>
    </div>

    {explanation.reasons.length > 0 && (
      <div className="flex flex-wrap gap-1.5 mb-3">
        {explanation.reasons.map((reason) => (
          <span
            key={reason.signal}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-lumina-500/10 text-lumina-600 text-[11px] font-medium"
          >
            <Check className="w-3 h-3" />
            {reason.detail}
          </span>
        ))}
      </div>
    )}

    {normSignals && (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 pt-3 border-t border-white/30">
        {SIGNAL_UI.map(({ key, label }) => {
          const value = normSignals[key] ?? 0;
          return (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-widest text-slate-400 font-medium">{label}</span>
                <span className="text-[10px] font-bold text-slate-500 tabular-nums">{Math.round(value * 100)}</span>
              </div>
              <div className="h-1 rounded-full bg-slate-200/60 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-lumina-400 to-lumina-500 transition-all duration-500"
                  style={{ width: `${Math.round(value * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

/* ------------------------------------------------
   Manage dropdown
   ------------------------------------------------ */
interface ManageDropdownProps {
  photoCount: number;
  onRename: () => void;
  onDownloadAll: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const ManageDropdown: React.FC<ManageDropdownProps> = ({
  photoCount, onRename, onDownloadAll, onDelete, onClose,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-40 bg-white/[0.04] backdrop-blur-sm backdrop-saturate-150"
          onClick={onClose}
          aria-hidden
        />,
        document.body,
      )}
      <div
        className="absolute right-0 top-full mt-2 w-56 z-50"
        style={{ animation: 'scaleIn 0.15s cubic-bezier(0.34, 1.56, 0.64, 1) both', transformOrigin: 'top right' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="rounded-2xl overflow-hidden shadow-xl shadow-black/15 border border-white/40"
          style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px)' }}
        >
          {!confirmDelete ? (
            <>
              <button
                onClick={() => { onRename(); onClose(); }}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-sm text-slate-700 hover:bg-slate-100/80 transition-colors duration-150 text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-lumina-500/10 flex items-center justify-center flex-shrink-0">
                  <Pencil className="w-3.5 h-3.5 text-lumina-500" />
                </div>
                <div>
                  <div className="font-medium leading-tight">Rename</div>
                  <div className="text-[11px] text-slate-400 leading-tight mt-0.5">Give this event a name</div>
                </div>
              </button>

              <div className="h-px bg-slate-200/80 mx-3" />

              <button
                onClick={() => { onDownloadAll(); onClose(); }}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-sm text-slate-700 hover:bg-slate-100/80 transition-colors duration-150 text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0">
                  <Download className="w-3.5 h-3.5 text-green-600" />
                </div>
                <div>
                  <div className="font-medium leading-tight">Download All</div>
                  <div className="text-[11px] text-slate-400 leading-tight mt-0.5">{photoCount} {photoCount === 1 ? 'photo' : 'photos'} in this event</div>
                </div>
              </button>

              <div className="h-px bg-slate-200/80 mx-3" />

              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-sm text-red-500 hover:bg-red-50 transition-colors duration-150 text-left"
              >
                <div className="w-7 h-7 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">
                  <Trash2 className="w-3.5 h-3.5 text-red-500" />
                </div>
                <div>
                  <div className="font-medium leading-tight">Delete Event</div>
                  <div className="text-[11px] text-red-400 leading-tight mt-0.5">Remove from results</div>
                </div>
              </button>
            </>
          ) : (
            <div className="px-4 py-4 flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-800 leading-tight">Delete this event?</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                    Removes {photoCount} {photoCount === 1 ? 'photo' : 'photos'} from results. Drive files unaffected.
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="flex-1 py-2 rounded-xl text-xs font-medium uppercase tracking-widest bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { onDelete(); onClose(); }}
                  className="flex-1 py-2 rounded-xl text-xs font-medium uppercase tracking-widest bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

/* ------------------------------------------------
   Inline rename input
   ------------------------------------------------ */
interface RenameInputProps {
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const RenameInput: React.FC<RenameInputProps> = ({ value, onChange, onConfirm, onCancel, inputRef }) => (
  <div className="flex items-center gap-1.5 min-w-0">
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onConfirm();
        if (e.key === 'Escape') onCancel();
      }}
      className="text-base sm:text-lg font-medium tracking-tight bg-transparent border-b-2 border-lumina-400 outline-none min-w-0 flex-1 pb-0.5 text-slate-900 placeholder:text-slate-300"
      placeholder="Enter a name…"
    />
    <button
      onMouseDown={(e) => { e.preventDefault(); onConfirm(); }}
      className="w-6 h-6 rounded-full bg-lumina-500 flex items-center justify-center text-white flex-shrink-0 hover:bg-lumina-600 transition-colors"
      title="Confirm"
    >
      <Check className="w-3.5 h-3.5" />
    </button>
    <button
      onMouseDown={(e) => { e.preventDefault(); onCancel(); }}
      className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-slate-500 flex-shrink-0 hover:bg-slate-300 transition-colors"
      title="Cancel"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
);

/* ------------------------------------------------
   Horizontal image carousel (with swap-best action)
   ------------------------------------------------ */
interface ClusterCarouselProps {
  photos: Photo[];
  onMakeBest?: (photoId: string) => void;
  getFaceBox?: (photoId: string) => FaceBox | null;
  getFlags?: (photoId: string) => RejectFlag[] | undefined;
  onOpen?: (photoId: string) => void;
}

const ClusterCarousel: React.FC<ClusterCarouselProps> = ({ photos, onMakeBest, getFaceBox, getFlags, onOpen }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [aspects, setAspects] = useState<Record<string, number>>({});

  const markLoaded = useCallback((id: string, img?: HTMLImageElement) => {
    setLoadedImages((prev) => new Set(prev).add(id));
    if (img && img.naturalHeight > 0) {
      setAspects((prev) => ({ ...prev, [id]: img.naturalWidth / img.naturalHeight }));
    }
  }, []);

  const updateScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateScroll, { passive: true });
    updateScroll();
    return () => el.removeEventListener('scroll', updateScroll);
  }, []);

  const scroll = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -el.clientWidth * 0.6 : el.clientWidth * 0.6, behavior: 'smooth' });
  };

  return (
    <div className="relative group/carousel">
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto scrollbar-hide pb-2 snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {photos.map((photo, i) => (
          <div key={photo.id} className="flex-shrink-0 w-36 sm:w-44 md:w-52 snap-start">
            <div
              className="relative aspect-square rounded-2xl overflow-hidden group/img cursor-zoom-in liquid-glass-light"
              onClick={() => onOpen?.(photo.id)}
            >
              <div className="absolute inset-0 skeleton" />
              <img
                src={photo.url}
                alt={photo.name}
                className="relative w-full h-full object-cover transition-transform duration-500 group-hover/img:scale-105"
                loading="lazy"
                onLoad={(e) => markLoaded(photo.id, e.currentTarget)}
                onError={() => markLoaded(photo.id)}
              />
              {getFaceBox?.(photo.id) && loadedImages.has(photo.id) && (
                <FaceRing bbox={getFaceBox(photo.id)!} imageAspect={aspects[photo.id] ?? null} />
              )}
              {(getFlags?.(photo.id)?.length ?? 0) > 0 && (
                <div className="absolute bottom-2 left-2 z-[4] flex gap-1 pointer-events-none">
                  {getFlags!(photo.id)!.slice(0, 2).map((flag) => (
                    <span key={flag} className="px-1.5 py-0.5 rounded-md bg-red-500/75 backdrop-blur-sm text-white text-[8px] font-bold uppercase tracking-widest">
                      {REJECT_FLAG_UI[flag]?.label ?? flag}
                    </span>
                  ))}
                </div>
              )}
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/img:opacity-100 transition-opacity duration-300 pointer-events-none group-hover/img:pointer-events-auto">
                {onMakeBest && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onMakeBest(photo.id); }}
                    className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full liquid-glass text-white text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/60 transition-colors duration-200"
                    title="Promote to Best Shot — Lumina learns your taste from this"
                  >
                    <Crown className="w-3.5 h-3.5" />
                    Best
                  </button>
                )}
                <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); downloadPhoto(photo, i); }}
                    className="w-7 h-7 rounded-full liquid-glass flex items-center justify-center text-white hover:bg-white/20 transition-colors duration-200"
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {canScrollLeft && (
        <button onClick={() => scroll('left')} className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 w-9 h-9 rounded-full liquid-glass flex items-center justify-center text-slate-700 transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100 z-10">
          <ChevronLeft className="w-4 h-4" />
        </button>
      )}
      {canScrollRight && (
        <button onClick={() => scroll('right')} className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 w-9 h-9 rounded-full liquid-glass flex items-center justify-center text-slate-700 transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100 z-10">
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
      {canScrollLeft && <div className="absolute left-0 top-0 bottom-2 w-12 bg-gradient-to-r from-white/80 to-transparent pointer-events-none rounded-l-2xl" />}
      {canScrollRight && <div className="absolute right-0 top-0 bottom-2 w-12 bg-gradient-to-l from-white/80 to-transparent pointer-events-none rounded-r-2xl" />}
    </div>
  );
};

/* ------------------------------------------------
   Best-per-person strip (event x identity selection)
   ------------------------------------------------ */
interface BestPerPersonStripProps {
  picks: BestByPerson[];
  identities: Identity[];
  photosById: Map<string, Photo>;
  topPhotoId: string;
  onOpenPhoto: (photoId: string) => void;
}

/** One clean chip per person; clicking opens their best shot in the lightbox
 *  (where the full explanation lives). Hidden entirely when it would only
 *  restate the event's best shot. */
const BestPerPersonStrip: React.FC<BestPerPersonStripProps> = ({ picks, identities, photosById, topPhotoId, onOpenPhoto }) => {
  const identityById = useMemo(() => new Map<string, Identity>(identities.map((i) => [i.id, i])), [identities]);

  const items = picks
    .map((pick) => {
      const identity = identityById.get(pick.personId);
      const photo = photosById.get(pick.photoId);
      return identity && photo ? { pick, identity, photo } : null;
    })
    .filter(Boolean) as Array<{ pick: BestByPerson; identity: Identity; photo: Photo }>;

  // No informative content: nobody, or a single person whose best shot is
  // already the event's best shot.
  if (items.length === 0) return null;
  if (items.length === 1 && items[0].pick.photoId === topPhotoId) return null;

  return (
    <div className="liquid-glass-light rounded-2xl px-4 py-3">
      <div className="flex items-center gap-2 text-slate-400 text-[10px] uppercase tracking-widest font-medium mb-2.5">
        <Users className="w-3.5 h-3.5 text-lumina-400" />
        <span>Best shot of each person</span>
        <span className="text-slate-300 normal-case tracking-normal font-normal">· click to view</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {items.map(({ pick, identity }) => {
          const isEventBest = pick.photoId === topPhotoId;
          return (
            <button
              key={pick.personId}
              onClick={() => onOpenPhoto(pick.photoId)}
              title={pick.explanation?.summary ?? `${identity.label}'s best shot`}
              className="group/chip flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-white/50 hover:bg-white/90 hover:shadow-md hover:shadow-lumina-500/10 hover:-translate-y-px transition-all duration-200"
            >
              <div className="relative flex-shrink-0">
                <div className="w-8 h-8 rounded-full overflow-hidden ring-2 ring-white shadow-sm">
                  {identity.faceThumb
                    ? <img src={identity.faceThumb} alt={identity.label} className="w-full h-full object-cover" />
                    : <div className="w-full h-full bg-lumina-100 flex items-center justify-center"><User className="w-4 h-4 text-lumina-400" /></div>}
                </div>
                {isEventBest && (
                  <div
                    className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-amber-400 ring-2 ring-white flex items-center justify-center"
                    title="Also the event's best shot"
                  >
                    <Award className="w-2.5 h-2.5 text-white" />
                  </div>
                )}
              </div>
              <span className="text-xs font-medium text-slate-700 max-w-[110px] truncate">{identity.label}</span>
              {pick.numCandidates > 1 && (
                <span className="text-[9px] font-bold text-slate-400 tabular-nums">1/{pick.numCandidates}</span>
              )}
              <ChevronRight className="w-3 h-3 text-slate-300 group-hover/chip:text-lumina-500 group-hover/chip:translate-x-0.5 transition-all" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* ------------------------------------------------
   Best Shot Card (used inside BestShotsGallery)
   ------------------------------------------------ */
interface BestShotCardProps {
  photo: Photo;
  event: Event;
  nimaScore: number;
  persons: Identity[];
  index: number;
  isTop: boolean;
  faceBox?: FaceBox | null;
  onOpen?: () => void;
}

const BestShotCard: React.FC<BestShotCardProps> = ({ photo, event, nimaScore, persons, index, isTop, faceBox, onOpen }) => {
  const [loaded, setLoaded] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const enh = useEnhance();

  const entry = enh.entries[photo.id];
  const busy = Boolean(enh.pending[photo.id]);
  const viewingOriginal = Boolean(enh.showOriginal[photo.id]);
  const displayUrl = entry && !viewingOriginal ? entry.url : photo.url;

  // Vary card sizes for a masonry-like feel
  const isHero = index === 0;
  const isTall = !isHero && index % 5 === 2;
  const isWide = !isHero && !isTall && index % 7 === 4;

  const sizeClasses = [
    isHero ? 'md:col-span-2 md:row-span-2' : '',
    isTall ? 'row-span-2' : '',
    isWide ? 'md:col-span-2' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`gallery-card relative overflow-hidden rounded-2xl cursor-zoom-in group ${sizeClasses}`}
      style={{ animation: `galleryCardIn 0.65s cubic-bezier(0.34, 1.56, 0.64, 1) ${Math.min(index * 55, 650)}ms both` }}
      onClick={onOpen}
    >
      {/* Skeleton under the image — cannot get stuck on a lost load event */}
      <div className="absolute inset-0 skeleton" />

      {/* Photo — the AI-enhanced version once one exists, unless comparing */}
      <img
        key={displayUrl}
        src={displayUrl}
        alt={photo.name}
        className="relative w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.07]"
        loading="lazy"
        onLoad={(e) => {
          setLoaded(true);
          if (e.currentTarget.naturalHeight > 0) {
            setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
          }
        }}
        onError={() => setLoaded(true)}
      />

      {faceBox && loaded && <FaceRing bbox={faceBox} imageAspect={aspect} />}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent pointer-events-none" />
      {/* Top vignette */}
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/30 to-transparent pointer-events-none" />

      {/* Top-left badges */}
      <div
        className="absolute top-3 left-3 flex items-center gap-1.5"
        style={{ animation: `showcaseBadgePop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${Math.min(index * 55 + 200, 800)}ms both` }}
      >
        <div className="flex items-center gap-1 bg-black/50 backdrop-blur-md rounded-lg px-2 py-1">
          {isTop ? <Award className="w-3 h-3 text-amber-400" /> : <Sparkles className="w-3 h-3 text-lumina-300" />}
          <span className="text-[9px] font-bold text-white uppercase tracking-widest leading-none">{isTop ? 'Best' : 'Pick'}</span>
        </div>
        {nimaScore > 0 && (
          <div className={`px-2 py-1 rounded-lg backdrop-blur-md text-[9px] font-bold text-white leading-none ${nimaScore >= 6 ? 'bg-green-500/70' : nimaScore >= 4.5 ? 'bg-yellow-500/70' : 'bg-red-500/70'}`}>
            {nimaScore.toFixed(1)}
          </div>
        )}
        {entry && (
          <div
            className="flex items-center gap-1 bg-lumina-500/80 backdrop-blur-md rounded-lg px-2 py-1"
            title={
              entry.identityScore != null
                ? `Identity verified — ${(entry.identityScore * 100).toFixed(0)}% match to the original face`
                : 'AI enhanced'
            }
          >
            <Wand2 className="w-3 h-3 text-white" />
            <span className="text-[9px] font-bold text-white uppercase tracking-widest leading-none">
              {viewingOriginal ? 'Original' : 'Enhanced'}
            </span>
          </div>
        )}
      </div>

      {/* Working overlay */}
      {busy && (
        <div className="absolute inset-0 z-20 bg-black/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 pointer-events-none">
          <Loader2 className="w-6 h-6 text-white animate-spin" />
          <span className="text-[10px] font-bold text-white uppercase tracking-widest">Enhancing</span>
          <span className="text-[9px] text-white/60">this takes ~30s</span>
        </div>
      )}

      {/* Top-right actions — appear on hover */}
      <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-300">
        {enh.enabled && !entry && (
          <button
            onClick={(e) => { e.stopPropagation(); enh.enhance(photo.id); }}
            disabled={busy}
            className="h-8 px-2.5 rounded-full bg-lumina-500/85 backdrop-blur-md border border-white/30 flex items-center gap-1.5 text-white hover:bg-lumina-500 transition-colors duration-200 disabled:opacity-50"
            title="AI enhance this photo (identity-checked)"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            <span className="text-[9px] font-bold uppercase tracking-widest leading-none">Enhance</span>
          </button>
        )}
        {entry && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); enh.toggleOriginal(photo.id); }}
              className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white hover:bg-white/40 transition-colors duration-200"
              title={viewingOriginal ? 'Show enhanced' : 'Hold on the original to compare'}
            >
              <ScanFace className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); enh.revert(photo.id); }}
              className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white hover:bg-red-500/60 transition-colors duration-200"
              title="Discard the enhancement"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            downloadPhoto(entry && !viewingOriginal ? { ...photo, url: entry.url } : photo, index);
          }}
          className="w-8 h-8 rounded-full bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white hover:bg-white/40 transition-colors duration-200"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-1 group-hover:translate-y-0 transition-transform duration-400">
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-white text-xs font-semibold truncate leading-tight drop-shadow-sm">{event.label}</p>
            <p className="text-white/55 text-[10px] mt-0.5 leading-none">{event.photos.length} {event.photos.length === 1 ? 'photo' : 'photos'}</p>
          </div>
          {/* Person face stack */}
          {persons.length > 0 && (
            <div className="flex items-center -space-x-1.5 flex-shrink-0">
              {persons.slice(0, 3).map((p) => (
                <div key={p.id} className="w-5 h-5 rounded-full ring-1 ring-white/50 overflow-hidden flex-shrink-0" title={p.label}>
                  {p.faceThumb
                    ? <img src={p.faceThumb} alt={p.label} className="w-full h-full object-cover" />
                    : <div className="w-full h-full bg-lumina-400/80 flex items-center justify-center"><User className="w-2.5 h-2.5 text-white" /></div>
                  }
                </div>
              ))}
              {persons.length > 3 && (
                <div className="w-5 h-5 rounded-full ring-1 ring-white/50 bg-black/40 backdrop-blur-sm flex items-center justify-center text-[8px] font-bold text-white">
                  +{persons.length - 3}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------
   Best Shots Gallery (showcase view with MMR modes)
   ------------------------------------------------ */
const MMR_MODE_UI: Array<{ mode: MmrMode; label: string; hint: string }> = [
  { mode: 'safe', label: 'Quality', hint: 'Highest scores only' },
  { mode: 'balanced', label: 'Balanced', hint: 'Quality with variety' },
  { mode: 'diverse', label: 'Diverse', hint: 'Maximum variety (MMR)' },
];

interface BestShotsGalleryProps {
  events: Event[];
  identities: Identity[];
  mmrMode: MmrMode;
  onMmrModeChange: (mode: MmrMode) => void;
  highlightPerson?: Identity | null;
  onOpenItems: (items: LightboxItem[], index: number) => void;
}

const BestShotsGallery: React.FC<BestShotsGalleryProps> = ({ events, identities, mmrMode, onMmrModeChange, highlightPerson, onOpenItems }) => {
  const items: Array<{ photo: Photo; event: Event; nimaScore: number; persons: Identity[]; isTop: boolean; faceBox?: FaceBox | null }> = [];

  for (const event of events) {
    const photoById = new Map<string, Photo>(event.photos.map((p) => [p.id, p]));
    // MMR picks for this mode; fall back to the single top shot
    const pickIds = event.mmrPicks?.[mmrMode]?.length
      ? event.mmrPicks[mmrMode]!
      : [event.topPhotoId];
    const persons = identities.filter((ident) => event.persons.includes(ident.id));
    for (const photoId of pickIds) {
      const photo = photoById.get(photoId) ?? null;
      if (!photo) continue;
      const nimaScore = event.members.find((m) => m.photoId === photoId)?.nimaScore ?? 0;
      items.push({
        photo, event, nimaScore, persons,
        isTop: photoId === event.topPhotoId,
        faceBox: highlightPerson?.faceBoxes?.[photoId] ?? null,
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <div style={{ animation: 'showcaseReveal 0.55s cubic-bezier(0.4, 0, 0.2, 1) both' }}>
      {/* Showcase header */}
      <div className="flex flex-col items-center text-center gap-3 mb-8">
        <div
          className="inline-flex items-center gap-2.5 px-5 py-2 rounded-full liquid-glass glass-prismatic"
          style={{ animation: 'showcaseBadgePop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) 100ms both' }}
        >
          <Sparkles className="w-3.5 h-3.5 text-lumina-500 anim-breathe" />
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-lumina-600">Showcase Mode</span>
          <Sparkles className="w-3.5 h-3.5 text-lumina-500 anim-breathe" style={{ animationDelay: '0.5s' }} />
        </div>

        <h3
          className="text-3xl sm:text-4xl font-semibold tracking-tight text-gradient"
          style={{ animation: 'fadeInUp 0.6s var(--smooth) 150ms both' }}
        >
          Your Best Shots
        </h3>
        <p
          className="text-slate-400 text-sm tracking-wide"
          style={{ animation: 'fadeInUp 0.6s var(--smooth) 220ms both' }}
        >
          {items.length} curated {items.length === 1 ? 'pick' : 'picks'} from {events.length} {events.length === 1 ? 'event' : 'events'}
        </p>

        {/* MMR mode segmented control */}
        <div
          className="liquid-glass rounded-full p-1 flex items-center gap-0.5"
          style={{ animation: 'fadeInUp 0.6s var(--smooth) 280ms both' }}
        >
          {MMR_MODE_UI.map(({ mode, label, hint }) => (
            <button
              key={mode}
              onClick={() => onMmrModeChange(mode)}
              title={hint}
              className={`px-4 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-all duration-300 ${
                mmrMode === mode
                  ? 'bg-lumina-500 text-white shadow-lg shadow-lumina-500/25'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-400 tracking-wide -mt-1" style={{ animation: 'fadeInUp 0.6s var(--smooth) 320ms both' }}>
          {MMR_MODE_UI.find((m) => m.mode === mmrMode)?.hint} · diversity-aware selection (Maximal Marginal Relevance)
        </p>
      </div>

      {/* Masonry grid */}
      <div
        key={mmrMode}
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4"
        style={{ gridAutoRows: 'clamp(140px, 16vw, 230px)', gridAutoFlow: 'dense' }}
      >
        {items.map((item, i) => (
          <BestShotCard
            key={`${item.event.id}-${item.photo.id}`}
            {...item}
            index={i}
            onOpen={() => onOpenItems(items.map((it) => ({ photo: it.photo, event: it.event })), i)}
          />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------
   NIMA Score Badge
   ------------------------------------------------ */
const NimaBadge: React.FC<{ score: number }> = ({ score }) => {
  if (score <= 0) return null;
  const color = score >= 6 ? 'bg-green-500/80' : score >= 4.5 ? 'bg-yellow-500/80' : 'bg-red-500/80';
  return (
    <div className={`absolute top-4 right-14 ${color} text-white text-[10px] font-bold px-2 py-1 rounded-lg backdrop-blur-sm`}>
      NIMA {score.toFixed(1)}
    </div>
  );
};

/* ------------------------------------------------
   Event Row (one event group)
   ------------------------------------------------ */
interface EventRowProps {
  event: Event;
  identities: Identity[];
  index: number;
  onDelete: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onMakeBest: (eventId: string, photoId: string) => void;
  highlightPerson?: Identity | null;
  onOpenPhoto: (event: Event, photoId: string) => void;
}

const EventRow: React.FC<EventRowProps> = ({ event, identities, index, onDelete, onRename, onMakeBest, highlightPerson, onOpenPhoto }) => {
  const topPhoto = event.photos.find((p) => p.id === event.topPhotoId) ?? event.photos[0];
  const otherPhotos = event.photos.filter((p) => p.id !== event.topPhotoId);
  const view = useInView(0.05);

  const [bestShotLoaded, setBestShotLoaded] = useState(false);
  const [bestShotAspect, setBestShotAspect] = useState<number | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [labelValue, setLabelValue] = useState(event.label);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setLabelValue(event.label); }, [event.label]);
  useEffect(() => { if (isRenaming) renameInputRef.current?.focus(); }, [isRenaming]);
  useEffect(() => { setBestShotLoaded(false); }, [event.topPhotoId]);

  const commitRename = useCallback(() => {
    const trimmed = labelValue.trim();
    if (trimmed && trimmed !== event.label) onRename(event.id, trimmed);
    else setLabelValue(event.label);
    setIsRenaming(false);
  }, [labelValue, event.label, event.id, onRename]);

  const cancelRename = useCallback(() => {
    setLabelValue(event.label);
    setIsRenaming(false);
  }, [event.label]);

  const handleDownloadAll = useCallback(() => {
    event.photos.forEach((photo, i) => setTimeout(() => downloadPhoto(photo, i), i * 150));
  }, [event.photos]);

  const photosById = useMemo(() => new Map<string, Photo>(event.photos.map((p) => [p.id, p])), [event.photos]);

  // Signals for the current best shot
  const topMember = event.members.find((m) => m.photoId === event.topPhotoId);
  const nimaScore = topMember?.nimaScore ?? 0;

  // Get person avatars for this event
  const eventIdentities = identities.filter((ident) => event.persons.includes(ident.id));

  if (!topPhoto) return null;

  return (
    <section
      id={`event-${event.id}`}
      ref={view.ref}
      className={`flex flex-col gap-6 ${view.visible ? 'anim-fade-in-up' : 'opacity-0'}`}
      style={view.visible ? { animationDelay: `${index * 100}ms` } : undefined}
    >
      {/* Event header */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 liquid-glass-light rounded-2xl px-4 sm:px-5 py-4${isDropdownOpen ? ' relative z-[100]' : ''}`}>
        <div className="flex items-center gap-3 sm:gap-4 min-w-0 flex-1">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full flex-shrink-0 flex items-center justify-center liquid-glass">
            <CalendarDays className="w-5 h-5 sm:w-6 sm:h-6 text-lumina-400" />
          </div>
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <RenameInput
                value={labelValue}
                onChange={setLabelValue}
                onConfirm={commitRename}
                onCancel={cancelRename}
                inputRef={renameInputRef}
              />
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <h3
                  className="text-base sm:text-lg font-medium tracking-tight truncate cursor-default"
                  onDoubleClick={() => setIsRenaming(true)}
                  title="Double-click to rename"
                >
                  {event.label}
                </h3>
                {event.autoLabel && !event.userPinned && (
                  <span
                    className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 text-[9px] font-bold uppercase tracking-widest"
                    title={`Named automatically by CLIP (confidence ${(event.autoLabel.confidence * 100).toFixed(0)}%)`}
                  >
                    <Wand2 className="w-2.5 h-2.5" />
                    Auto
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {event.dateLabel && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-500 text-[10px] font-bold uppercase tracking-widest">
                  <CalendarDays className="w-2.5 h-2.5" />
                  {event.dateLabel}
                </span>
              )}
              <span className="text-[10px] sm:text-xs font-normal text-slate-400 uppercase tracking-widest">
                {event.photos.length} {event.photos.length === 1 ? 'Photo' : 'Photos'} · Grouped by Event
              </span>
              {/* Person avatars in this event */}
              {eventIdentities.length > 0 && (
                <div className="flex items-center -space-x-1.5 ml-1">
                  {eventIdentities.slice(0, 4).map((ident) => (
                    <div
                      key={ident.id}
                      className="w-5 h-5 rounded-full overflow-hidden ring-1 ring-white flex-shrink-0"
                      title={ident.label}
                    >
                      {ident.faceThumb ? (
                        <img src={ident.faceThumb} alt={ident.label} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-lumina-100 flex items-center justify-center">
                          <User className="w-3 h-3 text-lumina-400" />
                        </div>
                      )}
                    </div>
                  ))}
                  {eventIdentities.length > 4 && (
                    <div className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center ring-1 ring-white text-[8px] font-medium text-slate-500">
                      +{eventIdentities.length - 4}
                    </div>
                  )}
                </div>
              )}
            </div>
            {event.caption && (
              <p className="text-xs text-slate-400 italic mt-1 truncate" title={event.caption}>
                “{event.caption}”
              </p>
            )}
          </div>
        </div>

        <div className="relative self-end sm:self-auto flex-shrink-0">
          <button
            onClick={() => setIsDropdownOpen((v) => !v)}
            className={`glass-btn px-4 py-2 rounded-xl text-xs font-medium uppercase tracking-widest flex items-center gap-1.5 transition-all duration-200 ${isDropdownOpen ? 'bg-white/60 shadow-md' : ''}`}
          >
            Manage
            <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-200 ${isDropdownOpen ? 'rotate-90' : ''}`} />
          </button>

          {isDropdownOpen && (
            <ManageDropdown
              photoCount={event.photos.length}
              onRename={() => setIsRenaming(true)}
              onDownloadAll={handleDownloadAll}
              onDelete={() => onDelete(event.id)}
              onClose={() => setIsDropdownOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 items-start">
        {/* Best shot */}
        <div className="relative w-full lg:w-[42%] flex-shrink-0 group">
          <div
            className="relative aspect-[4/3] rounded-2xl overflow-hidden liquid-glass-heavy glass-prismatic shadow-xl shadow-black/10 cursor-zoom-in"
            onClick={() => onOpenPhoto(event, topPhoto.id)}
          >
            {/* Skeleton sits UNDER the always-visible img: the browser paints
                the photo over it as soon as data arrives, with no JS-event
                dependency that could leave it stuck. */}
            <div className="absolute inset-0 skeleton" />
            <img
              key={topPhoto.id}
              src={topPhoto.url}
              alt="Best Pick"
              className="relative w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
              onLoad={(e) => {
                setBestShotLoaded(true);
                if (e.currentTarget.naturalHeight > 0) {
                  setBestShotAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
                }
              }}
              onError={() => setBestShotLoaded(true)}
            />
            {highlightPerson?.faceBoxes?.[topPhoto.id] && bestShotLoaded && (
              <FaceRing bbox={highlightPerson.faceBoxes[topPhoto.id]} imageAspect={bestShotAspect} />
            )}
            <div className="absolute top-4 left-4 liquid-glass rounded-xl px-3 py-1.5 flex items-center gap-2">
              {event.userPinned ? (
                <>
                  <Pin className="w-3 h-3 text-white" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white">Your Pick</span>
                </>
              ) : (
                <>
                  <div className="w-2 h-2 rounded-full bg-lumina-500 anim-breathe" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-white">Best Shot</span>
                </>
              )}
            </div>
            <NimaBadge score={nimaScore} />
            <div className="absolute top-4 right-4 w-9 h-9 rounded-full liquid-glass flex items-center justify-center">
              <Award className="w-4 h-4 text-white" />
            </div>
            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-all duration-400 pointer-events-none group-hover:pointer-events-auto">
              <div className="absolute bottom-4 right-4 flex items-center gap-2">
                <button
                  onClick={(e) => { e.stopPropagation(); downloadPhoto(topPhoto, 0); }}
                  className="w-11 h-11 rounded-full liquid-glass flex items-center justify-center text-white transition-all duration-300 hover:scale-110 hover:bg-white/20"
                  title="Download"
                >
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between px-1">
            <span className="text-xs font-normal text-slate-400 tracking-wide">
              {event.userPinned ? 'Pinned by you — Lumina learned from this' : 'Highest 7-signal quality score in this event'}
            </span>
            {topMember?.explanation && (
              <button
                onClick={() => setShowExplanation((v) => !v)}
                className={`inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest transition-colors ${
                  showExplanation ? 'text-lumina-600' : 'text-lumina-500 hover:text-lumina-400'
                }`}
              >
                <Info className="w-3.5 h-3.5" />
                Why this photo?
              </button>
            )}
          </div>

          {showExplanation && topMember?.explanation && (
            <div className="mt-3">
              <ExplanationPanel explanation={topMember.explanation} normSignals={topMember.normSignals} />
            </div>
          )}
        </div>

        {/* Other photos carousel */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col gap-6">
          {otherPhotos.length > 0 ? (
            <ClusterCarousel
              photos={otherPhotos}
              onMakeBest={(photoId) => onMakeBest(event.id, photoId)}
              getFaceBox={highlightPerson ? (photoId) => highlightPerson.faceBoxes?.[photoId] ?? null : undefined}
              getFlags={(photoId) => event.members.find((m) => m.photoId === photoId)?.flags}
              onOpen={(photoId) => onOpenPhoto(event, photoId)}
            />
          ) : (
            <div className="liquid-glass rounded-2xl flex flex-col items-center justify-center text-center p-10 min-h-[180px]">
              <div className="w-12 h-12 rounded-full bg-lumina-500/10 text-lumina-400 flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6" />
              </div>
              <h4 className="font-medium text-sm mb-1">Only one photo</h4>
              <p className="text-xs text-slate-400 max-w-[220px] leading-relaxed tracking-wide">No other shots in this event.</p>
            </div>
          )}

          {/* Best shot per person */}
          {(event.bestByPerson?.length ?? 0) > 0 && (
            <BestPerPersonStrip
              picks={event.bestByPerson!}
              identities={identities}
              photosById={photosById}
              topPhotoId={event.topPhotoId}
              onOpenPhoto={(photoId) => onOpenPhoto(event, photoId)}
            />
          )}
        </div>
      </div>
    </section>
  );
};

/* ------------------------------------------------
   CLIP semantic search bar + results
   ------------------------------------------------ */
interface SearchSectionProps {
  jobId: string | null;
  photosById: Map<string, Photo>;
  eventByPhotoId: Map<string, Event>;
  scopePerson: Identity | null;
  suggestions: string[];
  onNotify: (message: string, kind?: Toast['kind']) => void;
  onActiveChange: (active: boolean) => void;
  onOpenItems: (items: LightboxItem[], index: number) => void;
}

const SearchSection: React.FC<SearchSectionProps> = ({
  jobId, photosById, eventByPhotoId, scopePerson, suggestions, onNotify, onActiveChange, onOpenItems,
}) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Array<{ photo: Photo; score: number }> | null>(null);
  const [lastQuery, setLastQuery] = useState('');

  const runSearch = async (overrideQuery?: string) => {
    const q = (overrideQuery ?? query).trim();
    if (!q || !jobId) return;
    if (overrideQuery) setQuery(overrideQuery);
    setSearching(true);
    try {
      const hits = await searchPhotos(jobId, q, 12, scopePerson?.id ?? null);
      setLastQuery(q);
      setResults(
        hits
          .map((hit) => {
            const photo = photosById.get(hit.photoId);
            return photo ? { photo, score: hit.score } : null;
          })
          .filter(Boolean) as Array<{ photo: Photo; score: number }>,
      );
      onActiveChange(true);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Search failed.', 'error');
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setResults(null);
    setQuery('');
    onActiveChange(false);
  };

  if (!jobId) return null;

  return (
    <div className="mb-8">
      <div className="liquid-glass-light rounded-2xl p-1.5 flex items-center gap-2 max-w-2xl">
        <div className="w-9 h-9 rounded-xl bg-lumina-500/10 flex items-center justify-center flex-shrink-0 ml-1">
          <Search className="w-4 h-4 text-lumina-500" />
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
            if (e.key === 'Escape' && results !== null) clearSearch();
          }}
          placeholder='Search photos by meaning — try "group hug", "sunset", "someone laughing"…'
          className="flex-1 bg-transparent outline-none text-sm text-slate-700 placeholder:text-slate-400 min-w-0"
        />
        {results !== null && (
          <button
            onClick={clearSearch}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 transition-colors flex-shrink-0"
            title="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => runSearch()}
          disabled={searching || !query.trim()}
          className="px-4 py-2 rounded-xl bg-lumina-500 text-white text-xs font-bold uppercase tracking-widest hover:bg-lumina-600 transition-colors disabled:opacity-50 flex items-center gap-1.5 flex-shrink-0"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Search
        </button>
      </div>

      <div className="flex items-center gap-2 mt-2 ml-2 flex-wrap">
        <p className="text-[10px] text-slate-400 tracking-wide uppercase flex-shrink-0">
          {scopePerson
            ? <>Searching <span className="text-lumina-500 font-bold">{scopePerson.label}</span>'s photos</>
            : 'Cross-modal search · CLIP ViT-B/32'}
        </p>
        {suggestions.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => runSearch(suggestion)}
                disabled={searching}
                className="px-2.5 py-1 rounded-full liquid-glass-light text-[10px] font-medium text-slate-500 hover:text-lumina-600 hover:bg-white/70 transition-colors"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>

      {results !== null && (
        <div className="mt-6" style={{ animation: 'fadeInUp 0.4s var(--smooth) both' }}>
          <div className="flex items-center justify-between gap-3 mb-4">
            <span className="text-base font-medium text-slate-700">
              {results.length > 0 ? `Top matches for "${lastQuery}"` : `No matches for "${lastQuery}"`}
            </span>
            <button
              onClick={clearSearch}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full liquid-glass-light text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-800 transition-colors flex-shrink-0"
            >
              <X className="w-3 h-3" />
              Back to gallery
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 md:gap-4">
            {results.map(({ photo, score }, i) => (
              <div
                key={photo.id}
                className="relative aspect-square rounded-2xl overflow-hidden group liquid-glass-light cursor-zoom-in"
                style={{ animation: `galleryCardIn 0.5s cubic-bezier(0.34,1.56,0.64,1) ${i * 45}ms both` }}
                onClick={() => onOpenItems(
                  results.map((r) => ({ photo: r.photo, event: eventByPhotoId.get(r.photo.id) ?? null })),
                  i,
                )}
              >
                <img src={photo.url} alt={photo.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />
                <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
                  <span className="bg-white/20 backdrop-blur-md border border-white/25 rounded-lg px-2 py-1 text-[10px] font-bold text-white tabular-nums">
                    {(score * 100).toFixed(0)}% match
                  </span>
                  {i === 0 && results.length > 1 && (
                    <span className="bg-lumina-500/80 backdrop-blur-md rounded-lg px-2 py-1 text-[9px] font-bold text-white uppercase tracking-widest">
                      Top
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); downloadPhoto(photo, i); }}
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Download"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------
   People manager (rename + merge corrections)
   ------------------------------------------------ */
interface PeopleManagerProps {
  identities: Identity[];
  photosById: Map<string, Photo>;
  onRename: (personId: string, label: string) => Promise<void>;
  onMerge: (sourceId: string, targetId: string) => Promise<void>;
  onMovePhoto: (photoId: string, fromPersonId: string, toPersonId: string) => Promise<void>;
  onClose: () => void;
}

const PeopleManager: React.FC<PeopleManagerProps> = ({ identities, photosById, onRename, onMerge, onMovePhoto, onClose }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [photosOpenId, setPhotosOpenId] = useState<string | null>(null);
  const [movingPhotoId, setMovingPhotoId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commitRename = async (personId: string) => {
    const label = editValue.trim();
    setEditingId(null);
    if (!label) return;
    setBusy(true);
    try { await onRename(personId, label); } finally { setBusy(false); }
  };

  const commitMerge = async (sourceId: string, targetId: string) => {
    setMergingId(null);
    setBusy(true);
    try { await onMerge(sourceId, targetId); } finally { setBusy(false); }
  };

  const commitMove = async (photoId: string, fromPersonId: string, toPersonId: string) => {
    setMovingPhotoId(null);
    setBusy(true);
    try { await onMovePhoto(photoId, fromPersonId, toPersonId); } finally { setBusy(false); }
  };

  // Portaled to <body>: the gallery's animated/filtered ancestors create CSS
  // containing blocks that hijack position:fixed and produced the "modal in a
  // random place + weird blur" bug.
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
      style={{ background: 'rgba(30, 27, 60, 0.28)', backdropFilter: 'blur(6px)', animation: 'fadeInUp 0.2s ease both' }}
    >
      <div
        className="w-full max-w-md max-h-[82vh] flex flex-col rounded-3xl overflow-hidden shadow-2xl shadow-black/25 ring-1 ring-white/60"
        style={{
          background: 'linear-gradient(165deg, rgba(255,255,255,0.98) 0%, rgba(248,246,255,0.96) 100%)',
          animation: 'scaleInBounce 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-4 px-6 pt-6 pb-5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-lumina-400 to-indigo-500 flex items-center justify-center flex-shrink-0 shadow-lg shadow-lumina-500/25">
            <Users className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold tracking-tight text-slate-800">Manage People</h3>
            <p className="text-[11px] text-slate-400 leading-snug">
              Rename or merge clusters — every fix is saved & teaches Lumina.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-slate-900/[0.04] flex items-center justify-center text-slate-400 hover:bg-slate-900/[0.08] hover:text-slate-700 transition-colors flex-shrink-0"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

        {/* People list */}
        <div className="overflow-y-auto px-4 py-4 space-y-2">
          {identities.map((ident, i) => (
            <div
              key={ident.id}
              className={`rounded-2xl border transition-all duration-300 ${
                mergingId === ident.id
                  ? 'bg-indigo-50/70 border-indigo-200 shadow-sm'
                  : 'bg-white/70 border-slate-100 hover:border-slate-200 hover:shadow-sm'
              }`}
              style={{ animation: `fadeInUp 0.35s var(--smooth) ${Math.min(i * 40, 300)}ms both` }}
            >
              <div className="flex items-center gap-3 p-3">
                <FaceAvatar faceThumb={ident.faceThumb} label={ident.label} size="sm" />
                <div className="min-w-0 flex-1">
                  {editingId === ident.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(ident.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => commitRename(ident.id)}
                      className="text-sm font-medium bg-transparent border-b-2 border-lumina-400 outline-none w-full pb-0.5 text-slate-800"
                      placeholder="Person name…"
                    />
                  ) : (
                    <button
                      onClick={() => { setEditingId(ident.id); setEditValue(ident.label); }}
                      className="text-sm font-medium text-slate-800 truncate hover:text-lumina-600 transition-colors text-left block max-w-full"
                      title="Click to rename"
                    >
                      {ident.label}
                    </button>
                  )}
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {ident.photoIds.length} {ident.photoIds.length === 1 ? 'photo' : 'photos'} · {ident.eventIds.length} {ident.eventIds.length === 1 ? 'event' : 'events'}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => {
                      setPhotosOpenId(photosOpenId === ident.id ? null : ident.id);
                      setMovingPhotoId(null);
                    }}
                    disabled={busy}
                    className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors disabled:opacity-40 ${
                      photosOpenId === ident.id
                        ? 'bg-slate-700 text-white'
                        : 'bg-slate-900/[0.06] text-slate-500 hover:bg-slate-900/[0.12]'
                    }`}
                    title="Review this person's photos / fix wrong assignments"
                  >
                    <ImageIcon className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setEditingId(ident.id); setEditValue(ident.label); }}
                    disabled={busy}
                    className="w-8 h-8 rounded-xl bg-lumina-500/10 flex items-center justify-center text-lumina-500 hover:bg-lumina-500/20 transition-colors disabled:opacity-40"
                    title="Rename"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {identities.length > 1 && (
                    <button
                      onClick={() => setMergingId(mergingId === ident.id ? null : ident.id)}
                      disabled={busy}
                      className={`h-8 rounded-xl flex items-center justify-center gap-1.5 px-2.5 transition-all duration-200 text-[10px] font-bold uppercase tracking-wider ${
                        mergingId === ident.id
                          ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/25'
                          : 'bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20'
                      }`}
                      title="Same person split into two clusters? Merge them."
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      Merge
                    </button>
                  )}
                </div>
              </div>

              {mergingId === ident.id && (
                <div className="px-3 pb-3" style={{ animation: 'fadeInUp 0.25s var(--smooth) both' }}>
                  <div className="rounded-xl bg-white/80 border border-indigo-100 p-3">
                    <p className="text-[11px] text-slate-500 mb-2 font-medium">
                      <span className="text-indigo-500 font-semibold">"{ident.label}"</span> is the same person as…
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {identities.filter((other) => other.id !== ident.id).map((other) => (
                        <button
                          key={other.id}
                          onClick={() => commitMerge(ident.id, other.id)}
                          disabled={busy}
                          className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 hover:shadow-sm transition-all text-xs font-medium text-slate-700 disabled:opacity-40"
                        >
                          <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                            {other.faceThumb
                              ? <img src={other.faceThumb} alt={other.label} className="w-full h-full object-cover" />
                              : <div className="w-full h-full bg-lumina-100 flex items-center justify-center"><User className="w-3 h-3 text-lumina-400" /></div>}
                          </div>
                          {other.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {photosOpenId === ident.id && (
                <div className="px-3 pb-3" style={{ animation: 'fadeInUp 0.25s var(--smooth) both' }}>
                  <div className="rounded-xl bg-white/80 border border-slate-200 p-3">
                    <p className="text-[11px] text-slate-500 mb-2 font-medium">
                      Click a photo that <span className="font-semibold">isn't</span> {ident.label} to reassign it.
                    </p>
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1" style={{ scrollbarWidth: 'none' }}>
                      {ident.photoIds.map((photoId) => {
                        const photo = photosById.get(photoId);
                        if (!photo) return null;
                        const selected = movingPhotoId === photoId;
                        return (
                          <button
                            key={photoId}
                            onClick={() => setMovingPhotoId(selected ? null : photoId)}
                            className={`relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 transition-all ${
                              selected ? 'ring-2 ring-red-400 scale-95' : 'hover:ring-2 hover:ring-slate-300'
                            }`}
                          >
                            <img src={photo.url} alt={photo.name} className="w-full h-full object-cover" loading="lazy" />
                            {ident.faceBoxes?.[photoId] && (
                              <FaceRing bbox={ident.faceBoxes[photoId]} imageAspect={1} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {movingPhotoId && identities.length > 1 && (
                      <div className="mt-2 pt-2 border-t border-slate-200/70" style={{ animation: 'fadeInUp 0.2s ease both' }}>
                        <p className="text-[11px] text-red-400 font-medium mb-1.5">This photo actually shows…</p>
                        <div className="flex flex-wrap gap-1.5">
                          {identities.filter((other) => other.id !== ident.id).map((other) => (
                            <button
                              key={other.id}
                              onClick={() => commitMove(movingPhotoId, ident.id, other.id)}
                              disabled={busy}
                              className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full bg-white border border-slate-200 hover:border-red-300 hover:bg-red-50 transition-all text-xs font-medium text-slate-700 disabled:opacity-40"
                            >
                              <div className="w-5 h-5 rounded-full overflow-hidden flex-shrink-0">
                                {other.faceThumb
                                  ? <img src={other.faceThumb} alt={other.label} className="w-full h-full object-cover" />
                                  : <div className="w-full h-full bg-lumina-100 flex items-center justify-center"><User className="w-3 h-3 text-lumina-400" /></div>}
                              </div>
                              {other.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-6 py-3.5 bg-slate-50/80 border-t border-slate-100 flex items-center gap-2">
          {busy
            ? <Loader2 className="w-3.5 h-3.5 text-lumina-500 animate-spin flex-shrink-0" />
            : <Sparkles className="w-3.5 h-3.5 text-lumina-400 flex-shrink-0" />}
          <p className="text-[11px] text-slate-400 leading-snug">
            {busy ? 'Saving correction…' : 'Corrections persist with this session and are logged as clustering feedback.'}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/* ------------------------------------------------
   Personalization panel (learned preference weights)
   ------------------------------------------------ */
interface PersonalizationPanelProps {
  jobId: string | null;
  anchor: DOMRect | null;
  onApplyRescore: (events: Array<{ eventId: string; topPhotoId: string | null }>) => void;
  onNotify: (message: string, kind?: Toast['kind']) => void;
  onClose: () => void;
}

const PersonalizationPanel: React.FC<PersonalizationPanelProps> = ({ jobId, anchor, onApplyRescore, onNotify, onClose }) => {
  const [state, setState] = useState<{ weights: NormSignals; defaults: NormSignals; nUpdates: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPreferences()
      .then((prefs) => setState({ weights: prefs.weights, defaults: prefs.defaultWeights, nUpdates: prefs.nUpdates }))
      .catch(() => onNotify('Could not load preferences.', 'error'));
  }, [onNotify]);

  const applyTaste = async () => {
    if (!jobId) return;
    setBusy(true);
    try {
      const rescored = await rescoreWithPreferences(jobId);
      onApplyRescore(rescored.events);
      onNotify('Rankings updated to match your taste.', 'success');
      onClose();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Rescore failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await resetPreferences();
      const prefs = await getPreferences();
      setState({ weights: prefs.weights, defaults: prefs.defaultWeights, nUpdates: prefs.nUpdates });
      onNotify('Preferences reset to defaults.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Reset failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Portaled + fixed so it always paints above the gallery, immune to the
  // stacking contexts created by animated/blurred ancestors.
  const panelStyle: React.CSSProperties = anchor
    ? { top: Math.min(anchor.bottom + 10, window.innerHeight - 80), right: Math.max(window.innerWidth - anchor.right, 16) }
    : { top: 96, right: 16 };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[300]" onClick={onClose} aria-hidden />
      <div
        className="fixed w-[min(360px,calc(100vw-2rem))] z-[310] max-h-[calc(100vh-120px)] overflow-y-auto rounded-2xl shadow-2xl shadow-black/20 ring-1 ring-white/60 p-5"
        style={{
          ...panelStyle,
          background: 'linear-gradient(165deg, rgba(255,255,255,0.98) 0%, rgba(248,246,255,0.96) 100%)',
          animation: 'scaleIn 0.2s cubic-bezier(0.34,1.56,0.64,1) both', transformOrigin: 'top right',
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-lumina-500" />
            Your Taste Profile
          </h4>
          {state && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {state.nUpdates} {state.nUpdates === 1 ? 'swap' : 'swaps'} learned
            </span>
          )}
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
          Every time you promote a different best shot, Lumina updates these signal
          weights with pairwise preference learning (Bradley-Terry).
        </p>

        {!state ? (
          <div className="flex items-center justify-center py-6 text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : (
          <div className="space-y-2.5 mb-4">
            {SIGNAL_UI.map(({ key, label }) => {
              const learned = state.weights[key] ?? 0;
              const base = state.defaults[key] ?? 0;
              const delta = learned - base;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500 font-medium">{label}</span>
                    <span className={`text-[10px] font-bold tabular-nums ${
                      Math.abs(delta) < 0.01 ? 'text-slate-400' : delta > 0 ? 'text-green-500' : 'text-red-400'
                    }`}>
                      {(learned * 100).toFixed(0)}%
                      {Math.abs(delta) >= 0.01 && (delta > 0 ? ' ▲' : ' ▼')}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-lumina-400 to-lumina-500 transition-all duration-500"
                      style={{ width: `${Math.min(learned * 200, 100)}%` }}
                    />
                    {/* default marker */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-slate-400/70"
                      style={{ left: `${Math.min(base * 200, 100)}%` }}
                      title={`Default: ${(base * 100).toFixed(0)}%`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={applyTaste}
            disabled={busy || !jobId || !state || state.nUpdates === 0}
            className="flex-1 py-2.5 rounded-xl bg-lumina-500 text-white text-xs font-bold uppercase tracking-widest hover:bg-lumina-600 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5"
            title={state?.nUpdates === 0 ? 'Promote a few best shots first so Lumina can learn your taste' : 'Re-rank all events with your personal weights'}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            Apply my taste
          </button>
          <button
            onClick={reset}
            disabled={busy || !state}
            className="px-3 py-2.5 rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors disabled:opacity-40"
            title="Reset to default weights"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};

/* ------------------------------------------------
   Person Pill Bar
   ------------------------------------------------ */
interface PersonPillBarProps {
  identities: Identity[];
  selectedPerson: string | null;
  onSelect: (personId: string | null) => void;
  onManage: () => void;
  showFaceRing: boolean;
  onToggleFaceRing: () => void;
}

const PersonPillBar: React.FC<PersonPillBarProps> = ({
  identities, selectedPerson, onSelect, onManage, showFaceRing, onToggleFaceRing,
}) => {
  if (identities.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-widest font-medium mb-3">
        <Users className="w-3.5 h-3.5" />
        <span>Filter by person</span>
        <button
          onClick={onManage}
          className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-lumina-500/10 text-lumina-500 hover:bg-lumina-500/20 transition-colors text-[10px] font-bold normal-case tracking-widest uppercase"
          title="Rename or merge people"
        >
          <Pencil className="w-2.5 h-2.5" />
          Manage
        </button>
        {selectedPerson && (
          <button
            onClick={onToggleFaceRing}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full transition-all duration-300 text-[10px] font-bold tracking-widest uppercase ${
              showFaceRing
                ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/25'
                : 'bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20'
            }`}
            style={{ animation: 'scaleIn 0.25s cubic-bezier(0.34,1.56,0.64,1) both' }}
            title="Circle this person's face in every photo"
          >
            <ScanFace className="w-3 h-3" />
            {showFaceRing ? 'Face spotlight on' : 'Face spotlight off'}
          </button>
        )}
      </div>
      <div
        className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        <button
          onClick={() => onSelect(null)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-300 flex-shrink-0 ${
            selectedPerson === null
              ? 'bg-lumina-500 text-white shadow-lg shadow-lumina-500/25'
              : 'liquid-glass-light text-slate-600 hover:bg-white/60'
          }`}
        >
          All People
        </button>

        {identities.map((ident) => (
          <button
            key={ident.id}
            onClick={() => onSelect(selectedPerson === ident.id ? null : ident.id)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-300 flex-shrink-0 ${
              selectedPerson === ident.id
                ? 'bg-lumina-500 text-white shadow-lg shadow-lumina-500/25'
                : 'liquid-glass-light text-slate-600 hover:bg-white/60'
            }`}
          >
            <div className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
              {ident.faceThumb ? (
                <img src={ident.faceThumb} alt={ident.label} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-lumina-100 flex items-center justify-center">
                  <User className="w-3.5 h-3.5 text-lumina-400" />
                </div>
              )}
            </div>
            <span>{ident.label}</span>
            <span className={`text-[10px] ${selectedPerson === ident.id ? 'text-white/70' : 'text-slate-400'}`}>
              {ident.photoIds.length}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------
   Event Pill Bar
   ------------------------------------------------ */
interface EventPillBarProps {
  events: Event[];
  selectedEvent: string | null;
  onSelect: (eventId: string | null) => void;
}

const EventPillBar: React.FC<EventPillBarProps> = ({ events, selectedEvent, onSelect }) => {
  if (events.length === 0) return null;

  return (
    <div className="mb-8 sm:mb-10">
      <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-widest font-medium mb-3">
        <CalendarDays className="w-3.5 h-3.5" />
        <span>Filter by event</span>
      </div>
      <div
        className="flex gap-2 overflow-x-auto scrollbar-hide pb-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        <button
          onClick={() => onSelect(null)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-300 flex-shrink-0 ${
            selectedEvent === null
              ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
              : 'liquid-glass-light text-slate-600 hover:bg-white/60'
          }`}
        >
          All Events
        </button>

        {events.map((evt) => (
          <button
            key={evt.id}
            onClick={() => onSelect(selectedEvent === evt.id ? null : evt.id)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-300 flex-shrink-0 ${
              selectedEvent === evt.id
                ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
                : 'liquid-glass-light text-slate-600 hover:bg-white/60'
            }`}
          >
            <CalendarDays className={`w-3.5 h-3.5 flex-shrink-0 ${selectedEvent === evt.id ? 'text-white/80' : 'text-indigo-400'}`} />
            <span>{evt.label}</span>
            <span className={`text-[10px] ${selectedEvent === evt.id ? 'text-white/70' : 'text-slate-400'}`}>
              {evt.photos.length}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------
   SmartGallery Page
   ------------------------------------------------ */
/* ------------------------------------------------
   Collage panel (themed PDF album export)
   ------------------------------------------------ */
interface CollagePanelProps {
  photoCount: number;
  enhancedCount: number;
  busy: boolean;
  onBuild: (options: {
    theme: string;
    title: string;
    autoTitle: boolean;
    captions: boolean;
    useEnhanced: boolean;
  }) => void;
  onClose: () => void;
}

const CollagePanel: React.FC<CollagePanelProps> = ({
  photoCount, enhancedCount, busy, onBuild, onClose,
}) => {
  const [themes, setThemes] = useState<CollageTheme[]>([]);
  const [theme, setTheme] = useState('midnight');
  const [aiAvailable, setAiAvailable] = useState(false);
  const [title, setTitle] = useState('');
  const [autoTitle, setAutoTitle] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [useEnhanced, setUseEnhanced] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getCollageThemes()
      .then((data) => {
        if (!alive) return;
        setThemes(data.themes);
        setTheme(data.default);
        setAiAvailable(data.aiTitles);
        setAutoTitle(data.aiTitles);
      })
      .catch((err) => { if (alive) setLoadError(err instanceof Error ? err.message : 'Could not load themes.'); });
    return () => { alive = false; };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 sm:p-6"
      onClick={busy ? undefined : onClose}
      style={{ background: 'rgba(30, 27, 60, 0.28)', backdropFilter: 'blur(6px)', animation: 'fadeInUp 0.2s ease both' }}
    >
      <div
        className="w-full max-w-md max-h-[86vh] flex flex-col rounded-3xl overflow-hidden shadow-2xl shadow-black/25 ring-1 ring-white/60"
        style={{
          background: 'linear-gradient(165deg, rgba(255,255,255,0.98) 0%, rgba(248,246,255,0.96) 100%)',
          animation: 'scaleInBounce 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-4 px-6 pt-6 pb-5">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-rose-500 flex items-center justify-center flex-shrink-0 shadow-lg shadow-amber-500/25">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold tracking-tight text-slate-800">Photo Album PDF</h3>
            <p className="text-[11px] text-slate-400 leading-snug">
              {photoCount} {photoCount === 1 ? 'photo' : 'photos'} laid out as a designed, printable album.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="w-9 h-9 rounded-full bg-slate-900/[0.04] flex items-center justify-center text-slate-400 hover:bg-slate-900/[0.08] hover:text-slate-700 transition-colors flex-shrink-0 disabled:opacity-40"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

        <div className="overflow-y-auto px-6 py-5 space-y-5">
          {loadError && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-3 py-2 text-[11px] text-red-600">
              {loadError}
            </div>
          )}

          {/* Theme */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 mb-2.5">Theme</p>
            <div className="grid grid-cols-2 gap-2">
              {themes.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTheme(t.key)}
                  className={`relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all duration-200 ring-1 ${
                    theme === t.key
                      ? 'ring-lumina-500 bg-lumina-500/[0.07] shadow-sm'
                      : 'ring-slate-200 hover:ring-slate-300 bg-white/60'
                  }`}
                >
                  <span className="flex -space-x-1.5 flex-shrink-0">
                    {t.swatch.map((hex, i) => (
                      <span
                        key={i}
                        className="w-4 h-4 rounded-full ring-1 ring-white"
                        style={{ background: hex }}
                      />
                    ))}
                  </span>
                  <span className="text-xs font-medium text-slate-700 truncate">{t.name}</span>
                  {theme === t.key && <Check className="w-3.5 h-3.5 text-lumina-500 ml-auto flex-shrink-0" />}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 mb-2.5">Title</p>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={autoTitle}
              placeholder={autoTitle ? 'Named by AI from your events' : 'Summer at the Bay'}
              className="glass-input rounded-xl py-2.5 px-3 w-full text-sm disabled:opacity-50"
            />
            {aiAvailable && (
              <label className="flex items-center gap-2 mt-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoTitle}
                  onChange={(e) => setAutoTitle(e.target.checked)}
                  className="accent-lumina-500 w-3.5 h-3.5"
                />
                <span className="text-[11px] text-slate-500">
                  Let AI name the album from your events and people
                </span>
              </label>
            )}
          </div>

          {/* Options */}
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={captions}
                onChange={(e) => setCaptions(e.target.checked)}
                className="accent-lumina-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-slate-500">Caption each photo with its event and people</span>
            </label>
            {enhancedCount > 0 && (
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useEnhanced}
                  onChange={(e) => setUseEnhanced(e.target.checked)}
                  className="accent-lumina-500 w-3.5 h-3.5"
                />
                <span className="text-[11px] text-slate-500">
                  Use the AI-enhanced version where one exists ({enhancedCount})
                </span>
              </label>
            )}
          </div>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

        <div className="px-6 py-4">
          <button
            onClick={() => onBuild({ theme, title: title.trim(), autoTitle, captions, useEnhanced })}
            disabled={busy || photoCount === 0}
            className="w-full flex items-center justify-center gap-2 bg-lumina-600 text-white px-5 py-3 rounded-xl text-xs font-bold uppercase tracking-[0.14em] hover:bg-lumina-700 disabled:opacity-40 transition-all duration-300"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {busy ? 'Designing album…' : 'Download PDF'}
          </button>
          <p className="text-[10px] text-slate-400 text-center mt-2.5 leading-snug">
            A4 landscape · cover page · varied mosaic layouts
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
};

interface SmartGalleryProps {
  jobId: string | null;
  events: Event[];
  identities: Identity[];
  onGoToPhotos?: () => void;
  onResultUpdate?: (result: import('../lib/analysisApi').AnalyzeResult) => void;
  /** Photos that already had an AI edit when a stored session was reopened. */
  enhancedPhotoIds?: string[];
}

export const SmartGallery: React.FC<SmartGalleryProps> = ({
  jobId,
  events: initialEvents,
  identities: initialIdentities,
  onGoToPhotos,
  onResultUpdate,
  enhancedPhotoIds,
}) => {
  const [events, setEvents] = useState<Event[]>(initialEvents);
  const [identities, setIdentities] = useState<Identity[]>(initialIdentities);
  const [hideClutter, setHideClutter] = useState(false);
  const [mmrMode, setMmrMode] = useState<MmrMode>('balanced');
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [peopleManagerOpen, setPeopleManagerOpen] = useState(false);
  const [personalizationOpen, setPersonalizationOpen] = useState(false);
  const [personalizationAnchor, setPersonalizationAnchor] = useState<DOMRect | null>(null);
  const [exporting, setExporting] = useState(false);
  const [collageOpen, setCollageOpen] = useState(false);
  const [collageBusy, setCollageBusy] = useState(false);
  const [enhanceEntries, setEnhanceEntries] = useState<Record<string, EnhanceEntry>>({});
  const [enhancePending, setEnhancePending] = useState<Record<string, boolean>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [searchActive, setSearchActive] = useState(false);
  const [faceRingOn, setFaceRingOn] = useState(true);
  const [rejectsOpen, setRejectsOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => { setEvents(initialEvents); }, [initialEvents]);
  useEffect(() => { setIdentities(initialIdentities); }, [initialIdentities]);

  // Reopening a session restores its enhancements. The identity score is not
  // persisted, so restored entries show the badge without a match percentage.
  useEffect(() => {
    if (!jobId || !enhancedPhotoIds?.length) return;
    setEnhanceEntries((prev) => {
      const next = { ...prev };
      for (const photoId of enhancedPhotoIds) {
        if (!next[photoId]) next[photoId] = { url: enhancedPhotoUrl(jobId, photoId) };
      }
      return next;
    });
  }, [jobId, enhancedPhotoIds]);

  const notify = useCallback((message: string, kind: Toast['kind'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const photosById = useMemo(() => {
    const map = new Map<string, Photo>();
    for (const evt of events) {
      for (const photo of evt.photos) map.set(photo.id, photo);
    }
    return map;
  }, [events]);

  const eventByPhotoId = useMemo(() => {
    const map = new Map<string, Event>();
    for (const evt of events) {
      for (const photo of evt.photos) map.set(photo.id, evt);
    }
    return map;
  }, [events]);

  // Search suggestion chips: this session's auto-detected scenes + evergreens
  const searchSuggestions = useMemo(() => {
    const fromEvents = [...new Set(events.map((e) => e.autoLabel?.label).filter(Boolean))] as string[];
    const evergreen = ['smiling', 'group photo', 'food', 'outdoors'];
    return [...fromEvents.slice(0, 4), ...evergreen.filter((s) => !fromEvents.includes(s))].slice(0, 6);
  }, [events]);

  // Deletion candidates across all events
  const rejects = useMemo(() => {
    const out: Array<{ photo: Photo; member: EventMember; event: Event }> = [];
    for (const evt of events) {
      for (const member of evt.members) {
        if ((member.flags?.length ?? 0) > 0) {
          const photo = photosById.get(member.photoId);
          if (photo) out.push({ photo, member, event: evt });
        }
      }
    }
    return out;
  }, [events, photosById]);

  const openLightbox = useCallback((items: LightboxItem[], index: number) => {
    setLightbox({ items, index });
  }, []);

  const openEventPhoto = useCallback((event: Event, photoId: string) => {
    // Ranked order: members best-first
    const items: LightboxItem[] = event.members
      .map((m) => {
        const photo = photosById.get(m.photoId);
        return photo ? { photo, event } : null;
      })
      .filter(Boolean) as LightboxItem[];
    const idx = Math.max(0, items.findIndex((it) => it.photo.id === photoId));
    setLightbox({ items, index: idx });
  }, [photosById]);

  /* ---- corrections (persisted when a jobId exists) ---- */

  const handleDelete = useCallback(async (id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setSelectedEvent((prev) => prev === id ? null : prev);
    if (jobId) {
      try {
        const result = await applyCorrection(jobId, { action: 'delete_event', eventId: id });
        onResultUpdate?.(result);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Delete failed on server.', 'error');
      }
    }
  }, [jobId, onResultUpdate, notify]);

  const handleRename = useCallback(async (id: string, newLabel: string) => {
    setEvents((prev) => prev.map((e) => e.id === id ? { ...e, label: newLabel } : e));
    if (jobId) {
      try {
        const result = await applyCorrection(jobId, { action: 'rename_event', eventId: id, label: newLabel });
        onResultUpdate?.(result);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Rename failed on server.', 'error');
      }
    }
  }, [jobId, onResultUpdate, notify]);

  const handleMakeBest = useCallback(async (eventId: string, photoId: string) => {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    const previousBest = event.topPhotoId;

    // Optimistic update
    setEvents((prev) => prev.map((e) => e.id === eventId ? { ...e, topPhotoId: photoId, userPinned: true } : e));

    if (jobId) {
      try {
        const response = await submitFeedback(jobId, eventId, photoId, previousBest);
        notify(`Best shot updated — taste profile learned (${response.nUpdates} ${response.nUpdates === 1 ? 'swap' : 'swaps'} so far).`);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Could not record feedback.', 'error');
      }
    } else {
      notify('Best shot updated.');
    }
  }, [events, jobId, notify]);

  const handlePersonRename = useCallback(async (personId: string, label: string) => {
    setIdentities((prev) => prev.map((i) => i.id === personId ? { ...i, label } : i));
    if (jobId) {
      try {
        const result = await applyCorrection(jobId, { action: 'rename_person', personId, label });
        onResultUpdate?.(result);
        notify(`Renamed to "${label}".`);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Rename failed.', 'error');
      }
    }
  }, [jobId, onResultUpdate, notify]);

  const handlePersonMerge = useCallback(async (sourceId: string, targetId: string) => {
    if (!jobId) {
      notify('Merging requires a saved session.', 'error');
      return;
    }
    try {
      const result = await applyCorrection(jobId, { action: 'merge_persons', personId: sourceId, targetPersonId: targetId });
      onResultUpdate?.(result);
      setSelectedPerson((prev) => (prev === sourceId ? targetId : prev));
      notify('People merged — clustering correction saved.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Merge failed.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleMovePhoto = useCallback(async (photoId: string, fromPersonId: string, toPersonId: string) => {
    if (!jobId) {
      notify('Reassigning requires a saved session.', 'error');
      return;
    }
    try {
      const result = await applyCorrection(jobId, { action: 'move_photo', photoId, personId: fromPersonId, targetPersonId: toPersonId });
      onResultUpdate?.(result);
      notify('Photo reassigned — clustering correction saved.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Reassign failed.', 'error');
    }
  }, [jobId, onResultUpdate, notify]);

  const handleApplyRescore = useCallback((rescored: Array<{ eventId: string; topPhotoId: string | null }>) => {
    setEvents((prev) => prev.map((evt) => {
      const update = rescored.find((r) => r.eventId === evt.id);
      if (!update?.topPhotoId || evt.userPinned) return evt;
      return { ...evt, topPhotoId: update.topPhotoId };
    }));
  }, []);

  /* ---- AI enhancement ---- */

  const handleEnhance = useCallback(async (photoId: string, style: EnhanceStyle = 'natural') => {
    if (!jobId) {
      notify('Enhancement requires a saved session.', 'error');
      return;
    }
    setEnhancePending((prev) => ({ ...prev, [photoId]: true }));
    try {
      const status = await enhancePhoto(jobId, photoId, style);
      setEnhanceEntries((prev) => ({
        ...prev,
        [photoId]: {
          // Cache-bust so a re-enhance of the same photo actually reloads.
          url: enhancedPhotoUrl(jobId, photoId, Date.now()),
          identityScore: status.identityScore,
          warning: status.warning,
        },
      }));
      if (status.warning) {
        notify(status.warning, 'error');
      } else if (status.identityScore != null) {
        notify(`Enhanced · identity verified (${(status.identityScore * 100).toFixed(0)}% match).`);
      } else {
        notify('Photo enhanced.');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Enhancement failed.', 'error');
    } finally {
      setEnhancePending((prev) => {
        const next = { ...prev };
        delete next[photoId];
        return next;
      });
    }
  }, [jobId, notify]);

  const handleRevertEnhance = useCallback(async (photoId: string) => {
    if (!jobId) return;
    setEnhanceEntries((prev) => {
      const next = { ...prev };
      delete next[photoId];
      return next;
    });
    setShowOriginal((prev) => {
      const next = { ...prev };
      delete next[photoId];
      return next;
    });
    try {
      await deleteEnhanced(jobId, photoId);
      notify('Reverted to the original.');
    } catch {
      // The UI already shows the original; a failed cleanup is not worth a toast.
    }
  }, [jobId, notify]);

  const handleToggleOriginal = useCallback((photoId: string) => {
    setShowOriginal((prev) => ({ ...prev, [photoId]: !prev[photoId] }));
  }, []);

  const enhanceContext = useMemo<EnhanceContextValue>(() => ({
    enabled: Boolean(jobId),
    entries: enhanceEntries,
    pending: enhancePending,
    showOriginal,
    enhance: handleEnhance,
    revert: handleRevertEnhance,
    toggleOriginal: handleToggleOriginal,
  }), [jobId, enhanceEntries, enhancePending, showOriginal,
       handleEnhance, handleRevertEnhance, handleToggleOriginal]);

  /* ---- Collage ---- */

  /** The photos currently on screen: MMR picks in showcase mode, else best-per-event. */
  const curatedPhotoIds = useCallback((): string[] => {
    const filtered = events
      .filter((e) => !selectedPerson || e.persons.includes(selectedPerson))
      .filter((e) => !selectedEvent || e.id === selectedEvent);
    const ids = new Set<string>();
    for (const evt of filtered) {
      if (hideClutter && evt.mmrPicks?.[mmrMode]?.length) {
        evt.mmrPicks[mmrMode]!.forEach((id) => ids.add(id));
      } else {
        ids.add(evt.topPhotoId);
      }
    }
    return [...ids];
  }, [events, selectedPerson, selectedEvent, hideClutter, mmrMode]);

  const handleBuildCollage = useCallback(async (options: {
    theme: string; title: string; autoTitle: boolean; captions: boolean; useEnhanced: boolean;
  }) => {
    if (!jobId) {
      notify('An album requires a saved session.', 'error');
      return;
    }
    const photoIds = curatedPhotoIds();
    if (photoIds.length === 0) {
      notify('Nothing to put in the album.', 'error');
      return;
    }
    setCollageBusy(true);
    try {
      await downloadCollage(jobId, { photoIds, ...options });
      notify(`Album ready — ${photoIds.length} ${photoIds.length === 1 ? 'photo' : 'photos'}.`);
      setCollageOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Album export failed.', 'error');
    } finally {
      setCollageBusy(false);
    }
  }, [jobId, curatedPhotoIds, notify]);

  const handleExport = useCallback(async () => {
    if (!jobId) {
      notify('Export requires a saved session.', 'error');
      return;
    }
    // Export what's on screen: MMR picks in showcase mode, otherwise the best shot per event
    const filtered = events
      .filter((e) => !selectedPerson || e.persons.includes(selectedPerson))
      .filter((e) => !selectedEvent || e.id === selectedEvent);
    const ids = new Set<string>();
    for (const evt of filtered) {
      if (hideClutter && evt.mmrPicks?.[mmrMode]?.length) {
        evt.mmrPicks[mmrMode]!.forEach((id) => ids.add(id));
      } else {
        ids.add(evt.topPhotoId);
      }
    }
    if (ids.size === 0) {
      notify('Nothing to export.', 'error');
      return;
    }
    setExporting(true);
    try {
      await exportAlbum(jobId, [...ids], 'lumina-best-shots');
      notify(`Exported ${ids.size} ${ids.size === 1 ? 'photo' : 'photos'}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  }, [jobId, events, selectedPerson, selectedEvent, hideClutter, mmrMode, notify]);

  /* ---- derived view state ---- */

  const filteredEvents = events
    .filter((e) => !selectedPerson || e.persons.includes(selectedPerson))
    .filter((e) => !selectedEvent || e.id === selectedEvent);

  const eventsForPillBar = selectedPerson
    ? events.filter((e) => e.persons.includes(selectedPerson))
    : events;

  const totalPhotos = events.reduce((acc, e) => acc + e.photos.length, 0);

  // Identity whose face gets the spotlight ring in photos
  const highlightPerson = faceRingOn && selectedPerson
    ? identities.find((i) => i.id === selectedPerson) ?? null
    : null;

  if (events.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-20 text-center">
        <div className="liquid-glass rounded-3xl p-12 anim-scale-in">
          <div className="w-16 h-16 rounded-full bg-lumina-500/10 text-lumina-400 flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Your smart gallery will appear here</h2>
          <p className="text-sm text-slate-400 tracking-wide mb-8 max-w-md mx-auto leading-relaxed">
            Select and analyze photos first. Lumina will group them by event and pick the best shots automatically.
          </p>
          {onGoToPhotos && (
            <button
              onClick={onGoToPhotos}
              className="bg-lumina-600 text-white px-6 py-3 rounded-xl text-sm font-semibold tracking-wide inline-flex items-center gap-2 hover:bg-lumina-700 transition-all duration-300"
            >
              <ImageIcon className="w-4 h-4" />
              Go to Photos
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <EnhanceContext.Provider value={enhanceContext}>
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-8">
        <div>
          <div className="flex items-center gap-2 text-lumina-400 font-medium text-xs uppercase tracking-widest mb-2 anim-fade-in-left">
            <Zap className="w-3.5 h-3.5" />
            <span>Event-Based Smart Curation Active</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-medium tracking-tight anim-fade-in-up d-100">Smart Gallery</h2>
          <p className="text-slate-400 text-sm mt-1 tracking-wide anim-fade-in-up d-200">
            {events.length} {events.length === 1 ? 'event' : 'events'} · {identities.length} {identities.length === 1 ? 'person' : 'people'} · {totalPhotos} photos
          </p>
        </div>

        <div className={`flex items-center gap-2.5 anim-fade-in-right d-300 flex-wrap ${searchActive ? 'hidden' : ''}`}>
          {/* Personalization */}
          <button
            onClick={(e) => {
              setPersonalizationAnchor(e.currentTarget.getBoundingClientRect());
              setPersonalizationOpen((v) => !v);
            }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-[11px] font-bold uppercase tracking-[0.14em] transition-all duration-300 ${
              personalizationOpen
                ? 'bg-lumina-500 text-white shadow-lg shadow-lumina-500/25'
                : 'liquid-glass glass-prismatic-soft text-slate-600 hover:text-slate-900'
            }`}
            title="Your learned taste profile"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            My Taste
          </button>
          {personalizationOpen && (
            <PersonalizationPanel
              jobId={jobId}
              anchor={personalizationAnchor}
              onApplyRescore={handleApplyRescore}
              onNotify={notify}
              onClose={() => setPersonalizationOpen(false)}
            />
          )}

          {/* PDF album */}
          <button
            onClick={() => setCollageOpen(true)}
            disabled={!jobId}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full liquid-glass glass-prismatic-soft text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600 hover:text-slate-900 transition-all duration-300 disabled:opacity-40"
            title={jobId ? 'Build a themed PDF album from these picks' : 'An album requires a saved session'}
          >
            <FileText className="w-3.5 h-3.5 text-amber-500" />
            Album
          </button>

          {/* Export */}
          <button
            onClick={handleExport}
            disabled={exporting || !jobId}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full liquid-glass glass-prismatic-soft text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600 hover:text-slate-900 transition-all duration-300 disabled:opacity-40"
            title={jobId ? 'Download the curated selection as a zip' : 'Export requires a saved session'}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5 text-lumina-500" />}
            Export
          </button>

          {/* Rejects bin */}
          {rejects.length > 0 && (
            <button
              onClick={() => { setRejectsOpen((v) => !v); setHideClutter(false); }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-[11px] font-bold uppercase tracking-[0.14em] transition-all duration-300 ${
                rejectsOpen
                  ? 'bg-red-500 text-white shadow-lg shadow-red-500/25'
                  : 'liquid-glass glass-prismatic-soft text-slate-600 hover:text-red-500'
              }`}
              title="Photos Lumina thinks you can safely delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Rejects ({rejects.length})
            </button>
          )}

          {/* Showcase toggle */}
          <button
            onClick={() => setHideClutter((v) => !v)}
            className={`showcase-mode-btn relative overflow-hidden flex items-center gap-2.5 px-5 py-2.5 rounded-full cursor-pointer font-bold text-[11px] uppercase tracking-[0.14em] select-none ${
              hideClutter
                ? 'showcase-mode-btn--active'
                : 'showcase-mode-btn--inactive liquid-glass glass-prismatic-soft text-slate-600 hover:text-slate-900'
            }`}
          >
            {hideClutter && (
              <span
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: 'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.22) 50%, transparent 70%)',
                  backgroundSize: '200% 100%',
                  animation: 'shimmerSweep 3.5s ease-in-out infinite',
                }}
              />
            )}

            <Sparkles
              className={`w-4 h-4 flex-shrink-0 transition-colors duration-300 ${hideClutter ? 'text-white' : 'text-lumina-500'}`}
              style={hideClutter ? { animation: 'breathe 1.8s ease-in-out infinite' } : undefined}
            />

            <span className="relative z-[1]">
              {hideClutter ? 'Showcase On' : 'Best Shots'}
            </span>

            {hideClutter ? (
              <span className="relative z-[1] w-2 h-2 rounded-full bg-white/80 flex-shrink-0" style={{ animation: 'breathe 1.2s ease-in-out infinite' }} />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-lumina-400 flex-shrink-0" />
            )}
          </button>
        </div>
      </div>

      {/* CLIP semantic search — while results are showing, it takes over the page */}
      <SearchSection
        jobId={jobId}
        photosById={photosById}
        eventByPhotoId={eventByPhotoId}
        scopePerson={selectedPerson ? identities.find((i) => i.id === selectedPerson) ?? null : null}
        suggestions={searchSuggestions}
        onNotify={notify}
        onActiveChange={setSearchActive}
        onOpenItems={openLightbox}
      />

      {/* Person pill bar */}
      {!searchActive && (
        <PersonPillBar
          identities={identities}
          selectedPerson={selectedPerson}
          onSelect={(id) => { setSelectedPerson(id); setSelectedEvent(null); }}
          onManage={() => setPeopleManagerOpen(true)}
          showFaceRing={faceRingOn}
          onToggleFaceRing={() => setFaceRingOn((v) => !v)}
        />
      )}

      {/* Event pill bar */}
      {!searchActive && (
        <EventPillBar
          events={eventsForPillBar}
          selectedEvent={selectedEvent}
          onSelect={setSelectedEvent}
        />
      )}

      {/* Main content: Rejects bin OR Showcase gallery OR event rows */}
      {!searchActive && rejectsOpen && (
        <div key="rejects" style={{ animation: 'fadeInUp 0.4s var(--smooth) both' }}>
          <div className="flex flex-col items-center text-center gap-2 mb-8">
            <div className="inline-flex items-center gap-2 px-5 py-2 rounded-full liquid-glass">
              <Trash2 className="w-3.5 h-3.5 text-red-400" />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-red-400">Deletion Candidates</span>
            </div>
            <p className="text-slate-400 text-sm tracking-wide max-w-md">
              {rejects.length} {rejects.length === 1 ? 'photo' : 'photos'} flagged as duplicates, blinks, blur or
              low quality. Nothing is deleted — this is Lumina's cleanup shortlist.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {rejects.map(({ photo, member, event }, i) => (
              <div
                key={photo.id}
                className="relative rounded-2xl overflow-hidden liquid-glass-light cursor-zoom-in group"
                style={{ animation: `galleryCardIn 0.5s cubic-bezier(0.34,1.56,0.64,1) ${Math.min(i * 40, 500)}ms both` }}
                onClick={() => openEventPhoto(event, photo.id)}
              >
                <div className="aspect-square">
                  <img src={photo.url} alt={photo.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
                </div>
                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent">
                  <div className="flex flex-wrap gap-1">
                    {(member.flags ?? []).map((flag) => (
                      <span key={flag} className="px-1.5 py-0.5 rounded-md bg-red-500/80 text-white text-[8px] font-bold uppercase tracking-widest">
                        {REJECT_FLAG_UI[flag]?.label ?? flag}
                      </span>
                    ))}
                  </div>
                  <p className="text-[9px] text-white/60 mt-1 truncate">{event.label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!searchActive && !rejectsOpen && (hideClutter ? (
        <BestShotsGallery
          key="showcase"
          events={filteredEvents}
          identities={identities}
          mmrMode={mmrMode}
          onMmrModeChange={setMmrMode}
          highlightPerson={highlightPerson}
          onOpenItems={openLightbox}
        />
      ) : (
        <div key="events" className="space-y-20">
          {filteredEvents.map((event, i) => (
            <EventRow
              key={event.id}
              event={event}
              identities={identities}
              index={i}
              onDelete={handleDelete}
              onRename={handleRename}
              onMakeBest={handleMakeBest}
              highlightPerson={highlightPerson}
              onOpenPhoto={openEventPhoto}
            />
          ))}
        </div>
      ))}

      {/* No results for active filters */}
      {!searchActive && !hideClutter && filteredEvents.length === 0 && (selectedPerson || selectedEvent) && (
        <div className="text-center py-20">
          <div className="liquid-glass rounded-3xl p-12 max-w-md mx-auto">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <Filter className="w-6 h-6 text-slate-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">No results for this filter</h3>
            <p className="text-sm text-slate-400 mb-4">
              {selectedPerson && selectedEvent
                ? 'This person does not appear in that event.'
                : selectedPerson
                ? 'This person has no events.'
                : 'No photos match this event filter.'}
            </p>
            <button
              onClick={() => { setSelectedPerson(null); setSelectedEvent(null); }}
              className="text-xs font-semibold uppercase tracking-widest text-lumina-500 hover:text-lumina-400 transition-colors"
            >
              Clear all filters
            </button>
          </div>
        </div>
      )}

      {/* People manager modal */}
      {peopleManagerOpen && (
        <PeopleManager
          identities={identities}
          photosById={photosById}
          onRename={handlePersonRename}
          onMerge={handlePersonMerge}
          onMovePhoto={handleMovePhoto}
          onClose={() => setPeopleManagerOpen(false)}
        />
      )}

      {/* Full-screen photo viewer */}
      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          onNavigate={(index) => setLightbox((prev) => prev ? { ...prev, index } : prev)}
          onClose={() => setLightbox(null)}
          onMakeBest={handleMakeBest}
        />
      )}

      {/* Themed PDF album */}
      {collageOpen && (
        <CollagePanel
          photoCount={curatedPhotoIds().length}
          enhancedCount={Object.keys(enhanceEntries).length}
          busy={collageBusy}
          onBuild={handleBuildCollage}
          onClose={() => setCollageOpen(false)}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
    </EnhanceContext.Provider>
  );
};
