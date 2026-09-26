import React, { useLayoutEffect, useRef } from 'react';
import { gsap, ScrollTrigger, prefersReducedMotion } from '../../lib/motion';

/**
 * Reveal the elements matching `selector` inside `rootRef` as they scroll in.
 *
 * The old gallery hid every section behind a one-shot ScrollTrigger whose
 * start position was measured before the photos above it had loaded, so
 * sections stayed invisible until the user scrolled well past them. This one
 * reveals on *any* crossing (enter, leave, enter-back), re-measures when the
 * root resizes, and a timer shows anything already on screen regardless, so
 * content can never be left hidden.
 */
export function useReveal(
  rootRef: React.RefObject<HTMLElement | null>,
  selector: string,
  deps: React.DependencyList,
  from: gsap.TweenVars = { y: 28 },
  to: gsap.TweenVars = {},
): void {
  useLayoutEffect(() => {
    const root: HTMLElement | null = rootRef.current;
    if (!root || prefersReducedMotion()) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.dataset.revealed);
    if (els.length === 0) return;

    // Opacity, not visibility: waiting tiles stay focusable and clickable.
    gsap.set(els, { opacity: 0, ...from });
    const show = (batch: Element[]) => {
      const fresh = (batch as HTMLElement[]).filter((el) => !el.dataset.revealed);
      if (fresh.length === 0) return;
      fresh.forEach((el) => { el.dataset.revealed = '1'; });
      gsap.to(fresh, {
        opacity: 1, x: 0, y: 0, scale: 1, rotate: 0,
        duration: 0.8, ease: 'power3.out', stagger: 0.055, overwrite: true,
        ...to,
        clearProps: 'opacity,visibility,transform,clipPath',
      });
    };

    const triggers = ScrollTrigger.batch(els, {
      start: 'top bottom-=24',
      end: 'bottom top+=24',
      onEnter: show,
      onEnterBack: show,
      onLeave: show,
      batchMax: 14,
    });

    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => ScrollTrigger.refresh());
    });
    observer.observe(root);

    const failsafe = window.setTimeout(() => {
      show(els.filter((el) => el.getBoundingClientRect().top < window.innerHeight));
    }, 1400);

    return () => {
      window.clearTimeout(failsafe);
      cancelAnimationFrame(raf);
      observer.disconnect();
      triggers.forEach((t) => t.kill());
      // Anything still waiting goes back to its natural, visible state.
      const pending = els.filter((el) => !el.dataset.revealed);
      if (pending.length) gsap.set(pending, { clearProps: 'opacity,visibility,transform,clipPath' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A number that counts up to `value` whenever it changes. */
export const CountUp: React.FC<{ value: number; className?: string; delay?: number }> = ({ value, className, delay = 0 }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = String(value);
      shown.current = value;
      return;
    }
    const state = { v: shown.current };
    const tween = gsap.to(state, {
      v: value, duration: 1.1, delay, ease: 'power3.out',
      onUpdate: () => { el.textContent = String(Math.round(state.v)); },
      onComplete: () => { shown.current = value; },
    });
    return () => { tween.kill(); shown.current = Math.round(state.v); };
  }, [value, delay]);
  return <span ref={ref} className={`tabular-nums ${className ?? ''}`}>{shown.current}</span>;
};

/** A headline whose words rise out of a mask, one after another. */
export const SplitTitle: React.FC<{ text: string; className?: string; delay?: number; as?: 'h1' | 'h2' }> = ({
  text, className, delay = 0, as: Tag = 'h1',
}) => {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from(el.querySelectorAll('[data-word]'), {
        yPercent: 115, rotate: 4, duration: 1.05, ease: 'expo.out', stagger: 0.075, delay,
      });
    }, el);
    return () => ctx.revert();
  }, [text, delay]);
  const words = text.split(' ');
  return (
    <Tag ref={ref} className={className} aria-label={text}>
      {words.map((word, i) => (
        <span key={`${word}-${i}`} aria-hidden className="inline-block overflow-hidden align-bottom pb-[0.12em] -mb-[0.12em]">
          <span data-word className="inline-block origin-bottom-left">{word}</span>
          {i < words.length - 1 && ' '}
        </span>
      ))}
    </Tag>
  );
};

export interface SegmentItem<T extends string> {
  key: T;
  label: string;
  icon?: React.ReactNode;
  badge?: number | null;
}

/** Tabs with a pill that glides to the active one. */
export function Segmented<T extends string>({ items, value, onChange, className = '' }: {
  items: SegmentItem<T>[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const pill = pillRef.current;
    if (!wrap || !pill) return;
    const place = (animate: boolean) => {
      const btn = wrap.querySelector<HTMLElement>(`[data-seg="${value}"]`);
      if (!btn) return;
      const vars = { x: btn.offsetLeft, width: btn.offsetWidth, opacity: 1 };
      if (!animate || prefersReducedMotion()) gsap.set(pill, vars);
      else gsap.to(pill, { ...vars, duration: 0.5, ease: 'expo.out', overwrite: true });
      // Keep the active tab visible when the row scrolls on small screens.
      const left = btn.offsetLeft - wrap.scrollLeft;
      if (left < 0 || left + btn.offsetWidth > wrap.clientWidth) {
        wrap.scrollTo({ left: btn.offsetLeft - 16, behavior: animate ? 'smooth' : 'auto' });
      }
    };
    place(placed.current);
    placed.current = true;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [value, items.length]);

  return (
    <div
      ref={wrapRef}
      role="tablist"
      className={`relative flex items-center gap-0.5 p-1 rounded-full bg-slate-900/[0.05] overflow-x-auto scrollbar-hide ${className}`}
      style={{ scrollbarWidth: 'none' }}
    >
      <div
        ref={pillRef}
        aria-hidden
        className="absolute left-0 top-1 bottom-1 rounded-full bg-white shadow-[0_1px_2px_rgba(37,28,47,0.08),0_4px_14px_rgba(37,28,47,0.08)] opacity-0"
      />
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            data-seg={item.key}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={`relative z-[1] flex items-center gap-1.5 px-3.5 sm:px-4 h-9 rounded-full text-sm font-bold whitespace-nowrap transition-colors duration-300 ${
              active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {item.icon}
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span className={`min-w-[1.25rem] h-5 px-1.5 rounded-full text-[11px] leading-5 text-center tabular-nums ${
                active ? 'bg-slate-900 text-white' : 'bg-slate-900/[0.08] text-slate-500'
              }`}>
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
