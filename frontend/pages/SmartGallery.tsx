
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Event, Identity, Photo } from '../types';
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
  Image as ImageIcon,
  Pencil,
  AlertTriangle,
  Check,
  X,
  CalendarDays,
  Users,
} from 'lucide-react';

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
      <div
        className="fixed inset-0 z-40 bg-white/[0.04] backdrop-blur-2xl backdrop-saturate-150 dark:bg-white/[0.03]"
        onClick={onClose}
        aria-hidden
      />
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
   Horizontal image carousel
   ------------------------------------------------ */
interface ClusterCarouselProps {
  photos: Photo[];
}

const ClusterCarousel: React.FC<ClusterCarouselProps> = ({ photos }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());

  const markLoaded = useCallback((id: string) => {
    setLoadedImages((prev) => new Set(prev).add(id));
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
            <div className="relative aspect-square rounded-2xl overflow-hidden group/img cursor-pointer liquid-glass-light">
              {!loadedImages.has(photo.id) && (
                <div className="absolute inset-0 skeleton" />
              )}
              <img
                src={photo.url}
                alt={photo.name}
                className={`w-full h-full object-cover transition-all duration-500 group-hover/img:scale-105 ${loadedImages.has(photo.id) ? '' : 'opacity-0'}`}
                loading="lazy"
                onLoad={() => markLoaded(photo.id)}
              />
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/img:opacity-100 transition-opacity duration-300 pointer-events-none group-hover/img:pointer-events-auto">
                <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
                  <button
                    onClick={() => downloadPhoto(photo, i)}
                    className="w-7 h-7 rounded-full liquid-glass flex items-center justify-center text-white hover:bg-white/20 transition-colors duration-200"
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="w-7 h-7 rounded-full liquid-glass flex items-center justify-center text-white hover:bg-red-500/60 transition-colors duration-200"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
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
   Best Shot Card (used inside BestShotsGallery)
   ------------------------------------------------ */
interface BestShotCardProps {
  photo: Photo;
  event: Event;
  nimaScore: number;
  persons: Identity[];
  index: number;
}

const BestShotCard: React.FC<BestShotCardProps> = ({ photo, event, nimaScore, persons, index }) => {
  const [loaded, setLoaded] = useState(false);

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
      className={`gallery-card relative overflow-hidden rounded-2xl cursor-pointer group ${sizeClasses}`}
      style={{ animation: `galleryCardIn 0.65s cubic-bezier(0.34, 1.56, 0.64, 1) ${Math.min(index * 55, 650)}ms both` }}
    >
      {/* Skeleton */}
      {!loaded && <div className="absolute inset-0 skeleton z-[1]" />}

      {/* Photo */}
      <img
        src={photo.url}
        alt={photo.name}
        className={`w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.07] ${loaded ? 'opacity-100' : 'opacity-0'}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />

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
          <Award className="w-3 h-3 text-amber-400" />
          <span className="text-[9px] font-bold text-white uppercase tracking-widest leading-none">Best</span>
        </div>
        {nimaScore > 0 && (
          <div className={`px-2 py-1 rounded-lg backdrop-blur-md text-[9px] font-bold text-white leading-none ${nimaScore >= 6 ? 'bg-green-500/70' : nimaScore >= 4.5 ? 'bg-yellow-500/70' : 'bg-red-500/70'}`}>
            {nimaScore.toFixed(1)}
          </div>
        )}
      </div>

      {/* Top-right download — appears on hover */}
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-300">
        <button
          onClick={(e) => { e.stopPropagation(); downloadPhoto(photo, index); }}
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
   Best Shots Gallery (full showcase view)
   ------------------------------------------------ */
interface BestShotsGalleryProps {
  events: Event[];
  identities: Identity[];
}

const BestShotsGallery: React.FC<BestShotsGalleryProps> = ({ events, identities }) => {
  const items = events
    .map((e) => {
      const photo = e.photos.find((p) => p.id === e.topPhotoId) ?? e.photos[0];
      const nimaScore = e.members.find((m) => m.photoId === e.topPhotoId)?.nimaScore ?? 0;
      const persons = identities.filter((ident) => e.persons.includes(ident.id));
      return photo ? { photo, event: e, nimaScore, persons } : null;
    })
    .filter(Boolean) as Array<{ photo: Photo; event: Event; nimaScore: number; persons: Identity[] }>;

  if (items.length === 0) return null;

  return (
    <div style={{ animation: 'showcaseReveal 0.55s cubic-bezier(0.4, 0, 0.2, 1) both' }}>
      {/* Showcase header */}
      <div className="flex flex-col items-center text-center gap-3 mb-10">
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
          {items.length} curated {items.length === 1 ? 'pick' : 'picks'} · finest quality from {events.length} {events.length === 1 ? 'event' : 'events'}
        </p>
      </div>

      {/* Masonry grid */}
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4"
        style={{ gridAutoRows: 'clamp(140px, 16vw, 230px)', gridAutoFlow: 'dense' }}
      >
        {items.map((item, i) => (
          <BestShotCard key={item.photo.id} {...item} index={i} />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------
   Action circle button
   ------------------------------------------------ */
const ActionCircle: React.FC<{ icon: React.ReactNode; label: string; danger?: boolean; onClick?: () => void }> = ({
  icon, label, danger, onClick,
}) => (
  <button
    onClick={onClick}
    className={`w-11 h-11 rounded-full liquid-glass flex items-center justify-center text-white transition-all duration-300 hover:scale-110 ${danger ? 'hover:bg-red-500/60' : 'hover:bg-white/20'}`}
    title={label}
  >
    {icon}
  </button>
);

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
  hideClutter: boolean;
  index: number;
  onDelete: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
}

const EventRow: React.FC<EventRowProps> = ({ event, identities, hideClutter, index, onDelete, onRename }) => {
  const topPhoto = event.photos.find((p) => p.id === event.topPhotoId) ?? event.photos[0];
  const otherPhotos = event.photos.filter((p) => p.id !== event.topPhotoId);
  const view = useInView(0.05);

  const [bestShotLoaded, setBestShotLoaded] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [labelValue, setLabelValue] = useState(event.label);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setLabelValue(event.label); }, [event.label]);
  useEffect(() => { if (isRenaming) renameInputRef.current?.focus(); }, [isRenaming]);

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

  // Get NIMA score for best shot
  const topMember = event.members.find((m) => m.photoId === event.topPhotoId);
  const nimaScore = topMember?.nimaScore ?? 0;

  // Get person avatars for this event
  const eventIdentities = identities.filter((ident) => event.persons.includes(ident.id));

  if (!topPhoto) return null;

  return (
    <section
      id={`event-${event.id}`}
      ref={view.ref}
      className={`flex flex-col gap-8 ${view.visible ? 'anim-fade-in-up' : 'opacity-0'}`}
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
              <h3
                className="text-base sm:text-lg font-medium tracking-tight truncate cursor-default"
                onDoubleClick={() => setIsRenaming(true)}
                title="Double-click to rename"
              >
                {event.label}
              </h3>
            )}
            <div className="flex items-center gap-2 mt-0.5">
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
          <div className="relative aspect-[4/3] rounded-2xl overflow-hidden liquid-glass-heavy glass-prismatic shadow-xl shadow-black/10">
            {!bestShotLoaded && (
              <div className="absolute inset-0 skeleton z-[1]" />
            )}
            <img
              src={topPhoto.url}
              alt="Best Pick"
              className={`w-full h-full object-cover transition-all duration-700 group-hover:scale-[1.03] ${bestShotLoaded ? '' : 'opacity-0'}`}
              onLoad={() => setBestShotLoaded(true)}
            />
            <div className="absolute top-4 left-4 liquid-glass rounded-xl px-3 py-1.5 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-lumina-500 anim-breathe" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-white">Best Shot</span>
            </div>
            <NimaBadge score={nimaScore} />
            <div className="absolute top-4 right-4 w-9 h-9 rounded-full liquid-glass flex items-center justify-center">
              <Award className="w-4 h-4 text-white" />
            </div>
            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-all duration-400 pointer-events-none group-hover:pointer-events-auto">
              <div className="absolute bottom-4 right-4 flex items-center gap-2">
                <ActionCircle icon={<Download className="w-4 h-4" />} label="Download" onClick={() => downloadPhoto(topPhoto, 0)} />
                <ActionCircle icon={<Trash2 className="w-4 h-4" />} label="Delete" danger />
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between px-1">
            <span className="text-xs font-normal text-slate-400 tracking-wide">
              Highest 7-signal quality score in this event
            </span>
            <button className="text-[10px] font-medium uppercase tracking-widest text-lumina-500 hover:text-lumina-400 transition-colors">
              Keep Original
            </button>
          </div>
        </div>

        {/* Other photos carousel or hidden state */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {otherPhotos.length > 0 && (
            <div className={`transition-all duration-600 ${hideClutter ? 'opacity-0 scale-95 translate-y-4 pointer-events-none h-0' : 'opacity-100 scale-100 translate-y-0'}`}>
              <ClusterCarousel photos={otherPhotos} />
            </div>
          )}

          {hideClutter && otherPhotos.length > 0 && (
            <div className="liquid-glass rounded-2xl flex flex-col items-center justify-center text-center p-10 min-h-[220px]" style={{ animation: 'scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both' }}>
              <div className="w-12 h-12 rounded-full bg-green-500/15 text-green-400 flex items-center justify-center mb-4">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="font-medium text-sm mb-1">Event Culled</h4>
              <p className="text-xs text-slate-400 max-w-[220px] leading-relaxed tracking-wide">
                {otherPhotos.length} similar {otherPhotos.length === 1 ? 'shot' : 'shots'} hidden for this event.
              </p>
            </div>
          )}

          {otherPhotos.length === 0 && (
            <div className="liquid-glass rounded-2xl flex flex-col items-center justify-center text-center p-10 min-h-[220px]">
              <div className="w-12 h-12 rounded-full bg-lumina-500/10 text-lumina-400 flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6" />
              </div>
              <h4 className="font-medium text-sm mb-1">Only one photo</h4>
              <p className="text-xs text-slate-400 max-w-[220px] leading-relaxed tracking-wide">No other shots in this event.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

/* ------------------------------------------------
   Person Pill Bar
   ------------------------------------------------ */
interface PersonPillBarProps {
  identities: Identity[];
  selectedPerson: string | null;
  onSelect: (personId: string | null) => void;
}

const PersonPillBar: React.FC<PersonPillBarProps> = ({ identities, selectedPerson, onSelect }) => {
  if (identities.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs uppercase tracking-widest font-medium mb-3">
        <Users className="w-3.5 h-3.5" />
        <span>Filter by person</span>
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
interface SmartGalleryProps {
  events: Event[];
  identities: Identity[];
  onGoToPhotos?: () => void;
}

export const SmartGallery: React.FC<SmartGalleryProps> = ({ events: initialEvents, identities: initialIdentities, onGoToPhotos }) => {
  const [events, setEvents] = useState<Event[]>(initialEvents);
  const [identities] = useState<Identity[]>(initialIdentities);
  const [hideClutter, setHideClutter] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  useEffect(() => { setEvents(initialEvents); }, [initialEvents]);

  const handleDelete = useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setSelectedEvent((prev) => prev === id ? null : prev);
  }, []);

  const handleRename = useCallback((id: string, newLabel: string) => {
    setEvents((prev) => prev.map((e) => e.id === id ? { ...e, label: newLabel } : e));
  }, []);

  // Apply both filters (intersection)
  const filteredEvents = events
    .filter((e) => !selectedPerson || e.persons.includes(selectedPerson))
    .filter((e) => !selectedEvent || e.id === selectedEvent);

  // Events available for the event pill bar (respects person filter so pills stay relevant)
  const eventsForPillBar = selectedPerson
    ? events.filter((e) => e.persons.includes(selectedPerson))
    : events;

  const totalPhotos = events.reduce((acc, e) => acc + e.photos.length, 0);

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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-8 md:mb-10">
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

        <div className="anim-fade-in-right d-300">
          <button
            onClick={() => setHideClutter((v) => !v)}
            className={`showcase-mode-btn relative overflow-hidden flex items-center gap-2.5 px-5 py-2.5 rounded-full cursor-pointer font-bold text-[11px] uppercase tracking-[0.14em] select-none ${
              hideClutter
                ? 'showcase-mode-btn--active'
                : 'showcase-mode-btn--inactive liquid-glass glass-prismatic-soft text-slate-600 hover:text-slate-900'
            }`}
          >
            {/* Shimmer sweep on active */}
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

      {/* Person pill bar */}
      <PersonPillBar
        identities={identities}
        selectedPerson={selectedPerson}
        onSelect={(id) => { setSelectedPerson(id); setSelectedEvent(null); }}
      />

      {/* Event pill bar */}
      <EventPillBar
        events={eventsForPillBar}
        selectedEvent={selectedEvent}
        onSelect={setSelectedEvent}
      />

      {/* Main content: Showcase gallery OR event rows */}
      {hideClutter ? (
        <BestShotsGallery key="showcase" events={filteredEvents} identities={identities} />
      ) : (
        <div key="events" className="space-y-20">
          {filteredEvents.map((event, i) => (
            <EventRow
              key={event.id}
              event={event}
              identities={identities}
              hideClutter={false}
              index={i}
              onDelete={handleDelete}
              onRename={handleRename}
            />
          ))}
        </div>
      )}

      {/* No results for active filters */}
      {!hideClutter && filteredEvents.length === 0 && (selectedPerson || selectedEvent) && (
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
    </div>
  );
};
