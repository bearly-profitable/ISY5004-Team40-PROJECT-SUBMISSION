/**
 * Lumina's motion system, built on GSAP.
 *
 * Entrances are declared in markup rather than wired per component: any element
 * with `data-anim="<preset>"` (and optionally `data-delay="<ms>"`, or
 * `data-anim-on="view"` to wait until it scrolls into view) is animated
 * by GSAP the moment it enters the DOM. A MutationObserver catches elements
 * that mount later — gallery cards after a fetch, a modal opening — so every
 * page animates the same way without each one managing its own tweens.
 *
 * Everything here stands down under `prefers-reduced-motion`.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export { gsap, ScrollTrigger };

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Preset = gsap.TweenVars;

const PRESETS: Record<string, Preset> = {
  'fade-up': { y: 18, opacity: 0 },
  'fade-down': { y: -14, opacity: 0 },
  'fade-left': { x: -18, opacity: 0 },
  'fade-right': { x: 18, opacity: 0 },
  fade: { opacity: 0 },
  scale: { scale: 0.94, opacity: 0 },
  pop: { scale: 0.6, opacity: 0, ease: 'back.out(2.2)', duration: 0.5 },
  page: { y: 14, opacity: 0, duration: 0.55 },
};

function animate(el: HTMLElement): void {
  if (el.dataset.animDone) return;
  el.dataset.animDone = '1';
  const preset = PRESETS[el.dataset.anim ?? ''] ?? PRESETS['fade-up'];
  // Tailwind's `transition-*` classes would make the element trail behind
  // every GSAP frame, so CSS transitions are parked for the tween's length.
  const transition = el.style.transition;
  el.style.transition = 'none';
  gsap.from(el, {
    duration: 0.6,
    ease: 'power3.out',
    ...preset,
    delay: Number(el.dataset.delay ?? 0) / 1000,
    clearProps: 'transform,opacity,scale,x,y',
    onComplete: () => { el.style.transition = transition; },
    // `data-anim-on="view"` waits until the element scrolls into view.
    ...(el.dataset.animOn === 'view'
      ? { scrollTrigger: { trigger: el, start: 'top 92%', once: true } }
      : {}),
  });
}

function scan(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset.anim) animate(node);
  node.querySelectorAll<HTMLElement>('[data-anim]').forEach(animate);
}

/** Drift the background colour orbs, slowly and forever. */
function driftMesh(): void {
  gsap.utils.toArray<HTMLElement>('.mesh-orb').forEach((orb, i) => {
    gsap.to(orb, {
      x: () => gsap.utils.random(-120, 120),
      y: () => gsap.utils.random(-90, 90),
      scale: () => gsap.utils.random(0.85, 1.2),
      duration: 18 + i * 4,
      ease: 'sine.inOut',
      repeat: -1,
      yoyo: true,
      repeatRefresh: true,
    });
  });
}

let started = false;

/** Start the motion system once, for the whole app. */
export function startMotion(root: HTMLElement = document.body): void {
  if (started) return;
  started = true;
  if (prefersReducedMotion()) {
    // Still mark elements, so nothing waits on an entrance that never comes.
    root.querySelectorAll<HTMLElement>('[data-anim]').forEach((el) => {
      el.dataset.animDone = '1';
    });
    return;
  }
  driftMesh();
  scan(root);
  // MutationObserver callbacks run before the browser paints, so the element
  // never flashes in its final state before GSAP takes it back to the start.
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(scan);
  }).observe(root, { childList: true, subtree: true });
}

/** A quick, springy "boop" — for pose changes and button feedback. */
export function boop(target: gsap.TweenTarget, strength = 1): void {
  if (prefersReducedMotion()) return;
  gsap.fromTo(
    target,
    { scale: 1 - 0.14 * strength, rotation: -4 * strength },
    { scale: 1, rotation: 0, duration: 0.55, ease: 'elastic.out(1.1, 0.5)', overwrite: 'auto' },
  );
}
