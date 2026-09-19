import type { RejectFlag, SignalKey } from '../types';

/** Display metadata for the 7 scoring signals, in canonical order. */
export const SIGNAL_UI: Array<{ key: SignalKey; label: string }> = [
  { key: 'centrality', label: 'Representative' },
  { key: 'nimaScore', label: 'Aesthetics' },
  { key: 'faceSharpness', label: 'Sharpness' },
  { key: 'faceSize', label: 'Face size' },
  { key: 'detScore', label: 'Face clarity' },
  { key: 'poseQuality', label: 'Pose' },
  { key: 'ear', label: 'Eyes open' },
];

export const REJECT_FLAG_UI: Record<RejectFlag, { label: string; hint: string }> = {
  duplicate: { label: 'Duplicate', hint: 'Near-duplicate of a better shot' },
  blurry: { label: 'Blurry', hint: 'Face is out of focus' },
  eyes_closed: { label: 'Blink', hint: 'Eyes closed' },
  low_quality: { label: 'Low quality', hint: 'Scored far below the rest of the event' },
};
