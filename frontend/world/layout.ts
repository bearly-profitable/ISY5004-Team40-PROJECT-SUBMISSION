/**
 * Lumi's island: where every moment, photo, path stone and tree goes.
 *
 * Moments sit one after another along a spiral path that starts at the
 * plaza in the middle, newest first, so walking outward walks back in time.
 * Each moment is a round clearing ringed by up to FRAMES_PER_ZONE photo
 * easels, with a notice board in the middle that opens all of its photos.
 * Everything is placed with a seeded random, so the island looks the same
 * every visit.
 */
import type { LightboxItem } from '../components/Lightbox';
import type { LumiPose } from '../components/Lumi';
import { poseForEvent } from '../lib/lumiScenes';

export type ZoneTheme = 'meadow' | 'garden' | 'forest' | 'beach' | 'snow' | 'party' | 'cafe' | 'night';

export type PropKind =
  | 'tree' | 'pine' | 'snowPine' | 'palm' | 'bush' | 'rock' | 'flower'
  | 'balloon' | 'table' | 'lantern' | 'snowman';

export interface WorldPhoto {
  id: string;
  thumbUrl: string;
  /** width / height when known up front (library rows); else read from the texture. */
  aspect: number | null;
  item: LightboxItem;
}

/** One moment, before it is given a place on the island. */
export interface ZoneSource {
  key: string;
  title: string;
  subtitle: string;
  /** Labels used to pick the clearing's theme. */
  labels: string[];
  /** Best photo first. */
  photos: WorldPhoto[];
}

export interface Zone {
  index: number;
  key: string;
  title: string;
  subtitle: string;
  theme: ZoneTheme;
  pose: LumiPose;
  x: number;
  z: number;
  photos: WorldPhoto[];
}

export interface FrameSpot {
  id: string;
  zone: number;
  photoIndex: number;
  photo: WorldPhoto;
  x: number;
  z: number;
  rotY: number;
}

export interface Placement {
  x: number;
  z: number;
  rot: number;
  scale: number;
  /** Index into the prop's palette, for props that vary in colour. */
  tint?: number;
}

export interface Interactable {
  id: string;
  kind: 'photo' | 'board';
  zone: number;
  /** Which photo the Lightbox opens on. */
  photoIndex: number;
  x: number;
  z: number;
}

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export interface WorldLayout {
  zones: Zone[];
  frames: FrameSpot[];
  stones: Placement[];
  props: Record<PropKind, Placement[]>;
  obstacles: Obstacle[];
  interactables: Interactable[];
  islandRadius: number;
  /** The welcome sign on the plaza. */
  welcome: { x: number; z: number };
}

export const PLAZA_R = 4.5;
export const ZONE_R = 6;
export const FRAME_RING_R = 3.7;
export const FRAMES_PER_ZONE = 8;
/** Distance between neighbouring moments along the path. */
const ZONE_SPACING = 16;
/** Gap between the spiral's turns. */
const TURN_GAP = 17;
const SPIRAL_START_R = 12;

const THEME_BY_POSE: Partial<Record<LumiPose, ZoneTheme>> = {
  beach: 'beach',
  garden: 'garden',
  home: 'garden',
  hug: 'garden',
  hiking: 'forest',
  travel: 'forest',
  christmas: 'snow',
  night: 'night',
  birthday: 'party',
  celebrate: 'party',
  wedding: 'party',
  graduation: 'party',
  cafe: 'cafe',
  dinner: 'cafe',
  shopping: 'cafe',
  meeting: 'cafe',
};

/** Ground colour of each clearing. */
export const THEME_GROUND: Record<ZoneTheme, string> = {
  meadow: '#9fd67a',
  garden: '#b4e08a',
  forest: '#6fae62',
  beach: '#f2dca2',
  snow: '#f4f6fb',
  party: '#c9e7a0',
  cafe: '#e6cfa8',
  night: '#6d7bb0',
};

/** Props scattered around a clearing of each theme. */
const THEME_PROPS: Record<ZoneTheme, Array<[PropKind, number]>> = {
  meadow: [['flower', 10], ['bush', 3], ['rock', 2]],
  garden: [['flower', 16], ['bush', 4], ['tree', 1]],
  forest: [['pine', 7], ['rock', 3], ['bush', 2]],
  beach: [['palm', 5], ['rock', 3]],
  snow: [['snowPine', 6], ['snowman', 1], ['rock', 1]],
  party: [['balloon', 9], ['flower', 6]],
  cafe: [['table', 3], ['bush', 3], ['flower', 4]],
  night: [['lantern', 6], ['pine', 3]],
};

/** Mulberry32: tiny, fast, and the same numbers every visit. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function themeFor(labels: string[]): { theme: ZoneTheme; pose: LumiPose } {
  const pose = poseForEvent(labels, 0);
  return { theme: THEME_BY_POSE[pose] ?? 'meadow', pose };
}

/** Points along r = SPIRAL_START_R + b·θ, every `step` units of arc length. */
function spiralPoints(count: number, step: number, offset = 0): Array<{ x: number; z: number; theta: number }> {
  const b = TURN_GAP / (2 * Math.PI);
  const out: Array<{ x: number; z: number; theta: number }> = [];
  let theta = 0;
  let travelled = 0;
  let next = offset;
  // Start pointing away from the camera, so the first moment is in view.
  const turn = -Math.PI / 2;
  while (out.length < count) {
    const r = SPIRAL_START_R + b * theta;
    if (travelled >= next) {
      out.push({ x: Math.cos(theta + turn) * r, z: Math.sin(theta + turn) * r, theta });
      next += step;
    }
    const dTheta = 0.01;
    travelled += Math.hypot(r, b) * dTheta;
    theta += dTheta;
  }
  return out;
}

export function buildLayout(sources: ZoneSource[]): WorldLayout {
  const rand = seeded(hashString(sources.map((s) => s.key).join('|')) || 7);
  const centres = spiralPoints(sources.length, ZONE_SPACING);

  const zones: Zone[] = sources.map((src, index) => {
    const { theme, pose } = themeFor(src.labels);
    return { index, key: src.key, title: src.title, subtitle: src.subtitle, theme, pose, x: centres[index].x, z: centres[index].z, photos: src.photos };
  });

  // Beside the path out of the plaza, where the camera sees it on arrival.
  const welcome = { x: -2.4, z: -1.8 };
  const obstacles: Obstacle[] = [{ ...welcome, r: 0.8 }];
  const interactables: Interactable[] = [];
  const frames: FrameSpot[] = [];

  /* ---- path: plaza -> first moment, then along the spiral ---- */
  const stones: Placement[] = [];
  const onPath: Array<{ x: number; z: number }> = [];
  const insideClearing = (x: number, z: number) =>
    Math.hypot(x, z) < PLAZA_R + 0.6 || zones.some((zn) => Math.hypot(x - zn.x, z - zn.z) < ZONE_R - 0.4);
  const addStone = (x: number, z: number) => {
    onPath.push({ x, z });
    if (insideClearing(x, z)) return;
    stones.push({ x: x + (rand() - 0.5) * 0.25, z: z + (rand() - 0.5) * 0.25, rot: rand() * Math.PI, scale: 0.8 + rand() * 0.35 });
  };
  if (zones.length > 0) {
    const first = zones[0];
    const dist = Math.hypot(first.x, first.z);
    for (let d = PLAZA_R; d < dist; d += 1.15) addStone((first.x / dist) * d, (first.z / dist) * d);
    const pathLength = (zones.length - 1) * ZONE_SPACING;
    if (pathLength > 0) {
      for (const p of spiralPoints(Math.floor(pathLength / 1.15) + 1, 1.15)) addStone(p.x, p.z);
    }
  }
  const nearPath = (x: number, z: number, clearance: number) =>
    onPath.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < clearance * clearance);

  /* ---- each clearing: easels in a ring, a board in the middle ---- */
  for (const zone of zones) {
    const count = Math.min(FRAMES_PER_ZONE, zone.photos.length);
    // Leave the ring open where the path comes in, and turn it so the
    // gaps between easels line up with the path.
    const entry = Math.atan2(-zone.z, -zone.x);
    for (let i = 0; i < count; i++) {
      const angle = entry + ((i + 0.5) / count) * Math.PI * 2;
      const x = zone.x + Math.cos(angle) * FRAME_RING_R;
      const z = zone.z + Math.sin(angle) * FRAME_RING_R;
      const id = `${zone.index}:${i}`;
      // Face the middle of the clearing.
      frames.push({ id, zone: zone.index, photoIndex: i, photo: zone.photos[i], x, z, rotY: Math.atan2(zone.x - x, zone.z - z) });
      obstacles.push({ x, z, r: 0.55 });
      interactables.push({ id, kind: 'photo', zone: zone.index, photoIndex: i, x, z });
    }
    obstacles.push({ x: zone.x, z: zone.z, r: 0.75 });
    interactables.push({ id: `${zone.index}:board`, kind: 'board', zone: zone.index, photoIndex: 0, x: zone.x, z: zone.z });
  }

  /* ---- scenery ---- */
  const last = zones[zones.length - 1];
  const islandRadius = Math.max(22, (last ? Math.hypot(last.x, last.z) : 0) + ZONE_R + 8);

  const props = {
    tree: [], pine: [], snowPine: [], palm: [], bush: [], rock: [], flower: [],
    balloon: [], table: [], lantern: [], snowman: [],
  } as Record<PropKind, Placement[]>;
  const SOLID: Partial<Record<PropKind, number>> = {
    tree: 0.45, pine: 0.45, snowPine: 0.45, palm: 0.4, rock: 0.5, table: 0.7, lantern: 0.25, snowman: 0.55,
  };
  const place = (kind: PropKind, x: number, z: number, scale: number) => {
    props[kind].push({ x, z, rot: rand() * Math.PI * 2, scale, tint: Math.floor(rand() * 5) });
    const solid = SOLID[kind];
    if (solid) obstacles.push({ x, z, r: solid * scale });
  };
  const blocked = (x: number, z: number, r: number) => obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r);

  // Around each clearing, in its theme.
  for (const zone of zones) {
    for (const [kind, n] of THEME_PROPS[zone.theme]) {
      for (let i = 0; i < n; i++) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const a = rand() * Math.PI * 2;
          const small = kind === 'flower' || kind === 'balloon';
          const d = small ? 4.6 + rand() * 1.8 : ZONE_R - 0.6 + rand() * 2.2;
          const x = zone.x + Math.cos(a) * d;
          const z = zone.z + Math.sin(a) * d;
          if (nearPath(x, z, small ? 0.8 : 1.6) || blocked(x, z, small ? 0.2 : 0.6)) continue;
          if (Math.hypot(x, z) > islandRadius - 2.5) continue;
          place(kind, x, z, 0.8 + rand() * 0.45);
          break;
        }
      }
    }
  }

  // Everywhere else: a light scatter of trees, bushes, rocks and flowers.
  const area = Math.PI * islandRadius * islandRadius;
  const scatter = Math.min(420, Math.round(area / 16));
  const zoneAt = (x: number, z: number) => zones.find((zn) => Math.hypot(x - zn.x, z - zn.z) < ZONE_R + 2.5);
  for (let i = 0; i < scatter; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * (islandRadius - 2.2);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (d < PLAZA_R + 2.5 || zoneAt(x, z) || nearPath(x, z, 2)) continue;
    const roll = rand();
    const kind: PropKind = roll < 0.42 ? 'tree' : roll < 0.62 ? 'pine' : roll < 0.78 ? 'bush' : roll < 0.88 ? 'rock' : 'flower';
    if (blocked(x, z, 0.7)) continue;
    place(kind, x, z, 0.75 + rand() * 0.6);
  }

  return { zones, frames, stones, props, obstacles, interactables, islandRadius, welcome };
}
