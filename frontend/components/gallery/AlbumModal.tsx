import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, FileText, Loader2, X } from 'lucide-react';
import type { Photo } from '../../types';
import { getCollageThemes, type CharacterOutfit, type CollageTheme } from '../../lib/analysisApi';
import { FALLBACK_CHARACTER_OUTFITS, FALLBACK_COLLAGE_THEMES } from '../../lib/collageCatalog';
import { useAuth } from '../../lib/auth';
import { gsap, prefersReducedMotion } from '../../lib/motion';
import { Img, useFocal } from './shared';

export interface AlbumChoices {
  theme: string;
  title: string;
  photoIds: string[];
  /** Lumi's colourway on the chapter, cast and photo pages. */
  characterOutfit: string;
  /** Whether the server can write a caption per photo (always used when it can). */
  aiCaptions: boolean;
}

/** One thumbnail in the photo picker. */
export const PickTile: React.FC<{ photo: Photo; selected: boolean; onToggle: () => void }> = ({ photo, selected, onToggle }) => {
  const focal = useFocal(photo.id);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`${selected ? 'Remove' : 'Add'} ${photo.name}`}
      data-album-tile
      className="relative aspect-square rounded-lg overflow-hidden bg-slate-100 group"
    >
      <Img
        src={photo.url}
        alt=""
        focal={focal}
        className={`absolute inset-0 w-full h-full object-cover transition-all duration-300 ${selected ? '' : 'opacity-40 grayscale scale-95 rounded-lg'}`}
      />
      <span className={`absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center transition-all duration-200 ${
        selected ? 'bg-lumina-500 text-white scale-100' : 'bg-white/80 ring-1 ring-slate-300 text-transparent scale-90 group-hover:scale-100'
      }`}>
        <Check className="w-3 h-3" strokeWidth={3} />
      </span>
    </button>
  );
};

/** "Create album": pick a theme, the photos and a title, get a PDF. */
export const AlbumModal: React.FC<{
  photos: Photo[];
  busy: boolean;
  onBuild: (choices: AlbumChoices) => void;
  onClose: () => void;
}> = ({ photos, busy, onBuild, onClose }) => {
  const { profile } = useAuth();
  const [themes, setThemes] = useState<CollageTheme[]>(FALLBACK_COLLAGE_THEMES);
  const [theme, setTheme] = useState(profile?.collage_theme ?? 'lumi');
  const [outfits, setOutfits] = useState<CharacterOutfit[]>(FALLBACK_CHARACTER_OUTFITS);
  const [outfit, setOutfit] = useState<string>(profile?.lumi_outfit ?? 'classic');
  const [aiCaptions, setAiCaptions] = useState(false);
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(photos.map((p) => p.id)));
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    getCollageThemes()
      .then((data) => {
        if (!alive) return;
        if (data.themes?.length) {
          setThemes(data.themes);
          setTheme((current) => (data.themes.some((t) => t.key === current) ? current : data.default || data.themes[0].key));
        }
        if (data.characterOutfits?.length) {
          setOutfits(data.characterOutfits);
          setOutfit((current) => (data.characterOutfits!.some((o) => o.key === current) ? current : data.characterOutfits![0].key));
        }
        setAiCaptions(Boolean(data.aiCaptions ?? data.aiTitles));
      })
      .catch(() => { /* the built-in themes stay on screen */ });
    return () => { alive = false; };
  }, []);

  // In: backdrop fades, card springs up, sections and thumbnails follow.
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    const card = cardRef.current;
    const ctx = gsap.context(() => {
      gsap.timeline()
        .fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
        .fromTo(card, { y: 40, scale: 0.96, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: 'expo.out' }, 0)
        .from(card?.querySelectorAll('[data-album-section]') ?? [], { y: 14, opacity: 0, duration: 0.45, ease: 'power3.out', stagger: 0.07 }, 0.12)
        .from(card?.querySelectorAll('[data-album-tile]') ?? [], { scale: 0.85, opacity: 0, duration: 0.4, ease: 'back.out(1.6)', stagger: { each: 0.02, from: 'start' } }, 0.3);
    });
    return () => ctx.revert();
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    if (prefersReducedMotion()) { onClose(); return; }
    gsap.to(cardRef.current, { y: 24, scale: 0.97, opacity: 0, duration: 0.22, ease: 'power2.in' });
    gsap.to(backdropRef.current, { opacity: 0, duration: 0.25, ease: 'power2.in', onComplete: onClose });
  }, [busy, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [close]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const allSelected = selected.size === photos.length;
  const trimmed = title.trim();
  const canBuild = !busy && trimmed.length > 0 && selected.size > 0;

  const build = () => {
    if (!trimmed) {
      titleRef.current?.focus();
      if (!prefersReducedMotion()) gsap.fromTo(titleRef.current, { x: -6 }, { x: 0, duration: 0.5, ease: 'elastic.out(1.2, 0.3)' });
      return;
    }
    if (!canBuild) return;
    onBuild({
      theme,
      title: trimmed,
      // Keep the moments' order, whatever order the photos were ticked in.
      photoIds: photos.filter((p) => selected.has(p.id)).map((p) => p.id),
      characterOutfit: outfit,
      aiCaptions,
    });
  };

  return createPortal(
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[330] flex items-end sm:items-center justify-center p-3 sm:p-6"
      style={{ background: 'rgba(23, 15, 31, 0.45)', backdropFilter: 'blur(8px)' }}
      onClick={close}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="album-title"
        className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-[1.75rem] bg-white shadow-2xl shadow-slate-900/25 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-4">
          <div className="min-w-0 flex-1">
            <h3 id="album-title" className="font-display text-2xl font-semibold text-slate-900 leading-tight">Create an album</h3>
            <p className="text-sm text-slate-500 mt-0.5">A PDF, one chapter per moment, with Lumi along for the ride.</p>
          </div>
          <button
            onClick={close}
            disabled={busy}
            className="w-9 h-9 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 flex items-center justify-center flex-shrink-0 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 pb-6 space-y-7">
          {/* Title */}
          <section data-album-section>
            <label htmlFor="album-name" className="block text-sm font-bold text-slate-800 mb-2">Title</label>
            <input
              id="album-name"
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') build(); }}
              maxLength={120}
              placeholder="Summer at the Bay"
              className="w-full h-11 px-4 rounded-xl bg-slate-50 ring-1 ring-slate-200 text-[15px] text-slate-800 outline-none focus:ring-2 focus:ring-lumina-400 focus:bg-white transition-shadow"
              autoFocus={!window.matchMedia('(pointer: coarse)').matches}
            />
          </section>

          {/* Theme */}
          <section data-album-section>
            <p className="text-sm font-bold text-slate-800 mb-2">Theme</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
              {themes.map((t) => {
                const active = theme === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTheme(t.key)}
                    aria-pressed={active}
                    className="group text-left"
                  >
                    {/* A tiny page in the theme's colours */}
                    <span
                      className={`relative block aspect-[4/3] rounded-xl overflow-hidden transition-all duration-200 ${
                        active ? 'ring-2 ring-lumina-500 ring-offset-2' : 'ring-1 ring-slate-200 group-hover:ring-slate-300'
                      }`}
                      style={{ background: `linear-gradient(170deg, ${t.bgTop ?? t.swatch[0]}, ${t.bgBottom ?? t.swatch[0]})` }}
                    >
                      <span className="absolute left-[12%] top-[16%] w-[46%] h-[52%] rounded-[3px]" style={{ background: t.frame ?? t.swatch[1], opacity: 0.9 }} />
                      <span className="absolute right-[12%] top-[16%] w-[22%] h-[24%] rounded-[3px]" style={{ background: t.swatch[1] }} />
                      <span className="absolute right-[12%] top-[44%] w-[22%] h-[24%] rounded-[3px]" style={{ background: t.frame ?? t.swatch[1], opacity: 0.7 }} />
                      <span className="absolute left-[12%] bottom-[12%] w-[40%] h-[6%] rounded-full" style={{ background: t.swatch[2] }} />
                      {active && (
                        <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-lumina-500 text-white flex items-center justify-center">
                          <Check className="w-3 h-3" strokeWidth={3} />
                        </span>
                      )}
                    </span>
                    <span className={`block mt-1.5 text-xs truncate ${active ? 'font-bold text-slate-900' : 'font-semibold text-slate-500'}`}>{t.name}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Lumi */}
          <section data-album-section>
            <p className="text-sm font-bold text-slate-800 mb-2">Lumi&rsquo;s outfit</p>
            <div className="grid grid-cols-4 gap-2.5">
              {outfits.map((o) => {
                const active = outfit === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => setOutfit(o.key)}
                    aria-pressed={active}
                    className={`group relative flex flex-col items-center rounded-xl pt-2.5 pb-2 transition-all duration-200 ${
                      active ? 'bg-lumina-500/10 ring-2 ring-lumina-500' : 'bg-slate-50 ring-1 ring-slate-200 hover:ring-slate-300'
                    }`}
                  >
                    <img
                      src="/lumi/idle.webp"
                      alt=""
                      aria-hidden
                      draggable={false}
                      className="h-14 w-auto select-none transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-[-4deg]"
                      style={{ filter: `hue-rotate(${o.hue}deg) saturate(${o.saturate})` }}
                    />
                    <span className={`mt-1 text-xs ${active ? 'font-bold text-slate-900' : 'font-semibold text-slate-500'}`}>{o.name}</span>
                    {active && (
                      <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-lumina-500 text-white flex items-center justify-center">
                        <Check className="w-3 h-3" strokeWidth={3} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Photos */}
          <section data-album-section>
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-sm font-bold text-slate-800">
                Photos <span className="font-semibold text-slate-400">{selected.size} of {photos.length}</span>
              </p>
              <button
                type="button"
                onClick={() => setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)))}
                className="text-xs font-bold text-lumina-600 hover:text-lumina-700"
              >
                {allSelected ? 'Clear' : 'Select all'}
              </button>
            </div>
            <div className="grid grid-cols-5 sm:grid-cols-6 gap-1.5">
              {photos.map((photo) => (
                <PickTile key={photo.id} photo={photo} selected={selected.has(photo.id)} onToggle={() => toggle(photo.id)} />
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-2">Lumi&rsquo;s best photos from each moment. Tap one to leave it out.</p>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-white">
          <button onClick={build} disabled={busy || selected.size === 0} className="btn-jelly w-full">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {busy
              ? 'Lumi is designing your album…'
              : !trimmed ? 'Name your album to continue'
              : `Create album · ${selected.size} ${selected.size === 1 ? 'photo' : 'photos'}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
