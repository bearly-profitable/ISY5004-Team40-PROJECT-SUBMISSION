/**
 * The landing page's scroll-driven film.
 *
 * Four short clips of Lumi (generated once, see tools/mascot/) were upscaled to
 * 1440p and cut into a 24 fps WebP frame sequence. This pins a canvas while the reader scrolls and GSAP
 * ScrollTrigger maps scroll progress to a frame, the technique product pages
 * use for "scroll to play". Story beats fade in over the film at the points
 * where each clip begins.
 *
 * Each screen loads one of three frame sets: 1440p where the canvas is big
 * enough to show the difference (retina laptops, 1080p+ monitors), 1080p for
 * smaller windows, and for phones a square crop from the centre of the 16:9
 * film, since Lumi is always framed in the middle third.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { gsap, prefersReducedMotion } from '../lib/motion';
// Written by tools/mascot/phase2_frames.py alongside the frames themselves.
import film from '../lib/landingFilm.json';

const FRAME_COUNT: number = film.frames;
type FrameSet = 'h' | 'd' | 'm';
const frameUrl = (set: FrameSet, i: number) =>
  `/landing/${set}/${String(i + 1).padStart(4, '0')}.webp`;

const PHONE_QUERY = '(max-width: 767px)';

/** The frame set for this screen. The canvas is drawn in device pixels (DPR
 *  capped at 2), so past ~1600 of them the 1080p frames would be stretched
 *  visibly soft and the 1440p set is worth its extra weight. */
const pickSet = (): FrameSet => {
  if (window.matchMedia(PHONE_QUERY).matches) return 'm';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return window.innerWidth * dpr > 1600 ? 'h' : 'd';
};

type Beat = { eyebrow: string; title: string; body: string };

/** Where each beat shows, as scroll progress. The clips change at 0.25, 0.5
 *  and 0.75, and each beat arrives just after its clip starts. */
const BEATS: (Beat & { from: number; to: number })[] = [
  {
    eyebrow: 'Step 1 · Upload',
    title: 'Drop in your photos',
    body: 'Up to 200 at a time. Lumi wakes up and catches every one.',
    from: 0.09, to: 0.3,
  },
  {
    eyebrow: 'Step 2 · Look',
    title: 'Lumi looks at every face',
    body: 'Faces, bodies, scenes and moments, all understood in seconds.',
    from: 0.31, to: 0.55,
  },
  {
    eyebrow: 'Step 3 · Sort',
    title: 'Sorted by people & moments',
    body: 'Every person and every event gets its own neat little pile.',
    from: 0.56, to: 0.8,
  },
  {
    eyebrow: 'Step 4 · Pick',
    title: 'A best shot for every moment',
    body: 'Seven quality signals choose the keeper, and Lumi tells you why.',
    from: 0.81, to: 1.01,
  },
];

interface ScrollStoryProps {
  onGetStarted: () => void;
}

export const ScrollStory: React.FC<ScrollStoryProps> = ({ onGetStarted }) => {
  const sectionRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const beatRefs = useRef<(HTMLDivElement | null)[]>([]);
  const frames = useRef<(HTMLImageElement | null)[]>([]);
  const current = useRef(0);
  const [loaded, setLoaded] = useState(0);
  const [set, setSet] = useState<FrameSet>(
    () => (typeof window === 'undefined' ? 'd' : pickSet()),
  );
  const reduced = prefersReducedMotion();

  // Follow the screen, but never step down from 1440p to 1080p: the sharper
  // frames still look right in a smaller window, and reloading would cost more.
  useEffect(() => {
    const update = () => {
      const next = pickSet();
      setSet((prev) => (prev === 'h' && next === 'd' ? prev : next));
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  /** Draw frame `index` (or the nearest one that has loaded), cover-fit. */
  const draw = (index: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let img: HTMLImageElement | null = null;
    for (let d = 0; d < FRAME_COUNT && !img; d++) {
      img = frames.current[index - d] ?? frames.current[index + d] ?? null;
    }
    if (!img) return;
    const { width: cw, height: ch } = canvas;
    // Trim the clips' dark edge rows, which would read as a hairline.
    const trim = 3;
    const sw = img.naturalWidth;
    const sh = img.naturalHeight - trim * 2;
    // On wide screens the story text sits on the left, so the film is drawn a
    // touch larger and nudged right to keep Lumi clear of it.
    const wide = cw / ch > 1.2;
    const zoom = wide ? 1.12 : 1;
    const scale = Math.max(cw / sw, ch / sh) * zoom;
    const w = sw * scale;
    const h = sh * scale;
    const x = (cw - w) / 2 + (wide ? (w - cw) / 2 : 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, trim, sw, sh, x, (ch - h) / 2, w, h);
  };

  // Size the canvas to its box in device pixels, and redraw on resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      draw(current.current);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Load frames: the first immediately, then a coarse pass (every 8th) so any
  // scroll position has something close, then fill in the rest.
  useEffect(() => {
    frames.current = new Array(FRAME_COUNT).fill(null);
    setLoaded(0);
    let alive = true;
    const order: number[] = [0];
    for (let i = 8; i < FRAME_COUNT; i += 8) order.push(i);
    order.push(FRAME_COUNT - 1);
    for (let i = 1; i < FRAME_COUNT; i++) if (!order.includes(i)) order.push(i);

    let next = 0;
    const loadOne = () => {
      if (!alive || next >= order.length) return;
      const index = order[next++];
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (!alive) return;
        frames.current[index] = img;
        setLoaded((n) => n + 1);
        if (index === current.current || index === 0) draw(current.current);
        loadOne();
      };
      img.onerror = loadOne;
      img.src = frameUrl(set, index);
    };
    // A few parallel lanes keeps the connection busy without flooding it.
    for (let lane = 0; lane < 6; lane++) loadOne();
    return () => { alive = false; };
  }, [set]);

  useGSAP(() => {
    if (reduced) {
      current.current = FRAME_COUNT - 1;
      draw(current.current);
      return;
    }
    const state = { frame: 0 };
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: sectionRef.current,
        start: 'top top',
        end: () => `+=${window.innerHeight * 4.5}`,
        pin: true,
        scrub: 0.6,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    });
    tl.to(state, {
      frame: FRAME_COUNT - 1,
      duration: 1,
      onUpdate: () => {
        const f = Math.round(state.frame);
        if (f !== current.current) {
          current.current = f;
          draw(f);
        }
      },
    }, 0);
    tl.to(introRef.current, { autoAlpha: 0, y: -40, duration: 0.06, ease: 'power1.in' }, 0.03);
    BEATS.forEach((beat, i) => {
      const el = beatRefs.current[i];
      tl.fromTo(el, { autoAlpha: 0, y: 40 },
        { autoAlpha: 1, y: 0, duration: 0.05, ease: 'power2.out' }, beat.from);
      if (beat.to <= 1) {
        tl.to(el, { autoAlpha: 0, y: -40, duration: 0.05, ease: 'power2.in' }, beat.to - 0.05);
      }
    });
  }, { scope: sectionRef, dependencies: [reduced] });

  const progress = Math.round((loaded / FRAME_COUNT) * 100);

  return (
    <section
      ref={sectionRef}
      className="relative h-[100svh] w-full overflow-hidden"
      aria-label="How Lumina works, told by Lumi"
    >
      {/* Film. Full-bleed on wide screens; a square stage on phones, with
          the story told underneath it. */}
      <div className="absolute inset-0 flex flex-col md:block">
        <div className="relative w-full md:h-full pt-16 md:pt-0 shrink-0">
          <canvas
            ref={canvasRef}
            className="block w-full aspect-square max-h-[58svh] md:max-h-none md:aspect-auto md:h-full mx-auto"
            aria-hidden="true"
          />
          {/* Soft edges so the film melts into the page. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 md:h-40 bg-gradient-to-t from-[#f6eef4] to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 left-0 hidden md:block w-[50%] bg-gradient-to-r from-[#f6eef4]/95 via-[#f6eef4]/60 to-transparent" />
        </div>
        <div className="relative flex-1 md:absolute md:inset-0 md:pointer-events-none">
          {/* Intro: the first thing anyone sees. */}
          <div
            ref={introRef}
            className="absolute inset-x-0 top-2 md:top-0 md:bottom-0 md:left-[5%] md:right-auto md:max-w-[29rem] flex flex-col items-center md:items-start justify-start md:justify-center text-center md:text-left px-6 md:pointer-events-auto"
          >
            <span className="chip mb-3 md:mb-5">
              <Sparkles className="w-3 h-3" /> Meet Lumi
            </span>
            <h1 className="font-display text-[2.1rem] leading-[1.05] md:text-6xl font-bold text-slate-900 mb-3 md:mb-5">
              Your photos&rsquo; <span className="text-lumi-gradient">new best friend</span>
            </h1>
            <p className="text-slate-600 text-[0.95rem] md:text-lg max-w-md mb-5 md:mb-8">
              Lumi finds the people, groups the moments and picks the best shot of
              everyone, so you don&rsquo;t have to.
            </p>
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-3">
              <button className="btn-jelly" onClick={onGetStarted}>Start with your photos</button>
              <span className="hidden md:inline-flex items-center gap-1.5 text-sm font-bold text-slate-500">
                <ArrowDown className="w-4 h-4 animate-bounce" /> or scroll to watch Lumi work
              </span>
            </div>
          </div>

          {BEATS.map((beat, i) => (
            <div
              key={beat.title}
              ref={(el) => { beatRefs.current[i] = el; }}
              className="invisible absolute inset-x-0 top-2 md:top-0 md:bottom-0 md:left-[6%] md:right-auto md:max-w-md flex flex-col items-center md:items-start justify-start md:justify-center text-center md:text-left px-6 md:pointer-events-auto"
            >
              <span className="chip mb-3">{beat.eyebrow}</span>
              <h2 className="font-display text-3xl md:text-6xl font-bold text-slate-900 leading-[1.05] mb-3 md:mb-4">
                {beat.title}
              </h2>
              <p className="text-slate-600 text-[0.95rem] md:text-lg max-w-sm">{beat.body}</p>
              {i === BEATS.length - 1 && (
                <button className="btn-jelly mt-5 md:mt-7" onClick={onGetStarted}>
                  Let Lumi sort mine
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {progress < 100 && (
        <div className="absolute bottom-4 right-4 md:bottom-6 md:right-6 chip bg-white/70 backdrop-blur" aria-live="polite">
          Loading film {progress}%
        </div>
      )}
    </section>
  );
};
