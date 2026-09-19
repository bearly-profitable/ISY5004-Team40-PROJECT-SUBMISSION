
import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { AnalyzeResult, AnalyzeStatus, analysisStreamUrl, getAnalysisStatus } from '../lib/analysisApi';
import { Photo } from '../types';

interface ProcessingProps {
  jobId: string;
  photos?: Photo[];
  onComplete: (result: AnalyzeResult) => void;
  onError: (message: string) => void;
}

type PipelineStep = {
  key: string;
  label: string;
};

// Matches the step keys the backend actually emits after parallelization
const PIPELINE_STEPS: PipelineStep[] = [
  { key: 'loading_models', label: 'Loading models & cached embeddings' },
  { key: 'analyzing', label: 'Faces, persons, scenes & semantics (CLIP)' },
  { key: 'reid_embedding', label: 'Extracting body embeddings' },
  { key: 'identity_clustering', label: 'Fused identity clustering (face + body)' },
  { key: 'clustering_scoring', label: 'Time-aware events & aesthetic scoring' },
  { key: 'quality_scoring', label: 'Ranking, captions & duplicate detection' },
  { key: 'finalizing', label: 'Preparing gallery' },
];

export const Processing: React.FC<ProcessingProps> = ({ jobId, photos = [], onComplete, onError }) => {
  const [progress, setProgress] = useState(0);
  const [currentStepKey, setCurrentStepKey] = useState<string>('loading_models');
  const [stepLabel, setStepLabel] = useState('Initializing…');
  const [imagesDone, setImagesDone] = useState(0);
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let pollInterval: number | undefined;
    let source: EventSource | null = null;

    const handleStatus = (status: AnalyzeStatus) => {
      if (!alive || finishedRef.current) return;

      setProgress(Math.max(0, Math.min(status.progress ?? 0, 100)));
      setCurrentStepKey(status.stepKey || 'loading_models');
      setStepLabel(status.stepLabel || 'Running analysis…');
      if (typeof status.imagesDone === 'number') setImagesDone(status.imagesDone);

      if (status.status === 'failed') {
        finishedRef.current = true;
        onError(status.error || 'Analysis failed.');
      } else if (status.status === 'completed') {
        finishedRef.current = true;
        if (!status.result) {
          onError('Analysis completed but no result payload was returned.');
          return;
        }
        setProgress(100);
        setImagesDone(photos.length);
        setDone(true);
        window.setTimeout(() => onComplete(status.result as AnalyzeResult), 900);
      }
    };

    const startPolling = () => {
      if (pollInterval !== undefined || finishedRef.current) return;
      const poll = async () => {
        try {
          handleStatus(await getAnalysisStatus(jobId));
          if (finishedRef.current) window.clearInterval(pollInterval);
        } catch (error) {
          if (!alive) return;
          finishedRef.current = true;
          window.clearInterval(pollInterval);
          onError(error instanceof Error ? error.message : 'Failed to poll analysis status.');
        }
      };
      poll();
      pollInterval = window.setInterval(poll, 1100);
    };

    // Prefer live Server-Sent Events; fall back to polling if the stream
    // can't be established (proxy buffering, older browsers, …).
    try {
      source = new EventSource(analysisStreamUrl(jobId));
      source.onmessage = (event) => {
        try {
          handleStatus(JSON.parse(event.data) as AnalyzeStatus);
          if (finishedRef.current) source?.close();
        } catch { /* malformed frame — ignore */ }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!finishedRef.current) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      alive = false;
      source?.close();
      if (pollInterval !== undefined) window.clearInterval(pollInterval);
    };
  }, [jobId, onComplete, onError, photos.length]);

  // Auto-scroll log to the active step
  useEffect(() => {
    if (logRef.current) {
      const active = logRef.current.querySelector('[data-active="true"]');
      if (active) {
        active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [currentStepKey]);

  const currentStepIndex = PIPELINE_STEPS.findIndex((s) => s.key === currentStepKey);
  const activeIdx = currentStepIndex >= 0 ? currentStepIndex : PIPELINE_STEPS.length - 1;

  // Which thumbnails to light up: real per-image counts during extraction,
  // then everything once the pipeline moves past the analysis stage.
  const pastAnalysis = done || activeIdx >= 2;
  const litCount = pastAnalysis ? photos.length : imagesDone;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-12 sm:py-16 flex flex-col items-center">
      {/* Hero: percentage + label */}
      <div
        className={`liquid-glass-heavy glass-prismatic rounded-2xl px-8 py-5 flex items-center gap-6 mb-6 w-full max-w-md transition-all duration-700 ${
          done ? 'anim-glow' : ''
        }`}
        style={{ animation: 'scaleInBounce 0.6s cubic-bezier(0.34,1.56,0.64,1) both' }}
      >
        <div className="text-4xl sm:text-5xl font-light tracking-tighter tabular-nums shrink-0">
          {progress}<span className="text-gradient">%</span>
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight truncate">
            {done ? 'Gallery ready!' : 'Analyzing your photos'}
          </h2>
          <p className="text-xs text-slate-400 truncate">{stepLabel}</p>
          {photos.length > 0 && !done && (
            <p className="text-[10px] text-lumina-500 font-bold uppercase tracking-widest mt-1 tabular-nums">
              {Math.min(litCount, photos.length)} / {photos.length} photos analysed
            </p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full max-w-md glass-progress-track h-1.5 rounded-full mb-6 anim-fade-in-down">
        <div
          className="glass-progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Live thumbnail grid — tiles light up as each image is analysed */}
      {photos.length > 0 && (
        <div
          className="w-full mb-6 liquid-glass rounded-2xl p-3"
          style={{ animation: 'fadeInUp 0.5s var(--smooth, ease) 150ms both' }}
        >
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${photos.length > 60 ? 34 : 48}px, 1fr))` }}
          >
            {photos.map((photo, i) => {
              const lit = i < litCount;
              return (
                <div
                  key={photo.id}
                  className="relative aspect-square rounded-lg overflow-hidden bg-slate-200/40"
                >
                  <img
                    src={photo.url}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover transition-all duration-700"
                    style={{
                      filter: lit ? 'none' : 'grayscale(1) brightness(1.15)',
                      opacity: lit ? 1 : 0.35,
                      transform: lit ? 'scale(1)' : 'scale(0.96)',
                    }}
                  />
                  {lit && !done && i === litCount - 1 && (
                    <div className="absolute inset-0 ring-2 ring-inset ring-lumina-400/80 rounded-lg" />
                  )}
                  {lit && (
                    <div
                      className="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-lumina-500 flex items-center justify-center"
                      style={{ animation: 'scaleIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both' }}
                    >
                      <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Step log — compact, scrollable */}
      <div
        ref={logRef}
        className="w-full max-w-md liquid-glass rounded-xl max-h-52 overflow-y-auto overscroll-contain px-1 py-1 space-y-px scroll-smooth"
      >
        {PIPELINE_STEPS.map((step, i) => {
          const isDone = i < activeIdx || (i === activeIdx && done);
          const isActive = i === activeIdx && !done;

          return (
            <div
              key={step.key}
              data-active={isActive ? 'true' : undefined}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-300 ${
                isActive
                  ? 'liquid-glass glass-prismatic-soft'
                  : isDone
                  ? 'opacity-70'
                  : 'opacity-30'
              }`}
            >
              {/* Icon */}
              <div className="w-5 h-5 flex items-center justify-center shrink-0">
                {isDone ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                ) : isActive ? (
                  <Loader2
                    className="w-3.5 h-3.5 text-lumina-400"
                    style={{ animation: 'spinSlow 1.2s linear infinite' }}
                  />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-500/40" />
                )}
              </div>

              {/* Label */}
              <span
                className={`text-xs font-medium flex-1 truncate ${
                  isActive ? 'text-slate-900' : isDone ? 'text-slate-400' : 'text-slate-500'
                }`}
              >
                {step.label}
              </span>

              {isDone && (
                <span className="text-[9px] font-bold uppercase tracking-widest text-green-400/60 shrink-0">
                  Done
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Completion sparkle */}
      {done && (
        <div className="mt-6 flex items-center gap-2 text-lumina-400 anim-scale-bounce">
          <Sparkles className="w-4 h-4" />
          <span className="text-xs font-bold uppercase tracking-widest">Analysis Complete</span>
          <Sparkles className="w-4 h-4" />
        </div>
      )}
    </div>
  );
};
