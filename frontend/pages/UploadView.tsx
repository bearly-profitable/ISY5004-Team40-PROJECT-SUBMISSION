
import React, { useState, useRef, useCallback } from 'react';
import { Photo } from '../types';
import { Search, Play, Images, Check, ImageIcon, Upload } from 'lucide-react';
import { GlassCarousel } from '../components/GlassCarousel';

interface UploadViewProps {
  onAnalyze: (selectedPhotoIds: string[]) => void | Promise<void>;
  photos: Photo[];
  onLocalUpload?: (files: FileList) => void;
  isAnalyzing?: boolean;
  analyzeError?: string | null;
  maxPhotos: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const UploadView: React.FC<UploadViewProps> = ({
  onAnalyze,
  photos,
  onLocalUpload,
  isAnalyzing = false,
  analyzeError = null,
  maxPhotos,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [imageLoaded, setImageLoaded] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const markLoaded = useCallback((id: string) => {
    setImageLoaded((prev) => new Set(prev).add(id));
  }, []);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((p) => p.id)));
    }
  };

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
    setDragOver(false);
  }, []);

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && onLocalUpload) {
      onLocalUpload(e.target.files);
    }
    e.target.value = '';
  };

  const filtered = photos.filter((p) =>
    p.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const featured = filtered.slice(0, 5).map((p) => ({
    url: p.url,
    label: `${p.name} — ${p.size}`,
  }));

  const allSelected = filtered.length > 0 && selected.size === filtered.length;

  // Empty state — no photos loaded yet
  if (photos.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />

        <div
          className={`liquid-glass rounded-3xl p-12 text-center anim-scale-in drop-zone ${dragOver ? 'drag-over' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="w-16 h-16 rounded-full bg-lumina-500/10 text-lumina-400 flex items-center justify-center mx-auto mb-6">
            <Upload className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Get started</h2>
          <p className="text-sm text-slate-400 mb-8 max-w-md mx-auto leading-relaxed">
            Drop a batch of photos from one event and Lumina will group them, find the
            people, and pick the best shot of everyone.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button
              onClick={handleBrowseClick}
              className="bg-lumina-600 text-white px-6 py-3 rounded-xl text-sm font-semibold tracking-wide flex items-center gap-2 hover:bg-lumina-700 transition-all duration-300"
            >
              <Upload className="w-4 h-4" />
              Upload Photos
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-6">
            Drop photos here or click to browse &middot; Accepts image files &middot; Max {maxPhotos} photos
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="max-w-7xl mx-auto px-4 sm:px-6 py-6"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Drag overlay for existing grid */}
      {dragOver && (
        <div className="fixed inset-0 z-40 bg-lumina-500/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="liquid-glass rounded-3xl p-10 text-center">
            <Upload className="w-10 h-10 text-lumina-400 mx-auto mb-3" />
            <p className="text-lg font-medium">Drop photos to add</p>
          </div>
        </div>
      )}

      {/* Compact header */}
      <div className="flex items-center justify-between gap-4 mb-5 anim-fade-in-up">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-lumina-400 font-medium text-[10px] uppercase tracking-widest mb-1">
            <Images className="w-3 h-3 shrink-0" />
            <span className="truncate">Your upload</span>
          </div>
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold tracking-tight">Select Photos</h2>
            <span className="text-xs text-slate-400">
              {photos.length} items
              {selected.size > 0 && (
                <span className="text-lumina-400 ml-1">· {selected.size} selected</span>
              )}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 anim-fade-in-right d-200">
          <button
            onClick={handleBrowseClick}
            title="Upload more photos"
            className="glass-btn p-2 rounded-lg text-slate-400 hover:text-white transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={selectAll}
            disabled={filtered.length === 0}
            className="glass-btn px-3 py-1.5 rounded-lg text-xs font-medium"
          >
            {allSelected ? 'Deselect' : 'Select All'}
          </button>
          <button
            onClick={() => onAnalyze(Array.from(selected))}
            disabled={selected.size === 0 || isAnalyzing}
            className="bg-lumina-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wide flex items-center gap-1.5 hover:bg-lumina-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-300"
          >
            <Play className="w-3 h-3 fill-current" />
            {isAnalyzing ? 'Starting…' : 'Analyze'}
          </button>
        </div>
      </div>

      {analyzeError && (
        <div className="mb-4 liquid-glass-light border border-red-400/30 rounded-xl p-3 text-xs text-red-400">
          {analyzeError}
        </div>
      )}

      {/* Main two-column layout */}
      <div className="flex gap-4 items-start">

        {/* Left — compact carousel */}
        <div className="w-[55%] shrink-0 anim-scale-in d-200">
          {featured.length > 0 ? (
            <GlassCarousel
              images={featured}
              autoPlay
              interval={4000}
              aspectRatio="4/3"
              showArrows
              className="shadow-lg shadow-black/10 rounded-2xl overflow-hidden"
            />
          ) : (
            <div className="liquid-glass rounded-2xl flex items-center justify-center" style={{ aspectRatio: '4/3' }}>
              <ImageIcon className="w-8 h-8 text-slate-500" />
            </div>
          )}
        </div>

        {/* Right — scrollable image selection panel */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          {/* Search bar */}
          <div className="relative anim-fade-in-right d-100">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              placeholder="Filter images…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="glass-input rounded-xl py-2 pl-9 pr-3 w-full text-xs"
            />
          </div>

          {/* Scrollable grid */}
          {filtered.length === 0 ? (
            <div className="liquid-glass rounded-2xl p-10 text-center anim-scale-in">
              <ImageIcon className="w-8 h-8 text-slate-500 mx-auto mb-3" />
              <p className="font-medium text-sm mb-0.5">No photos found</p>
              <p className="text-xs text-slate-400">Try a different filter term.</p>
            </div>
          ) : (
            <div
              className="overflow-y-auto pr-1 anim-fade-in-up d-200"
              style={{ maxHeight: 'calc(4/3 * 55vw * 0.97 - 2.5rem)', minHeight: '200px' }}
            >
              <div className="grid grid-cols-3 xl:grid-cols-4 gap-2">
                {filtered.map((photo, i) => {
                  const isSelected = selected.has(photo.id);
                  const loaded = imageLoaded.has(photo.id);
                  return (
                    <div
                      key={photo.id}
                      onClick={() => toggle(photo.id)}
                      className={`group relative aspect-square rounded-xl cursor-pointer transition-all duration-300 ${
                        isSelected
                          ? 'ring-2 ring-lumina-500 ring-offset-2 ring-offset-white/5 scale-[0.96]'
                          : 'hover:scale-[0.98]'
                      }`}
                      style={{ animation: `fadeInUp 0.5s cubic-bezier(0,0,0.2,1) ${40 + i * 20}ms both` }}
                    >
                      {/* Inner wrapper clips image to rounded corners */}
                      <div className="absolute inset-0 rounded-xl overflow-hidden">
                        {/* Skeleton placeholder */}
                        {!loaded && (
                          <div className="absolute inset-0 skeleton" />
                        )}
                        <img
                          src={photo.url}
                          alt={photo.name}
                          className={`w-full h-full object-cover transition-all duration-300 ${
                            loaded ? '' : 'opacity-0'
                          } ${
                            isSelected ? 'brightness-110' : 'brightness-90 group-hover:brightness-100'
                          }`}
                          loading="lazy"
                          onLoad={() => markLoaded(photo.id)}
                        />

                        {/* Bottom info */}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent px-2 py-1.5">
                          <span className="text-[9px] text-white/90 font-medium block truncate leading-tight">{photo.name}</span>
                          <span className="text-[8px] text-white/50 leading-tight">{photo.size}</span>
                        </div>

                        {/* Hover shimmer */}
                        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                      </div>

                      {/* Selection indicator — outside overflow clip so it's always visible */}
                      <div className="absolute top-1.5 right-1.5 z-10">
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center transition-all duration-300 ${
                            isSelected
                              ? 'bg-lumina-500 border-lumina-400 scale-100'
                              : 'border-white/40 bg-black/20 backdrop-blur-sm scale-75 group-hover:scale-100'
                          }`}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
