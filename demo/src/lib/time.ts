import { Easing, interpolate } from 'remotion';
import beatData from './beats.json';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Seconds -> frames. */
export const f = (sec: number) => Math.round(sec * FPS);

/** Beat times (s) of the soundtrack, from librosa (≈129 BPM). */
export const BEATS: number[] = beatData.beats;

/** Where the song changes (s), measured from the track's bass energy. */
export const SONG = {
  build: 7.268,
  drop1: 15.813,
  breakdown: 39.172,
  drop2: 52.965,
  finalHit: 83.917,
  end: 90.6,
} as const;

/** Snap a time to the nearest beat. */
export const snap = (sec: number) =>
  BEATS.reduce((best, b) => (Math.abs(b - sec) < Math.abs(best - sec) ? b : best), BEATS[0]);

/** 1 on each beat, decaying to 0 over `decay` seconds. */
export const beatPulse = (sec: number, decay = 0.22, from = 0, to = Infinity) => {
  let last = -Infinity;
  for (const b of BEATS) {
    if (b > sec) break;
    if (b >= from && b <= to) last = b;
  }
  const d = sec - last;
  return d < 0 || d > decay ? 0 : Math.pow(1 - d / decay, 2);
};

export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.7, 0, 0.84, 0),
  snappy: Easing.bezier(0.2, 0.9, 0.1, 1),
};

/** interpolate with clamping on both sides. */
export const lerp = (
  t: number,
  input: number[],
  output: number[],
  easing: (n: number) => number = ease.inOut,
) => interpolate(t, input, output, { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing });

export const COLORS = {
  lavender: '#9d88d4',
  accent: '#8f7bc6',
  rose: '#e38c9e',
  peach: '#f3ad7f',
  ink: '#1c1530',
  plum: '#140f24',
  cream: '#fdf7f4',
  gradient: 'linear-gradient(135deg, #9d88d4 0%, #e38c9e 55%, #f3ad7f 100%)',
};
