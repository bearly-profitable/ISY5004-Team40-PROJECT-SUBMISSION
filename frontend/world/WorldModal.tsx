/**
 * "Explore world": a low-poly island where Lumi walks among your photos.
 *
 * Signed in, the island holds the whole library, one clearing per moment;
 * otherwise it holds this session's keepers. Arrow keys / WASD (or the
 * joystick on touch screens) run, Q sprints, Space jumps, and E looks at the
 * photo Lumi is next to, opening it in the Lightbox. M mutes the sound.
 *
 * Lazy-loaded from the gallery, so three.js is only downloaded when used.
 */
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { ChevronsUp, Eye, Loader2, Volume2, VolumeX, X, Zap } from 'lucide-react';
import type { Event, EventMember } from '../types';
import { Lightbox, type LightboxItem } from '../components/Lightbox';
import { Lumi } from '../components/Lumi';
import { keeperIds } from '../components/gallery/PhotoGrid';
import { useAuth } from '../lib/auth';
import { listLibrary, signedUrls, type LibraryPhoto } from '../lib/library';
import { gsap, prefersReducedMotion } from '../lib/motion';
import { buildLayout, type Interactable, type WorldLayout, type WorldPhoto, type ZoneSource } from './layout';
import { Island } from './Island';
import { LumiCharacter } from './LumiCharacter';
import { PhotoFrames } from './PhotoFrames';
import { createRuntime, type WorldRuntime } from './runtime';
import { WorldAudio, readMuted } from './sound';

/* ------------------------------------------------------------------ */
/* Photos -> moments                                                   */
/* ------------------------------------------------------------------ */

function monthOf(row: LibraryPhoto): { key: string; label: string } {
  const d = new Date(row.taken_at ?? row.created_at);
  return {
    key: `${d.getFullYear()}-${d.getMonth()}`,
    label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

/** The library, one moment per event label per month, newest first. */
async function librarySources(): Promise<ZoneSource[]> {
  const rows = await listLibrary();
  if (rows.length === 0) return [];
  const urls = await signedUrls(rows.flatMap((r) => [r.thumb_path, r.storage_path]));
  const groups = new Map<string, { title: string; month: string; rows: LibraryPhoto[] }>();
  for (const row of rows) {
    if (!urls[row.thumb_path]) continue;
    const month = monthOf(row);
    const title = row.event_label?.trim() || 'Memories';
    const key = `${title}|${month.key}`;
    const group = groups.get(key) ?? { title, month: month.label, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => {
    const sorted = [...g.rows].sort((a, b) =>
      Number(b.is_best) - Number(a.is_best) || Number(b.favourite) - Number(a.favourite) || (b.score ?? 0) - (a.score ?? 0));
    const photos: WorldPhoto[] = sorted.map((row) => {
      const thumb = urls[row.thumb_path];
      return {
        id: row.id,
        thumbUrl: thumb,
        aspect: row.width && row.height ? row.width / row.height : null,
        item: {
          photo: { id: row.id, url: thumb, largeUrl: thumb, fullUrl: urls[row.storage_path] ?? thumb, name: row.name ?? 'photo.jpg', size: '' },
          subtitle: [g.title, g.month].join(' · '),
        },
      };
    });
    return { key, title: g.title, subtitle: g.month, labels: [g.title], photos };
  });
}

/** This session's keepers, one moment per event, newest first. */
function sessionSources(events: Event[]): ZoneSource[] {
  return [...events]
    .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
    .map((evt) => {
      const keep = keeperIds(evt);
      const members = new Map<string, EventMember>(evt.members.map((m) => [m.photoId, m]));
      const photos = evt.photos
        .filter((p) => keep.has(p.id))
        .sort((a, b) => Number(b.id === evt.topPhotoId) - Number(a.id === evt.topPhotoId)
          || (members.get(b.id)?.finalScore ?? 0) - (members.get(a.id)?.finalScore ?? 0))
        .map((photo): WorldPhoto => ({ id: photo.id, thumbUrl: photo.largeUrl ?? photo.url, aspect: null, item: { photo, event: evt } }));
      return {
        key: evt.id,
        title: evt.label,
        subtitle: evt.dateLabel ?? '',
        labels: [evt.autoLabel?.label ?? '', evt.label].filter(Boolean),
        photos,
      };
    })
    .filter((z) => z.photos.length > 0);
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

const MOVE_KEYS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};
const INTERACT_KEYS = new Set(['KeyE', 'Enter']);

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['W', 'A', 'S', 'D'], label: 'Run (or arrow keys)' },
  { keys: ['Q'], label: 'Sprint (hold)' },
  { keys: ['Space'], label: 'Jump' },
  { keys: ['E'], label: 'Look at photo' },
  { keys: ['M'], label: 'Sound on / off' },
  { keys: ['Esc'], label: 'Leave' },
];

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-flex min-w-[1.6rem] h-6 px-1.5 items-center justify-center rounded-md bg-white text-slate-700 text-[11px] font-extrabold ring-1 ring-slate-300 shadow-[0_1.5px_0_rgb(148_163_184)]">
    {children}
  </kbd>
);

const Joystick: React.FC<{ runtime: React.MutableRefObject<WorldRuntime> }> = ({ runtime }) => {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const R = 48;

  const update = (e: React.PointerEvent) => {
    const el = base.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
    const input = runtime.current.input;
    input.x = dx / R;
    input.y = -dy / R;
  };
  const release = () => {
    if (knob.current) knob.current.style.transform = '';
    Object.assign(runtime.current.input, { x: 0, y: 0 });
  };

  return (
    <div
      ref={base}
      className="absolute left-5 bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] w-32 h-32 rounded-full bg-white/35 ring-1 ring-white/60 backdrop-blur-sm touch-none select-none"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); update(e); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) update(e); }}
      onPointerUp={release}
      onPointerCancel={release}
      aria-label="Move Lumi"
      role="application"
    >
      <div ref={knob} className="absolute left-1/2 top-1/2 -ml-8 -mt-8 w-16 h-16 rounded-full bg-white/90 shadow-lg ring-1 ring-slate-200" />
    </div>
  );
};

class WebGLBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/* ------------------------------------------------------------------ */

type Status = { kind: 'loading' } | { kind: 'ready'; source: 'library' | 'session' } | { kind: 'empty' } | { kind: 'error'; message: string };

export const WorldModal: React.FC<{ events: Event[]; onClose: () => void }> = ({ events, onClose }) => {
  const { user } = useAuth();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [layout, setLayout] = useState<WorldLayout | null>(null);
  const [lumiReady, setLumiReady] = useState(false);
  const [near, setNear] = useState<Interactable | null>(null);
  const [zone, setZone] = useState(-1);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const [sprinting, setSprinting] = useState(false);
  const [sprintLatched, setSprintLatched] = useState(false);
  const [muted, setMuted] = useState(readMuted);
  const runtime = useRef<WorldRuntime>(createRuntime());
  const lightboxOpen = useRef(false);
  lightboxOpen.current = lightbox !== null;
  const nearRef = useRef<Interactable | null>(null);
  nearRef.current = near;

  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const lowPower = touch || (navigator.hardwareConcurrency ?? 8) <= 4;

  /* ---- data ---- */
  useEffect(() => {
    let live = true;
    (async () => {
      let sources: ZoneSource[] = [];
      let source: 'library' | 'session' = 'session';
      if (user) {
        try {
          sources = await librarySources();
          source = 'library';
        } catch {
          sources = []; // library not set up: fall back to the session
        }
      }
      if (sources.length === 0) { sources = sessionSources(events); source = 'session'; }
      if (!live) return;
      if (sources.length === 0) { setStatus({ kind: 'empty' }); return; }
      setLayout(buildLayout(sources));
      setStatus({ kind: 'ready', source });
    })().catch((err) => {
      if (live) setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Could not build the island.' });
    });
    return () => { live = false; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPhotos = useMemo(() => layout?.zones.reduce((n, z) => n + z.photos.length, 0) ?? 0, [layout]);

  /* ---- page chrome: no scrolling behind the world ---- */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; document.body.style.cursor = ''; };
  }, []);

  /* ---- sound ---- */
  const audioLoad = useRef<Promise<void> | null>(null);
  useEffect(() => {
    let audio: WorldAudio;
    try { audio = new WorldAudio(); } catch { return undefined; } // no Web Audio: stay silent
    runtime.current.audio = audio;
    audioLoad.current = audio.load();
    // Browsers keep audio asleep until the page is touched or typed on.
    const wake = () => audio.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      runtime.current.audio = null;
      audio.dispose();
    };
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      runtime.current.audio?.setMuted(!m);
      return !m;
    });
  }, []);

  /* ---- looking at things ---- */
  const openZone = useCallback((zoneIndex: number, photoIndex: number, kind: Interactable['kind'] = 'photo') => {
    const zn = layout?.zones[zoneIndex];
    if (!zn) return;
    const rt = runtime.current;
    rt.paused = true;
    Object.assign(rt.input, { x: 0, y: 0, jumpAt: 0 });
    if (kind === 'board') rt.audio?.board();
    else rt.audio?.photo();
    rt.audio?.duck(true);
    setLightbox({ items: zn.photos.map((p) => p.item), index: Math.min(photoIndex, zn.photos.length - 1) });
  }, [layout]);

  const interact = useCallback((target: Interactable) => {
    const rt = runtime.current;
    if (rt.paused || !rt.grounded) return;
    rt.lookAt = { x: target.x, z: target.z };
    rt.gesture += 1;
    if (prefersReducedMotion()) { openZone(target.zone, target.photoIndex, target.kind); return; }
    rt.paused = true; // stand still for the little hop
    const tl = gsap.timeline({ onComplete: () => openZone(target.zone, target.photoIndex, target.kind) });
    tl.to(rt.flourish, { hop: 0.38, duration: 0.2, ease: 'power2.out' })
      .to(rt.flourish, { hop: 0, duration: 0.35, ease: 'bounce.out' });
    if (target.kind === 'board') tl.to(rt.flourish, { spin: Math.PI * 2, duration: 0.55, ease: 'power2.inOut' }, 0).set(rt.flourish, { spin: 0 });
  }, [openZone]);

  const closeLightbox = useCallback(() => {
    setLightbox(null);
    runtime.current.paused = false;
    runtime.current.audio?.duck(false);
  }, []);

  const jump = useCallback(() => {
    if (!runtime.current.paused) runtime.current.input.jumpAt = performance.now();
  }, []);

  const toggleSprint = useCallback(() => {
    setSprintLatched((on) => {
      runtime.current.input.sprint = !on;
      return !on;
    });
  }, []);

  /* ---- keyboard ---- */
  useEffect(() => {
    const held = new Set<string>();
    const sync = () => {
      const input = runtime.current.input;
      input.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      input.y = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0);
    };
    const down = (e: KeyboardEvent) => {
      if (lightboxOpen.current) return; // the Lightbox has its own keys
      if (e.code === 'Escape') { onClose(); return; }
      const dir = MOVE_KEYS[e.code];
      if (dir) { held.add(dir); sync(); e.preventDefault(); return; }
      if (e.code === 'KeyQ') { runtime.current.input.sprint = true; return; }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) jump();
        return;
      }
      if (e.code === 'KeyM' && !e.repeat) { toggleMute(); return; }
      if (INTERACT_KEYS.has(e.code)) {
        e.preventDefault();
        if (!e.repeat && nearRef.current) interact(nearRef.current);
      }
    };
    const up = (e: KeyboardEvent) => {
      const dir = MOVE_KEYS[e.code];
      if (dir) { held.delete(dir); sync(); }
      if (e.code === 'KeyQ') runtime.current.input.sprint = false;
    };
    const blur = () => { held.clear(); sync(); runtime.current.input.sprint = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [interact, onClose, jump, toggleMute]);

  /* ---- HUD motion ---- */
  const bannerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLButtonElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const [loaderGone, setLoaderGone] = useState(false);
  const ready = status.kind === 'ready' && lumiReady;

  useEffect(() => {
    if (!ready) return;
    audioLoad.current?.then(() => runtime.current.audio?.startMusic());
  }, [ready]);

  useEffect(() => {
    if (zone >= 0) runtime.current.audio?.zone();
  }, [zone]);

  useLayoutEffect(() => {
    const el = bannerRef.current;
    if (!el || zone < 0 || prefersReducedMotion()) return;
    const tl = gsap.timeline();
    tl.fromTo(el, { y: -24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.55, ease: 'back.out(1.8)' })
      .to(el, { y: -16, autoAlpha: 0, duration: 0.45, ease: 'power2.in' }, '+=2.6');
    return () => { tl.kill(); };
  }, [zone]);

  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || !near || prefersReducedMotion()) return;
    gsap.fromTo(el, { y: 12, scale: 0.92, autoAlpha: 0 }, { y: 0, scale: 1, autoAlpha: 1, duration: 0.35, ease: 'back.out(2)' });
  }, [near?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = loaderRef.current;
    if (!ready || !el) return;
    if (prefersReducedMotion()) { setLoaderGone(true); return; }
    gsap.to(el, { autoAlpha: 0, duration: 0.6, delay: 0.15, ease: 'power2.out', onComplete: () => setLoaderGone(true) });
  }, [ready]);

  const zoneInfo = zone >= 0 ? layout?.zones[zone] : null;
  const nearZone = near ? layout?.zones[near.zone] : null;

  const unsupported = (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
      <Lumi pose="sad" size={120} />
      <p className="mt-4 font-display text-2xl font-semibold text-slate-900">This browser can’t show 3D</p>
      <p className="text-slate-500 mt-1">Try a recent Chrome, Edge, Safari or Firefox.</p>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[320] overflow-hidden select-none"
      style={{ background: 'linear-gradient(180deg, #a9d8ff 0%, #d7ecfc 45%, #fbe7ef 100%)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Lumi’s island"
    >
      {layout && status.kind === 'ready' && (
        <WebGLBoundary fallback={unsupported}>
          <Canvas
            shadows={lowPower ? false : 'percentage'}
            dpr={[1, lowPower ? 1.5 : 2]}
            frameloop={lightbox ? 'never' : 'always'}
            camera={{ fov: 45, near: 0.1, far: 220, position: [0, 8, 10] }}
            gl={{ antialias: !lowPower, alpha: true, powerPreference: 'high-performance' }}
            aria-label="3D island with your photos. Arrow keys or WASD to run, Q to sprint, Space to jump, E to look at a photo."
          >
            <fog attach="fog" args={['#dcedfb', 30, 64]} />
            <hemisphereLight args={['#eaf5ff', '#8fcf6c', 1.15]} />
            <ambientLight intensity={0.25} />
            <Island layout={layout} shadows={!lowPower} />
            <PhotoFrames layout={layout} runtime={runtime} totalPhotos={totalPhotos} onOpen={openZone} />
            <Suspense fallback={null}>
              <LumiCharacter
                layout={layout}
                runtime={runtime}
                shadows={!lowPower}
                onNearest={setNear}
                onZone={setZone}
                onSprint={setSprinting}
                onReady={() => setLumiReady(true)}
              />
            </Suspense>
          </Canvas>
        </WebGLBoundary>
      )}

      {/* ---------- sprint: anime speed lines round the edges ---------- */}
      <style>{`
        @keyframes world-speedlines { 0% { transform: rotate(0deg) scale(1.02); } 50% { transform: rotate(1.4deg) scale(1.05); } 100% { transform: rotate(-1deg) scale(1.02); } }
        .world-speedlines {
          background: repeating-conic-gradient(from 0deg at 50% 55%, transparent 0deg 3.1deg, rgba(255,255,255,0.75) 3.3deg 3.7deg, transparent 3.9deg 7deg);
          -webkit-mask-image: radial-gradient(ellipse 58% 52% at 50% 55%, transparent 55%, #000 100%);
          mask-image: radial-gradient(ellipse 58% 52% at 50% 55%, transparent 55%, #000 100%);
          animation: world-speedlines 0.16s steps(2) infinite;
        }
        @media (prefers-reduced-motion: reduce) { .world-speedlines { animation: none; } }
      `}</style>
      <div
        className="world-speedlines absolute -inset-[10%] pointer-events-none transition-opacity duration-300"
        style={{ opacity: sprinting && !lightbox ? 0.85 : 0 }}
        aria-hidden="true"
      />

      {/* ---------- top bar ---------- */}
      <div className="absolute top-0 inset-x-0 p-3 sm:p-5 flex items-start justify-between gap-3 pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            onClick={onClose}
            className="h-11 w-11 rounded-full bg-white/85 backdrop-blur ring-1 ring-white shadow-sm flex items-center justify-center text-slate-700 hover:bg-white"
            aria-label="Leave the island"
            title="Back to gallery (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
          {layout && (
            <div className="h-11 px-4 rounded-full bg-white/85 backdrop-blur ring-1 ring-white shadow-sm flex items-center gap-2 text-sm">
              <span className="font-display font-semibold text-slate-900">Lumi’s island</span>
              <span className="text-slate-400 hidden sm:inline">·</span>
              <span className="font-bold text-slate-500 hidden sm:inline">
                {layout.zones.length} {layout.zones.length === 1 ? 'moment' : 'moments'}, {totalPhotos} photos
                {status.kind === 'ready' && status.source === 'session' ? ' from this session' : ''}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={toggleMute}
          className="pointer-events-auto h-11 w-11 rounded-full bg-white/85 backdrop-blur ring-1 ring-white shadow-sm flex items-center justify-center text-slate-700 hover:bg-white"
          aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
          aria-pressed={!muted}
          title={muted ? 'Sound off (M)' : 'Sound on (M)'}
        >
          {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      </div>

      {/* ---------- moment banner ---------- */}
      <div className="absolute top-20 sm:top-6 inset-x-0 flex justify-center pointer-events-none px-4">
        <div ref={bannerRef} className="invisible px-6 py-3 rounded-3xl bg-white/90 backdrop-blur shadow-lg ring-1 ring-white text-center max-w-md">
          {zoneInfo && (
            <>
              <p className="font-display text-xl sm:text-2xl font-semibold text-slate-900 leading-tight">{zoneInfo.title}</p>
              <p className="text-sm font-bold text-slate-500 mt-0.5">
                {[zoneInfo.subtitle, `${zoneInfo.photos.length} ${zoneInfo.photos.length === 1 ? 'photo' : 'photos'}`].filter(Boolean).join(' · ')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* ---------- look prompt ---------- */}
      {near && ready && !lightbox && (
        <div className={`absolute inset-x-0 flex pointer-events-none px-4 ${
          touch ? 'bottom-[calc(10.5rem_+_env(safe-area-inset-bottom))] justify-end' : 'bottom-8 justify-center'
        }`}>
          <button
            ref={promptRef}
            onClick={() => interact(near)}
            className="pointer-events-auto h-12 pl-2 pr-5 rounded-full bg-slate-900/85 text-white backdrop-blur shadow-xl flex items-center gap-3 text-sm font-bold"
          >
            {touch
              ? <span className="h-8 w-8 rounded-full bg-white/15 flex items-center justify-center"><Eye className="w-4 h-4" /></span>
              : <kbd className="inline-flex h-8 min-w-[2rem] px-3 items-center justify-center rounded-full bg-white/15 text-xs font-extrabold tracking-wide">E</kbd>}
            {near.kind === 'board'
              ? `See all ${nearZone?.photos.length ?? ''} photos`
              : 'Look at this photo'}
          </button>
        </div>
      )}

      {/* ---------- controls ---------- */}
      {ready && touch && !lightbox && (
        <>
          <Joystick runtime={runtime} />
          <div className="absolute right-5 bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] flex items-end gap-3 select-none">
            <button
              onClick={toggleSprint}
              className={`h-16 w-16 rounded-full backdrop-blur shadow-lg ring-1 flex flex-col items-center justify-center text-[10px] font-extrabold uppercase tracking-wide transition-colors ${
                sprintLatched ? 'bg-amber-300 text-amber-950 ring-amber-200' : 'bg-white/70 text-slate-700 ring-white'
              }`}
              aria-pressed={sprintLatched}
              aria-label="Sprint"
            >
              <Zap className="w-6 h-6" /> Sprint
            </button>
            <button
              onPointerDown={(e) => { e.preventDefault(); jump(); }}
              className="h-20 w-20 rounded-full bg-white/85 backdrop-blur shadow-lg ring-1 ring-white flex flex-col items-center justify-center text-[11px] font-extrabold uppercase tracking-wide text-slate-700 active:scale-95 transition-transform touch-none"
              aria-label="Jump"
            >
              <ChevronsUp className="w-7 h-7" /> Jump
            </button>
          </div>
        </>
      )}
      {ready && !touch && (
        <div
          className="absolute left-5 bottom-6 px-3.5 py-3 rounded-2xl bg-white/80 backdrop-blur ring-1 ring-white shadow-sm text-[13px] text-slate-600 pointer-events-none"
          aria-label="Keyboard shortcuts"
        >
          <ul className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1.5 items-center">
            {SHORTCUTS.map((row) => (
              <li key={row.label} className="contents">
                <span className="flex gap-1">{row.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                <span className="font-semibold">{row.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------- loading / empty / error ---------- */}
      {!loaderGone && (
        <div
          ref={loaderRef}
          className="absolute inset-0 flex flex-col items-center justify-center text-center p-6"
          style={{ background: 'linear-gradient(180deg, #a9d8ff 0%, #d7ecfc 45%, #fbe7ef 100%)' }}
        >
          {status.kind === 'empty' ? (
            <>
              <Lumi pose="search" size={130} />
              <p className="mt-4 font-display text-2xl font-semibold text-slate-900">No photos to build with yet</p>
              <p className="text-slate-500 mt-1">Analyse some photos first, and Lumi will give each moment a spot on the island.</p>
              <button onClick={onClose} className="btn-jelly btn-jelly-sm !h-10 mt-5">Back to gallery</button>
            </>
          ) : status.kind === 'error' ? (
            <>
              <Lumi pose="sad" size={130} />
              <p className="mt-4 font-display text-2xl font-semibold text-slate-900">The island didn’t load</p>
              <p className="text-slate-500 mt-1">{status.message}</p>
              <button onClick={onClose} className="btn-jelly btn-jelly-sm !h-10 mt-5">Back to gallery</button>
            </>
          ) : (
            <>
              <Lumi pose="travel" size={140} />
              <p className="mt-4 font-display text-2xl font-semibold text-slate-900">Building Lumi’s island…</p>
              <p className="text-slate-500 mt-1 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {status.kind === 'ready' ? 'Waking Lumi up' : 'Gathering your moments'}
              </p>
            </>
          )}
        </div>
      )}

      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          onNavigate={(index) => setLightbox((prev) => (prev ? { ...prev, index } : prev))}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
};

export default WorldModal;
