import React, { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { Loader2, Lock, LogIn } from 'lucide-react';
import { Lumi } from './Lumi';
import { gsap, prefersReducedMotion } from '../lib/motion';
import { AppStep } from '../types';

/** Pages that only make sense with an account: photos, results and history
 *  all belong to the signed-in user. */
export const MEMBER_STEPS = new Set<AppStep>([
  AppStep.UPLOAD, AppStep.PROCESSING, AppStep.GALLERY,
  AppStep.SESSIONS, AppStep.FACE_ANALYSIS, AppStep.PROFILE,
]);

const COPY: Partial<Record<AppStep, { title: string; say: string }>> = {
  [AppStep.UPLOAD]: {
    title: 'Log in to upload your photos',
    say: 'Log in first, then hand me your photos!',
  },
  [AppStep.GALLERY]: {
    title: 'Log in to see your gallery',
    say: 'Your gallery lives in your account. Log in and I’ll bring it out!',
  },
  [AppStep.SESSIONS]: {
    title: 'Log in to see your sessions',
    say: 'I saved every session to your account. Log in to open them!',
  },
};

const FALLBACK = { title: 'Log in to continue', say: 'Just one tap and we’re off!' };

interface SignInGateProps {
  step: AppStep;
  onLogIn: () => void;
  /** Still reading the stored login: show Lumi waiting, not the gate. */
  checking?: boolean;
}

/** Stands in for a members-only page while nobody is signed in: Lumi points
 *  the visitor at the Log in button. */
export const SignInGate: React.FC<SignInGateProps> = ({ step, onLogIn, checking = false }) => {
  const nudgeRef = useRef<HTMLDivElement>(null);
  const { title, say } = COPY[step] ?? FALLBACK;

  // Lumi jabs a finger toward the button, over and over, like a helpful friend.
  useGSAP(() => {
    if (checking || prefersReducedMotion()) return;
    gsap.to(nudgeRef.current, {
      x: 8, duration: 0.45, ease: 'power1.inOut', repeat: -1, yoyo: true, repeatDelay: 0.25,
    });
  }, { dependencies: [checking] });

  if (checking) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-3">
        <Lumi pose="think" size={120} />
        <span className="text-sm font-bold flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking your login…
        </span>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-14">
      <div data-anim="scale" className="liquid-glass rounded-[32px] px-5 py-8 sm:p-12 text-center flex flex-col items-center">
        <span className="chip mb-3">
          <Lock className="w-3 h-3" /> Members only
        </span>
        <h1 className="font-display text-3xl md:text-4xl font-bold text-slate-900">{title}</h1>
        <p className="text-sm text-slate-500 mt-2 max-w-md leading-relaxed">
          Your photos, galleries and sessions are private to your account, so Lumi needs to
          know it’s you first.
        </p>

        <div className="lumi-bubble mt-7 max-w-[18rem]" data-tail="bottom-left" role="status">{say}</div>
        <div className="mt-3 flex items-center justify-center gap-1 sm:gap-3">
          <div ref={nudgeRef} className="shrink-0">
            <Lumi pose="point" size={140} />
          </div>
          <button onClick={onLogIn} className="btn-jelly login-beacon shrink-0">
            <LogIn className="w-4 h-4" /> Log in with Google
          </button>
        </div>

        <p className="text-xs text-slate-400 mt-6">
          Free, one tap with Google. Nobody else can see what you upload.
        </p>
      </div>
    </div>
  );
};
