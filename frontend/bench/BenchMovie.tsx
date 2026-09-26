import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';

/**
 * Benchmark stand-in for the real "Create video" movie: the same kinds of
 * scenes (intro, chapter cards, Ken Burns shots, 3-up collages, Lumi cameos,
 * outro) and transitions, so export timings are representative.
 */

export interface BenchPhoto { src: string; w: number; h: number }
export interface BenchMovieProps { photos: BenchPhoto[]; blurBackdrop: boolean }

type Scene =
  | { kind: 'intro'; frames: number }
  | { kind: 'chapter'; frames: number; index: number; pose: string }
  | { kind: 'solo'; frames: number; photo: number; cameo: string | null }
  | { kind: 'trio'; frames: number; photos: number[] }
  | { kind: 'outro'; frames: number };

const CHAPTER_POSES = ['beach', 'birthday', 'cafe', 'hiking', 'travel', 'garden'];
const CAMEO_POSES = ['point', 'camera', 'star', 'wave'];
const PHOTOS_PER_CHAPTER = 10;
export const TRANSITION_S = 0.5;

/** Seconds per shot: shorter as the photo count grows, within 1.2–3.5 s. */
export const shotSeconds = (n: number) => Math.min(3.5, Math.max(1.2, 3.2 - 0.04 * n));

export function planScenes(n: number, fps: number): Scene[] {
  const shot = Math.round(shotSeconds(n) * fps);
  const scenes: Scene[] = [{ kind: 'intro', frames: Math.round(3 * fps) }];
  let i = 0;
  let shotCount = 0;
  while (i < n) {
    if (i % PHOTOS_PER_CHAPTER === 0) {
      const index = i / PHOTOS_PER_CHAPTER;
      scenes.push({ kind: 'chapter', frames: Math.round(2 * fps), index, pose: CHAPTER_POSES[index % CHAPTER_POSES.length] });
    }
    // Every fourth shot packs three photos, when three remain in this chapter.
    const leftInChapter = PHOTOS_PER_CHAPTER - (i % PHOTOS_PER_CHAPTER);
    if (shotCount % 4 === 3 && leftInChapter >= 3 && n - i >= 3) {
      scenes.push({ kind: 'trio', frames: Math.round(shot * 1.3), photos: [i, i + 1, i + 2] });
      i += 3;
    } else {
      scenes.push({ kind: 'solo', frames: shot, photo: i, cameo: shotCount % 5 === 2 ? CAMEO_POSES[shotCount % CAMEO_POSES.length] : null });
      i += 1;
    }
    shotCount++;
  }
  scenes.push({ kind: 'outro', frames: Math.round(3 * fps) });
  return scenes;
}

export function totalFrames(n: number, fps: number): number {
  const scenes = planScenes(n, fps);
  const t = Math.round(TRANSITION_S * fps);
  return scenes.reduce((sum, s) => sum + s.frames, 0) - (scenes.length - 1) * t;
}

const lumi = (pose: string) => `/lumi/${pose}.webp`;

const Bob: React.FC<{ children: React.ReactNode; amp?: number }> = ({ children, amp = 10 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const y = Math.sin((frame / fps) * Math.PI * 1.6) * amp;
  return <div style={{ transform: `translateY(${y}px)` }}>{children}</div>;
};

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const text = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(135deg, #fde2f3 0%, #e0e7ff 55%, #cffafe 100%)', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div style={{ transform: `scale(${pop})` }}>
        <Bob><Img src={lumi('wave')} style={{ height: height * 0.42 }} /></Bob>
      </div>
      <div style={{ opacity: text, transform: `translateY(${(1 - text) * 40}px)`, fontFamily: 'system-ui, sans-serif', fontWeight: 800, fontSize: height * 0.075, color: '#1e293b', marginTop: height * 0.03 }}>
        Our Summer
      </div>
      <div style={{ opacity: text, fontFamily: 'system-ui, sans-serif', fontSize: height * 0.035, color: '#64748b' }}>
        June – August 2026
      </div>
    </AbsoluteFill>
  );
};

const Chapter: React.FC<{ index: number; pose: string }> = ({ index, pose }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const hop = spring({ frame, fps, config: { damping: 9, stiffness: 120 } });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(160deg, #fef3c7 0%, #fce7f3 100%)', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: height * 0.05 }}>
      <div style={{ transform: `translateY(${(1 - hop) * height * 0.3}px) rotate(${(1 - hop) * -12}deg)` }}>
        <Img src={lumi(pose)} style={{ height: height * 0.5 }} />
      </div>
      <div style={{ fontFamily: 'system-ui, sans-serif', color: '#1e293b', opacity: interpolate(frame, [8, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <div style={{ fontSize: height * 0.035, letterSpacing: 4, textTransform: 'uppercase', color: '#a855f7', fontWeight: 700 }}>Chapter {index + 1}</div>
        <div style={{ fontSize: height * 0.08, fontWeight: 800 }}>{pose[0].toUpperCase() + pose.slice(1)} day</div>
      </div>
    </AbsoluteFill>
  );
};

const Solo: React.FC<{ photo: BenchPhoto; seed: number; frames: number; cameo: string | null; blurBackdrop: boolean }> = ({ photo, seed, frames, cameo, blurBackdrop }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / frames;
  // Ken Burns: slow zoom plus a drift whose direction depends on the seed.
  const scale = 1.06 + 0.1 * t;
  const dx = (seed % 2 ? 1 : -1) * 2.5 * t;
  const dy = (seed % 3 === 0 ? 1 : -1) * 1.5 * t;
  const narrow = photo.w / photo.h < (width / height) * 0.8;
  const peek = cameo ? spring({ frame: frame - 6, fps, config: { damping: 14 } }) : 0;
  return (
    <AbsoluteFill style={{ backgroundColor: '#0f172a', overflow: 'hidden' }}>
      {narrow && blurBackdrop && (
        <Img src={photo.src} style={{ position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(40px) brightness(0.6)', transform: 'scale(1.2)' }} />
      )}
      <Img
        src={photo.src}
        style={{ position: 'absolute', width: '100%', height: '100%', objectFit: narrow ? 'contain' : 'cover', transform: `scale(${scale}) translate(${dx}%, ${dy}%)` }}
      />
      {cameo && (
        <div style={{ position: 'absolute', right: width * 0.03, bottom: 0, transform: `translateY(${(1 - peek) * 100}%)` }}>
          <Bob amp={6}><Img src={lumi(cameo)} style={{ height: height * 0.3 }} /></Bob>
        </div>
      )}
    </AbsoluteFill>
  );
};

const Trio: React.FC<{ photos: BenchPhoto[] }> = ({ photos }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const gap = width * 0.015;
  return (
    <AbsoluteFill style={{ background: '#fff7ed', flexDirection: 'row', padding: gap, gap }}>
      {photos.map((p, k) => {
        const s = spring({ frame: frame - k * 5, fps, config: { damping: 15 } });
        return (
          <div key={k} style={{ flex: 1, height: height - 2 * gap, borderRadius: 18, overflow: 'hidden', transform: `translateY(${(1 - s) * height}px)`, boxShadow: '0 12px 30px rgba(0,0,0,0.18)' }}>
            <Img src={p.src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.05 + 0.05 * (frame / 90)})` }} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 10 } });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(135deg, #e0e7ff 0%, #fde2f3 100%)', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div style={{ transform: `scale(${pop}) rotate(${Math.sin(frame / 6) * 4}deg)` }}>
        <Img src={lumi('celebrate')} style={{ height: height * 0.45 }} />
      </div>
      <div style={{ fontFamily: 'system-ui, sans-serif', fontWeight: 700, fontSize: height * 0.04, color: '#475569', opacity: pop }}>Made with Lumina</div>
    </AbsoluteFill>
  );
};

const TRANSITIONS = [
  () => fade(),
  () => slide({ direction: 'from-right' }),
  () => wipe({ direction: 'from-left' }),
  () => slide({ direction: 'from-bottom' }),
];

export const BenchMovie: React.FC<BenchMovieProps> = ({ photos, blurBackdrop }) => {
  const { fps } = useVideoConfig();
  const scenes = planScenes(photos.length, fps);
  const t = Math.round(TRANSITION_S * fps);
  const items: React.ReactNode[] = [];
  scenes.forEach((scene, k) => {
    if (k > 0) {
      items.push(
        <TransitionSeries.Transition key={`t${k}`} presentation={TRANSITIONS[k % TRANSITIONS.length]()} timing={linearTiming({ durationInFrames: t })} />,
      );
    }
    let body: React.ReactNode;
    switch (scene.kind) {
      case 'intro': body = <Intro />; break;
      case 'chapter': body = <Chapter index={scene.index} pose={scene.pose} />; break;
      case 'solo': body = <Solo photo={photos[scene.photo]} seed={scene.photo} frames={scene.frames} cameo={scene.cameo} blurBackdrop={blurBackdrop} />; break;
      case 'trio': body = <Trio photos={scene.photos.map((i) => photos[i])} />; break;
      case 'outro': body = <Outro />; break;
    }
    items.push(<TransitionSeries.Sequence key={`s${k}`} durationInFrames={scene.frames}>{body}</TransitionSeries.Sequence>);
  });
  return <AbsoluteFill style={{ backgroundColor: '#000' }}><TransitionSeries>{items}</TransitionSeries></AbsoluteFill>;
};
