import React from 'react';
import { OffthreadVideo, Sequence, staticFile } from 'remotion';
import { useScenePre, useT } from '../lib/clock';
import { ClipName, VIEW } from '../lib/clips';
import { ease, f, FPS } from '../lib/time';

/** A stretch of a clip: clip seconds [from, to] played over `dur` output seconds. */
export type Seg = { from: number; to: number; dur: number };

/** Camera key on the clip's clock: zoom `z` centred on (x, y) in viewport px. */
export type CamKey = { t: number; z: number; x?: number; y?: number };

export const segsDuration = (segs: Seg[]) => segs.reduce((s, g) => s + g.dur, 0);

/** Clip time shown `u` output seconds into the shot. */
export const clipTimeAt = (segs: Seg[], u: number) => {
  let start = 0;
  for (const g of segs) {
    if (u < start + g.dur || g === segs[segs.length - 1]) {
      const k = Math.min(Math.max((u - start) / g.dur, 0), 1);
      return g.from + (g.to - g.from) * k;
    }
    start += g.dur;
  }
  return segs[0].from;
};

const camAt = (keys: CamKey[], t: number) => {
  const cx = VIEW.w / 2, cy = VIEW.h / 2;
  const norm = keys.map((k) => ({ t: k.t, z: k.z, x: k.x ?? cx, y: k.y ?? cy }));
  if (!norm.length) return { z: 1, x: cx, y: cy };
  if (t <= norm[0].t) return norm[0];
  for (let i = 0; i < norm.length - 1; i++) {
    const a = norm[i], b = norm[i + 1];
    if (t <= b.t) {
      const k = ease.inOut((t - a.t) / Math.max(b.t - a.t, 1e-6));
      // Interpolate zoom in log space so zooming feels even.
      const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * k);
      return { z, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return norm[norm.length - 1];
};

type Props = {
  clip: ClipName;
  segs: Seg[];
  cam?: CamKey[];
  radius?: number;
  /** Overlays drawn in viewport px, moving with the camera. */
  children?: React.ReactNode;
};

/**
 * Real app footage in a floating window. The window is VIEW.w x VIEW.h layout px;
 * the recording is 2x that, so zooming in up to 2x stays pixel-sharp.
 */
export const Footage: React.FC<Props> = ({ clip, segs, cam = [], radius = 22, children }) => {
  const u = useT();
  const pre = useScenePre();
  const t = clipTimeAt(segs, u);
  const c = camAt(cam, t);
  const z = c.z;
  // Keep the focus point centred without showing past the recording's edges.
  const tx = Math.min(0, Math.max(VIEW.w - VIEW.w * z, VIEW.w / 2 - c.x * z));
  const ty = Math.min(0, Math.max(VIEW.h - VIEW.h * z, VIEW.h / 2 - c.y * z));

  // Segments sit on the Scene's clock (offset by its entrance lead-in); the first
  // one starts early so the footage is already moving while it flies in.
  let start = 0;
  const seqs = segs.map((g, i) => {
    const rate = (g.to - g.from) / g.dur;
    const lead = i === 0 ? pre : 0;
    const from = f(pre + start - lead);
    // ...and the last one runs on through the exit transition.
    const tail = i === segs.length - 1 ? 0.3 : 0;
    const dur = Math.max(1, f(pre + start + g.dur + tail) - from);
    const clipFrom = Math.max(0, g.from - lead * rate);
    start += g.dur;
    return (
      <Sequence key={i} from={from} durationInFrames={dur} layout="none">
        <OffthreadVideo
          src={staticFile(`clips/${clip}.mp4`)}
          trimBefore={Math.round(clipFrom * FPS)}
          playbackRate={rate}
          muted
          style={{ position: 'absolute', inset: 0, width: VIEW.w, height: VIEW.h }}
        />
      </Sequence>
    );
  });

  return (
    <div
      style={{
        position: 'relative',
        width: VIEW.w,
        height: VIEW.h,
        borderRadius: radius,
        overflow: 'hidden',
        background: '#f6eef4',
        boxShadow:
          '0 50px 120px -30px rgba(50, 25, 90, .55), 0 18px 40px -18px rgba(50, 25, 90, .45), 0 0 0 1px rgba(255,255,255,.55)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transformOrigin: '0 0',
          transform: `translate(${tx}px, ${ty}px) scale(${z})`,
        }}
      >
        {seqs}
        {children}
      </div>
    </div>
  );
};
