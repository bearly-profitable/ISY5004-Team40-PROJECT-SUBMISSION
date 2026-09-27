import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { useT } from '../lib/clock';
import { text as textFont } from '../lib/fonts';
import { COLORS, ease, lerp } from '../lib/time';
import { CamKey, Footage, Seg } from './Footage';
import { Headline } from './Type';
import { ClipName } from '../lib/clips';

type Layout = 'split' | 'full' | 'top' | 'bleed';

/** Pose, scale and position of the 1600x900 window for each layout. */
const WINDOW: Record<Layout, { x: number; y: number; s: number; ry: number; rx: number }> = {
  split: { x: 330, y: 20, s: 0.76, ry: -13, rx: 3 },
  full: { x: 0, y: 0, s: 1.0, ry: 0, rx: 0 },
  top: { x: 0, y: 95, s: 0.8, ry: 0, rx: 6 },
  bleed: { x: 0, y: 0, s: 1.2, ry: 0, rx: 0 },
};

export type AppShotProps = {
  clip: ClipName;
  segs: Seg[];
  cam?: CamKey[];
  layout?: Layout;
  /** Headline; *word* = gradient. '/' = line break. */
  title?: string;
  kicker?: string;
  body?: string;
  pose?: string;
  titleAt?: number;
  titleOut?: number;
  /** Morph from one layout's window pose to another's over [from, to] s. */
  morph?: { to: Layout; from: number; until: number };
  overlay?: React.ReactNode;
  /** Extra content under the split-layout headline. */
  aside?: React.ReactNode;
  children?: React.ReactNode;
};

/** A feature shot: real footage in a 3D window plus its kinetic caption. */
export const AppShot: React.FC<AppShotProps> = ({
  clip,
  segs,
  cam,
  layout = 'split',
  title,
  kicker,
  body,
  pose,
  titleAt = 0.15,
  titleOut,
  morph,
  overlay,
  aside,
  children,
}) => {
  const t = useT();
  const a = WINDOW[layout];
  const m = morph ? lerp(t, [morph.from, morph.until], [0, 1], ease.inOut) : 0;
  const b = morph ? WINDOW[morph.to] : a;
  const w = {
    x: a.x + (b.x - a.x) * m,
    y: a.y + (b.y - a.y) * m,
    s: a.s + (b.s - a.s) * m,
    ry: a.ry + (b.ry - a.ry) * m,
    rx: a.rx + (b.rx - a.rx) * m,
  };
  // Slow handheld drift so nothing is ever perfectly still.
  const still = layout === 'bleed' || morph?.to === 'bleed' ? 1 - m * 0.9 : 1;
  const driftX = Math.sin(t * 0.7) * 1.4 * still;
  const driftY = Math.cos(t * 0.55) * 1.1 * still;
  const textIn = layout === 'full' ? 0 : 1;

  return (
    <AbsoluteFill style={{ perspective: 2000 }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            transform: `translate(${w.x}px, ${w.y}px) scale(${w.s}) rotateY(${w.ry + driftX}deg) rotateX(${w.rx + driftY}deg)`,
            transformStyle: 'preserve-3d',
            position: 'relative',
          }}
        >
          <Footage clip={clip} segs={segs} cam={cam} radius={layout === 'bleed' ? 0 : morph?.to === 'bleed' ? 24 * (1 - m) : layout === 'full' ? 18 : 24}>
            {children}
          </Footage>
          {overlay}
        </div>
      </AbsoluteFill>

      {title && layout === 'split' && (
        <div style={{ position: 'absolute', left: 96, top: 0, bottom: 0, width: 560, display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: textIn * (1 - m) }}>
          {kicker && <Kicker text={kicker} at={titleAt - 0.05} out={titleOut} />}
          <Headline text={title} at={titleAt} out={titleOut} size={82} stagger={0.075} />
          {body && <Headline text={body} at={titleAt + 0.35} out={titleOut} size={30} font="text" weight={700} color="rgba(28,21,48,.62)" stagger={0.025} lineHeight={1.35} style={{ marginTop: 22 }} />}
          {aside}
          {pose && <Pose src={pose} at={titleAt + 0.2} out={titleOut} />}
        </div>
      )}

      {title && layout === 'top' && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 30, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {kicker && <Kicker text={kicker} at={titleAt - 0.05} out={titleOut} />}
          <Headline text={title} at={titleAt} out={titleOut} size={76} align="center" stagger={0.07} />
        </div>
      )}

      {title && layout === 'full' && <CaptionPill text={title} kicker={kicker} at={titleAt} out={titleOut} />}
    </AbsoluteFill>
  );
};

export const Kicker: React.FC<{ text: string; at: number; out?: number }> = ({ text, at, out }) => {
  const t = useT();
  const k = lerp(t, [at, at + 0.4], [0, 1], ease.out);
  const o = out !== undefined ? lerp(t, [out, out + 0.25], [0, 1], ease.in) : 0;
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 22,
        padding: '8px 18px 8px 14px',
        borderRadius: 999,
        background: 'rgba(255,255,255,.8)',
        boxShadow: '0 0 0 1px rgba(157,136,212,.35)',
        fontFamily: textFont,
        fontWeight: 900,
        fontSize: 20,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: COLORS.accent,
        opacity: k * (1 - o),
        transform: `translateX(${(1 - k) * -30}px)`,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 99, background: COLORS.gradient }} />
      {text}
    </div>
  );
};

const Pose: React.FC<{ src: string; at: number; out?: number }> = ({ src, at, out }) => {
  const t = useT();
  const k = lerp(t, [at, at + 0.6], [0, 1], ease.snappy);
  const o = out !== undefined ? lerp(t, [out, out + 0.3], [0, 1], ease.in) : 0;
  return (
    <Img
      src={staticFile(`lumi/${src}.webp`)}
      style={{
        height: 230,
        alignSelf: 'flex-start',
        marginTop: 26,
        opacity: k * (1 - o),
        transform: `translateY(${(1 - k) * 80 + Math.sin(t * 3) * 5}px) rotate(${(1 - k) * -12 + Math.sin(t * 2.2) * 2}deg) scale(${0.7 + 0.3 * k})`,
        filter: 'drop-shadow(0 24px 30px rgba(60, 30, 100, .3))',
      }}
    />
  );
};

/** Dark caption pill for full-frame shots, bottom centre. */
export const CaptionPill: React.FC<{ text: string; kicker?: string; at: number; out?: number }> = ({ text, kicker, at, out }) => {
  const t = useT();
  const k = lerp(t, [at, at + 0.45], [0, 1], ease.snappy);
  const o = out !== undefined ? lerp(t, [out, out + 0.25], [0, 1], ease.in) : 0;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '20px 38px',
          borderRadius: 999,
          background: 'rgba(24, 18, 42, .88)',
          boxShadow: '0 30px 60px -20px rgba(20, 10, 40, .7), 0 0 0 1px rgba(255,255,255,.12)',
          opacity: k * (1 - o),
          transform: `translateY(${(1 - k) * 60 + o * 20}px) scale(${0.85 + 0.15 * k})`,
          filter: `blur(${(1 - k) * 8}px)`,
        }}
      >
        {kicker && (
          <span style={{ fontFamily: textFont, fontWeight: 900, fontSize: 20, letterSpacing: '0.14em', textTransform: 'uppercase', backgroundImage: COLORS.gradient, WebkitBackgroundClip: 'text', color: 'transparent' }}>
            {kicker}
          </span>
        )}
        <Headline text={text} at={at + 0.05} out={out} size={44} color="#fff" font="text" weight={800} stagger={0.04} />
      </div>
    </div>
  );
};
