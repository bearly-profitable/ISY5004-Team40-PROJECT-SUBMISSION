/**
 * Photos on easels, a notice board in each clearing, and the plaza's welcome
 * sign. Photo textures load only as Lumi walks near and are freed again
 * once she is far away, so a large library stays light on memory.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { lumiSrc, type LumiPose } from '../components/Lumi';
import type { FrameSpot, WorldLayout, Zone } from './layout';
import type { WorldRuntime } from './runtime';

const LOAD_WITHIN = 24;
const FREE_BEYOND = 34;
/** Past the fog, nothing needs drawing. */
const DRAW_WITHIN = 58;
const MAX_PHOTO = 1.3;
const EASEL_FOOT = 0.78;

/* ------------------------------------------------------------------ */
/* Texture queue: a few downloads at a time, nearest first             */
/* ------------------------------------------------------------------ */

const loader = new THREE.TextureLoader().setCrossOrigin('anonymous');
const queue: Array<{ url: string; priority: () => number; done: (tex: THREE.Texture | null) => void; cancelled: boolean }> = [];
let active = 0;
const MAX_ACTIVE = 4;

function pump() {
  while (active < MAX_ACTIVE && queue.length > 0) {
    queue.sort((a, b) => a.priority() - b.priority());
    const job = queue.shift()!;
    if (job.cancelled) continue;
    active += 1;
    loader.load(
      job.url,
      (tex) => {
        active -= 1;
        if (job.cancelled) tex.dispose();
        else job.done(tex);
        pump();
      },
      undefined,
      () => {
        active -= 1;
        if (!job.cancelled) job.done(null);
        pump();
      },
    );
  }
}

function requestTexture(url: string, priority: () => number, done: (tex: THREE.Texture | null) => void): () => void {
  const job = { url, priority, done, cancelled: false };
  queue.push(job);
  pump();
  return () => { job.cancelled = true; };
}

/* ------------------------------------------------------------------ */
/* Easel                                                               */
/* ------------------------------------------------------------------ */

const legGeo = new THREE.BoxGeometry(0.07, 1, 0.07);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const planeGeo = new THREE.PlaneGeometry(1, 1);
const woodMat = new THREE.MeshStandardMaterial({ color: '#c8966a', flatShading: true, roughness: 0.9 });
const placeholderMat = new THREE.MeshBasicMaterial({ color: '#e7def2' });

function photoSize(aspect: number): [number, number] {
  return aspect >= 1 ? [MAX_PHOTO, MAX_PHOTO / aspect] : [MAX_PHOTO * aspect, MAX_PHOTO];
}

const Easel: React.FC<{
  spot: FrameSpot;
  runtime: React.MutableRefObject<WorldRuntime>;
  onOpen: (zone: number, photoIndex: number, kind?: 'photo' | 'board') => void;
}> = ({ spot, runtime, onOpen }) => {
  const group = useRef<THREE.Group>(null);
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [aspect, setAspect] = useState(spot.photo.aspect ?? 4 / 3);
  const cancel = useRef<(() => void) | null>(null);
  const tick = useRef(Math.floor(Math.random() * 12));
  const glow = useRef(0);

  const frameMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#fffaf2', flatShading: true, roughness: 0.7, emissive: '#ffc86b', emissiveIntensity: 0,
  }), []);
  const photoMat = useMemo(() => (texture ? new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) : null), [texture]);

  useEffect(() => () => {
    cancel.current?.();
    frameMat.dispose();
  }, [frameMat]);
  useEffect(() => () => { photoMat?.dispose(); texture?.dispose(); }, [texture, photoMat]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const rt = runtime.current;
    // Distance checks a few times a second are plenty.
    if (++tick.current % 12 === 0) {
      const d = Math.hypot(rt.pos.x - spot.x, rt.pos.z - spot.z);
      g.visible = d < DRAW_WITHIN;
      if (d < LOAD_WITHIN && !texture && !cancel.current) {
        cancel.current = requestTexture(
          spot.photo.thumbUrl,
          () => Math.hypot(runtime.current.pos.x - spot.x, runtime.current.pos.z - spot.z),
          (tex) => {
            if (!tex) return; // leave the placeholder; the Lightbox still opens
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = 4;
            const img = tex.image as { width?: number; height?: number } | undefined;
            if (img?.width && img?.height) setAspect(img.width / img.height);
            setTexture(tex);
          },
        );
      } else if (d > FREE_BEYOND && (texture || cancel.current)) {
        cancel.current?.();
        cancel.current = null;
        setTexture(null);
      }
    }
    // Glow and lift a little when Lumi can look at it.
    const target = rt.nearestId === spot.id ? 1 : 0;
    glow.current += (target - glow.current) * Math.min(1, dt * 8);
    frameMat.emissiveIntensity = glow.current * 0.9;
    g.scale.setScalar(1 + glow.current * 0.06);
  });

  const [w, h] = photoSize(aspect);
  const centreY = EASEL_FOOT + h / 2 + 0.06;
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onOpen(spot.zone, spot.photoIndex);
  };

  return (
    <group ref={group} position={[spot.x, 0, spot.z]} rotation-y={spot.rotY}>
      {/* legs: two in front, one behind */}
      <mesh geometry={legGeo} material={woodMat} position={[-w / 2 + 0.12, 0.95, 0.08]} scale={[1, 1.9, 1]} rotation-x={0.08} castShadow />
      <mesh geometry={legGeo} material={woodMat} position={[w / 2 - 0.12, 0.95, 0.08]} scale={[1, 1.9, 1]} rotation-x={0.08} castShadow />
      <mesh geometry={legGeo} material={woodMat} position={[0, 0.85, -0.32]} scale={[1, 1.75, 1]} rotation-x={-0.35} castShadow />
      <group position={[0, centreY, 0]} rotation-x={-0.08}>
        {/* shelf */}
        <mesh geometry={boxGeo} material={woodMat} position={[0, -h / 2 - 0.1, 0.05]} scale={[w + 0.3, 0.06, 0.2]} castShadow />
        {/* frame */}
        <mesh geometry={boxGeo} material={frameMat} scale={[w + 0.14, h + 0.14, 0.06]} castShadow />
        {/* the photo, on both faces so it reads from anywhere */}
        <mesh
          geometry={planeGeo}
          material={photoMat ?? placeholderMat}
          position={[0, 0, 0.032]}
          scale={[w, h, 1]}
          onClick={click}
          onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { document.body.style.cursor = ''; }}
        />
        <mesh
          geometry={planeGeo}
          material={photoMat ?? placeholderMat}
          position={[0, 0, -0.032]}
          rotation-y={Math.PI}
          scale={[w, h, 1]}
          onClick={click}
        />
      </group>
    </group>
  );
};

/* ------------------------------------------------------------------ */
/* Signs                                                               */
/* ------------------------------------------------------------------ */

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

/** A cream card with Lumi on the left and the words on the right. */
async function signTexture(title: string, lines: string[], pose: LumiPose): Promise<THREE.CanvasTexture> {
  await Promise.all([
    document.fonts?.load('600 72px Fraunces').catch(() => undefined),
    document.fonts?.load('800 48px Nunito').catch(() => undefined),
  ]);
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fffaf2';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#c9b8e6';
  ctx.lineWidth = 18;
  ctx.strokeRect(9, 9, W - 18, H - 18);

  const lumi = await loadImage(lumiSrc(pose));
  if (lumi) {
    const scale = Math.min(300 / lumi.width, 420 / lumi.height);
    const w = lumi.width * scale;
    const h = lumi.height * scale;
    ctx.drawImage(lumi, 40 + (300 - w) / 2, (H - h) / 2, w, h);
  }
  const left = 370;
  const maxW = W - left - 50;
  let size = 88;
  ctx.font = `600 ${size}px Fraunces, Georgia, serif`;
  let titleLines = wrapLines(ctx, title, maxW, 2);
  while (titleLines.some((l) => ctx.measureText(l).width > maxW) && size > 52) {
    size -= 4;
    ctx.font = `600 ${size}px Fraunces, Georgia, serif`;
    titleLines = wrapLines(ctx, title, maxW, 2);
  }
  ctx.fillStyle = '#251c2f';
  ctx.textBaseline = 'alphabetic';
  let y = 190 - (titleLines.length - 1) * size * 0.55;
  for (const l of titleLines) { ctx.fillText(l, left, y); y += size * 1.08; }
  ctx.font = '800 48px Nunito, sans-serif';
  ctx.fillStyle = '#7d6d8e';
  y += 22;
  for (const l of lines) { ctx.fillText(wrapLines(ctx, l, maxW, 1)[0], left, y); y += 62; }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const Sign: React.FC<{
  id: string;
  x: number;
  z: number;
  title: string;
  lines: string[];
  pose: LumiPose;
  runtime: React.MutableRefObject<WorldRuntime>;
  onClick?: () => void;
}> = ({ id, x, z, title, lines, pose, runtime, onClick }) => {
  const group = useRef<THREE.Group>(null);
  const [tex, setTex] = useState<THREE.CanvasTexture | null>(null);
  const glow = useRef(0);
  const tick = useRef(Math.floor(Math.random() * 12));
  const boardMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#c8966a', flatShading: true, roughness: 0.9, emissive: '#ffc86b', emissiveIntensity: 0,
  }), []);
  const faceMat = useMemo(() => (tex ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : null), [tex]);
  const key = `${title}|${lines.join('|')}|${pose}`;

  useEffect(() => {
    let live = true;
    signTexture(title, lines, pose).then((t) => { if (live) setTex(t); else t.dispose(); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { tex?.dispose(); faceMat?.dispose(); }, [tex, faceMat]);
  useLayoutEffect(() => () => boardMat.dispose(), [boardMat]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const rt = runtime.current;
    if (++tick.current % 12 === 0) g.visible = Math.hypot(rt.pos.x - x, rt.pos.z - z) < DRAW_WITHIN;
    const target = rt.nearestId === id ? 1 : 0;
    glow.current += (target - glow.current) * Math.min(1, dt * 8);
    boardMat.emissiveIntensity = glow.current * 0.6;
  });

  return (
    <group ref={group} position={[x, 0, z]}>
      <mesh geometry={boxGeo} material={woodMat} position={[-0.95, 0.8, -0.11]} scale={[0.12, 1.6, 0.12]} castShadow />
      <mesh geometry={boxGeo} material={woodMat} position={[0.95, 0.8, -0.11]} scale={[0.12, 1.6, 0.12]} castShadow />
      <mesh geometry={boxGeo} material={boardMat} position={[0, 1.55, 0]} scale={[2.3, 1.2, 0.1]} castShadow />
      <mesh
        geometry={planeGeo}
        material={faceMat ?? placeholderMat}
        position={[0, 1.55, 0.052]}
        scale={[2.14, 1.07, 1]}
        onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      />
    </group>
  );
};

/* ------------------------------------------------------------------ */

export const PhotoFrames: React.FC<{
  layout: WorldLayout;
  runtime: React.MutableRefObject<WorldRuntime>;
  totalPhotos: number;
  onOpen: (zone: number, photoIndex: number, kind?: 'photo' | 'board') => void;
}> = ({ layout, runtime, totalPhotos, onOpen }) => (
  <group>
    {layout.frames.map((spot) => (
      <Easel key={spot.id} spot={spot} runtime={runtime} onOpen={onOpen} />
    ))}
    {layout.zones.map((zone: Zone) => (
      <Sign
        key={zone.key}
        id={`${zone.index}:board`}
        x={zone.x}
        z={zone.z}
        title={zone.title}
        lines={[zone.subtitle, `${zone.photos.length} ${zone.photos.length === 1 ? 'photo' : 'photos'}`].filter(Boolean)}
        pose={zone.pose}
        runtime={runtime}
        onClick={() => onOpen(zone.index, 0, 'board')}
      />
    ))}
    <Sign
      id="welcome"
      x={layout.welcome.x}
      z={layout.welcome.z}
      title="Lumi’s island"
      lines={[
        `${layout.zones.length} ${layout.zones.length === 1 ? 'moment' : 'moments'} · ${totalPhotos} photos`,
        'Follow the path →',
      ]}
      pose="wave"
      runtime={runtime}
    />
  </group>
);
