import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { Headline } from '../components/Type';
import { useT } from '../lib/clock';
import { text as textFont } from '../lib/fonts';
import { COLORS, ease, lerp } from '../lib/time';

const FEATURES = ['Moments', 'People', 'Best shots', 'Search', 'Albums', 'Videos', 'Lumi’s island'];

/** Final hit → end: Lumi waves goodbye over the logo, tagline and link. */
export const EndCard: React.FC<{ dur: number }> = ({ dur }) => {
  const t = useT();
  const lumi = lerp(t, [0, 0.7], [0, 1], ease.snappy);
  const bob = Math.sin(t * 3.2) * 8;
  const logo = lerp(t, [0.15, 0.8], [0, 1], ease.out);
  const url = lerp(t, [1.5, 2.1], [0, 1], ease.out);
  const fadeOut = lerp(t, [dur - 0.9, dur], [0, 1], ease.inOut);

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 56, marginTop: -40 }}>
        <Img
          src={staticFile('lumi/wave.webp')}
          style={{
            height: 520,
            transform: `translateY(${(1 - lumi) * 420 + bob}px) rotate(${(1 - lumi) * 14 + Math.sin(t * 2.4) * 2}deg) scale(${0.7 + 0.3 * lumi})`,
            filter: 'drop-shadow(0 40px 50px rgba(60, 30, 100, .35))',
          }}
        />
        <div>
          <Img
            src={staticFile('logo-wordmark.png')}
            style={{
              height: 230,
              display: 'block',
              marginLeft: -10,
              opacity: logo,
              transform: `translateX(${(1 - logo) * 60}px) scale(${0.9 + 0.1 * logo})`,
              filter: `blur(${(1 - logo) * 14}px)`,
            }}
          />
          <Headline text="Your best photos, / *found for you.*" at={0.5} size={72} stagger={0.08} />
          <div
            style={{
              marginTop: 34,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 14,
              padding: '16px 30px',
              borderRadius: 999,
              background: COLORS.ink,
              color: '#fff',
              fontFamily: textFont,
              fontWeight: 800,
              fontSize: 32,
              opacity: url,
              transform: `translateY(${(1 - url) * 24}px)`,
              boxShadow: '0 20px 40px -16px rgba(40, 20, 80, .6)',
            }}
          >
            <span style={{ width: 14, height: 14, borderRadius: 99, background: COLORS.gradient }} />
            luminaphoto.up.railway.app
          </div>
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 84, display: 'flex', gap: 14 }}>
        {FEATURES.map((label, i) => {
          const k = lerp(t, [1.9 + i * 0.07, 2.4 + i * 0.07], [0, 1], ease.out);
          return (
            <div
              key={label}
              style={{
                padding: '10px 20px',
                borderRadius: 999,
                background: 'rgba(255,255,255,.75)',
                boxShadow: '0 0 0 1px rgba(157,136,212,.35)',
                fontFamily: textFont,
                fontWeight: 800,
                fontSize: 22,
                color: COLORS.accent,
                opacity: k,
                transform: `translateY(${(1 - k) * 20}px)`,
              }}
            >
              {label}
            </div>
          );
        })}
      </div>

      <AbsoluteFill style={{ background: COLORS.plum, opacity: fadeOut, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};
