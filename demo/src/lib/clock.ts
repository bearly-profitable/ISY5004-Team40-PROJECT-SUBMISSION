import { createContext, useContext } from 'react';
import { useCurrentFrame } from 'remotion';
import { FPS } from './time';

/** Seconds a Scene is mounted before its start (for its entrance transition). */
export const SceneClock = createContext({ pre: 0 });

/** Seconds since the enclosing Scene's start; negative during its entrance. */
export const useT = () => {
  const frame = useCurrentFrame();
  const { pre } = useContext(SceneClock);
  return frame / FPS - pre;
};

export const useScenePre = () => useContext(SceneClock).pre;
