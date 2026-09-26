import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { Audio } from '@remotion/media';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import type { Storyboard } from './storyboard';
import { luminaTransition } from './transitions';
import { ChapterScene, IntroScene, OutroScene, ShotScene } from './scenes';

/** The "Create video" movie: a storyboard played as scenes and transitions. */

export interface LuminaMovieProps extends Record<string, unknown> {
  storyboard: Storyboard;
  /** Soundtrack URL (composed or the user's own), or null for silence. */
  music: string | null;
  /** The user's own track fades out at the end; composed ones already do. */
  fadeMusic: boolean;
}

export const LuminaMovie: React.FC<LuminaMovieProps> = ({ storyboard, music, fadeMusic }) => {
  const { scenes, beatFrames: beat, durationInFrames } = storyboard;
  const items: React.ReactNode[] = [];
  scenes.forEach(({ scene, frames, out }, i) => {
    let body: React.ReactNode;
    switch (scene.kind) {
      case 'intro':
        body = <IntroScene title={scene.title} subtitle={scene.subtitle} photos={scene.photos} beat={beat} />;
        break;
      case 'chapter':
        body = <ChapterScene index={scene.index} total={scene.total} title={scene.title} dateLabel={scene.dateLabel} pose={scene.pose} photos={scene.photos} beat={beat} />;
        break;
      case 'shot':
        body = (
          <ShotScene
            layout={scene.layout} photos={scene.photos} chapterTitle={scene.chapterTitle} chapterIndex={scene.chapterIndex}
            cameo={scene.cameo} seed={scene.seed} frames={frames} beat={beat} label={scene.label}
          />
        );
        break;
      case 'outro':
        body = <OutroScene photos={scene.photos} beat={beat} frames={frames} />;
        break;
    }
    items.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={frames}>
        {body}
      </TransitionSeries.Sequence>,
    );
    if (out) {
      items.push(
        <TransitionSeries.Transition key={`t${i}`} presentation={luminaTransition(out.kind)} timing={linearTiming({ durationInFrames: out.frames })} />,
      );
    }
  });

  return (
    <AbsoluteFill style={{ backgroundColor: '#0f0a1e' }}>
      <TransitionSeries>{items}</TransitionSeries>
      {music && (
        <Audio
          src={music}
          volume={fadeMusic
            ? (f) => interpolate(f, [0, 12, durationInFrames - 60, durationInFrames], [0, 0.85, 0.85, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
            : 1}
        />
      )}
    </AbsoluteFill>
  );
};
