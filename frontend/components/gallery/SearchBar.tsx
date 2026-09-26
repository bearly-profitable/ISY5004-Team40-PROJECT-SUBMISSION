import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import type { Identity, Photo } from '../../types';
import { searchPhotos } from '../../lib/analysisApi';
import { gsap, prefersReducedMotion } from '../../lib/motion';

export interface SearchHits {
  query: string;
  results: Array<{ photo: Photo; score: number }>;
}

/** CLIP search: describe a moment in words, get the photos that show it. */
export const SearchBar: React.FC<{
  jobId: string;
  photosById: Map<string, Photo>;
  scopePerson: Identity | null;
  suggestions: string[];
  active: boolean;
  onResults: (hits: SearchHits | null) => void;
  onError: (message: string) => void;
  className?: string;
}> = ({ jobId, photosById, scopePerson, suggestions, active, onResults, onError, className = '' }) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exampleIdx, setExampleIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const exampleRef = useRef<HTMLSpanElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);

  const examples = useMemo(() => [...new Set([
    ...suggestions.map((s) => s.toLowerCase()),
    'group hug', 'sunset', 'someone laughing', 'birthday cake', 'people at the beach',
  ])], [suggestions]);

  const run = async (override?: string) => {
    const q = (override ?? query).trim();
    if (!q) return;
    if (override) setQuery(override);
    setSearching(true);
    try {
      const hits = await searchPhotos(jobId, q, 24, scopePerson?.id ?? null);
      onResults({
        query: q,
        results: hits
          .map((hit) => {
            const photo = photosById.get(hit.photoId);
            return photo ? { photo, score: hit.score } : null;
          })
          .filter(Boolean) as SearchHits['results'],
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const clear = () => {
    setQuery('');
    onResults(null);
    inputRef.current?.focus();
  };

  // "/" jumps to search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cycle example queries in the placeholder while idle.
  useEffect(() => {
    const el = exampleRef.current;
    if (!el || query || focused || examples.length < 2 || prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      gsap.to(el, {
        yPercent: -100, opacity: 0, duration: 0.3, ease: 'power2.in',
        onComplete: () => {
          setExampleIdx((i) => (i + 1) % examples.length);
          gsap.fromTo(el, { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.45, ease: 'expo.out' });
        },
      });
    }, 2800);
    return () => {
      window.clearInterval(timer);
      gsap.killTweensOf(el);
      gsap.set(el, { clearProps: 'transform,opacity' });
    };
  }, [query, focused, examples.length]);

  // A light runs along the field while CLIP works.
  useEffect(() => {
    const el = sweepRef.current;
    if (!searching || !el) return;
    const tween = gsap.fromTo(el, { xPercent: -100 }, { xPercent: 300, duration: 1, ease: 'power1.inOut', repeat: -1 });
    return () => { tween.kill(); };
  }, [searching]);

  const example = examples[exampleIdx % examples.length] ?? '';

  return (
    <div className={`relative ${className}`}>
      <div className={`relative flex items-center h-11 rounded-full bg-white/85 ring-1 transition-shadow duration-300 ${
        focused ? 'ring-lumina-300 shadow-[0_8px_30px_rgb(var(--lumina-500)/0.18)]' : 'ring-slate-200/80 shadow-sm'
      }`}>
        <span className="pl-4 pr-2 text-slate-400 flex-shrink-0">
          {searching ? <Loader2 className="w-4 h-4 animate-spin text-lumina-500" /> : <Search className="w-4 h-4" />}
        </span>
        <div className="relative flex-1 min-w-0 h-full flex items-center">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run();
              if (e.key === 'Escape') (active ? clear() : inputRef.current?.blur());
            }}
            aria-label={scopePerson ? `Search ${scopePerson.label}'s photos` : 'Search your photos by describing them'}
            enterKeyHint="search"
            className="w-full h-full bg-transparent outline-none text-[15px] text-slate-800"
          />
          {!query && (
            <span className="absolute inset-0 flex items-center pointer-events-none text-[15px] text-slate-400 whitespace-nowrap overflow-hidden">
              {scopePerson ? `Search ${scopePerson.label}'s photos, like ` : 'Search, like '}
              <span className="inline-block overflow-hidden">
                <span ref={exampleRef} className="inline-block text-slate-500">&ldquo;{example}&rdquo;</span>
              </span>
            </span>
          )}
        </div>
        {(query || active) ? (
          <button onClick={clear} className="w-9 h-9 mr-1 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-900/[0.05] transition-colors flex-shrink-0" aria-label="Clear search">
            <X className="w-4 h-4" />
          </button>
        ) : (
          <kbd className="hidden md:flex mr-3 items-center justify-center w-6 h-6 rounded-md border border-slate-300/80 text-xs font-mono text-slate-400 flex-shrink-0" title="Press / to search">/</kbd>
        )}
        {searching && (
          <div className="absolute inset-x-5 bottom-0 h-[2px] overflow-hidden rounded-full pointer-events-none">
            <div ref={sweepRef} className="h-full w-1/3 bg-gradient-to-r from-transparent via-lumina-500 to-transparent" />
          </div>
        )}
      </div>
      {focused && !query && suggestions.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full mt-2 z-30 rounded-2xl bg-white shadow-xl shadow-slate-900/10 ring-1 ring-slate-200/70 p-3"
          data-anim="fade-up"
          onMouseDown={(e) => e.preventDefault()}
        >
          <p className="text-xs text-slate-400 px-1 mb-2">Try one of these</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => { run(s); inputRef.current?.blur(); }}
                className="h-8 px-3 rounded-full bg-slate-900/[0.05] text-sm text-slate-600 hover:bg-lumina-500 hover:text-white transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
