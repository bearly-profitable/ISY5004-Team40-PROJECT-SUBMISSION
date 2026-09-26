import React from 'react';
import { AbsoluteFill, Easing } from 'remotion';
import type { TransitionPresentation, TransitionPresentationComponentProps } from '@remotion/transitions';
import type { TransitionKind } from './storyboard';

/**
 * The movie's transitions, built only from transforms, opacity and filters so
 * the in-browser exporter draws them exactly like the preview. The entering
 * scene is rendered after the exiting one, so it sits on top.
 */

type Props = { kind: TransitionKind };

const expoInOut = Easing.inOut(Easing.exp);
const cubicOut = Easing.out(Easing.cubic);
const cubicInOut = Easing.inOut(Easing.cubic);

const LuminaPresentation: React.FC<TransitionPresentationComponentProps<Props>> = ({
  children, presentationDirection, presentationProgress: p, passedProps: { kind },
}) => {
  const entering = presentationDirection === 'entering';
  let style: React.CSSProperties = {};
  let flash = 0;

  switch (kind) {
    case 'rise': {
      // The next scene slides up like a card over the last one, which sinks back.
      const e = cubicInOut(p);
      style = entering
        ? { transform: `translateY(${(1 - e) * 100}%) scale(${0.94 + 0.06 * e})`, borderRadius: (1 - e) * 48, overflow: 'hidden', boxShadow: `0 -30px 80px rgba(0,0,0,${0.35 * (1 - e)})` }
        : { transform: `scale(${1 - 0.1 * e}) translateY(${-4 * e}%)`, filter: `brightness(${1 - 0.45 * e})` };
      break;
    }
    case 'whip-left':
    case 'whip-up': {
      // A fast camera pan with motion blur that peaks mid-move.
      const e = expoInOut(p);
      const blur = Math.sin(p * Math.PI) * 22;
      const axis = kind === 'whip-left' ? 'X' : 'Y';
      const offset = entering ? (1 - e) * 100 : -e * 100;
      style = { transform: `translate${axis}(${offset}%)`, filter: `blur(${blur}px)` };
      break;
    }
    case 'zoom': {
      // Fly through the old scene into the new one.
      const e = expoInOut(p);
      style = entering
        ? { transform: `scale(${0.7 + 0.3 * e})`, opacity: cubicOut(Math.min(1, p * 1.6)), filter: `blur(${(1 - e) * 18}px)` }
        : { transform: `scale(${1 + 0.6 * e})`, opacity: 1 - Math.max(0, (p - 0.35) / 0.65), filter: `blur(${e * 18}px)` };
      break;
    }
    case 'flash': {
      // A camera flash: white peaks at the cut.
      flash = entering ? 1 - Math.abs(2 * p - 1) : 0;
      style = entering
        ? { opacity: p >= 0.5 ? 1 : 0, transform: `scale(${1.06 - 0.06 * cubicOut(p)})` }
        : { transform: `scale(${1 + 0.05 * p})` };
      break;
    }
    case 'fade':
    default: {
      const e = cubicInOut(p);
      style = entering ? { opacity: e, transform: `scale(${1.04 - 0.04 * e})` } : { transform: `scale(${1 + 0.03 * e})` };
    }
  }

  return (
    <AbsoluteFill>
      <AbsoluteFill style={style}>{children}</AbsoluteFill>
      {flash > 0 && <AbsoluteFill style={{ backgroundColor: '#fff', opacity: Math.pow(flash, 0.7) }} />}
    </AbsoluteFill>
  );
};

export const luminaTransition = (kind: TransitionKind): TransitionPresentation<Props> => ({
  component: LuminaPresentation,
  props: { kind },
});
