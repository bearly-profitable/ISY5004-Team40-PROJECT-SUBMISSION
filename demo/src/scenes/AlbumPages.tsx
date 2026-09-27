import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { Kicker } from '../components/AppShot';
import { Chip, Headline } from '../components/Type';
import { useT } from '../lib/clock';
import { BEATS, ease, lerp } from '../lib/time';

const PAGES = new Array(11).fill(0).map((_, i) => `album/page-${String(i + 1).padStart(2, '0')}.jpg`);
const W = 760;
const H = Math.round((W * 910) / 1287);

/** The album PDF Lumina just made, page by page, stepping on every beat. */
export const AlbumPages: React.FC<{ start: number; dur: number }> = ({ start, dur }) => {
  const t = useT();
  const song = start + t;
  // Index advances one page per beat with a snappy settle.
  let passed = 0;
  let frac = 0;
  for (const b of BEATS) {
    if (b < start + 0.2) continue;
    if (b > song) break;
    passed++;
    frac = lerp(song - b, [0, 0.3], [0, 1], ease.snappy);
  }
  const idx = Math.min(PAGES.length - 1, Math.max(0, passed - 1 + frac));
  const exit = lerp(t, [dur - 0.3, dur], [0, 1], ease.in);

  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 70, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Kicker text="Create album" at={0.05} />
        </div>
        <Headline text="A photo book, *designed for you.*" at={0.1} size={80} align="center" stagger={0.07} />
      </div>
      <AbsoluteFill style={{ perspective: 1600, top: 170 }}>
        <AbsoluteFill style={{ transformStyle: 'preserve-3d', alignItems: 'center', justifyContent: 'center' }}>
          {PAGES.map((src, i) => {
            const d = i - idx;
            if (Math.abs(d) > 3.2) return null;
            const sd = Math.sign(d) * Math.min(Math.abs(d), 1);
            const x = d * 330 + sd * 230;
            const z = -Math.abs(d) * 320;
            const ry = -sd * 52;
            const enter = lerp(t, [0.05 + i * 0.03, 0.55 + i * 0.03], [0, 1], ease.out);
            return (
              <div
                key={src}
                style={{
                  position: 'absolute',
                  width: W,
                  height: H,
                  transform: `translate3d(${x}px, ${(1 - enter) * 500 - exit * 80}px, ${z - exit * 600}px) rotateY(${ry}deg)`,
                  opacity: Math.min(1, 3.2 - Math.abs(d)) * enter * (1 - exit),
                  borderRadius: 10,
                  overflow: 'hidden',
                  boxShadow: '0 40px 80px -24px rgba(50, 25, 90, .55), 0 0 0 1px rgba(255,255,255,.6)',
                  zIndex: 100 - Math.round(Math.abs(d) * 10),
                }}
              >
                <Img src={staticFile(src)} style={{ width: '100%', height: '100%' }} />
                <div style={{ position: 'absolute', inset: 0, background: `rgba(40, 25, 70, ${Math.min(Math.abs(d), 1) * 0.25})` }} />
              </div>
            );
          })}
        </AbsoluteFill>
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 56, display: 'flex', justifyContent: 'center', gap: 16 }}>
        <Chip label="Real PDF" sub="· 11 pages" at={0.6} />
        <Chip label="7 themes" sub="· Lumi in every chapter" at={0.75} dot="#e38c9e" />
      </div>
    </AbsoluteFill>
  );
};
