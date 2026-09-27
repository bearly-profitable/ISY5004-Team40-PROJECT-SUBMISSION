import React from 'react';
import { Composition } from 'remotion';
import { LuminaDemo } from './LuminaDemo';
import { f, FPS, HEIGHT, SONG, WIDTH } from './lib/time';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="LuminaDemo"
    component={LuminaDemo}
    durationInFrames={f(SONG.end)}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
