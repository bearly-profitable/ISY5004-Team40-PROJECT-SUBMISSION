
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  Upload,
  HardDrive,
  Sparkles,
  Eye,
  Ruler,
  Droplets,
  CircleDot,
  Smile,
  Diamond,
  RotateCcw,
  ChevronDown,
  ImagePlus,
  Loader2,
  AlertCircle,
  User,
} from 'lucide-react';
import type { Photo, FaceAnalysisResult, FaceResult, FaceMetrics } from '../types';
import { startFaceAnalysis, getFaceAnalysisStatus } from '../lib/analysisApi';

interface AnalysisProps {
  photos: Photo[];
}

type AnalysisState = 'idle' | 'processing' | 'done' | 'error';

const METRIC_META: { key: keyof Omit<FaceMetrics, 'overall'>; label: string; icon: React.ReactNode; color: string }[] = [
  { key: 'symmetry', label: 'Symmetry', icon: <Diamond className="w-4 h-4" />, color: '#b4a7d6' },
  { key: 'proportions', label: 'Proportions', icon: <Ruler className="w-4 h-4" />, color: '#e8b4b8' },
  { key: 'skinQuality', label: 'Skin Quality', icon: <Droplets className="w-4 h-4" />, color: '#ebc8aa' },
  { key: 'eyeScore', label: 'Eyes', icon: <Eye className="w-4 h-4" />, color: '#a8d8ea' },
  { key: 'noseScore', label: 'Nose', icon: <CircleDot className="w-4 h-4" />, color: '#c8a0c8' },
  { key: 'lipScore', label: 'Lips', icon: <Smile className="w-4 h-4" />, color: '#f2b5d4' },
  { key: 'jawlineScore', label: 'Jawline', icon: <Diamond className="w-4 h-4" />, color: '#b5d4c8' },
];

// ---------- SVG Radar Chart ----------
const RadarChart: React.FC<{ metrics: FaceMetrics }> = ({ metrics }) => {
  const categories = METRIC_META;
  const cx = 120, cy = 120, r = 90;
  const n = categories.length;
  const angleStep = (2 * Math.PI) / n;

  const pointsAt = (radius: number) =>
    categories.map((_, i) => {
      const angle = -Math.PI / 2 + i * angleStep;
      return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    });

  const gridLevels = [0.25, 0.5, 0.75, 1.0];
  const dataPoints = categories.map((cat, i) => {
    const val = (metrics[cat.key] / 10) * r;
    const angle = -Math.PI / 2 + i * angleStep;
    return [cx + Math.cos(angle) * val, cy + Math.sin(angle) * val];
  });

  const pathD = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ') + ' Z';

  return (
    <svg viewBox="0 0 240 240" className="w-full max-w-[260px] mx-auto">
      <defs>
        <linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(180,167,214,0.35)" />
          <stop offset="100%" stopColor="rgba(232,180,184,0.25)" />
        </linearGradient>
      </defs>

      {/* Grid */}
      {gridLevels.map((lvl) => {
        const pts = pointsAt(r * lvl);
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ') + ' Z';
        return <path key={lvl} d={d} fill="none" stroke="rgba(180,167,214,0.2)" strokeWidth="0.8" />;
      })}

      {/* Axes */}
      {categories.map((_, i) => {
        const angle = -Math.PI / 2 + i * angleStep;
        const x2 = cx + Math.cos(angle) * r;
        const y2 = cy + Math.sin(angle) * r;
        return <line key={i} x1={cx} y1={cy} x2={x2} y2={y2} stroke="rgba(180,167,214,0.15)" strokeWidth="0.6" />;
      })}

      {/* Data polygon */}
      <path d={pathD} fill="url(#radarFill)" stroke="rgba(180,167,214,0.8)" strokeWidth="1.5" className="" data-anim="scale" />

      {/* Data dots */}
      {dataPoints.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3" fill={categories[i].color} stroke="white" strokeWidth="1.5" />
      ))}

      {/* Labels */}
      {categories.map((cat, i) => {
        const angle = -Math.PI / 2 + i * angleStep;
        const lx = cx + Math.cos(angle) * (r + 18);
        const ly = cy + Math.sin(angle) * (r + 18);
        return (
          <text
            key={cat.key}
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-slate-500 text-[8px] font-medium"
          >
            {cat.label}
          </text>
        );
      })}
    </svg>
  );
};

// ---------- Animated Score Counter ----------
const AnimatedScore: React.FC<{ value: number; size?: 'lg' | 'sm' }> = ({ value, size = 'lg' }) => {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let start = 0;
    const duration = 1200;
    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      start = eased * value;
      setDisplay(parseFloat(start.toFixed(1)));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [value]);

  const isLarge = size === 'lg';

  return (
    <div className={`flex items-baseline gap-1 ${isLarge ? '' : ''}`}>
      <span className={`font-bold tracking-tight ${isLarge ? 'text-5xl' : 'text-3xl'}`}
        style={{ background: 'linear-gradient(135deg, #b4a7d6, #e8b4b8, #ebc8aa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
      >
        {display.toFixed(1)}
      </span>
      <span className={`text-slate-400 font-medium ${isLarge ? 'text-xl' : 'text-base'}`}>/10</span>
    </div>
  );
};

// ---------- Score Bar ----------
const ScoreBar: React.FC<{ value: number; color: string; delay: number }> = ({ value, color, delay }) => {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setWidth((value / 10) * 100), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return (
    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(180,167,214,0.12)' }}>
      <div
        className="h-full rounded-full transition-all duration-1000"
        style={{
          width: `${width}%`,
          background: `linear-gradient(90deg, ${color}, ${color}88)`,
          transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      />
    </div>
  );
};

// ---------- Face Result Card ----------
const FaceCard: React.FC<{ face: FaceResult; index: number }> = ({ face, index }) => {
  const { metrics, faceCrop } = face;

  return (
    <div
      className="liquid-glass-heavy glass-prismatic rounded-3xl overflow-hidden" data-anim="fade-up"
      style={{ animationDelay: `${index * 150}ms` }}
    >
      <div className="p-6 sm:p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-full liquid-glass flex items-center justify-center">
            <User className="w-5 h-5 text-lumina-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800">Face {index + 1}</h3>
            <p className="text-xs text-slate-400">Detailed facial analysis</p>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Left: Face crop + Overall score */}
          <div className="flex flex-col items-center gap-5 lg:w-[280px] flex-shrink-0">
            <div className="relative w-48 h-48 rounded-2xl overflow-hidden liquid-glass glass-prismatic-soft shadow-lg">
              <img src={faceCrop} alt={`Face ${index + 1}`} className="w-full h-full object-cover" />
            </div>
            <div className="text-center">
              <p className="text-xs text-slate-400 uppercase tracking-widest mb-1">Overall Rating</p>
              <AnimatedScore value={metrics.overall} size="lg" />
            </div>
            <RadarChart metrics={metrics} />
          </div>

          {/* Right: Category breakdown */}
          <div className="flex-1 space-y-4">
            <h4 className="text-sm font-semibold text-slate-600 uppercase tracking-wider mb-3">Category Breakdown</h4>
            {METRIC_META.map((cat, i) => (
              <div key={cat.key} className="" data-anim="fade-up" style={{ animationDelay: `${(index * 150) + (i * 80)}ms` }}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span style={{ color: cat.color }}>{cat.icon}</span>
                    <span className="text-sm font-medium text-slate-700">{cat.label}</span>
                  </div>
                  <span className="text-sm font-semibold text-slate-600">
                    {metrics[cat.key].toFixed(1)}
                  </span>
                </div>
                <ScoreBar value={metrics[cat.key]} color={cat.color} delay={(index * 150) + (i * 80) + 200} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------- Drive Photo Picker Modal ----------
const DrivePickerModal: React.FC<{
  photos: Photo[];
  onSelect: (photo: Photo) => void;
  onClose: () => void;
}> = ({ photos, onSelect, onClose }) => {
  const [search, setSearch] = useState('');
  const filtered = photos.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      {/* Frosted glass: blur page behind modal — avoid heavy grey/black scrim */}
      <div
        className="absolute inset-0 bg-white/[0.06] backdrop-blur-2xl backdrop-saturate-150 dark:bg-white/[0.04]"
        aria-hidden
      />
      <div
        className="relative liquid-glass-heavy glass-prismatic rounded-3xl w-full max-w-2xl max-h-[80vh] overflow-hidden shadow-2xl"
        data-anim="pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-white/20">
          <h3 className="text-lg font-semibold text-slate-800 mb-3">Choose from Drive</h3>
          <input
            type="text"
            placeholder="Search photos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="glass-input w-full"
          />
        </div>
        <div className="p-4 overflow-y-auto max-h-[55vh] grid grid-cols-3 sm:grid-cols-4 gap-3">
          {filtered.map((photo) => (
            <button
              key={photo.id}
              onClick={() => onSelect(photo)}
              className="group relative aspect-square rounded-xl overflow-hidden liquid-glass hover:scale-[0.97] transition-all duration-300"
            >
              <img src={photo.url} alt={photo.name} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/50 to-transparent">
                <p className="text-[10px] text-white truncate">{photo.name}</p>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full py-12 text-center text-slate-400 text-sm">No photos found</div>
          )}
        </div>
      </div>
    </div>
  );
};

// ========== Main Analysis Component ==========
export const Analysis: React.FC<AnalysisProps> = ({ photos }) => {
  const [state, setState] = useState<AnalysisState>('idle');
  const [selectedImage, setSelectedImage] = useState<string | null>(null); // data URL or blob URL
  const [selectedName, setSelectedName] = useState('');
  const [result, setResult] = useState<FaceAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [showDrivePicker, setShowDrivePicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setState('idle');
    setSelectedImage(null);
    setSelectedName('');
    setResult(null);
    setError(null);
    setProgress(0);
  }, []);

  const processImage = useCallback(async (blob: Blob, filename: string) => {
    // Show preview
    const previewUrl = URL.createObjectURL(blob);
    setSelectedImage(previewUrl);
    setSelectedName(filename);
    setState('processing');
    setProgress(5);
    setError(null);

    try {
      const jobId = await startFaceAnalysis(blob, filename);
      setProgress(15);

      // Poll for completion
      const poll = async () => {
        let alive = true;
        while (alive) {
          await new Promise((r) => setTimeout(r, 800));
          const status = await getFaceAnalysisStatus(jobId);
          setProgress(status.progress);

          if (status.status === 'completed' && status.result) {
            setResult(status.result as FaceAnalysisResult);
            setState('done');
            alive = false;
          } else if (status.status === 'failed') {
            setError(status.error ?? 'Analysis failed.');
            setState('error');
            alive = false;
          }
        }
      };
      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setState('error');
    }
  }, []);

  const handleFileUpload = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;
    processImage(file, file.name);
  }, [processImage]);

  const handleDriveSelect = useCallback(async (photo: Photo) => {
    setShowDrivePicker(false);
    try {
      const resp = await fetch(photo.url);
      const blob = await resp.blob();
      processImage(blob, photo.name);
    } catch {
      setError('Failed to load photo from drive.');
      setState('error');
    }
  }, [processImage]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFileUpload(e.dataTransfer.files);
  }, [handleFileUpload]);

  // -------- IDLE STATE: Upload UI --------
  if (state === 'idle') {
    return (
      <div className="min-h-[calc(100vh-4rem)] relative overflow-hidden">
        <div className="bg-mesh fixed inset-0 -z-10" />
        <div className="mesh-orb-1" /><div className="mesh-orb-2" /><div className="mesh-orb-3" />

        <div className="max-w-3xl mx-auto px-4 pt-20 pb-16">
          {/* Header */}
          <div className="text-center mb-12" data-anim="fade-up">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full liquid-glass glass-prismatic-soft mb-4">
              <Sparkles className="w-3.5 h-3.5 text-lumina-500" />
              <span className="text-xs font-medium text-lumina-600 tracking-wide">AI Face Analysis</span>
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-slate-800 tracking-tight mb-3">
              Face <span className="text-gradient">Analysis</span>
            </h1>
            <p className="text-slate-500 text-sm sm:text-base max-w-md mx-auto">
              Upload a photo to get an in-depth facial analysis with detailed scoring across multiple categories
            </p>
          </div>

          {/* Upload Zone */}
          <div
            className={`liquid-glass-heavy glass-prismatic rounded-3xl p-8 sm:p-12 text-center transition-all duration-300 cursor-pointer ${
              dragOver ? 'scale-[0.98] ring-2 ring-lumina-400 ring-offset-4 ring-offset-transparent' : 'hover:scale-[1.01]'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFileUpload(e.target.files)}
            />

            <div className="w-20 h-20 rounded-2xl liquid-glass glass-prismatic-soft flex items-center justify-center mx-auto mb-6 anim-float">
              <ImagePlus className="w-9 h-9 text-lumina-500" />
            </div>

            <h3 className="text-xl font-semibold text-slate-700 mb-2">Drop your photo here</h3>
            <p className="text-slate-400 text-sm mb-8">or click to browse files</p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="glass-btn glass-btn-primary px-6 py-2.5 rounded-full text-sm font-medium flex items-center gap-2"
              >
                <Upload className="w-4 h-4" />
                Upload Photo
              </button>

              {photos.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowDrivePicker(true); }}
                  className="glass-btn px-6 py-2.5 rounded-full text-sm font-medium flex items-center gap-2 text-slate-600"
                >
                  <HardDrive className="w-4 h-4" />
                  Choose from Drive
                </button>
              )}
            </div>
          </div>

          {/* Info cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
            {[
              { icon: <Eye className="w-5 h-5" />, title: 'Multi-Face', desc: 'Auto-detects multiple faces' },
              { icon: <Ruler className="w-5 h-5" />, title: '7 Categories', desc: 'Comprehensive scoring metrics' },
              { icon: <Sparkles className="w-5 h-5" />, title: 'AI Powered', desc: '468-point facial landmark mesh' },
            ].map((card, i) => (
              <div
                key={card.title}
                className="liquid-glass glass-prismatic-soft rounded-2xl p-5 text-center" data-anim="fade-up"
                style={{ animationDelay: `${200 + i * 100}ms` }}
              >
                <div className="w-10 h-10 rounded-xl liquid-glass flex items-center justify-center mx-auto mb-3 text-lumina-500">
                  {card.icon}
                </div>
                <h4 className="text-sm font-semibold text-slate-700 mb-1">{card.title}</h4>
                <p className="text-xs text-slate-400">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {showDrivePicker && (
          <DrivePickerModal
            photos={photos}
            onSelect={handleDriveSelect}
            onClose={() => setShowDrivePicker(false)}
          />
        )}
      </div>
    );
  }

  // -------- PROCESSING STATE --------
  if (state === 'processing') {
    return (
      <div className="min-h-[calc(100vh-4rem)] relative overflow-hidden flex items-center justify-center">
        <div className="bg-mesh fixed inset-0 -z-10" />
        <div className="mesh-orb-1" /><div className="mesh-orb-2" /><div className="mesh-orb-3" />

        <div className="max-w-md mx-auto px-4 text-center">
          <div className="liquid-glass-heavy glass-prismatic rounded-3xl p-10" data-anim="fade-up">
            {/* Preview thumb */}
            {selectedImage && (
              <div className="w-32 h-32 rounded-2xl overflow-hidden liquid-glass mx-auto mb-6 shadow-lg">
                <img src={selectedImage} alt="Preview" className="w-full h-full object-cover" />
              </div>
            )}

            <Loader2 className="w-10 h-10 text-lumina-500 mx-auto mb-4 animate-spin" />

            <h3 className="text-xl font-semibold text-slate-800 mb-2">Analyzing Face</h3>
            <p className="text-sm text-slate-400 mb-6">{selectedName}</p>

            {/* Progress bar */}
            <div className="glass-progress-track rounded-full overflow-hidden mb-3">
              <div
                className="glass-progress-fill h-full rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-slate-400">{progress}% — Detecting landmarks & computing metrics...</p>
          </div>
        </div>
      </div>
    );
  }

  // -------- ERROR STATE --------
  if (state === 'error') {
    return (
      <div className="min-h-[calc(100vh-4rem)] relative overflow-hidden flex items-center justify-center">
        <div className="bg-mesh fixed inset-0 -z-10" />
        <div className="mesh-orb-1" /><div className="mesh-orb-2" /><div className="mesh-orb-3" />

        <div className="max-w-md mx-auto px-4 text-center">
          <div className="liquid-glass-heavy glass-prismatic rounded-3xl p-10" data-anim="fade-up">
            <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <h3 className="text-xl font-semibold text-slate-800 mb-2">Analysis Failed</h3>
            <p className="text-sm text-slate-400 mb-6">{error}</p>
            <button
              onClick={reset}
              className="glass-btn glass-btn-primary px-6 py-2.5 rounded-full text-sm font-medium inline-flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------- DONE STATE: Results --------
  return (
    <div className="min-h-[calc(100vh-4rem)] relative overflow-hidden">
      <div className="bg-mesh fixed inset-0 -z-10" />
      <div className="mesh-orb-1" /><div className="mesh-orb-2" /><div className="mesh-orb-3" />

      <div className="max-w-5xl mx-auto px-4 pt-20 pb-16">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-10" data-anim="fade-up">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass glass-prismatic-soft mb-2">
              <Sparkles className="w-3 h-3 text-lumina-500" />
              <span className="text-[11px] font-medium text-lumina-600 tracking-wide">Analysis Complete</span>
            </div>
            <h1 className="text-3xl font-bold text-slate-800 tracking-tight">
              Results
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              {result?.faces.length === 0
                ? 'No faces detected in this image'
                : `${result?.faces.length} face${(result?.faces.length ?? 0) > 1 ? 's' : ''} detected`}
            </p>
          </div>
          <button
            onClick={reset}
            className="glass-btn glass-btn-primary px-5 py-2 rounded-full text-sm font-medium inline-flex items-center gap-2"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Analyze Another
          </button>
        </div>

        {/* Original image preview */}
        {selectedImage && (
          <div className="liquid-glass glass-prismatic-soft rounded-2xl p-3 mb-10 inline-block" data-anim="fade-up" data-delay="100">
            <img
              src={selectedImage}
              alt="Analyzed"
              className="rounded-xl max-h-64 object-contain"
            />
          </div>
        )}

        {/* No faces */}
        {result?.faces.length === 0 && (
          <div className="liquid-glass-heavy glass-prismatic rounded-3xl p-12 text-center" data-anim="fade-up">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <User className="w-8 h-8 text-slate-300" />
            </div>
            <h3 className="text-lg font-semibold text-slate-700 mb-2">No Faces Detected</h3>
            <p className="text-sm text-slate-400 mb-6">Try uploading a clearer photo with visible faces</p>
            <button
              onClick={reset}
              className="glass-btn glass-btn-primary px-6 py-2.5 rounded-full text-sm font-medium inline-flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Try Another Photo
            </button>
          </div>
        )}

        {/* Face result cards */}
        <div className="space-y-8">
          {result?.faces.map((face, i) => (
            <FaceCard key={face.faceIndex} face={face} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
};
