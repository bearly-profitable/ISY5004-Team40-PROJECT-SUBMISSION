import * as THREE from 'three';
import type { WorldAudio } from './sound';

/** Movement intent, from the keyboard or the touch controls. */
export interface InputState {
  /** -1 (left) .. 1 (right) */
  x: number;
  /** -1 (towards the camera) .. 1 (away from it) */
  y: number;
  sprint: boolean;
  /** When a jump was asked for (performance.now()), so a slightly early press still counts. */
  jumpAt: number;
}

/** Visual effects the character can ask for; set by the effect components. */
export interface WorldFx {
  dust: (x: number, z: number, count: number, power: number) => void;
}

/**
 * Per-frame state shared by Lumi, the easels, the effects and the HUD. It
 * lives in a ref, not React state, so 60 updates a second never re-render
 * anything.
 */
export interface WorldRuntime {
  pos: THREE.Vector3;
  /** Height above the ground and vertical speed, for jumps. */
  y: number;
  vy: number;
  grounded: boolean;
  facing: number;
  speed: number;
  /** 0..1, eased: how much of a sprint Lumi is in (drives the effects). */
  sprint: number;
  input: InputState;
  /** What Lumi is close enough to look at. */
  nearestId: string | null;
  /** While the Lightbox is open: Lumi stands still and keys go to it. */
  paused: boolean;
  /** Tweened by GSAP when Lumi looks at something. */
  flourish: { hop: number; spin: number };
  /** Bumped to make a rigged Lumi play its wave. */
  gesture: number;
  /** Set by the character when it turns to face something. */
  lookAt: { x: number; z: number } | null;
  fx: WorldFx | null;
  audio: WorldAudio | null;
}

export function createRuntime(): WorldRuntime {
  return {
    pos: new THREE.Vector3(0, 0, 1.5),
    y: 0,
    vy: 0,
    grounded: true,
    facing: 0, // facing the camera, to say hello
    speed: 0,
    sprint: 0,
    input: { x: 0, y: 0, sprint: false, jumpAt: 0 },
    nearestId: null,
    paused: false,
    flourish: { hop: 0, spin: 0 },
    gesture: 0,
    lookAt: null,
    fx: null,
    audio: null,
  };
}
