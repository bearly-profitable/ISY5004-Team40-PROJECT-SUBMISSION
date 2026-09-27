import React, { useMemo, useState } from 'react';
import type { Event, Photo } from '../../types';
import type { LightboxItem } from '../Lightbox';
import { lumiSrc } from '../Lumi';
import { PhotoGrid, type GridEntry } from './PhotoGrid';

/* ------------------------------------------------
   Quick look — a session analysed with "Analysis off"

   Nothing is ranked or grouped: every photo, in the order it was taken,
   each tagged with what Lumi saw in it. The tags double as filters.
   ------------------------------------------------ */
const OTHER = '__other__';

export const QuickView = React.memo<{
  events: Event[];
  onOpenItems: (items: LightboxItem[], index: number) => void;
}>(({ events, onOpenItems }) => {
  const [scene, setScene] = useState<string | null>(null);

  const all = useMemo(() => {
    const out: Array<{ photo: Photo; context: string | null }> = [];
    for (const evt of events) {
      const context = new Map(evt.members.map((m) => [m.photoId, m.context ?? null]));
      for (const photo of evt.photos) out.push({ photo, context: context.get(photo.id) ?? null });
    }
    return out;
  }, [events]);

  const scenes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { context } of all) counts.set(context ?? OTHER, (counts.get(context ?? OTHER) ?? 0) + 1);
    // Most common first; unlabelled photos last.
    return [...counts.entries()].sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1]));
  }, [all]);

  const shown = scene ? all.filter((p) => (p.context ?? OTHER) === scene) : all;
  const entries: GridEntry[] = shown.map((p) => ({ photo: p.photo, caption: p.context ?? undefined }));
  const open = (index: number) => onOpenItems(
    shown.map((p) => ({ photo: p.photo, subtitle: p.context ?? undefined })),
    index,
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-5 max-w-2xl">
        <img src={lumiSrc('camera')} alt="" aria-hidden className="lumi-sprite h-14 w-auto flex-shrink-0" />
        <p className="text-sm text-slate-500 leading-relaxed">
          A quick look: every photo in the order it was taken, labelled with what Lumi saw.
          Nothing was ranked or grouped. Turn <span className="font-bold text-slate-700">Analysis on</span> when
          uploading to find people, best shots and moments.
        </p>
      </div>

      {scenes.length > 1 && (
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1 mb-6 -mx-1 px-1" style={{ scrollbarWidth: 'none' }} aria-label="Filter by what's in the photo">
          {[[null, all.length] as const, ...scenes].map(([key, count]) => {
            const active = scene === key;
            return (
              <button
                key={key ?? 'all'}
                onClick={() => setScene(active ? null : key)}
                aria-pressed={active}
                className={`h-9 px-3.5 rounded-full text-sm font-bold whitespace-nowrap flex-shrink-0 transition-colors duration-300 ${
                  active ? 'bg-slate-900 text-white' : 'bg-white/70 ring-1 ring-slate-200/70 text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                {key === null ? 'All' : key === OTHER ? 'Other' : key}
                <span className={`ml-1.5 tabular-nums ${active ? 'text-white/60' : 'text-slate-400'}`}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <PhotoGrid entries={entries} eagerCount={12} onOpen={open} />
    </div>
  );
});
