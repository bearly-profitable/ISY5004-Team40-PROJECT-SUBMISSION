// Event logs written by capture/encode.mjs, on each clip's page-time clock (s).
// Coordinates are CSS px in the 1600x900 viewport the app was recorded at.
import album from '../../public/clips/album.json';
import cleanup from '../../public/clips/cleanup.json';
import gallery from '../../public/clips/gallery.json';
import landing from '../../public/clips/landing.json';
import people from '../../public/clips/people.json';
import processing from '../../public/clips/processing.json';
import search from '../../public/clips/search.json';
import taste from '../../public/clips/taste.json';
import upload from '../../public/clips/upload.json';
import video from '../../public/clips/video.json';
import why from '../../public/clips/why.json';
import world from '../../public/clips/world.json';

export type ClipEvent = {
  t: number;
  type: string;
  x?: number;
  y?: number;
  box?: { x: number; y: number; width: number; height: number };
  to?: number;
  ms?: number;
  text?: string;
};
type ClipMeta = { name: string; duration: number; events: ClipEvent[] };

export const CLIPS = { album, cleanup, gallery, landing, people, processing, search, taste, upload, video, why, world } as unknown as Record<ClipName, ClipMeta>;
export type ClipName = 'album' | 'cleanup' | 'gallery' | 'landing' | 'people' | 'processing' | 'search' | 'taste' | 'upload' | 'video' | 'why' | 'world';

export const VIEW = { w: 1600, h: 900 };

/** The i-th event of a type in a clip (negative i counts from the end). */
export const ev = (clip: ClipName, type: string, i = 0): ClipEvent => {
  const list = CLIPS[clip].events.filter((e) => e.type === type);
  const e = list[i < 0 ? list.length + i : i];
  if (!e) throw new Error(`${clip}: no ${type} #${i}`);
  return e;
};

export const clipDuration = (clip: ClipName) => CLIPS[clip].duration;
