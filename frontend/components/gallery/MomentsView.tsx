import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, Crown, Download, Info, Loader2, Pencil, Pin, ScanFace, Trash2, Undo2, Wand2, X,
} from 'lucide-react';
import type { Event, EventMember, Identity, Photo } from '../../types';
import { lumiSrc } from '../Lumi';
import { poseForEvent } from '../../lib/lumiScenes';
import { gsap, ScrollTrigger, prefersReducedMotion } from '../../lib/motion';
import { FaceAvatar, FaceRing, Img, downloadPhoto, useEnhance, useFocal } from './shared';
import { WhyModal } from './WhyModal';
import { PhotoGrid, PhotoTile, keeperIds } from './PhotoGrid';
import { useReveal } from './motion';

/* ------------------------------------------------
   Mosaic layout: the best shot plus up to four others, in a box whose
   proportions never depend on the photos (so nothing shifts as they load).
   Spans are for the 8-column, 2-row grid used from `sm` up.
   ------------------------------------------------ */
const MOSAIC: Record<number, { hero: string; side: string[] }> = {
  0: { hero: 'sm:col-span-8 sm:row-span-2', side: [] },
  1: { hero: 'sm:col-span-5 sm:row-span-2', side: ['sm:col-span-3 sm:row-span-2'] },
  2: { hero: 'sm:col-span-5 sm:row-span-2', side: ['sm:col-span-3', 'sm:col-span-3'] },
  3: { hero: 'sm:col-span-4 sm:row-span-2', side: ['sm:col-span-2 sm:row-span-2', 'sm:col-span-2', 'sm:col-span-2'] },
  4: { hero: 'sm:col-span-4 sm:row-span-2', side: ['sm:col-span-2', 'sm:col-span-2', 'sm:col-span-2', 'sm:col-span-2'] },
};

/** Height tween for disclosures: open from 0, or close to 0 then call back. */
function useDisclosure(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current || prefersReducedMotion()) return;
    gsap.fromTo(ref.current, { height: 0, opacity: 0 }, {
      height: 'auto', opacity: 1, duration: 0.55, ease: 'power3.inOut', clearProps: 'height,opacity',
    });
  }, [open]);
  const close = (done: () => void) => {
    if (!ref.current || prefersReducedMotion()) { done(); return; }
    gsap.to(ref.current, { height: 0, opacity: 0, duration: 0.4, ease: 'power3.inOut', onComplete: done });
  };
  return { ref, close };
}

/* ------------------------------------------------
   One moment
   ------------------------------------------------ */
interface MomentCardProps {
  event: Event;
  index: number;
  identities: Identity[];
  highlightPerson: Identity | null;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onMakeBest: (eventId: string, photoId: string) => void;
  onOpenPhoto: (event: Event, photoId: string) => void;
}

const MomentCard: React.FC<MomentCardProps> = ({
  event, index, identities, highlightPerson, onDelete, onRename, onMakeBest, onOpenPhoto,
}) => {
  const enh = useEnhance();
  const [renaming, setRenaming] = useState(false);
  const [labelValue, setLabelValue] = useState(event.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [why, setWhy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [heroAspect, setHeroAspect] = useState<number | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const heroFocal = useFocal(event.topPhotoId);
  const moreBox = useDisclosure(expanded);

  useEffect(() => { setLabelValue(event.label); }, [event.label]);
  useEffect(() => { if (renaming) renameRef.current?.select(); }, [renaming]);

  const top = event.photos.find((p) => p.id === event.topPhotoId) ?? event.photos[0];
  const members = useMemo(() => new Map<string, EventMember>(event.members.map((m) => [m.photoId, m])), [event.members]);
  const topMember = top ? members.get(top.id) : undefined;

  // Side tiles: the next-best keepers first (members are ranked best-first),
  // then anything else, so the mosaic shows the strongest shots.
  const others = useMemo(() => {
    const byId = new Map<string, Photo>(event.photos.map((p) => [p.id, p]));
    const keep = keeperIds(event);
    const ranked = event.members.map((m) => byId.get(m.photoId)).filter((p): p is Photo => Boolean(p));
    const rest = event.photos.filter((p) => !members.has(p.id));
    const ordered = [...ranked, ...rest].filter((p) => p.id !== top?.id);
    return [...ordered.filter((p) => keep.has(p.id)), ...ordered.filter((p) => !keep.has(p.id))];
  }, [event, members, top?.id]);

  const side = others.slice(0, 4);
  const hidden = others.slice(4);
  const layout = MOSAIC[side.length];

  const people = identities.filter((i) => event.persons.includes(i.id));
  const identityById = useMemo(() => new Map(identities.map((i) => [i.id, i])), [identities]);
  const bestOfEach = (event.bestByPerson ?? [])
    .map((b) => ({ pick: b, person: identityById.get(b.personId) }))
    .filter((x): x is { pick: typeof x.pick; person: Identity } => Boolean(x.person));

  const commitRename = useCallback(() => {
    const trimmed = labelValue.trim();
    if (trimmed && trimmed !== event.label) onRename(event.id, trimmed);
    else setLabelValue(event.label);
    setRenaming(false);
  }, [labelValue, event.label, event.id, onRename]);

  const downloadAll = () => {
    event.photos.forEach((photo, i) => setTimeout(() => { downloadPhoto(photo, i); }, i * 250));
  };

  if (!top) return null;

  const enhanced = enh.entries[top.id];
  const enhancing = Boolean(enh.pending[top.id]);
  const showingOriginal = Boolean(enh.showOriginal[top.id]);
  const heroSrc = enhanced && !showingOriginal ? enhanced.url : (top.largeUrl ?? top.url);
  const heroFace = highlightPerson?.faceBoxes?.[top.id] ?? null;
  const pose = poseForEvent([event.label, event.autoLabel?.label], index);
  const showDate = event.dateLabel && !event.label.includes('·');

  return (
    <article id={`event-${event.id}`} className="g-moment relative grid lg:grid-cols-[250px_minmax(0,1fr)] gap-x-10 gap-y-5">
      {/* ---- details column ---- */}
      <div className="g-meta relative lg:pl-9 lg:sticky lg:top-[96px] self-start">
        <span className="g-dot hidden lg:block" aria-hidden />
        <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-400">
          <img src={lumiSrc(pose)} alt="" aria-hidden className="lumi-sprite h-8 w-auto -my-1" />
          <span>{showDate ? event.dateLabel : `Moment ${index + 1}`}</span>
        </div>

        {renaming ? (
          <div className="flex items-center gap-1.5 mt-2">
            <input
              ref={renameRef}
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setLabelValue(event.label); setRenaming(false); }
              }}
              onBlur={commitRename}
              maxLength={80}
              className="font-display text-2xl font-semibold text-slate-900 bg-transparent border-b-2 border-lumina-400 outline-none min-w-0 flex-1 pb-0.5"
              aria-label="Moment name"
            />
            <button onMouseDown={(e) => { e.preventDefault(); commitRename(); }} className="w-7 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center flex-shrink-0" aria-label="Save name">
              <Check className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <h3
            className="font-display text-2xl sm:text-[1.75rem] leading-[1.15] font-semibold text-slate-900 mt-2 break-words"
            onDoubleClick={() => setRenaming(true)}
            title="Double-click to rename"
          >
            {event.label}
          </h3>
        )}
        {event.autoLabel && !event.userPinned && !renaming && (
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-400" title={event.autoLabel.source === 'vision' ? `Named by ${event.autoLabel.model ?? 'a vision model'}` : 'Named by CLIP'}>
            <Wand2 className="w-3 h-3" /> Named by Lumi
          </p>
        )}
        {event.caption && (
          <p className="text-sm text-slate-500 leading-relaxed mt-2 line-clamp-3" title={event.caption}>{event.caption}</p>
        )}
        <p className="text-sm text-slate-500 mt-3">
          {event.photos.length} {event.photos.length === 1 ? 'photo' : 'photos'}
          {people.length > 0 && <> · {people.length} {people.length === 1 ? 'person' : 'people'}</>}
        </p>

        {/* Best of each person (or just who was there) */}
        {(bestOfEach.length > 0 || people.length > 0) && (
          <div className="mt-4">
            {bestOfEach.length > 1 && (
              <p className="text-xs text-slate-400 mb-2">Best shot of each person</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {(bestOfEach.length > 1 ? bestOfEach : people.map((person) => ({ pick: null, person }))).slice(0, 10).map(({ pick, person }) => (
                <button
                  key={person.id}
                  onClick={pick ? () => onOpenPhoto(event, pick.photoId) : undefined}
                  disabled={!pick}
                  title={pick ? `${person.label}'s best shot` : person.label}
                  className={`rounded-full ring-2 ring-white transition-transform duration-300 ${pick ? 'hover:-translate-y-0.5 hover:ring-lumina-300' : 'cursor-default'}`}
                >
                  <FaceAvatar faceThumb={person.faceThumb} label={person.label} size="xs" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-5 flex items-center gap-1 min-h-9">
          {confirmDelete ? (
            <div className="flex items-center gap-2 text-sm" data-anim="fade">
              <span className="text-slate-600 font-semibold">Remove this moment?</span>
              <button onClick={() => setConfirmDelete(false)} className="h-8 px-3 rounded-full text-slate-500 hover:bg-slate-900/[0.06] font-bold">Keep</button>
              <button onClick={() => onDelete(event.id)} className="h-8 px-3 rounded-full bg-red-500 text-white hover:bg-red-600 font-bold">Remove</button>
            </div>
          ) : (
            <>
              <IconAction label="Rename" onClick={() => setRenaming(true)}><Pencil className="w-4 h-4" /></IconAction>
              <IconAction label={`Download ${event.photos.length === 1 ? 'photo' : `all ${event.photos.length}`}`} onClick={downloadAll}><Download className="w-4 h-4" /></IconAction>
              {topMember?.explanation && (
                <IconAction label="Why this photo?" active={why} onClick={() => setWhy(true)}>
                  <Info className="w-4 h-4" />
                </IconAction>
              )}
              <IconAction label="Remove moment" danger onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" /></IconAction>
            </>
          )}
        </div>

        {why && topMember && (
          <WhyModal
            photo={top}
            member={topMember}
            eventLabel={event.label}
            photoCount={event.photos.length}
            pinned={event.userPinned}
            onClose={() => setWhy(false)}
          />
        )}
      </div>

      {/* ---- photos ---- */}
      <div className="min-w-0">
        <div className={`grid grid-cols-2 gap-1.5 ${side.length === 0 ? 'sm:grid-cols-1 sm:aspect-[2/1]' : 'sm:grid-cols-8 sm:grid-rows-2 sm:aspect-[8/3]'}`}>
          {/* Best shot */}
          <div
            className={`g-tile group relative overflow-hidden rounded-2xl bg-slate-100 cursor-zoom-in col-span-2 aspect-[4/3] sm:aspect-auto ${layout.hero}`}
            onClick={() => onOpenPhoto(event, top.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpenPhoto(event, top.id); }}
            aria-label={`Open best shot of ${event.label}`}
          >
            <Img
              src={heroSrc}
              alt={`Best shot of ${event.label}`}
              eager={index < 2}
              focal={heroFocal}
              onAspect={setHeroAspect}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.03]"
            />
            {heroFace && <FaceRing bbox={heroFace} imageAspect={heroAspect} focal={heroFocal} />}
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-black/5 opacity-60 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

            <div className="absolute top-3 left-3 z-[4] flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-white/90 text-slate-800 text-xs font-bold shadow-sm">
                {event.userPinned ? <Pin className="w-3 h-3" /> : <Crown className="w-3 h-3 text-amber-500" />}
                {event.userPinned ? 'Your pick' : 'Best shot'}
              </span>
              {enhanced && (
                <span
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-slate-900/70 backdrop-blur text-white text-xs font-bold"
                  title={enhanced.identityScore != null ? `Identity verified: ${(enhanced.identityScore * 100).toFixed(0)}% match` : 'AI enhanced'}
                >
                  <Wand2 className="w-3 h-3" /> {showingOriginal ? 'Original' : 'Enhanced'}
                </span>
              )}
            </div>

            {enhancing && (
              <div className="absolute inset-0 z-20 bg-slate-900/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-1.5 pointer-events-none text-white">
                <Loader2 className="w-7 h-7 animate-spin" />
                <span className="text-sm font-bold">Enhancing…</span>
                <span className="text-xs text-white/60">about 30 seconds</span>
              </div>
            )}

            <div className="absolute bottom-3 right-3 z-[5] flex items-center gap-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300">
              {enh.enabled && !enhanced && (
                <button
                  onClick={(e) => { e.stopPropagation(); enh.enhance(top.id); }}
                  disabled={enhancing}
                  className="h-9 px-3.5 rounded-full bg-white/90 text-slate-800 text-sm font-bold flex items-center gap-1.5 shadow-sm hover:bg-white disabled:opacity-50"
                  title="AI enhance (identity-checked before you see it)"
                >
                  <Wand2 className="w-4 h-4 text-lumina-500" /> Enhance
                </button>
              )}
              {enhanced && (
                <>
                  <HeroButton label={showingOriginal ? 'Show enhanced' : 'Compare with original'} onClick={() => enh.toggleOriginal(top.id)}><ScanFace className="w-4 h-4" /></HeroButton>
                  <HeroButton label="Discard enhancement" onClick={() => enh.revert(top.id)}><Undo2 className="w-4 h-4" /></HeroButton>
                </>
              )}
              <HeroButton
                label="Download"
                onClick={() => { downloadPhoto(enhanced && !showingOriginal ? { ...top, fullUrl: enhanced.url } : top); }}
              >
                <Download className="w-4 h-4" />
              </HeroButton>
            </div>
          </div>

          {/* Next-best shots */}
          {side.map((photo, i) => {
            const isLast = i === side.length - 1;
            const moreCount = isLast && !expanded ? hidden.length : 0;
            const mobileWide = side.length % 2 === 1 && isLast;
            return (
              <PhotoTile
                key={photo.id}
                photo={photo}
                eager={index < 2}
                className={`rounded-2xl ${mobileWide ? 'col-span-2 aspect-[2/1]' : 'aspect-square'} sm:aspect-auto ${layout.side[i]}`}
                flags={members.get(photo.id)?.flags}
                faceBox={highlightPerson?.faceBoxes?.[photo.id] ?? null}
                onOpen={() => (moreCount > 0 ? setExpanded(true) : onOpenPhoto(event, photo.id))}
                onMakeBest={moreCount > 0 ? undefined : () => onMakeBest(event.id, photo.id)}
              >
                {moreCount > 0 && (
                  <span className="absolute inset-0 z-[6] bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center text-white font-display text-2xl sm:text-3xl font-semibold transition-colors group-hover:bg-slate-900/55">
                    +{moreCount}
                  </span>
                )}
              </PhotoTile>
            );
          })}
        </div>

        {hidden.length > 0 && (
          <>
            {expanded && (
              <div ref={moreBox.ref} className="overflow-hidden">
                <PhotoGrid
                  className="pt-1.5"
                  entries={hidden.map((photo) => ({ photo, event, flags: members.get(photo.id)?.flags }))}
                  highlightPerson={highlightPerson}
                  onMakeBest={onMakeBest}
                  onOpen={(i) => onOpenPhoto(event, hidden[i].id)}
                />
              </div>
            )}
            <button
              onClick={() => (expanded ? moreBox.close(() => setExpanded(false)) : setExpanded(true))}
              className="mt-3 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-sm font-bold text-slate-600 hover:text-slate-900 bg-slate-900/[0.05] hover:bg-slate-900/[0.08] transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
              {expanded ? 'Show less' : `All ${event.photos.length} photos`}
            </button>
          </>
        )}
      </div>
    </article>
  );
};

const IconAction: React.FC<{ label: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }> = ({
  label, onClick, active, danger, children,
}) => (
  <button
    onClick={onClick}
    title={label}
    aria-label={label}
    className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
      active ? 'bg-slate-900 text-white'
        : danger ? 'text-slate-400 hover:text-red-500 hover:bg-red-50'
        : 'text-slate-500 hover:text-slate-900 hover:bg-slate-900/[0.06]'
    }`}
  >
    {children}
  </button>
);

const HeroButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode }> = ({ label, onClick, children }) => (
  <button
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    title={label}
    aria-label={label}
    className="w-9 h-9 rounded-full bg-white/90 text-slate-700 hover:text-slate-900 hover:bg-white flex items-center justify-center shadow-sm transition-colors"
  >
    {children}
  </button>
);

/* ------------------------------------------------
   The timeline of moments
   ------------------------------------------------ */
export const MomentsView: React.FC<Omit<MomentCardProps, 'event' | 'index'> & { events: Event[]; onClearFilters?: () => void }> = ({
  events, onClearFilters, ...cardProps
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const key = events.map((e) => e.id).join('|');

  useReveal(listRef, '.g-meta', [key], { y: 24 });
  useReveal(listRef, '.g-moment > div:last-child > div:first-child > .g-tile', [key],
    { clipPath: 'inset(10% 6% 10% 6% round 16px)', scale: 1.02 },
    { clipPath: 'inset(0% 0% 0% 0% round 16px)', duration: 1, ease: 'expo.out', stagger: 0.07 });

  // The timeline fills as you scroll; each moment's dot lights as it arrives.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      if (fillRef.current) {
        gsap.fromTo(fillRef.current, { scaleY: 0 }, {
          scaleY: 1, ease: 'none',
          scrollTrigger: { trigger: list, start: 'top 55%', end: 'bottom 55%', scrub: 0.5 },
        });
      }
      list.querySelectorAll<HTMLElement>('.g-moment').forEach((moment) => {
        ScrollTrigger.create({
          trigger: moment,
          start: 'top 55%',
          end: 'bottom 55%',
          toggleClass: { targets: moment.querySelector('.g-dot'), className: 'is-on' },
        });
      });
    }, list);
    return () => ctx.revert();
  }, [key]);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-16">
        <img src={lumiSrc('search')} alt="" aria-hidden className="lumi-sprite h-28 w-auto mb-4" />
        <h3 className="font-display text-2xl font-semibold text-slate-900">No moments match</h3>
        <p className="text-sm text-slate-500 mt-1">That person isn&rsquo;t in the selected moment.</p>
        {onClearFilters && (
          <button onClick={onClearFilters} className="mt-5 btn-soft !py-2 !px-4 !text-sm">
            <X className="w-4 h-4" /> Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={listRef} className="relative">
      <div className="hidden lg:block absolute left-[5px] top-3 bottom-0 w-[2px] rounded-full bg-slate-200/80" aria-hidden>
        <div ref={fillRef} className="w-full h-full origin-top rounded-full bg-gradient-to-b from-lumina-400 to-indigo-400" />
      </div>
      <div className="space-y-16 sm:space-y-24">
        {events.map((event, i) => (
          <MomentCard key={event.id} event={event} index={i} {...cardProps} />
        ))}
      </div>
    </div>
  );
};
