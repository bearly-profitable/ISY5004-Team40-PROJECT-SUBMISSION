import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { SceneClock, useT } from '../lib/clock';
import { COLORS, ease, f, FPS, lerp } from '../lib/time';

export type Move = 'whip' | 'whipUp' | 'zoom' | 'rise' | 'fade' | 'cut';

/** Seconds scenes overlap by, so exits and entrances blend into one move. */
export const OVER = 0.22;

const enterStyle = (m: Move, p: number): React.CSSProperties => {
  const q = 1 - p;
  switch (m) {
    case 'whip':
      return { transform: `translateX(${q * 1700}px) rotateY(${-q * 28}deg) scale(${1 - q * 0.1})`, filter: `blur(${q * 18}px)`, opacity: Math.min(1, p * 2.5) };
    case 'whipUp':
      return { transform: `translateY(${q * 1100}px) rotateX(${q * 30}deg)`, filter: `blur(${q * 18}px)`, opacity: Math.min(1, p * 2.5) };
    case 'zoom':
      return { transform: `scale(${1 + q * 0.7})`, filter: `blur(${q * 22}px)`, opacity: p };
    case 'rise':
      return { transform: `translateY(${q * 900}px) rotateX(${q * 40}deg) scale(${1 - q * 0.2})`, opacity: Math.min(1, p * 2) };
    case 'fade':
      return { opacity: p };
    default:
      return {};
  }
};

const exitStyle = (m: Move, p: number): React.CSSProperties => {
  switch (m) {
    case 'whip':
      return { transform: `translateX(${-p * 1700}px) rotateY(${p * 28}deg) scale(${1 - p * 0.1})`, filter: `blur(${p * 18}px)`, opacity: Math.min(1, (1 - p) * 2.5) };
    case 'whipUp':
      return { transform: `translateY(${-p * 1100}px) rotateX(${-p * 30}deg)`, filter: `blur(${p * 18}px)`, opacity: Math.min(1, (1 - p) * 2.5) };
    case 'zoom':
      return { transform: `scale(${1 + p * 0.9})`, filter: `blur(${p * 22}px)`, opacity: 1 - p };
    case 'rise':
      return { transform: `translateY(${-p * 900}px) rotateX(${-p * 40}deg)`, opacity: 1 - p };
    case 'fade':
      return { opacity: 1 - p };
    default:
      return {};
  }
};

const merge = (a: React.CSSProperties, b: React.CSSProperties): React.CSSProperties => ({
  transform: [a.transform, b.transform].filter(Boolean).join(' ') || undefined,
  filter: [a.filter, b.filter].filter(Boolean).join(' ') || undefined,
  opacity: (a.opacity === undefined ? 1 : Number(a.opacity)) * (b.opacity === undefined ? 1 : Number(b.opacity)),
});

/**
 * A scene from `start` to `end` (song seconds). Children see a clock where 0 is
 * `start`; the scene is mounted OVER seconds early/late for the transitions.
 */
export const Scene: React.FC<{
  start: number;
  end: number;
  enter?: Move;
  exit?: Move;
  children: React.ReactNode;
  name?: string;
}> = ({ start, end, enter = 'cut', exit = 'cut', children, name }) => {
  const pre = enter === 'cut' ? 0 : OVER;
  const post = exit === 'cut' ? 0 : OVER;
  return (
    <Sequence from={f(start - pre)} durationInFrames={f(end - start + pre + post)} name={name}>
      <SceneClock.Provider value={{ pre }}>
        <StageBody dur={end - start} enter={enter} exit={exit}>
          {children}
        </StageBody>
      </SceneClock.Provider>
    </Sequence>
  );
};

const StageBody: React.FC<{ dur: number; enter: Move; exit: Move; children: React.ReactNode }> = ({ dur, enter, exit, children }) => {
  const t = useT();
  const pIn = enter === 'cut' ? 1 : lerp(t, [-OVER, OVER], [0, 1], ease.inOut);
  const pOut = exit === 'cut' ? 0 : lerp(t, [dur - OVER, dur + OVER], [0, 1], ease.inOut);
  const style = merge(enterStyle(enter, pIn), exitStyle(exit, pOut));
  return (
    <AbsoluteFill style={{ perspective: 1800 }}>
      <AbsoluteFill style={{ ...style, transformStyle: 'preserve-3d', willChange: 'transform' }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/** A warm light-leak flash centred on `at` (song seconds). */
export const Flash: React.FC<{ at: number; dur?: number; strength?: number; x?: number; y?: number }> = ({
  at,
  dur = 0.5,
  strength = 0.9,
  x = 50,
  y = 45,
}) => {
  const t = useCurrentFrame() / FPS;
  if (t < at - dur || t > at + dur) return null;
  const k = t < at ? lerp(t, [at - dur * 0.5, at], [0, 1], ease.in) : lerp(t, [at, at + dur], [1, 0], ease.out);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen', opacity: k * strength }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 70% 60% at ${x}% ${y}%, rgba(255,255,255,1) 0%, rgba(255,214,196,.85) 30%, rgba(227,140,158,.5) 55%, rgba(157,136,212,0) 80%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `linear-gradient(${100 + t * 40}deg, rgba(243,173,127,0) 20%, rgba(243,173,127,.7) 45%, rgba(255,255,255,.9) 50%, rgba(227,140,158,.6) 56%, rgba(157,136,212,0) 80%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.35 }) => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      background: `radial-gradient(ellipse 85% 80% at 50% 50%, rgba(0,0,0,0) 60%, rgba(40, 20, 70, ${strength}) 100%)`,
    }}
  />
);

export { COLORS };
