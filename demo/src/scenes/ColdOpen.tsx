import React from 'react';
import { AbsoluteFill, Img, random, staticFile } from 'remotion';
import { Headline } from '../components/Type';
import { useT } from '../lib/clock';
import { text as textFont } from '../lib/fonts';
import { BEATS, COLORS, ease, lerp, SONG } from '../lib/time';

// The 12 real test photos (public/photos), portrait ones are 6-8.
const PHOTOS = new Array(12).fill(0).map((_, i) => ({ src: `photos/p${String(i).padStart(2, '0')}.jpg`, portrait: i >= 6 && i <= 8 }));

const RUSH = 5.2; // photos start rushing past the camera
const REVEAL = BEATS[12]; // ≈5.85 s: Lumina appears

/** Distance travelled toward the camera by time t (px). */
const travel = (t: number) => {
  const cruise = t * 230;
  const rush = t > RUSH ? Math.pow(t - RUSH, 2) * 2600 : 0;
  return cruise + rush;
};

const PhotoCloud: React.FC = () => {
  const t = useT();
  const cards = [];
  for (let k = 0; k < 24; k++) {
    const p = PHOTOS[k % 12];
    const a = (k / 24) * Math.PI * 2 + random(`a${k}`) * 0.6;
    const r = 430 + random(`r${k}`) * 520;
    const x = Math.cos(a) * r * 1.25;
    const y = Math.sin(a) * r * 0.62;
    const z0 = -3400 + ((k * 397) % 3000);
    const z = z0 + travel(t);
    if (z > 1100) continue;
    const blur = Math.min(14, Math.abs(z + 700) / 170);
    const fadeIn = lerp(z, [-3400, -2300], [0, 1]);
    const w = p.portrait ? 250 : 340;
    const h = p.portrait ? 333 : 255;
    cards.push(
      <div
        key={k}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: w,
          height: h,
          marginLeft: -w / 2,
          marginTop: -h / 2,
          transform: `translate3d(${x}px, ${y}px, ${z}px) rotateZ(${(random(`z${k}`) - 0.5) * 16}deg) rotateY(${-x / 60}deg)`,
          padding: 10,
          paddingBottom: 30,
          background: '#fffdfb',
          borderRadius: 8,
          boxShadow: '0 30px 60px -20px rgba(0,0,0,.6)',
          filter: `blur(${blur}px)`,
          opacity: fadeIn,
        }}
      >
        <Img src={staticFile(p.src)} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 3 }} />
      </div>,
    );
  }
  return (
    <AbsoluteFill style={{ perspective: 1100, perspectiveOrigin: '50% 50%' }}>
      <AbsoluteFill style={{ transformStyle: 'preserve-3d' }}>{cards}</AbsoluteFill>
    </AbsoluteFill>
  );
};

const Center: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center', textShadow: '0 6px 40px rgba(10, 6, 24, .8)' }}>
    {children}
  </AbsoluteFill>
);

/** 0 → build: real photos drift out of the dark, questions on the beat, Lumina appears. */
export const ColdOpen: React.FC = () => {
  const t = useT();
  const b = (i: number) => BEATS[i];
  const reveal = lerp(t, [REVEAL - 0.1, REVEAL + 0.7], [0, 1], ease.out);
  const lumiIn = lerp(t, [REVEAL, REVEAL + 0.6], [0, 1], ease.snappy);
  const exit = lerp(t, [SONG.build - 0.35, SONG.build], [0, 1], ease.in);

  return (
    <AbsoluteFill>
      <PhotoCloud />
      {/* Soft scrim so the words read over the photos. */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse 48% 30% at 50% 50%, rgba(18, 12, 34, .72) 0%, rgba(18, 12, 34, .35) 55%, rgba(18, 12, 34, 0) 100%)',
          opacity: lerp(t, [0.3, 0.9, RUSH, RUSH + 0.3], [0, 1, 1, 0]),
        }}
      />
      <Center>
        <Headline text="Every trip." at={b(1)} out={b(3) - 0.1} size={150} color="#fff" align="center" />
      </Center>
      <Center>
        <Headline text="Every dinner." at={b(3)} out={b(5) - 0.1} size={150} color="#fff" align="center" />
      </Center>
      <Center>
        <Headline text="Every *blink.*" at={b(5)} out={b(7) - 0.1} size={150} color="#fff" align="center" />
      </Center>
      <Center>
        <Headline text="Which ones are / the *keepers?*" at={b(7)} out={RUSH - 0.1} size={124} stagger={0.1} color="#fff" align="center" />
      </Center>

      {/* Lumina reveal */}
      <Center>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 34,
            opacity: reveal * (1 - exit),
            transform: `scale(${0.85 + 0.15 * reveal + exit * 0.4})`,
            filter: `blur(${(1 - reveal) * 20 + exit * 16}px)`,
          }}
        >
          <Img
            src={staticFile('lumi/celebrate.webp')}
            style={{
              height: 330,
              transform: `translateY(${(1 - lumiIn) * 160}px) rotate(${(1 - lumiIn) * -18}deg) scale(${0.6 + 0.4 * lumiIn})`,
              filter: 'drop-shadow(0 30px 40px rgba(0,0,0,.35))',
            }}
          />
          <div style={{ textAlign: 'left' }}>
            <Img src={staticFile('logo-wordmark.png')} style={{ height: 210, display: 'block', marginLeft: -8 }} />
            <div
              style={{
                fontFamily: textFont,
                fontWeight: 700,
                fontSize: 40,
                color: 'rgba(255,255,255,.9)',
                marginTop: 6,
                opacity: lerp(t, [REVEAL + 0.45, REVEAL + 0.9], [0, 1], ease.out),
                transform: `translateY(${lerp(t, [REVEAL + 0.45, REVEAL + 0.9], [20, 0], ease.out)}px)`,
              }}
            >
              Your best photos, found for you.
            </div>
          </div>
        </div>
      </Center>
      {/* Shine sweep across the reveal */}
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          mixBlendMode: 'screen',
          opacity: lerp(t, [REVEAL - 0.1, REVEAL + 0.2, REVEAL + 0.9], [0, 0.9, 0], ease.out),
          background: `radial-gradient(ellipse 50% 40% at 50% 50%, ${COLORS.peach}88 0%, ${COLORS.rose}55 40%, rgba(0,0,0,0) 75%)`,
        }}
      />
    </AbsoluteFill>
  );
};
