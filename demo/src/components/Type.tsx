import React from 'react';
import { useT } from '../lib/clock';
import { display, text as textFont } from '../lib/fonts';
import { COLORS, ease, lerp } from '../lib/time';

/**
 * Per-word kinetic headline. Words wrapped in *stars* get the Lumi gradient.
 * `at` / `out` are seconds on the parent Sequence's clock.
 */
export const Headline: React.FC<{
  text: string;
  at?: number;
  out?: number;
  size?: number;
  stagger?: number;
  color?: string;
  font?: 'display' | 'text';
  weight?: number;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  style?: React.CSSProperties;
  maxWidth?: number;
}> = ({
  text,
  at = 0,
  out,
  size = 96,
  stagger = 0.07,
  color = COLORS.ink,
  font = 'display',
  weight = 700,
  align = 'left',
  lineHeight = 1.02,
  style,
  maxWidth,
}) => {
  const t = useT();
  const words = text.split(' ');
  let emOn = false;
  return (
    <div
      style={{
        fontFamily: font === 'display' ? display : textFont,
        fontWeight: weight,
        fontSize: size,
        lineHeight,
        letterSpacing: font === 'display' ? '-0.025em' : '-0.01em',
        color,
        textAlign: align,
        maxWidth,
        ...style,
      }}
    >
      {words.map((raw, i) => {
        if (raw === '/') return <br key={i} />;
        // *emphasis* may span several words.
        const opens = raw.startsWith('*');
        const closes = raw.endsWith('*') && (raw.length > 1 || !opens);
        if (opens) emOn = true;
        const em = emOn;
        if (closes) emOn = false;
        const word = raw.replace(/^\*/, '').replace(/\*$/, '');
        const start = at + i * stagger;
        const k = lerp(t, [start, start + 0.55], [0, 1], ease.out);
        const o = out !== undefined ? lerp(t, [out + i * 0.03, out + 0.28 + i * 0.03], [0, 1], ease.in) : 0;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              whiteSpace: 'pre',
              opacity: Math.min(k * 1.4, 1) * (1 - o),
              transform: `translateY(${(1 - k) * 0.55 - o * 0.35}em) rotate(${(1 - k) * 5}deg) scale(${0.92 + 0.08 * k})`,
              filter: `blur(${(1 - k) * 12 + o * 10}px)`,
              ...(em
                ? {
                    backgroundImage: COLORS.gradient,
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent',
                    paddingBottom: '0.08em',
                    marginBottom: '-0.08em',
                  }
                : {}),
            }}
          >
            {word}
            {i < words.length - 1 && words[i + 1] !== '/' ? ' ' : ''}
          </span>
        );
      })}
    </div>
  );
};

/** Small label pill (e.g. "ArcFace · faces"). */
export const Chip: React.FC<{
  label: string;
  sub?: string;
  at: number;
  out?: number;
  dot?: string;
  dark?: boolean;
  style?: React.CSSProperties;
}> = ({ label, sub, at, out, dot = COLORS.lavender, dark = false, style }) => {
  const t = useT();
  const k = lerp(t, [at, at + 0.45], [0, 1], ease.snappy);
  const o = out !== undefined ? lerp(t, [out, out + 0.25], [0, 1], ease.in) : 0;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 24px 14px 18px',
        borderRadius: 999,
        background: dark ? 'rgba(28, 21, 48, .86)' : 'rgba(255, 255, 255, .92)',
        color: dark ? '#fff' : COLORS.ink,
        boxShadow: '0 14px 34px -12px rgba(60, 30, 100, .4), 0 0 0 1px rgba(255,255,255,.6)',
        fontFamily: textFont,
        fontWeight: 800,
        fontSize: 26,
        opacity: k * (1 - o),
        transform: `translateY(${(1 - k) * 30 - o * 20}px) scale(${0.7 + 0.3 * k})`,
        filter: `blur(${(1 - k) * 6}px)`,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <span style={{ width: 14, height: 14, borderRadius: 99, background: dot, boxShadow: `0 0 14px ${dot}` }} />
      {label}
      {sub && <span style={{ fontWeight: 700, opacity: 0.55 }}>{sub}</span>}
    </div>
  );
};

/** Full-frame one-word slam, for the drops. */
export const Slam: React.FC<{ word: string; at: number; dur: number; size?: number; color?: string }> = ({
  word,
  at,
  dur,
  size = 250,
  color = '#fff',
}) => {
  const t = useT();
  if (t < at - 0.05 || t > at + dur + 0.1) return null;
  const k = lerp(t, [at, at + 0.18], [0, 1], ease.snappy);
  const o = lerp(t, [at + dur - 0.12, at + dur], [0, 1], ease.in);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: display,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: '-0.04em',
        color,
        opacity: k * (1 - o),
        transform: `scale(${1.35 - 0.35 * k + o * 0.25})`,
        filter: `blur(${(1 - k) * 18 + o * 16}px)`,
        textShadow: '0 20px 60px rgba(40, 20, 80, .35)',
      }}
    >
      {word}
    </div>
  );
};
