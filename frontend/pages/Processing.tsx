
import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Lumi, LumiPose, preloadPoses } from '../components/Lumi';
import { AnalyzeResult, AnalyzeStatus, analysisStreamUrl, getAnalysisStatus } from '../lib/analysisApi';
import { prefersReducedMotion } from '../lib/motion';
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

/** What Lumi is doing, and saying, during each stage. */
const STEP_LUMI: Record<string, { pose: LumiPose; line: string }> = {
  loading_models: { pose: 'sleepy', line: 'Stretching… waking up my brain!' },
  analyzing: { pose: 'search', line: 'Looking closely at every face and scene…' },
  reid_embedding: { pose: 'camera', line: 'Remembering outfits, in case someone turns away.' },
  identity_clustering: { pose: 'tag', line: 'Working out who’s who…' },
  clustering_scoring: { pose: 'sort', line: 'Sorting everything into moments.' },
  quality_scoring: { pose: 'star', line: 'Picking the very best shots!' },
  finalizing: { pose: 'carry', line: 'Carrying it all to your gallery…' },
  done: { pose: 'celebrate', line: 'All done! Come and see!' },
};
/** Lumi's one animated loop, played through every working stage. */
const WORKING_POSE: LumiPose = 'star';
preloadPoses([WORKING_POSE], { animated: true });
preloadPoses(Object.values(STEP_LUMI).map((s) => s.pose));

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
          const frame = JSON.parse(event.data) as AnalyzeStatus;
          if (frame.status === 'completed' && !frame.result) {
            // EventSource can't send credentials, so the stream never carries
            // the result: fetch it with them.
            source?.close();
            source = null;
            getAnalysisStatus(jobId).then(handleStatus).catch(() => startPolling());
            return;
          }
          handleStatus(frame);
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

  const lumi = done ? STEP_LUMI.done : STEP_LUMI[PIPELINE_STEPS[activeIdx]?.key] ?? STEP_LUMI.loading_models;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 flex flex-col items-center">
      {/* Lumi narrates the pipeline, one line per stage. */}
      <div data-anim="pop" className="mb-5 flex justify-center">
        {/* While working Lumi plays its star loop and each stage keeps its own
            line; with reduced motion each stage shows its own still pose. */}
        <Lumi
          pose={!done && !prefersReducedMotion() ? WORKING_POSE : lumi.pose}
          size={150}
          say={lumi.line}
          bubble="top"
          animate
        />
      </div>

      {/* Percentage + label */}
      <div
        data-anim="fade-up"
        className="liquid-glass-heavy rounded-[28px] px-6 sm:px-8 py-5 flex items-center gap-5 mb-4 w-full max-w-md"
      >
        <div className="font-display text-5xl font-bold tabular-nums shrink-0 text-slate-900">
          {progress}<span className="text-lumi-gradient">%</span>
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-extrabold truncate font-sans">
            {done ? 'Your gallery is ready!' : 'Analyzing your photos'}
          </h1>
          <p className="text-xs text-slate-500 truncate">{stepLabel}</p>
          {photos.length > 0 && !done && (
            <p className="text-[11px] text-lumina-600 font-extrabold mt-1 tabular-nums">
              {Math.min(litCount, photos.length)} / {photos.length} photos looked at
            </p>
          )}
        </div>
      </div>

      <div
        className="w-full max-w-md h-3 rounded-full mb-6 bg-white/70 overflow-hidden shadow-inner"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Analysis progress"
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%`, background: 'var(--lumi-gradient)' }}
        />
      </div>

      {/* Live thumbnail grid: tiles light up as each image is analysed */}
      {photos.length > 0 && (
        <div data-anim="fade-up" data-delay="120" className="w-full mb-6 liquid-glass rounded-[24px] p-3">
          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${photos.length > 60 ? 34 : 48}px, 1fr))` }}
          >
            {photos.map((photo, i) => {
              const lit = i < litCount;
              return (
                <div key={photo.id} className="relative aspect-square rounded-lg overflow-hidden bg-slate-200/40">
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
                    <div className="absolute inset-0 ring-2 ring-inset ring-lumina-400 rounded-lg" />
                  )}
                  {lit && (
                    <div data-anim="pop" className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-lumina-500 flex items-center justify-center">
                      <CheckCircle2 className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Step log */}
      <div
        ref={logRef}
        className="w-full max-w-md liquid-glass rounded-[24px] max-h-56 overflow-y-auto overscroll-contain p-1.5 space-y-px scroll-smooth"
      >
        {PIPELINE_STEPS.map((step, i) => {
          const isDone = i < activeIdx || (i === activeIdx && done);
          const isActive = i === activeIdx && !done;
          return (
            <div
              key={step.key}
              data-active={isActive ? 'true' : undefined}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-2xl transition-all duration-300 ${
                isActive ? 'bg-white shadow-sm' : isDone ? 'opacity-75' : 'opacity-40'
              }`}
            >
              <div className="w-5 h-5 flex items-center justify-center shrink-0">
                {isDone ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : isActive ? (
                  <Loader2 className="w-4 h-4 text-lumina-500 animate-spin" />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-400/60" />
                )}
              </div>
              <span className={`text-sm font-bold flex-1 truncate ${
                isActive ? 'text-slate-900' : 'text-slate-500'
              }`}>
                {step.label}
              </span>
              {isDone && (
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-emerald-500/80 shrink-0">
                  Done
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
