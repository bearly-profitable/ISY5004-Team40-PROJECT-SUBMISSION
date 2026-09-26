import React, { useEffect, useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { boop, gsap, prefersReducedMotion } from '../lib/motion';

/** Every pose in /public/lumi — mirrors backend/mascot.py POSES. */
export type LumiPose =
  | 'wave' | 'idle' | 'think' | 'search' | 'sleepy' | 'sad'
  | 'carry' | 'hang' | 'point' | 'present' | 'tag' | 'celebrate'
  | 'camera' | 'sort' | 'star' | 'hug'
  | 'wedding' | 'birthday' | 'graduation' | 'christmas' | 'beach' | 'hiking'
  | 'cafe' | 'dinner' | 'travel' | 'garden' | 'shopping' | 'night'
  | 'home' | 'meeting';

export const lumiSrc = (pose: LumiPose): string => `/lumi/${pose}.webp`;

/** Poses with a looping animation in /public/lumi/anim, made from Veo clips by
 *  tools/mascot/phase4_loops.py. Every other pose falls back to its still. */
const ANIMATED_POSES = new Set<LumiPose>(['star']);

export const lumiAnimSrc = (pose: LumiPose): string | null =>
  ANIMATED_POSES.has(pose) ? `/lumi/anim/${pose}.webp` : null;

/** Warm the browser cache so a pose swap never shows an empty frame. */
export function preloadPoses(poses: LumiPose[], { animated = false } = {}): void {
  for (const pose of poses) {
    const img = new Image();
    img.src = (animated && lumiAnimSrc(pose)) || lumiSrc(pose);
  }
}

interface LumiProps {
  pose: LumiPose;
  /** Rendered height in px (width follows the sprite). */
  size?: number;
  /** Gentle idle bob. */
  float?: boolean;
  /** Mirror, so Lumi can face the other way. */
  flip?: boolean;
  /** What Lumi says, in a speech bubble beside or above Lumi. */
  say?: React.ReactNode;
  bubble?: 'left' | 'right' | 'top';
  className?: string;
  /** Describe Lumi for screen readers when the pose itself carries meaning. */
  alt?: string;
  /** Play the pose's animated loop, if it has one (stills under reduced motion). */
  animate?: boolean;
}

/** Lumi, Lumina's mascot, in one of the pre-rendered poses. */
export const Lumi: React.FC<LumiProps> = ({
  pose, size = 140, float = true, flip = false, say, bubble = 'right', className = '', alt, animate = false,
}) => {
  const src = (animate && !prefersReducedMotion() && lumiAnimSrc(pose)) || lumiSrc(pose);
  const bodyRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useGSAP(() => {
    if (!float || prefersReducedMotion()) return;
    gsap.to(bodyRef.current, {
      y: -Math.max(4, size * 0.04),
      duration: 1.8,
      ease: 'sine.inOut',
      repeat: -1,
      yoyo: true,
    });
  }, { dependencies: [float, size] });

  // A change of pose gets a springy boop, so Lumi visibly "reacts".
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    boop(imgRef.current);
  }, [pose]);

  useEffect(() => {
    if (say && bubbleRef.current && !prefersReducedMotion()) {
      gsap.fromTo(bubbleRef.current,
        { scale: 0.85, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2)' });
    }
  }, [say]);

  const layout = bubble === 'top'
    ? 'flex-col-reverse items-center'
    : bubble === 'left' ? 'flex-row-reverse items-center' : 'flex-row items-center';
  const tail = bubble === 'top' ? 'bottom' : bubble === 'left' ? 'right' : 'left';

  return (
    <div className={`inline-flex gap-3 ${layout} ${className}`}>
      {/* Three layers so their transforms never fight: the float moves the
          outer box, the flip mirrors the middle, the boop squashes the image. */}
      <div ref={bodyRef} className="shrink-0" style={{ height: size }}>
        <div className="h-full" style={{ transform: flip ? 'scaleX(-1)' : undefined }}>
          <img
            ref={imgRef}
            src={src}
            alt={alt ?? ''}
            aria-hidden={alt ? undefined : true}
            draggable={false}
            className="lumi-sprite h-full w-auto"
            style={{
              transformOrigin: '50% 100%',
              // The user's chosen outfit (index.css) plus Lumi's soft shadow.
              filter: 'var(--lumi-outfit) drop-shadow(0 10px 14px rgba(90, 60, 120, 0.18))',
            }}
          />
        </div>
      </div>
      {say && (
        <div ref={bubbleRef} className="lumi-bubble max-w-[16rem]" data-tail={tail} role="status">
          {say}
        </div>
      )}
    </div>
  );
};
