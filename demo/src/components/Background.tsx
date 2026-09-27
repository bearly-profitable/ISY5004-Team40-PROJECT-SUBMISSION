import React from 'react';
import { AbsoluteFill, random, useCurrentFrame } from 'remotion';
import { FPS, HEIGHT, lerp, WIDTH } from '../lib/time';

const BLOBS = [
  { c: '157, 136, 212', x: 0.18, y: 0.22, r: 0.62, sx: 0.07, sy: 0.05, p: 0 },
  { c: '227, 140, 158', x: 0.82, y: 0.28, r: 0.55, sx: 0.06, sy: 0.07, p: 1.7 },
  { c: '243, 173, 127', x: 0.7, y: 0.9, r: 0.6, sx: 0.08, sy: 0.04, p: 3.1 },
  { c: '190, 170, 240', x: 0.2, y: 0.95, r: 0.5, sx: 0.05, sy: 0.06, p: 4.4 },
];

/**
 * Lumina's pastel world: drifting lavender / rose / peach light, soft bokeh that
 * drifts slowly, and film grain. `dark` (0..1) fades to a night plum.
 */
export const Background: React.FC<{ dark?: number }> = ({ dark = 0 }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;

  const blobs = BLOBS.map((b, i) => {
    const x = (b.x + Math.sin(t * 0.35 + b.p) * b.sx) * WIDTH;
    const y = (b.y + Math.cos(t * 0.28 + b.p) * b.sy) * HEIGHT;
    const r = b.r * WIDTH;
    const a = lerp(dark, [0, 1], [0.55, 0.42]);
    return `radial-gradient(circle ${r}px at ${x}px ${y}px, rgba(${b.c}, ${a}) 0%, rgba(${b.c}, 0) 70%)`;
  });

  const base = dark > 0 ? `rgb(${lerp(dark, [0, 1], [251, 22])}, ${lerp(dark, [0, 1], [244, 16])}, ${lerp(dark, [0, 1], [248, 38])})` : '#fbf4f8';

  return (
    <AbsoluteFill style={{ background: base }}>
      <AbsoluteFill style={{ backgroundImage: blobs.join(',') }} />
      {/* Bokeh */}
      {new Array(16).fill(0).map((_, i) => {
        const size = 30 + random(`s${i}`) * 110;
        const speed = 12 + random(`v${i}`) * 26;
        const x = random(`x${i}`) * WIDTH + Math.sin(t * 0.5 + i) * 30;
        const y = HEIGHT + 150 - ((t * speed + random(`y${i}`) * (HEIGHT + 300)) % (HEIGHT + 300));
        const o = (0.18 + random(`o${i}`) * 0.25);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: size,
              height: size,
              borderRadius: '50%',
              background: `radial-gradient(circle, rgba(255,255,255,${o}) 0%, rgba(255,255,255,${o * 0.4}) 45%, rgba(255,255,255,0) 70%)`,
              transform: `translate(-50%, -50%)`,
            }}
          />
        );
      })}
      <Grain />
    </AbsoluteFill>
  );
};

/** Animated film grain (an SVG noise tile jittered every frame). */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.07 }) => {
  const frame = useCurrentFrame();
  const dx = Math.floor(random(`gx${frame % 12}`) * 200);
  const dy = Math.floor(random(`gy${frame % 12}`) * 200);
  return (
    <AbsoluteFill style={{ opacity, mixBlendMode: 'overlay', pointerEvents: 'none', overflow: 'hidden' }}>
      <svg width={WIDTH + 200} height={HEIGHT + 200} style={{ position: 'absolute', left: -dx, top: -dy }}>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};
