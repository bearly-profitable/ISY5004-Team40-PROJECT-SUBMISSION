import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, Crown, Pin, X } from 'lucide-react';
import type { EventMember, Photo } from '../../types';
import { SIGNAL_UI } from '../../lib/signals';
import { lumiSrc } from '../Lumi';
import { gsap, prefersReducedMotion } from '../../lib/motion';
import { Img, useFocal } from './shared';

/** "Why this photo?" — Lumi's reasoning for a moment's best shot, in a popup. */
export const WhyModal: React.FC<{
  photo: Photo;
  member: EventMember;
  eventLabel: string;
  photoCount: number;
  pinned?: boolean;
  onClose: () => void;
}> = ({ photo, member, eventLabel, photoCount, pinned, onClose }) => {
  const backdropRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const focal = useFocal(photo.id);
  const explanation = member.explanation;

  // In: backdrop fades, card springs up, then the signal bars fill one by one.
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    const card = cardRef.current;
    // A context, so an interrupted run (React re-running effects) reverts to
    // the real styles instead of leaving `from` tweens stuck at their start.
    const ctx = gsap.context(() => {
      gsap.timeline()
        .fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' })
        .fromTo(card, { y: 40, scale: 0.95, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: 'expo.out' }, 0)
        .from(card?.querySelectorAll('[data-why-item]') ?? [], { y: 12, opacity: 0, duration: 0.45, ease: 'power3.out', stagger: 0.05 }, 0.15)
        .from(card?.querySelectorAll('[data-why-bar]') ?? [], { scaleX: 0, duration: 0.8, ease: 'expo.out', stagger: 0.06 }, 0.3);
    });
    return () => ctx.revert();
  }, []);

  const close = useCallback(() => {
    if (prefersReducedMotion()) { onClose(); return; }
    gsap.to(cardRef.current, { y: 24, scale: 0.97, opacity: 0, duration: 0.22, ease: 'power2.in' });
    gsap.to(backdropRef.current, { opacity: 0, duration: 0.25, ease: 'power2.in', onComplete: onClose });
  }, [onClose]);

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
        aria-label={`Why Lumi picked this photo for ${eventLabel}`}
        className="relative w-full max-w-[26rem] max-h-[88vh] overflow-y-auto rounded-[1.75rem] bg-white shadow-2xl shadow-slate-900/25"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Photo */}
        <div className="relative aspect-[16/10] bg-slate-100 overflow-hidden">
          <Img src={photo.largeUrl ?? photo.url} alt={photo.name} eager focal={focal} className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-transparent pointer-events-none" />
          <button
            onClick={close}
            className="absolute top-3 right-3 w-9 h-9 rounded-full bg-white/90 text-slate-700 hover:bg-white flex items-center justify-center shadow-sm"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="absolute left-4 right-4 bottom-3 flex items-end justify-between gap-3 text-white">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1 text-xs font-bold text-white/85">
                {pinned ? <Pin className="w-3 h-3" /> : <Crown className="w-3 h-3 text-amber-300" />}
                {pinned ? 'Your pick' : `Best of ${photoCount}`}
              </span>
              <p className="font-display text-lg font-semibold leading-tight truncate">{eventLabel}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="font-display text-3xl font-semibold leading-none tabular-nums">{Math.round(member.finalScore * 100)}</p>
              <p className="text-[11px] text-white/70 mt-0.5">score</p>
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-6">
          {/* Lumi's verdict */}
          {explanation && (
            <div className="flex items-start gap-3" data-why-item>
              <img src={lumiSrc('point')} alt="" aria-hidden className="lumi-sprite h-14 w-auto flex-shrink-0 -scale-x-100 -mt-1" />
              <p className="lumi-bubble text-sm !font-semibold leading-relaxed" data-tail="left">{explanation.summary}</p>
            </div>
          )}

          {/* Reasons */}
          {(explanation?.reasons.length ?? 0) > 0 && (
            <ul className="mt-5 space-y-2">
              {explanation!.reasons.map((reason) => (
                <li key={reason.signal} className="flex items-start gap-2.5 text-sm text-slate-600" data-why-item>
                  <span className="w-5 h-5 rounded-full bg-lumina-500/10 text-lumina-600 flex items-center justify-center flex-shrink-0 mt-px">
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
                  {reason.detail}
                </li>
              ))}
            </ul>
          )}

          {/* Signals */}
          {member.normSignals && (
            <div className="mt-6 pt-5 border-t border-slate-100" data-why-item>
              <p className="text-xs font-bold text-slate-400 mb-3">How it scored</p>
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                {SIGNAL_UI.map(({ key, label }) => {
                  const value = Math.round((member.normSignals![key] ?? 0) * 100);
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between mb-1.5 text-xs">
                        <span className="text-slate-500">{label}</span>
                        <span className="font-bold text-slate-700 tabular-nums">{value}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          data-why-bar
                          className="h-full rounded-full bg-gradient-to-r from-lumina-400 to-lumina-500 origin-left"
                          style={{ width: `${value}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              {member.nimaScore > 0 && (
                <p className="text-xs text-slate-400 mt-4">NIMA aesthetic rating {member.nimaScore.toFixed(1)} / 10</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
