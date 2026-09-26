import type { LumiPose } from '../components/Lumi';

/**
 * Turns the chosen photos into a timed shot list for the "Create video" movie.
 *
 * Every scene lasts a whole number of beats plus its outgoing transition, so
 * cuts land on the soundtrack's beat grid. The more photos there are, the
 * shorter each shot and the more photos share a shot (pairs, trios, mosaics),
 * keeping the movie watchable (~15–90 s) whatever the selection size.
 */

export type Orientation = 'landscape' | 'portrait';

export interface MoviePhoto {
  id: string;
  /** Same-origin (blob:) URL, so the frame renderer can read its pixels. */
  src: string;
  width: number;
  height: number;
  /** Centre of the faces, 0..1 of the image; crops keep it in frame. */
  focal?: [number, number];
  /** Tiny pre-blurred copy for backdrops (live blur is too slow to export). */
  blurSrc?: string;
}

export interface MovieChapter {
  title: string;
  dateLabel?: string | null;
  pose: LumiPose;
  photos: MoviePhoto[];
}

export type Mood = 'sunny' | 'dreamy';

/** Soundtrack tempo, picked so a beat is a whole number of frames at 30 fps. */
export const MOOD_BPM: Record<Mood, number> = { sunny: 100, dreamy: 75 };
export const FPS = 30;
export const beatFrames = (mood: Mood) => Math.round((FPS * 60) / MOOD_BPM[mood]);

export type TransitionKind = 'rise' | 'whip-left' | 'whip-up' | 'zoom' | 'flash' | 'fade';

export type ShotLayout = 'single' | 'framed' | 'polaroid' | 'pair' | 'trio' | 'mosaic';

export type Scene =
  | { kind: 'intro'; beats: number; title: string; subtitle: string; photos: MoviePhoto[] }
  | { kind: 'chapter'; beats: number; index: number; total: number; title: string; dateLabel?: string | null; pose: LumiPose; photos: MoviePhoto[] }
  | { kind: 'shot'; beats: number; layout: ShotLayout; photos: MoviePhoto[]; chapterTitle: string; chapterIndex: number; cameo: Cameo | null; seed: number; label: ChapterLabel | null }
  | { kind: 'outro'; beats: number; photos: MoviePhoto[] };

export interface Cameo { pose: LumiPose; say: string | null; side: 'left' | 'right' }

/** With many moments, each is named by a lower-third on its first shot instead of a full card. */
export interface ChapterLabel { title: string; dateLabel?: string | null; pose: LumiPose; index: number; total: number }

/** Beyond this many moments, full chapter cards would drag. */
const MAX_CHAPTER_CARDS = 6;

export interface TimedScene {
  scene: Scene;
  /** Total frames, including the overlap with the next scene. */
  frames: number;
  /** Transition into the next scene (null for the last one). */
  out: { kind: TransitionKind; frames: number } | null;
}

export interface Storyboard {
  scenes: TimedScene[];
  durationInFrames: number;
  beatFrames: number;
  fps: number;
}

export interface StoryboardOptions {
  title: string;
  subtitle: string;
  mood: Mood;
  vertical: boolean;
  /** Longest acceptable movie (default grows with the photo count); packing
   *  gets denser until it fits. */
  maxSeconds?: number;
}

/** Deterministic PRNG so the same selection always gives the same movie. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const orientationOf = (p: MoviePhoto): Orientation => (p.width >= p.height ? 'landscape' : 'portrait');

const CAMEO_LINES: Array<{ pose: LumiPose; say: string | null }> = [
  { pose: 'camera', say: 'Say cheese!' },
  { pose: 'point', say: 'Look at this!' },
  { pose: 'star', say: 'So good!' },
  { pose: 'hug', say: 'Aww' },
  { pose: 'celebrate', say: 'Yay!' },
  { pose: 'present', say: null },
];

/** How many photos each layout shows. */
const LAYOUT_SIZE: Record<ShotLayout, number> = { single: 1, framed: 1, polaroid: 1, pair: 2, trio: 3, mosaic: 4 };

/** Layout rotations by packing level: denser levels put more photos per shot. */
const PATTERNS: ShotLayout[][] = [
  ['single', 'single', 'polaroid', 'single', 'pair'],
  ['single', 'trio', 'single', 'pair', 'polaroid', 'trio'],
  ['trio', 'single', 'mosaic', 'pair', 'trio'],
  ['mosaic', 'trio', 'mosaic', 'single', 'mosaic'],
];

/** Seconds a one-photo shot holds, shrinking as the photo count grows. */
export const singleShotSeconds = (n: number) => Math.min(3.2, Math.max(1.5, 3.2 - 0.045 * n));

function groupChapter(
  photos: MoviePhoto[],
  level: number,
  vertical: boolean,
  offset: number,
): Array<{ layout: ShotLayout; photos: MoviePhoto[] }> {
  const out: Array<{ layout: ShotLayout; photos: MoviePhoto[] }> = [];
  const queue = [...photos];
  // The chapter's best photo opens it on its own.
  const hero = queue.shift();
  if (!hero) return out;
  out.push({ layout: 'single', photos: [hero] });
  const pattern = PATTERNS[level];
  let k = offset;
  while (queue.length) {
    let layout = pattern[k % pattern.length];
    k++;
    // Mosaics grow to six when there is a lot left to show.
    let size = layout === 'mosaic' && queue.length >= 8 && level >= 3 ? 6 : LAYOUT_SIZE[layout];
    if (queue.length < size) {
      layout = queue.length >= 3 ? 'trio' : queue.length === 2 ? 'pair' : 'single';
      size = LAYOUT_SIZE[layout];
    }
    // Leave no single photo stranded at the end of a chapter.
    if (queue.length - size === 1 && size >= 2 && size < 4) {
      layout = size === 2 ? 'trio' : 'mosaic';
      size = size + 1;
    }
    const group = queue.splice(0, size);
    // A photo shaped against the frame looks better framed than cropped.
    if (group.length === 1 && layout === 'single') {
      const against = vertical ? orientationOf(group[0]) === 'landscape' : orientationOf(group[0]) === 'portrait';
      if (against) layout = 'framed';
    }
    out.push({ layout, photos: group });
  }
  return out;
}

function buildScenes(chapters: MovieChapter[], opts: StoryboardOptions, level: number, beatSec: number): Scene[] {
  const all = chapters.flatMap((c) => c.photos);
  const n = all.length;
  const singleBeats = Math.max(2, Math.round(singleShotSeconds(n) / beatSec));
  const beatsFor = (layout: ShotLayout, count: number) => {
    if (layout === 'single' || layout === 'framed') return singleBeats;
    if (layout === 'polaroid' || layout === 'pair') return singleBeats + 1;
    if (layout === 'trio') return singleBeats + 2;
    return singleBeats + (count > 4 ? 3 : 2);
  };
  const chapterBeats = Math.max(3, Math.round((chapters.length > 6 ? 2.2 : 3) / beatSec));
  const random = rng(hashString(all.map((p) => p.id).join('|')));

  const scenes: Scene[] = [
    // Whole bars, so the beat drops exactly on the first cut.
    { kind: 'intro', beats: introBeats(beatSec), title: opts.title, subtitle: opts.subtitle, photos: pickSpread(all, 4) },
  ];
  let shotIndex = 0;
  let cameoGap = 2;
  chapters.forEach((chapter, index) => {
    if (!chapter.photos.length) return;
    const cards = chapters.length > 1 && chapters.length <= MAX_CHAPTER_CARDS;
    if (cards) {
      scenes.push({
        kind: 'chapter', beats: chapterBeats, index, total: chapters.length, title: chapter.title,
        dateLabel: chapter.dateLabel, pose: chapter.pose, photos: chapter.photos.slice(0, 3),
      });
    }
    groupChapter(chapter.photos, level, opts.vertical, index).forEach((group, g) => {
      const label: ChapterLabel | null = !cards && chapters.length > 1 && g === 0
        ? { title: chapter.title, dateLabel: chapter.dateLabel, pose: chapter.pose, index, total: chapters.length }
        : null;
      // Lumi drops in every few shots, never on busy mosaics or labelled shots.
      let cameo: Cameo | null = null;
      cameoGap--;
      if (!label && cameoGap <= 0 && (group.layout === 'single' || group.layout === 'framed' || group.layout === 'polaroid')) {
        const line = CAMEO_LINES[Math.floor(random() * CAMEO_LINES.length)];
        cameo = { ...line, side: random() < 0.5 ? 'left' : 'right' };
        cameoGap = 3 + Math.floor(random() * 3);
      }
      scenes.push({
        // A named shot holds long enough (~2 s) for the name to be read.
        kind: 'shot', beats: label ? Math.max(beatsFor(group.layout, group.photos.length), Math.ceil(2 / beatSec)) : beatsFor(group.layout, group.photos.length), layout: group.layout, photos: group.photos,
        chapterTitle: chapter.title, chapterIndex: index, cameo, seed: shotIndex++, label,
      });
    });
  });
  scenes.push({ kind: 'outro', beats: Math.max(6, Math.round(4.8 / beatSec)), photos: pickSpread(all, 6) });
  return scenes;
}

export const introBeats = (beatSec: number) => 4 * Math.max(1, Math.round(4.4 / (4 * beatSec)));

/** Up to `k` photos spread evenly through the list. */
function pickSpread<T>(list: T[], k: number): T[] {
  if (list.length <= k) return list;
  return Array.from({ length: k }, (_, i) => list[Math.floor((i * list.length) / k)]);
}

function transitionInto(prev: Scene, next: Scene, i: number): TransitionKind {
  if (next.kind === 'outro') return 'fade';
  if (prev.kind === 'intro') return 'rise';
  if (next.kind === 'chapter' || (next.kind === 'shot' && next.label)) return 'zoom';
  if (prev.kind === 'chapter') return 'flash';
  if (next.kind === 'shot' && next.cameo?.pose === 'camera') return 'flash';
  const cycle: TransitionKind[] = ['whip-left', 'rise', 'zoom', 'whip-up', 'fade', 'whip-left', 'rise'];
  return cycle[i % cycle.length];
}

/** Frames each transition takes, as a fraction of a beat. */
const TRANSITION_BEATS: Record<TransitionKind, number> = {
  rise: 1, 'whip-left': 0.75, 'whip-up': 0.75, zoom: 1, flash: 0.5, fade: 1.5,
};

/** About 14 s plus 1.1 s a photo, up to 100 s. */
export const targetSeconds = (n: number) => Math.min(100, 14 + 1.1 * n);

export function planStoryboard(chapters: MovieChapter[], opts: StoryboardOptions): Storyboard {
  const beat = beatFrames(opts.mood);
  const beatSec = beat / FPS;
  const n = chapters.reduce((sum, c) => sum + c.photos.length, 0);
  const maxFrames = (opts.maxSeconds ?? targetSeconds(n)) * FPS;
  let timed: TimedScene[] = [];
  let duration = 0;
  for (let level = 0; level < PATTERNS.length; level++) {
    const scenes = buildScenes(chapters, opts, level, beatSec);
    timed = scenes.map((scene, i) => {
      const next = scenes[i + 1];
      const out = next ? { kind: transitionInto(scene, next, i), frames: 0 } : null;
      if (out) out.frames = Math.round(TRANSITION_BEATS[out.kind] * beat);
      // Hold for whole beats, then overlap the next scene by the transition.
      return { scene, frames: scene.beats * beat + (out?.frames ?? 0), out };
    });
    duration = timed.reduce((sum, t) => sum + t.frames - (t.out?.frames ?? 0), 0);
    if (duration <= maxFrames) break;
  }
  return { scenes: timed, durationInFrames: duration, beatFrames: beat, fps: FPS };
}
