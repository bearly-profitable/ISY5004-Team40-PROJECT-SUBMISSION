import React, { memo, useState, useRef, useCallback, useMemo } from 'react';
import { AnalysisMode, Photo } from '../types';
import { Search, Play, Check, ImageIcon, Upload, Plus, Sparkles } from 'lucide-react';
import { GlassCarousel } from '../components/GlassCarousel';
import { Lumi } from '../components/Lumi';

const MODE_KEY = 'lumina-analysis-mode';

function readMode(): AnalysisMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'quick' ? 'quick' : 'full';
  } catch {
    return 'full';
  }
}

interface PhotoTileProps {
  photo: Photo;
  index: number;
  selected: boolean;
  onToggle: (id: string) => void;
}

/** One pickable photo. Memoised so a tap re-renders one tile, not the grid. */
const PhotoTile = memo(function PhotoTile({ photo, index, selected, onToggle }: PhotoTileProps) {
  const [loaded, setLoaded] = useState(false);
  // Wait for the small thumbnail rather than decoding the full original.
  const src = photo.source === 'local' ? photo.thumbUrl : photo.thumbUrl ?? photo.url;
  return (
    <button
      type="button"
      onClick={() => onToggle(photo.id)}
      aria-pressed={selected}
      aria-label={`${selected ? 'Deselect' : 'Select'} ${photo.name}`}
      data-anim="pop"
      data-delay={Math.min(index, 30) * 18}
      className={`group relative aspect-square rounded-2xl cursor-pointer transition-transform duration-200 ${
        selected
          ? 'ring-[3px] ring-lumina-500 ring-offset-2 ring-offset-[#f6eef4] scale-[0.95]'
          : 'hover:scale-[0.97]'
      }`}
    >
      <div className="absolute inset-0 rounded-2xl overflow-hidden">
        {!loaded && <div className="absolute inset-0 skeleton" />}
        {src && <img
          src={src}
          alt=""
          className={`w-full h-full object-cover transition-all duration-300 ${
            loaded ? '' : 'opacity-0'
          } ${selected ? 'brightness-105' : 'brightness-95 group-hover:brightness-100'}`}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
        />}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-900/60 to-transparent px-2 pt-4 pb-1.5 text-left">
          <span className="text-[10px] text-white font-bold block truncate leading-tight">{photo.name}</span>
        </div>
      </div>
      <div className="absolute top-1.5 right-1.5 z-10">
        <div
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
            selected
              ? 'bg-lumina-500 border-white scale-100'
              : 'border-white/80 bg-slate-900/20 backdrop-blur-sm scale-90 group-hover:scale-100'
          }`}
        >
          {selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
        </div>
      </div>
    </button>
  );
});

interface UploadViewProps {
  onAnalyze: (selectedPhotoIds: string[], mode: AnalysisMode) => void | Promise<void>;
  photos: Photo[];
  onLocalUpload?: (files: FileList) => void;
  isAnalyzing?: boolean;
  analyzeError?: string | null;
  /** Pre-picked photos, e.g. the batch whose upload just failed. */
  initialSelected?: string[] | null;
  maxPhotos: number;
}

export const UploadView: React.FC<UploadViewProps> = ({
  onAnalyze,
  photos,
  onLocalUpload,
  isAnalyzing = false,
  analyzeError = null,
  initialSelected = null,
  maxPhotos,
}) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? []));
  const [filter, setFilter] = useState('');
  const [dragOver, setDragOver] = useState(false);
  // Analysis on: people, best shots and moments. Off: just note what's in
  // each photo, which is much quicker. Remembered per browser.
  const [mode, setModeState] = useState<AnalysisMode>(readMode);
  const analysisOn = mode === 'full';
  const toggleMode = () => {
    const next: AnalysisMode = analysisOn ? 'quick' : 'full';
    setModeState(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer nicety only */ }
  };
  const start = () => onAnalyze(Array.from(selected), mode);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0 && onLocalUpload) {
      onLocalUpload(e.dataTransfer.files);
    }
  }, [onLocalUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Leaving for a child element is not leaving the drop zone.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  }, []);

  const handleBrowseClick = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && onLocalUpload) {
      onLocalUpload(e.target.files);
    }
    e.target.value = '';
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? photos.filter((p) => p.name.toLowerCase().includes(q)) : photos;
  }, [photos, filter]);
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));
  const selectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((p) => p.id)));
  };
  // Memoised: a fresh array every render would restart the carousel.
  const featured = useMemo(() => filtered.slice(0, 5).map((p) => ({
    url: p.url,
    label: `${p.name} — ${p.size}`,
  })), [filtered]);

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={handleFileChange}
    />
  );

  // Empty state: Lumi, holding a camera, waiting for photos.
  if (photos.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
        {fileInput}
        <div
          data-anim="scale"
          className={`liquid-glass-heavy rounded-[36px] px-6 py-10 sm:p-14 text-center drop-zone transition-all duration-300 ${
            dragOver ? 'drag-over ring-4 ring-lumina-300/60 scale-[1.01]' : ''
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <Lumi
            pose={dragOver ? 'celebrate' : 'camera'}
            size={170}
            say={dragOver ? 'Ooh! Drop them right here!' : 'Show me your photos!'}
            bubble="top"
          />
          <h1 className="font-display text-3xl sm:text-5xl font-bold text-slate-900 mt-6 mb-3">
            Let&rsquo;s get started
          </h1>
          <p className="text-slate-500 text-sm sm:text-base mb-8 max-w-md mx-auto leading-relaxed">
            Drop a batch of photos from one trip or party. Lumi will group them, find
            the people, and pick the best shot of everyone.
          </p>
          <button onClick={handleBrowseClick} className="btn-jelly text-base px-7 py-3.5">
            <Upload className="w-4 h-4" /> Choose photos
          </button>
          <p className="text-xs font-bold text-slate-400 mt-6">
            <span className="hidden sm:inline">Or drag them here · </span>
            Images only · Up to {maxPhotos} photos
          </p>
        </div>
      </div>
    );
  }

  const lumiLine = isAnalyzing
    ? 'On it! Starting now…'
    : selected.size === 0
    ? 'Tap the photos you want me to look at.'
    : !analysisOn
    ? 'Quick mode: I’ll just note what’s in each photo.'
    : selected.size === 1
    ? 'Just one? Pick a few more and I can compare!'
    : `${selected.size} photos. Let’s go!`;
  const action = analysisOn ? 'Analyze' : 'Submit';

  return (
    <div
      className="max-w-7xl mx-auto px-4 sm:px-6 pb-28 lg:pb-8"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {fileInput}

      {dragOver && (
        <div className="fixed inset-0 z-40 bg-lumina-300/20 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="liquid-glass-heavy rounded-[32px] p-8 sm:p-10 text-center">
            <Lumi pose="celebrate" size={140} />
            <p className="font-display text-2xl font-bold mt-3">Drop to add them</p>
          </div>
        </div>
      )}

      {/* Header: Lumi, the count, and the actions */}
      <div data-anim="fade-up" className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <Lumi
            pose={isAnalyzing ? 'search' : selected.size > 1 ? 'celebrate' : 'point'}
            size={84}
            say={lumiLine}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="chip mr-auto sm:mr-1">{photos.length} photos · {selected.size} picked</span>
          <button onClick={handleBrowseClick} className="btn-soft !py-2 !px-3.5 text-sm" title="Add more photos">
            <Plus className="w-4 h-4" /> Add
          </button>
          <button onClick={selectAll} disabled={filtered.length === 0} className="btn-soft !py-2 !px-3.5 text-sm">
            {allSelected ? 'Clear' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={toggleMode}
            role="switch"
            aria-checked={analysisOn}
            disabled={isAnalyzing}
            className="btn-soft !py-2 !pl-3 !pr-3.5 text-sm gap-2"
            title={analysisOn
              ? 'On: Lumi finds the people, picks the best shots and groups moments'
              : 'Off: Lumi only notes what is in each photo. Much quicker, nothing is ranked'}
          >
            <span className={`relative w-8 h-[18px] rounded-full transition-colors duration-300 ${analysisOn ? 'bg-lumina-500' : 'bg-slate-300'}`}>
              <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-[left] duration-300 ${analysisOn ? 'left-4' : 'left-[2px]'}`} />
            </span>
            <Sparkles className="w-3.5 h-3.5" />
            Analysis {analysisOn ? 'on' : 'off'}
          </button>
          <button
            onClick={start}
            disabled={selected.size === 0 || isAnalyzing}
            className="btn-jelly btn-jelly-sm hidden lg:inline-flex"
          >
            {analysisOn ? <Play className="w-3.5 h-3.5 fill-current" /> : <Upload className="w-3.5 h-3.5" />}
            {isAnalyzing ? 'Starting…' : action}
          </button>
        </div>
      </div>

      {analyzeError && (
        <div role="alert" className="mb-4 liquid-glass-light border border-red-300/60 rounded-2xl p-3 text-sm font-semibold text-red-500">
          {analyzeError}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
        {/* Preview carousel: a wide banner on phones, a column on desktop */}
        <div data-anim="scale" data-delay="100" className="w-full lg:w-[52%] shrink-0">
          {featured.length > 0 ? (
            <GlassCarousel
              images={featured}
              autoPlay
              interval={4000}
              aspectRatio="4/3"
              showArrows
              className="shadow-lg shadow-slate-900/10 rounded-[28px] overflow-hidden"
            />
          ) : (
            <div className="liquid-glass rounded-[28px] flex items-center justify-center" style={{ aspectRatio: '4/3' }}>
              <ImageIcon className="w-8 h-8 text-slate-400" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="relative" data-anim="fade-left" data-delay="100">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Filter by file name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="glass-input rounded-full py-2.5 pl-10 pr-4 w-full text-sm"
              aria-label="Filter photos by file name"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="liquid-glass rounded-[28px] p-8 text-center">
              <Lumi pose="think" size={100} />
              <p className="font-extrabold mt-3">No photos match that</p>
              <p className="text-sm text-slate-500">Try a different name.</p>
            </div>
          ) : (
            <div className="lg:overflow-y-auto lg:max-h-[calc(100svh-15rem)] lg:pr-1">
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4 gap-2 sm:gap-2.5">
                {filtered.map((photo, i) => (
                  <PhotoTile
                    key={photo.id}
                    photo={photo}
                    index={i}
                    selected={selected.has(photo.id)}
                    onToggle={toggle}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Phones and tablets: the main action lives at the bottom, within thumb reach. */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 bg-gradient-to-t from-[#f6eef4] via-[#f6eef4]/90 to-transparent">
        <button
          onClick={start}
          disabled={selected.size === 0 || isAnalyzing}
          className="btn-jelly w-full py-4 text-base"
        >
          {analysisOn ? <Play className="w-4 h-4 fill-current" /> : <Upload className="w-4 h-4" />}
          {isAnalyzing
            ? 'Starting…'
            : selected.size === 0
              ? `Pick photos to ${action.toLowerCase()}`
              : `${action} ${selected.size} photo${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
};
