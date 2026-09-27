import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { AppShot, AppShotProps } from './components/AppShot';
import { Background, Grain } from './components/Background';
import { Seg } from './components/Footage';
import { Flash, Move, Scene, Vignette } from './components/Stage';
import { Chip, Headline } from './components/Type';
import { useT } from './lib/clock';
import { text as textFont } from './lib/fonts';
import { CLIPS, ClipName, ev } from './lib/clips';
import { AlbumPages } from './scenes/AlbumPages';
import { ColdOpen } from './scenes/ColdOpen';
import { EndCard } from './scenes/EndCard';
import { BEATS, COLORS, f, FPS, lerp, SONG } from './lib/time';

/* ------------------------------------------------------------------ plan */

type ShotDef = {
  kind: 'shot';
  name: string;
  start: number;
  end: number;
  enter: Move;
  exit: Move;
} & AppShotProps;

type CustomDef = {
  kind: 'custom';
  name: string;
  start: number;
  end: number;
  enter: Move;
  exit: Move;
  render: (dur: number, start: number) => React.ReactNode;
};

const c = (clip: ClipName, i: number) => ev(clip, 'click', i);

// Song landmarks, snapped to the beat grid.
const B = (i: number) => BEATS[i];
const T = {
  upload: SONG.drop1,
  processing: B(42), // ≈19.9
  gallery: B(51), // ≈24.1
  people: B(62), // ≈29.2
  search: B(73), // ≈34.3
  why: SONG.breakdown,
  taste: B(97), // ≈46.1
  album: SONG.drop2,
  albumPages: B(117), // ≈55.8
  video: B(127), // ≈60.4
  cleanup: B(136), // ≈64.6
  world: B(143), // ≈67.9
  end: SONG.finalHit,
};

const TECH = [
  { label: 'ArcFace', sub: '· faces', dot: COLORS.lavender },
  { label: 'YOLOv8', sub: '· people', dot: COLORS.rose },
  { label: 'OSNet', sub: '· bodies', dot: COLORS.peach },
  { label: 'DINOv3', sub: '· scenes', dot: COLORS.lavender },
  { label: 'CLIP', sub: '· meaning', dot: COLORS.rose },
  { label: 'NIMA', sub: '· aesthetics', dot: COLORS.peach },
];

const PLAN: (ShotDef | CustomDef)[] = [
  {
    kind: 'shot',
    name: 'landing',
    start: SONG.build,
    end: SONG.drop1,
    enter: 'rise',
    exit: 'zoom',
    clip: 'landing',
    layout: 'full',
    segs: [
      { from: 1.0, to: 2.7, dur: 1.2 },
      { from: 2.7, to: 11.2, dur: SONG.drop1 - SONG.build - 1.2 },
    ],
    cam: [
      { t: 1.0, z: 1.0 },
      { t: 8.6, z: 1.06, x: 820, y: 470 },
      { t: 11.2, z: 1.45, x: 840, y: 470 },
    ],
  },
  {
    kind: 'shot',
    name: 'upload',
    start: T.upload,
    end: T.processing,
    enter: 'zoom',
    exit: 'whip',
    clip: 'upload',
    layout: 'full',
    title: 'Drop in your photos.',
    kicker: 'Upload',
    titleAt: 0.35,
    titleOut: 3.4,
    segs: [
      { from: 2.85, to: 3.6, dur: 0.9 },
      { from: 3.6, to: 5.5, dur: 1.0 },
      { from: 5.5, to: 7.7, dur: T.processing - T.upload - 1.9 },
    ],
    cam: [
      { t: 2.85, z: 1.0 },
      { t: 3.8, z: 1.18, x: 820, y: 470 },
      { t: 5.3, z: 1.12, x: 900, y: 400 },
      { t: c('upload', 1).t, z: 1.7, x: c('upload', 1).x, y: c('upload', 1).y! + 60 },
      { t: c('upload', 2).t, z: 1.9, x: c('upload', 2).x, y: c('upload', 2).y! + 50 },
    ],
  },
  {
    kind: 'shot',
    name: 'processing',
    start: T.processing,
    end: T.gallery,
    enter: 'whip',
    exit: 'whip',
    clip: 'processing',
    layout: 'split',
    kicker: 'On our own backend',
    title: 'Lumi studies / *every photo.*',
    titleAt: 0.2,
    segs: [
      { from: 1.0, to: 9.95, dur: T.gallery - T.processing - 1.1 },
      { from: 9.95, to: 11.8, dur: 1.1 },
    ],
    cam: [
      { t: 1.0, z: 1.35, x: 800, y: 330 },
      { t: 5.5, z: 1.3, x: 800, y: 560 },
      { t: 9.6, z: 1.35, x: 800, y: 350 },
      { t: 10.3, z: 1.0 },
    ],
    aside: (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 30, width: 540 }}>
        {TECH.map((tch, i) => (
          <Chip key={tch.label} label={tch.label} sub={tch.sub} dot={tch.dot} at={0.55 + i * 0.4643} style={{ fontSize: 22, padding: '10px 18px 10px 14px' }} />
        ))}
      </div>
    ),
    overlay: <SpeedBadge text="Sped up 10×" />,
  },
  {
    kind: 'shot',
    name: 'gallery',
    start: T.gallery,
    end: T.people,
    enter: 'whip',
    exit: 'whip',
    clip: 'gallery',
    layout: 'split',
    kicker: 'Moments',
    title: 'Sorted into / *moments.*',
    body: '4 moments, 7 people, 12 photos. Grouped and named by Lumi.',
    pose: 'sort',
    segs: [
      { from: 0.2, to: 1.5, dur: 1.2 },
      { from: 1.5, to: 8.6, dur: T.people - T.gallery - 1.2 },
    ],
    cam: [
      { t: 0.2, z: 1.55, x: 420, y: 200 },
      { t: 1.5, z: 1.3, x: 420, y: 210 },
      { t: 2.6, z: 1.15, x: 700, y: 500 },
      { t: 8.6, z: 1.15, x: 700, y: 500 },
    ],
  },
  {
    kind: 'shot',
    name: 'people',
    start: T.people,
    end: T.search,
    enter: 'whip',
    exit: 'whip',
    clip: 'people',
    layout: 'split',
    kicker: 'People',
    title: 'Knows / *who’s who.*',
    body: 'Face and body recognition finds each friend in every photo, even turned away.',
    pose: 'tag',
    segs: [
      { from: 0.6, to: 1.6, dur: 0.8 },
      { from: 1.6, to: 3.45, dur: T.search - T.people - 0.8 },
    ],
    cam: [
      { t: 0.6, z: 1.3, x: 520, y: 440 },
      { t: c('people', 0).t, z: 1.6, x: c('people', 0).x, y: c('people', 0).y },
      { t: 1.7, z: 1.1, x: 820, y: 620 },
      { t: 2.3, z: 2.2, x: 898, y: 668 },
      { t: 3.45, z: 2.35, x: 898, y: 668 },
    ],
  },
  {
    kind: 'shot',
    name: 'search',
    start: T.search,
    end: T.why,
    enter: 'whip',
    exit: 'zoom',
    clip: 'search',
    layout: 'full',
    kicker: 'Search',
    title: 'Search in plain words.',
    titleAt: 0.3,
    segs: [
      { from: 1.55, to: 4.4, dur: 2.2 },
      { from: 4.4, to: 7.4, dur: T.why - T.search - 2.2 },
    ],
    cam: [
      { t: 1.55, z: 1.25, x: 1150, y: 330 },
      { t: 2.1, z: 2.0, x: 1194, y: 327 },
      { t: 4.0, z: 2.0, x: 1194, y: 327 },
      { t: 4.8, z: 1.05, x: 800, y: 560 },
      { t: 7.4, z: 1.3, x: 600, y: 560 },
    ],
  },
  {
    kind: 'shot',
    name: 'why',
    start: T.why,
    end: T.taste,
    enter: 'zoom',
    exit: 'whip',
    clip: 'why',
    layout: 'split',
    kicker: 'Best shot',
    title: 'Picks the best shot. / *Tells you why.*',
    body: 'Sharpness, open eyes, pose and aesthetics, scored and explained.',
    pose: 'star',
    segs: [
      { from: 1.9, to: 2.9, dur: 1.0 },
      { from: 2.9, to: 8.6, dur: T.taste - T.why - 1.0 },
    ],
    cam: [
      { t: 1.9, z: 1.3, x: 420, y: 700 },
      { t: c('why', 0).t, z: 1.55, x: c('why', 0).x, y: c('why', 0).y },
      { t: 3.3, z: 1.05, x: 800, y: 450 },
      { t: 4.2, z: 1.8, x: 830, y: 410 },
      { t: 6.3, z: 1.8, x: 830, y: 420 },
      { t: 7.3, z: 1.5, x: 800, y: 640 },
      { t: 8.6, z: 1.45, x: 800, y: 650 },
    ],
  },
  {
    kind: 'shot',
    name: 'taste',
    start: T.taste,
    end: T.album,
    enter: 'whip',
    exit: 'zoom',
    clip: 'taste',
    layout: 'split',
    kicker: 'Learns you',
    title: 'Disagree? / It learns / *your taste.*',
    body: 'Swap in the photo you prefer. Lumina updates what it looks for.',
    pose: 'think',
    segs: [
      { from: 1.9, to: 5.4, dur: 2.9 },
      { from: 6.6, to: 11.0, dur: T.album - T.taste - 2.9 },
    ],
    cam: [
      { t: 1.9, z: 1.2, x: 1150, y: 600 },
      { t: c('taste', 0).t, z: 1.65, x: c('taste', 0).x, y: c('taste', 0).y },
      { t: 3.7, z: 1.6, x: 800, y: 845 },
      { t: 5.4, z: 1.6, x: 800, y: 845 },
      { t: 6.6, z: 1.2, x: 900, y: 300 },
      { t: c('taste', 1).t, z: 1.5, x: c('taste', 1).x, y: c('taste', 1).y },
      { t: 7.9, z: 1.6, x: 930, y: 470 },
      { t: 11.0, z: 1.75, x: 930, y: 470 },
    ],
  },
  {
    kind: 'shot',
    name: 'album',
    start: T.album,
    end: T.albumPages,
    enter: 'zoom',
    exit: 'zoom',
    clip: 'album',
    layout: 'full',
    kicker: 'Create album',
    title: 'Pick a theme. Lumi does the rest.',
    titleAt: 0.2,
    segs: [
      { from: 1.6, to: 5.9, dur: 1.4 },
      { from: 5.9, to: 9.0, dur: T.albumPages - T.album - 1.4 },
    ],
    cam: [
      { t: 1.6, z: 1.15, x: 800, y: 450 },
      { t: c('album', 1).t, z: 1.7, x: 800, y: 200 },
      { t: 4.8, z: 1.7, x: 800, y: 200 },
      { t: c('album', 2).t, z: 1.55, x: 733, y: 330 },
      { t: c('album', 4).t, z: 1.7, x: 800, y: 800 },
      { t: 9.0, z: 1.8, x: 800, y: 800 },
    ],
  },
  {
    kind: 'custom',
    name: 'album pages',
    start: T.albumPages,
    end: T.video,
    enter: 'zoom',
    exit: 'whip',
    render: (dur, start) => <AlbumPages start={start} dur={dur} />,
  },
  {
    kind: 'shot',
    name: 'video',
    start: T.video,
    end: T.cleanup,
    enter: 'whip',
    exit: 'whip',
    clip: 'video',
    layout: 'split',
    kicker: 'Create video',
    title: 'A movie, / *cut to the beat.*',
    body: '1080p, landscape or 9:16, with music and Lumi.',
    pose: 'camera',
    segs: [
      { from: 3.6, to: 7.7, dur: 2.2 },
      { from: 7.7, to: 11.4, dur: T.cleanup - T.video - 2.2 },
    ],
    cam: [
      { t: 3.6, z: 1.45, x: 560, y: 470 },
      { t: 7.7, z: 1.3, x: 700, y: 400 },
      { t: c('video', 1).t, z: 1.55, x: c('video', 1).x, y: c('video', 1).y },
      { t: 9.2, z: 1.45, x: 470, y: 480 },
      { t: 11.4, z: 1.5, x: 470, y: 480 },
    ],
  },
  {
    kind: 'shot',
    name: 'cleanup',
    start: T.cleanup,
    end: T.world,
    enter: 'whip',
    exit: 'zoom',
    clip: 'cleanup',
    layout: 'full',
    kicker: 'Cleanup',
    title: 'Blinks and duplicates, set aside.',
    titleAt: 0.3,
    segs: [{ from: 0.5, to: 5.4, dur: T.world - T.cleanup }],
    cam: [
      { t: 0.5, z: 1.3, x: 500, y: 330 },
      { t: c('cleanup', 0).t, z: 1.6, x: c('cleanup', 0).x, y: c('cleanup', 0).y },
      { t: 1.5, z: 1.3, x: 500, y: 560 },
      { t: 5.4, z: 1.45, x: 420, y: 640 },
    ],
  },
  {
    kind: 'shot',
    name: 'world',
    start: T.world,
    end: T.end,
    enter: 'zoom',
    exit: 'zoom',
    clip: 'world',
    layout: 'full',
    morph: { to: 'bleed', from: 0.6, until: 1.5 },
    segs: [
      { from: 3.45, to: 4.3, dur: 0.55 },
      { from: 5.9, to: 11.0, dur: 3.35 },
      { from: 11.0, to: 14.3, dur: 3.0 },
      { from: 14.3, to: 25.3, dur: T.end - T.world - 0.55 - 3.35 - 3.0 },
    ],
    cam: [
      { t: 3.45, z: 1.3, x: 1300, y: 260 },
      { t: c('world', 1).t, z: 1.6, x: c('world', 1).x, y: c('world', 1).y },
      { t: 5.9, z: 1.25, x: 800, y: 520 },
      { t: 10.5, z: 1.1, x: 800, y: 480 },
      { t: 11.5, z: 1.0 },
      { t: 14.3, z: 1.0 },
      { t: 15.0, z: 1.12, x: 800, y: 500 },
      { t: 25.3, z: 1.12, x: 800, y: 500 },
    ],
  },
  {
    kind: 'custom',
    name: 'end card',
    start: T.end,
    end: SONG.end,
    enter: 'zoom',
    exit: 'cut',
    render: (dur) => <EndCard dur={dur} />,
  },
];

/* --------------------------------------------------------------- helpers */

function SpeedBadge({ text }: { text: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 24,
        right: 24,
        padding: '10px 18px',
        borderRadius: 999,
        background: 'rgba(24, 18, 42, .85)',
        color: '#fff',
        fontFamily: textFont,
        fontWeight: 800,
        fontSize: 24,
        letterSpacing: '0.04em',
      }}
    >
      {text}
    </div>
  );
}

/** Song time at which a clip moment plays inside a shot, or null if cut. */
const songTimeOf = (start: number, segs: Seg[], clipT: number) => {
  let at = 0;
  for (const g of segs) {
    if (clipT >= g.from && clipT <= g.to) return start + at + ((clipT - g.from) / (g.to - g.from)) * g.dur;
    at += g.dur;
  }
  return null;
};

/** World shot: big type over the island. */
const WorldTitles: React.FC = () => {
  const t = useT();
  const k = lerp(t, [4.2, 4.5], [0, 1]);
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', paddingBottom: 380 }}>
        <Headline text="Then, / step inside." at={1.0} out={3.2} size={150} align="center" color="#fff" style={{ textShadow: '0 10px 50px rgba(30, 15, 60, .45)' }} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 70, display: 'flex', justifyContent: 'center', gap: 16, opacity: k }}>
        <Chip label="Lumi’s island" sub="· your moments on easels" at={4.3} out={7.2} dark />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 70, display: 'flex', justifyContent: 'center', gap: 14 }}>
        {[
          ['W A S D', 'run'],
          ['Q', 'sprint'],
          ['Space', 'jump'],
          ['E', 'look'],
        ].map(([key, what], i) => (
          <Chip key={key} label={key} sub={`· ${what}`} at={8.0 + i * 0.4643} out={14.6} dark dot={[COLORS.lavender, COLORS.rose, COLORS.peach, COLORS.lavender][i]} />
        ))}
      </div>
    </>
  );
};

/* ----------------------------------------------------------------- video */

export const LuminaDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const dark = lerp(t, [SONG.build - 0.6, SONG.build + 0.3], [1, 0]);

  // Sound effects: whooshes on whips, clicks where the recording clicked.
  const sfx: { at: number; src: string; volume: number }[] = [];
  for (const s of PLAN) {
    if (s.enter === 'whip' || s.enter === 'zoom') sfx.push({ at: s.start - 0.3, src: 'sfx/whoosh.wav', volume: s.enter === 'whip' ? 0.35 : 0.25 });
    if (s.kind !== 'shot') continue;
    for (const e of CLIPS[s.clip].events) {
      if (e.type !== 'click') continue;
      const at = songTimeOf(s.start, s.segs, e.t);
      if (at !== null && at > s.start + 0.05 && at < s.end - 0.05) sfx.push({ at, src: 'sfx/click.wav', volume: 0.45 });
    }
  }
  for (const at of [SONG.drop1, SONG.drop2, SONG.finalHit]) sfx.push({ at, src: 'sfx/impact.wav', volume: 0.55 });
  sfx.push({ at: BEATS[12], src: 'sfx/sparkle.wav', volume: 0.4 });
  sfx.push({ at: SONG.finalHit + 0.3, src: 'sfx/sparkle.wav', volume: 0.35 });

  return (
    <AbsoluteFill style={{ background: COLORS.plum }}>
      <Background dark={dark} />

      <Scene start={0} end={SONG.build} exit="fade" name="cold open">
        <ColdOpen />
      </Scene>

      {PLAN.map((s) => (
        <Scene key={s.name} name={s.name} start={s.start} end={s.end} enter={s.enter} exit={s.exit}>
          {s.kind === 'custom' ? (
            s.render(s.end - s.start, s.start)
          ) : (
            <ShotWithTitles def={s} />
          )}
        </Scene>
      ))}

      <Flash at={SONG.drop1} strength={0.95} />
      <Flash at={SONG.drop2} strength={0.95} />
      <Flash at={SONG.finalHit} strength={0.9} />
      <Flash at={SONG.build} dur={0.4} strength={0.5} />
      <Flash at={T.world + 0.55} dur={0.35} strength={0.6} />

      <Vignette strength={0.28} />
      <Grain opacity={0.06} />

      <Audio
        src={staticFile('audio/track.mp3')}
        volume={(fr) => lerp(fr / FPS, [0, 0.3, SONG.end - 2.2, SONG.end], [0, 1, 1, 0])}
      />
      {sfx.map((s, i) => (
        <Sequence key={i} from={Math.max(0, f(s.at))} durationInFrames={f(1.6)} layout="none">
          <Audio src={staticFile(s.src)} volume={s.volume} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const ShotWithTitles: React.FC<{ def: ShotDef }> = ({ def }) => {
  const { kind: _k, name: _n, start: _s, end: _e, enter: _en, exit: _ex, ...shot } = def;
  return (
    <>
      <AppShot {...shot} />
      {def.name === 'world' && <WorldTitles />}
    </>
  );
};
