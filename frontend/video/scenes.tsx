import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Cameo, MoviePhoto, ShotLayout } from './storyboard';
import { rng } from './storyboard';
import { LumiActor, Sparkle } from './LumiActor';
import type { LumiPose } from '../components/Lumi';

/* ------------------------------------------------
   Shared bits
   ------------------------------------------------ */

export const DISPLAY_FONT = "'Fraunces', Georgia, serif";
export const BODY_FONT = "'Nunito', 'Segoe UI', system-ui, sans-serif";

/** Pastel pairs, one per chapter, drawn from Lumina's palette. */
const PALETTES: Array<[string, string, string]> = [
  ['#fde2f3', '#e0e7ff', '#a855f7'],
  ['#fef3c7', '#fce7f3', '#ea580c'],
  ['#dcfce7', '#e0f2fe', '#0d9488'],
  ['#e0e7ff', '#fae8ff', '#7c3aed'],
  ['#ffedd5', '#fef9c3', '#d97706'],
  ['#cffafe', '#ede9fe', '#2563eb'],
];
export const palette = (i: number) => PALETTES[((i % PALETTES.length) + PALETTES.length) % PALETTES.length];

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** Scale unit: 1 at 1080 px on the short side. */
function useUnit() {
  const { width, height } = useVideoConfig();
  return Math.min(width, height) / 1080;
}

/** Slowly turning pastel gradient with soft floating orbs. */
const Backdrop: React.FC<{ colors: [string, string, string]; seed?: number }> = ({ colors, seed = 0 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const angle = 135 + Math.sin(frame / 90 + seed) * 25;
  const random = rng(seed + 11);
  const orbs = Array.from({ length: 4 }, () => ({ x: random(), y: random(), r: 0.18 + random() * 0.2, sp: 0.5 + random() }));
  return (
    <AbsoluteFill style={{ background: `linear-gradient(${angle}deg, ${colors[0]} 0%, ${colors[1]} 100%)` }}>
      {orbs.map((o, i) => {
        const r = o.r * Math.max(width, height);
        const dx = Math.sin(frame / (70 * o.sp) + i) * width * 0.03;
        const dy = Math.cos(frame / (80 * o.sp) + i * 2) * height * 0.04;
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: o.x * width - r / 2, top: o.y * height - r / 2, width: r, height: r, borderRadius: '50%',
              backgroundColor: i % 2 ? 'rgba(255,255,255,0.55)' : `${colors[2]}22`, filter: `blur(${r * 0.18}px)`,
              transform: `translate(${dx}px, ${dy}px)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/**
 * A photo cropped to fill a box, keeping the faces in frame, with a slow Ken
 * Burns zoom and pan. The zoom pivots on a point inside the image, which
 * keeps the box covered at every frame (no object-position needed).
 */
export const PhotoFrame: React.FC<{
  photo: MoviePhoto;
  width: number;
  height: number;
  /** 0..1 through the shot. */
  t: number;
  seed?: number;
  zoom?: [number, number];
  style?: React.CSSProperties;
  radius?: number;
}> = ({ photo, width, height, t, seed = 0, zoom, style, radius = 0 }) => {
  const base = Math.max(width / photo.width, height / photo.height);
  const dw = photo.width * base;
  const dh = photo.height * base;
  const [fx, fy] = photo.focal ?? [0.5, 0.42];
  const left = Math.min(0, Math.max(width - dw, width / 2 - fx * dw));
  const top = Math.min(0, Math.max(height - dh, height / 2 - fy * dh));
  const random = rng(seed * 97 + 5);
  const zoomIn = random() < 0.65;
  const [z0, z1] = zoom ?? (zoomIn ? [1.02, 1.14] : [1.14, 1.02]);
  const ease = Easing.inOut(Easing.sin)(Math.max(0, Math.min(1, t)));
  const z = z0 + (z1 - z0) * ease;
  // Pan the pivot from beside the faces towards them.
  const ox = fx * dw + (1 - ease) * (random() - 0.5) * dw * 0.25;
  const oy = fy * dh + (1 - ease) * (random() - 0.5) * dh * 0.2;
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden', borderRadius: radius, ...style }}>
      <Img
        src={photo.src}
        style={{
          position: 'absolute', left, top, width: dw, height: dh,
          transformOrigin: `${Math.max(0, Math.min(dw, ox))}px ${Math.max(0, Math.min(dh, oy))}px`,
          transform: `scale(${z})`,
        }}
      />
    </div>
  );
};

/** A photo scaled to fit a box, keeping its whole frame. */
const fitBox = (photo: MoviePhoto, maxW: number, maxH: number) => {
  const k = Math.min(maxW / photo.width, maxH / photo.height);
  return { w: photo.width * k, h: photo.height * k };
};

/** Letters rise into place one after another. */
const RiseText: React.FC<{ text: string; delay?: number; stagger?: number; style?: React.CSSProperties }> = ({ text, delay = 0, stagger = 1.2, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  let n = 0;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', ...style }}>
      {words.map((word, wi) => (
        <span key={wi} style={{ display: 'flex', marginRight: wi < words.length - 1 ? '0.28em' : 0 }}>
          {[...word].map((ch) => {
            const s = spring({ frame: frame - delay - n++ * stagger, fps, config: { damping: 14, stiffness: 160 } });
            return (
              <span key={n} style={{ display: 'inline-block', transform: `translateY(${(1 - s) * 0.7}em) rotate(${(1 - s) * 8}deg)`, opacity: Math.min(1, s * 1.5) }}>
                {ch}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
};

/** A white-bordered print with a caption strip. */
const Polaroid: React.FC<{ photo: MoviePhoto; width: number; t: number; caption?: string; seed?: number }> = ({ photo, width, t, caption, seed = 0 }) => {
  const pad = width * 0.05;
  const inner = width - pad * 2;
  return (
    <div style={{ width, padding: pad, paddingBottom: caption ? pad * 3.6 : pad * 2.4, backgroundColor: '#fffdf8', borderRadius: width * 0.012, boxShadow: `0 ${width * 0.04}px ${width * 0.1}px rgba(40,20,60,0.28)` }}>
      <PhotoFrame photo={photo} width={inner} height={inner} t={t} seed={seed} zoom={[1.04, 1.1]} />
      {caption && (
        <div style={{ fontFamily: DISPLAY_FONT, fontStyle: 'italic', fontWeight: 500, fontSize: width * 0.07, color: '#475569', textAlign: 'center', marginTop: pad * 0.9 }}>
          {caption}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------
   Intro
   ------------------------------------------------ */

export const IntroScene: React.FC<{ title: string; subtitle: string; photos: MoviePhoto[]; beat: number }> = ({ title, subtitle, photos, beat }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = useUnit();
  const vertical = height > width;
  const cards = photos.slice(0, 4);
  const spots = vertical
    ? [[0.02, 0.06, -9], [0.62, 0.04, 8], [0.0, 0.74, 7], [0.64, 0.76, -6]]
    : [[0.03, 0.08, -10], [0.78, 0.06, 9], [0.02, 0.62, 6], [0.8, 0.6, -7]];
  const titleSize = Math.min(150 * u, (width * 0.85) / Math.max(6, title.length * 0.55));
  const sub = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <Backdrop colors={palette(0)} seed={1} />
      {cards.map((p, i) => {
        const [x, y, r] = spots[i];
        const s = spring({ frame: frame - 4 - i * 4, fps, config: { damping: 15 } });
        const drift = Math.sin(frame / 50 + i) * 8 * u;
        const w = (vertical ? 330 : 360) * u;
        return (
          <div key={p.id} style={{ position: 'absolute', left: x * width, top: y * height, opacity: s * 0.92, transform: `translate(${(1 - s) * (x < 0.5 ? -200 : 200) * u}px, ${drift}px) rotate(${r + (1 - s) * r}deg)` }}>
            <Polaroid photo={p} width={w} t={frame / 150} seed={i} />
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 60 * u }}>
        <LumiActor pose={[{ pose: 'wave', at: 0 }, { pose: 'camera', at: Math.round(fps * 2.4) }]} size={300 * u} delay={2} beat={beat * 2} />
        <div style={{ position: 'relative', marginTop: 26 * u, fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: titleSize, lineHeight: 1.05, color: '#1e1b4b', textAlign: 'center', maxWidth: width * 0.8 }}>
          <RiseText text={title} delay={12} />
          <Sparkle size={56 * u} delay={30} style={{ left: -60 * u, top: -20 * u }} color="#f0abfc" />
          <Sparkle size={42 * u} delay={40} style={{ right: -50 * u, bottom: 0 }} color="#fcd34d" />
        </div>
        {subtitle && (
          <div style={{ marginTop: 18 * u, fontFamily: BODY_FONT, fontWeight: 700, fontSize: 40 * u, color: '#6b21a8', opacity: sub, transform: `translateY(${(1 - sub) * 20}px)`, letterSpacing: 1 }}>
            {subtitle}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------
   Chapter card
   ------------------------------------------------ */

export const ChapterScene: React.FC<{
  index: number; total: number; title: string; dateLabel?: string | null; pose: LumiPose; photos: MoviePhoto[]; beat: number;
}> = ({ index, total, title, dateLabel, pose, photos, beat }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = useUnit();
  const vertical = height > width;
  const colors = palette(index);
  const label = spring({ frame: frame - 6, fps, config: { damping: 200 } });
  const numberShift = interpolate(frame, [0, 90], [60, -30]) * u;
  const titleSize = Math.min(118 * u, (vertical ? width * 0.9 : width * 0.5) / Math.max(5, title.length * 0.5));
  return (
    <AbsoluteFill>
      <Backdrop colors={colors} seed={index * 7 + 3} />
      <div style={{ position: 'absolute', right: vertical ? -40 * u : 40 * u, top: vertical ? height * 0.02 : -120 * u, fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 620 * u, lineHeight: 1, color: colors[2], opacity: 0.1, transform: `translateX(${numberShift}px)` }}>
        {String(index + 1).padStart(2, '0')}
      </div>
      <AbsoluteFill style={{ flexDirection: vertical ? 'column' : 'row', alignItems: 'center', justifyContent: 'center', gap: 60 * u, padding: 80 * u }}>
        <LumiActor pose={pose} size={(vertical ? 560 : 520) * u} delay={0} beat={beat} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: vertical ? 'center' : 'flex-start', maxWidth: vertical ? width * 0.9 : width * 0.5 }}>
          <div style={{ fontFamily: BODY_FONT, fontWeight: 800, fontSize: 30 * u, letterSpacing: 6 * u, textTransform: 'uppercase', color: colors[2], opacity: label, transform: `translateX(${(1 - label) * -30}px)` }}>
            Chapter {index + 1} of {total}
          </div>
          <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: titleSize, lineHeight: 1.05, color: '#1e1b4b', marginTop: 10 * u }}>
            <RiseText text={title} delay={8} stagger={1} style={{ justifyContent: vertical ? 'center' : 'flex-start' }} />
          </div>
          {dateLabel && (
            <div style={{ marginTop: 18 * u, padding: `${8 * u}px ${22 * u}px`, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.75)', fontFamily: BODY_FONT, fontWeight: 700, fontSize: 30 * u, color: '#475569', opacity: label }}>
              {dateLabel}
            </div>
          )}
          <div style={{ display: 'flex', gap: 16 * u, marginTop: 34 * u }}>
            {photos.map((p, i) => {
              const s = spring({ frame: frame - 18 - i * 4, fps, config: { damping: 12, stiffness: 150 } });
              return (
                <div key={p.id} style={{ transform: `scale(${s}) rotate(${(i - 1) * 4}deg)`, boxShadow: '0 10px 24px rgba(0,0,0,0.18)', borderRadius: 20 * u, border: `${5 * u}px solid #fff` }}>
                  <PhotoFrame photo={p} width={150 * u} height={150 * u} t={frame / 90} seed={i} radius={15 * u} />
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
      {/* Chapter progress */}
      <div style={{ position: 'absolute', left: '50%', bottom: 50 * u, transform: 'translateX(-50%)', display: 'flex', gap: 10 * u }}>
        {Array.from({ length: Math.min(total, 12) }, (_, i) => (
          <div key={i} style={{ width: (i === index ? 42 : 12) * u, height: 12 * u, borderRadius: 999, backgroundColor: i === index ? colors[2] : 'rgba(30,27,75,0.18)' }} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------
   Photo shots
   ------------------------------------------------ */

/** Lumi pops up from the bottom corner with something to say. */
const CameoOverlay: React.FC<{ cameo: Cameo; frames: number; beat: number }> = ({ cameo, frames, beat }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const u = useUnit();
  const size = 330 * u;
  const bubble = spring({ frame: frame - 16, fps, config: { damping: 11, stiffness: 170 } });
  const bubbleOut = interpolate(frame, [frames - 22, frames - 14], [1, 0], clamp);
  const side = cameo.side === 'left' ? { left: 40 * u } : { right: 40 * u };
  return (
    <div style={{ position: 'absolute', bottom: 0, ...side, display: 'flex', flexDirection: cameo.side === 'left' ? 'row' : 'row-reverse', alignItems: 'flex-start' }}>
      <LumiActor pose={cameo.pose} size={size} delay={4} enter="peek" exitAt={Math.max(20, frames - 16)} beat={beat} flip={cameo.side === 'right'} shadow={false} />
      {cameo.say && (
        <div
          style={{
            marginTop: 10 * u, padding: `${14 * u}px ${26 * u}px`, borderRadius: 32 * u, backgroundColor: '#fff',
            fontFamily: BODY_FONT, fontWeight: 900, fontSize: 38 * u, color: '#6b21a8', whiteSpace: 'nowrap',
            boxShadow: '0 12px 30px rgba(0,0,0,0.2)', transform: `scale(${bubble * bubbleOut})`,
            transformOrigin: cameo.side === 'left' ? '0% 100%' : '100% 100%', maxWidth: width * 0.4,
          }}
        >
          {cameo.say}
        </div>
      )}
    </div>
  );
};

/** Soft darkening at the edges (linear gradients; radial ones do not export). */
const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.35 }) => (
  <>
    <AbsoluteFill style={{ background: `linear-gradient(180deg, rgba(0,0,0,${strength * 0.6}) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 70%, rgba(0,0,0,${strength}) 100%)` }} />
    <AbsoluteFill style={{ background: `linear-gradient(90deg, rgba(0,0,0,${strength * 0.5}) 0%, rgba(0,0,0,0) 15%, rgba(0,0,0,0) 85%, rgba(0,0,0,${strength * 0.5}) 100%)` }} />
  </>
);

/** Blurred, dimmed copy of a photo filling the frame behind framed shots. */
const BlurFill: React.FC<{ photo: MoviePhoto; t: number }> = ({ photo, t }) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: '#0f0a1e', overflow: 'hidden' }}>
      <div style={{ filter: 'blur(48px) brightness(0.62) saturate(1.3)', transform: `scale(${1.25 + 0.05 * t})` }}>
        <PhotoFrame photo={photo} width={width} height={height} t={0} zoom={[1, 1]} />
      </div>
    </AbsoluteFill>
  );
};

export const ShotScene: React.FC<{
  layout: ShotLayout; photos: MoviePhoto[]; chapterTitle: string; cameo: Cameo | null; seed: number; frames: number; beat: number; chapterIndex: number;
}> = ({ layout, photos, chapterTitle, cameo, seed, frames, beat, chapterIndex }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = useUnit();
  const vertical = height > width;
  const t = frame / frames;
  const random = rng(seed * 31 + 7);
  let body: React.ReactNode = null;

  if (layout === 'single') {
    body = (
      <>
        <PhotoFrame photo={photos[0]} width={width} height={height} t={t} seed={seed} />
        <Vignette />
      </>
    );
  } else if (layout === 'framed') {
    const box = fitBox(photos[0], width * 0.86, height * 0.84);
    const s = spring({ frame, fps, config: { damping: 18 } });
    body = (
      <>
        <BlurFill photo={photos[0]} t={t} />
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ transform: `scale(${0.94 + 0.06 * s}) rotate(${(random() - 0.5) * 3}deg)`, boxShadow: `0 ${30 * u}px ${80 * u}px rgba(0,0,0,0.45)`, borderRadius: 22 * u, border: `${8 * u}px solid rgba(255,255,255,0.92)` }}>
            <PhotoFrame photo={photos[0]} width={box.w} height={box.h} t={t} seed={seed} zoom={[1, 1.06]} radius={14 * u} />
          </div>
        </AbsoluteFill>
      </>
    );
  } else if (layout === 'polaroid') {
    const w = Math.min(width * 0.62, height * 0.62);
    const drop = spring({ frame: frame - 2, fps, config: { damping: 13, stiffness: 110 } });
    const rot = (random() < 0.5 ? -1 : 1) * (3 + random() * 3);
    body = (
      <>
        <Backdrop colors={palette(chapterIndex)} seed={seed} />
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', width: w * 0.95, height: w * 1.15, backgroundColor: '#fff', opacity: 0.55, transform: `rotate(${-rot * 1.8}deg)`, borderRadius: 8 * u }} />
          <div style={{ transform: `translateY(${(1 - drop) * -height}px) rotate(${rot + (1 - drop) * 25}deg)` }}>
            <Polaroid photo={photos[0]} width={w} t={t} caption={chapterTitle} seed={seed} />
          </div>
        </AbsoluteFill>
      </>
    );
  } else {
    // Multi-photo layouts: tiles slide or pop in, one after another.
    const gap = 18 * u;
    const pad = 36 * u;
    const W = width - pad * 2;
    const H = height - pad * 2;
    type Tile = { x: number; y: number; w: number; h: number };
    let tiles: Tile[] = [];
    if (layout === 'pair') {
      tiles = vertical
        ? [{ x: 0, y: 0, w: W, h: (H - gap) / 2 }, { x: 0, y: (H + gap) / 2, w: W, h: (H - gap) / 2 }]
        : [{ x: 0, y: 0, w: (W - gap) / 2, h: H }, { x: (W + gap) / 2, y: 0, w: (W - gap) / 2, h: H }];
    } else if (layout === 'trio') {
      if (vertical) {
        const top = H * 0.58;
        tiles = [
          { x: 0, y: 0, w: W, h: top },
          { x: 0, y: top + gap, w: (W - gap) / 2, h: H - top - gap },
          { x: (W + gap) / 2, y: top + gap, w: (W - gap) / 2, h: H - top - gap },
        ];
      } else {
        const big = W * 0.6;
        tiles = [
          { x: 0, y: 0, w: big, h: H },
          { x: big + gap, y: 0, w: W - big - gap, h: (H - gap) / 2 },
          { x: big + gap, y: (H + gap) / 2, w: W - big - gap, h: (H - gap) / 2 },
        ];
      }
    } else {
      const n = photos.length;
      const cols = vertical ? 2 : n > 4 ? 3 : 2;
      const rows = Math.ceil(n / cols);
      const tw = (W - gap * (cols - 1)) / cols;
      const th = (H - gap * (rows - 1)) / rows;
      tiles = photos.map((_, i) => ({ x: (i % cols) * (tw + gap), y: Math.floor(i / cols) * (th + gap), w: tw, h: th }));
    }
    const order = photos.map((_, i) => i).sort(() => random() - 0.5);
    body = (
      <>
        <BlurFill photo={photos[0]} t={t} />
        <div style={{ position: 'absolute', left: pad, top: pad, width: W, height: H, transform: `scale(${1 + 0.03 * t})` }}>
          {tiles.map((tile, i) => {
            const s = spring({ frame: frame - order.indexOf(i) * 4, fps, config: { damping: 15, stiffness: 120 } });
            const from = layout === 'mosaic'
              ? `scale(${0.6 + 0.4 * s})`
              : vertical
                ? `translateX(${(1 - s) * (i % 2 ? 1 : -1) * width}px)`
                : `translateY(${(1 - s) * (i % 2 ? 1 : -1) * height}px)`;
            return (
              <div key={photos[i].id} style={{ position: 'absolute', left: tile.x, top: tile.y, opacity: Math.min(1, s * 2), transform: from, boxShadow: `0 ${16 * u}px ${40 * u}px rgba(0,0,0,0.35)`, borderRadius: 20 * u }}>
                <PhotoFrame photo={photos[i]} width={tile.w} height={tile.h} t={t} seed={seed + i} radius={20 * u} />
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: '#0f0a1e', overflow: 'hidden' }}>
      {body}
      {cameo && <CameoOverlay cameo={cameo} frames={frames} beat={beat} />}
    </AbsoluteFill>
  );
};

/* ------------------------------------------------
   Outro
   ------------------------------------------------ */

const CONFETTI = ['#f472b6', '#a78bfa', '#fbbf24', '#34d399', '#60a5fa', '#fb7185'];

export const OutroScene: React.FC<{ photos: MoviePhoto[]; beat: number; frames: number }> = ({ photos, beat, frames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const u = useUnit();
  const vertical = height > width;
  const random = rng(4242);
  const pieces = Array.from({ length: 46 }, () => ({
    x: random(), speed: 0.6 + random() * 0.8, delay: random() * 40, rot: random() * 360, spin: (random() - 0.5) * 16,
    color: CONFETTI[Math.floor(random() * CONFETTI.length)], w: 10 + random() * 14, sway: random() * 6,
  }));
  const text = spring({ frame: frame - 18, fps, config: { damping: 200 } });
  const fadeOut = interpolate(frame, [frames - 24, frames], [0, 1], clamp);
  const fanW = (vertical ? 300 : 280) * u;
  return (
    <AbsoluteFill>
      <Backdrop colors={['#ede9fe', '#fce7f3', '#a855f7']} seed={99} />
      {/* A fan of prints behind Lumi */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: vertical ? 'flex-start' : 'center', paddingTop: vertical ? height * 0.12 : 0 }}>
        {photos.map((p, i) => {
          const k = photos.length > 1 ? i / (photos.length - 1) - 0.5 : 0;
          const s = spring({ frame: frame - i * 3, fps, config: { damping: 14 } });
          const spread = (vertical ? width * 0.62 : width * 0.62) * k;
          return (
            <div key={p.id} style={{ position: 'absolute', transform: `translate(${spread * s}px, ${Math.abs(k) * 140 * u * s - (vertical ? 0 : 150 * u)}px) rotate(${k * 34 * s}deg)`, opacity: s }}>
              <Polaroid photo={p} width={fanW} t={frame / frames} seed={i} />
            </div>
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: (vertical ? 260 : 90) * u }}>
        <LumiActor pose={[{ pose: 'celebrate', at: 0 }, { pose: 'wave', at: Math.round(frames * 0.55) }]} size={340 * u} delay={6} beat={beat} />
        <div style={{ fontFamily: DISPLAY_FONT, fontWeight: 800, fontSize: 84 * u, color: '#1e1b4b', marginTop: 16 * u, opacity: text, transform: `translateY(${(1 - text) * 30}px)` }}>
          Until next time
        </div>
        <div style={{ fontFamily: BODY_FONT, fontWeight: 800, fontSize: 30 * u, color: '#7c3aed', letterSpacing: 4 * u, textTransform: 'uppercase', opacity: text, marginTop: 8 * u }}>
          Made with Lumina
        </div>
      </AbsoluteFill>
      {pieces.map((c, i) => {
        const f = frame - c.delay;
        if (f < 0) return null;
        const y = -60 + f * c.speed * 9 * u;
        if (y > height + 40) return null;
        return (
          <div key={i} style={{ position: 'absolute', left: c.x * width + Math.sin(f / 10 + i) * c.sway * 6 * u, top: y, width: c.w * u, height: c.w * 0.45 * u, backgroundColor: c.color, borderRadius: 3, transform: `rotate(${c.rot + f * c.spin}deg)` }} />
        );
      })}
      <AbsoluteFill style={{ backgroundColor: '#fff', opacity: fadeOut }} />
    </AbsoluteFill>
  );
};
