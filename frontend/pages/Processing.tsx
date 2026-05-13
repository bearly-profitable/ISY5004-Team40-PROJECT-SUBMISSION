
import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { AnalyzeResult, getAnalysisStatus } from '../lib/analysisApi';

interface ProcessingProps {
  jobId: string;
  onComplete: (result: AnalyzeResult) => void;
  onError: (message: string) => void;
}

type PipelineStep = {
  key: string;
  label: string;
};

// Matches the step keys the backend actually emits after parallelization
const PIPELINE_STEPS: PipelineStep[] = [
  { key: 'loading_models', label: 'Loading models & images' },
  { key: 'analyzing', label: 'Detecting faces, persons & scenes' },
  { key: 'reid_embedding', label: 'Extracting body embeddings' },
  { key: 'identity_clustering', label: 'Clustering identities' },
  { key: 'clustering_scoring', label: 'Events & aesthetic scoring' },
  { key: 'quality_scoring', label: 'Ranking best shots' },
  { key: 'finalizing', label: 'Preparing gallery' },
];

export const Processing: React.FC<ProcessingProps> = ({ jobId, onComplete, onError }) => {
  const [progress, setProgress] = useState(0);
  const [currentStepKey, setCurrentStepKey] = useState<string>('loading_models');
  const [stepLabel, setStepLabel] = useState('Initializing…');
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let interval: number | undefined;

    const poll = async () => {
      try {
        const status = await getAnalysisStatus(jobId);
        if (!alive) return;

        setProgress(Math.max(0, Math.min(status.progress ?? 0, 100)));
        setCurrentStepKey(status.stepKey || 'loading_models');
        setStepLabel(status.stepLabel || 'Running analysis…');

        if (status.status === 'failed') {
          onError(status.error || 'Analysis failed.');
          window.clearInterval(interval);
          return;
        }

        if (status.status === 'completed') {
          if (!status.result) {
            onError('Analysis completed but no result payload was returned.');
            window.clearInterval(interval);
            return;
          }
          setDone(true);
          window.clearInterval(interval);
          window.setTimeout(() => onComplete(status.result as AnalyzeResult), 900);
        }
      } catch (error) {
        if (!alive) return;
        onError(error instanceof Error ? error.message : 'Failed to poll analysis status.');
        window.clearInterval(interval);
      }
    };

    poll();
    interval = window.setInterval(poll, 1100);

    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [jobId, onComplete, onError]);

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

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-16 sm:py-24 flex flex-col items-center">
      {/* Hero: percentage + label */}
      <div
        className={`liquid-glass-heavy glass-prismatic rounded-2xl px-8 py-5 flex items-center gap-6 mb-6 w-full transition-all duration-700 ${
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
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full glass-progress-track h-1.5 rounded-full mb-5 anim-fade-in-down">
        <div
          className="glass-progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Step log — compact, scrollable */}
      <div
        ref={logRef}
        className="w-full liquid-glass rounded-xl max-h-52 overflow-y-auto overscroll-contain px-1 py-1 space-y-px scroll-smooth"
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
