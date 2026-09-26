import React from 'react';
import { Img, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { lumiSrc, type LumiPose } from '../components/Lumi';

/**
 * Lumi, animated in code from the still poses: a squash-and-stretch hop in,
 * breathing and sway while idle, little hops on the beat, pose swaps with a
 * pop, and an optional hop out. Every value is a pure function of the frame,
 * so preview and export match exactly.
 */

export interface PoseCue { pose: LumiPose; at: number }

interface LumiActorProps {
  /** One pose, or a timeline of poses (frame offsets within the scene). */
  pose: LumiPose | PoseCue[];
  /** Rendered height in px. */
  size: number;
  /** Frame the entrance starts. */
  delay?: number;
  enter?: 'hop' | 'peek' | 'pop';
  /** Frame to hop back out, if any. */
  exitAt?: number;
  /** Frames per beat: Lumi bounces along with the music. */
  beat?: number;
  flip?: boolean;
  shadow?: boolean;
  style?: React.CSSProperties;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const LumiActor: React.FC<LumiActorProps> = ({
  pose, size, delay = 0, enter = 'hop', exitAt, beat, flip = false, shadow = true, style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = frame - delay;
  const cues: PoseCue[] = typeof pose === 'string' ? [{ pose, at: 0 }] : pose;

  // Entrance.
  const inP = spring({ frame: f, fps, config: enter === 'pop' ? { damping: 10, stiffness: 170 } : { damping: 13, stiffness: 120, mass: 0.9 } });
  const outP = exitAt != null ? spring({ frame: frame - exitAt, fps, config: { damping: 16, stiffness: 150 } }) : 0;
  const travel = enter === 'peek' ? size * 0.75 : size * 1.25;
  let y = (1 - inP) * travel + outP * travel * 1.1;
  let scaleIn = enter === 'pop' ? inP : 1;

  // Stretch while flying, squash on landing (a damped wobble).
  const flying = clamp01(1 - inP) + clamp01(outP);
  let sy = 1 + 0.16 * flying;
  let sx = 1 - 0.1 * flying;
  const landed = f - fps * 0.32;
  if (landed > 0 && enter !== 'pop') {
    const wob = Math.exp(-landed / 5) * Math.sin(landed * 0.9) * 0.13;
    sy -= wob;
    sx += wob * 0.8;
  }

  // Idle: breathe, sway, and bounce on the beat.
  const t = Math.max(0, f) / fps;
  sy += Math.sin(t * Math.PI * 1.25) * 0.022;
  sx -= Math.sin(t * Math.PI * 1.25) * 0.011;
  let rot = Math.sin(t * Math.PI * 0.8) * 3;
  if (beat && f > fps * 0.6) {
    const ph = (f % beat) / beat;
    const hop = ph < 0.42 ? Math.sin((Math.PI * ph) / 0.42) : 0;
    y -= hop * size * 0.045;
    // Squash just as the hop starts and ends.
    const contact = ph < 0.08 ? 1 - ph / 0.08 : ph > 0.34 && ph < 0.42 ? (ph - 0.34) / 0.08 : 0;
    sy -= contact * 0.05;
    sx += contact * 0.04;
    rot += hop * (Math.floor(f / beat) % 2 ? 2.5 : -2.5);
  }

  // Pose swaps pop slightly.
  let active = 0;
  cues.forEach((c, i) => { if (f >= c.at) active = i; });
  const sinceSwap = f - cues[active].at;
  if (active > 0 && sinceSwap < 10) {
    const pop = spring({ frame: sinceSwap, fps, config: { damping: 9, stiffness: 220 } });
    scaleIn *= 0.9 + 0.1 * pop + Math.sin(pop * Math.PI) * 0.06;
  }

  const lift = Math.max(0, -y) / size;
  const visible = f >= 0 ? 1 : 0;

  return (
    <div style={{ position: 'relative', width: size * 0.9, height: size, opacity: visible, ...style }}>
      {shadow && (
        <div
          style={{
            position: 'absolute', left: '18%', right: '18%', bottom: -size * 0.02, height: size * 0.07,
            borderRadius: '50%', backgroundColor: 'rgba(60, 40, 90, 0.28)', filter: `blur(${size * 0.025}px)`,
            transform: `scale(${(1 - lift * 1.5) * clamp01(inP) * (1 - outP)})`,
          }}
        />
      )}
      <div
        style={{
          position: 'absolute', inset: 0, transformOrigin: '50% 100%',
          transform: `translateY(${y}px) rotate(${rot}deg) scale(${sx * scaleIn}, ${sy * scaleIn}) scaleX(${flip ? -1 : 1})`,
        }}
      >
        {cues.map((c, i) => {
          // Crossfade over 3 frames so the swap never flashes empty.
          const on = i === active ? 1 : i === active - 1 ? clamp01(1 - sinceSwap / 3) : 0;
          return (
            <Img
              key={`${c.pose}-${i}`}
              src={lumiSrc(c.pose)}
              style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: on }}
            />
          );
        })}
      </div>
    </div>
  );
};

/** A four-point sparkle that twinkles; Lumi's signature. */
export const Sparkle: React.FC<{ size: number; delay?: number; color?: string; style?: React.CSSProperties; period?: number }> = ({
  size, delay = 0, color = '#fde68a', style, period = 40,
}) => {
  const frame = useCurrentFrame();
  const f = frame - delay;
  if (f < 0) return null;
  const ph = (f % period) / period;
  const s = Math.sin(ph * Math.PI);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ position: 'absolute', opacity: s, transform: `scale(${0.4 + 0.6 * s}) rotate(${ph * 90}deg)`, ...style }}
    >
      <path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" fill={color} />
    </svg>
  );
};
