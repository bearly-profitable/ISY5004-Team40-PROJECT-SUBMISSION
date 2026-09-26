/**
 * The island's low-poly scenery kit. Every prop is a handful of flat-shaded
 * primitives; each part is drawn as one InstancedMesh, so hundreds of trees
 * cost a few draw calls.
 */
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Placement, PropKind } from './layout';

interface Part {
  geometry: THREE.BufferGeometry;
  /** One colour, or a palette picked per instance by `Placement.tint`. */
  color: string | string[];
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  emissive?: string;
  castShadow?: boolean;
}

const GREENS = ['#6dbb5a', '#7fcf63', '#5aa84f', '#8fd46b', '#68b35e'];
const BLOOMS = ['#ff9ecb', '#ffd166', '#b9a6ff', '#ff8a7a', '#ffffff'];
const BALLOONS = ['#ff8fb8', '#ffd166', '#9ad0ff', '#c3a6ff', '#8ee3b5'];
const UMBRELLAS = ['#ff9eb6', '#ffd38a', '#a8d8ff', '#c9b6ff', '#ffb38a'];

const trunk = new THREE.CylinderGeometry(0.1, 0.16, 1, 5);
const ico = new THREE.IcosahedronGeometry(1, 0);
const cone6 = new THREE.ConeGeometry(1, 1, 6);
const cone4 = new THREE.ConeGeometry(1, 1, 4);
const rockGeo = new THREE.DodecahedronGeometry(1, 0);
const ball = new THREE.SphereGeometry(1, 7, 5);
const disc = new THREE.CylinderGeometry(1, 1, 1, 8);
const thin = new THREE.CylinderGeometry(1, 1, 1, 4);
const box = new THREE.BoxGeometry(1, 1, 1);

const palmLeaves: Part[] = [0, 1, 2, 3, 4].map((i) => ({
  geometry: cone4,
  color: GREENS,
  position: [Math.cos((i / 5) * Math.PI * 2) * 0.55, 2.55, Math.sin((i / 5) * Math.PI * 2) * 0.55],
  // Lay each leaf down, pointing outward and drooping a little.
  rotation: [0, -(i / 5) * Math.PI * 2, -Math.PI / 2 - 0.35],
  scale: [0.22, 1.25, 0.06],
}));

export const PROPS: Record<PropKind, Part[]> = {
  tree: [
    { geometry: trunk, color: '#a47551', position: [0, 0.5, 0], scale: [1, 1, 1] },
    { geometry: ico, color: GREENS, position: [0, 1.55, 0], scale: [0.85, 0.95, 0.85] },
    { geometry: ico, color: GREENS, position: [0.28, 2.15, 0.08], scale: [0.55, 0.6, 0.55] },
  ],
  pine: [
    { geometry: trunk, color: '#8c6242', position: [0, 0.3, 0], scale: [0.9, 0.6, 0.9] },
    { geometry: cone6, color: '#4f9a5a', position: [0, 1.1, 0], scale: [0.9, 1.3, 0.9] },
    { geometry: cone6, color: '#5aa864', position: [0, 1.75, 0], scale: [0.68, 1.1, 0.68] },
    { geometry: cone6, color: '#66b56d', position: [0, 2.3, 0], scale: [0.45, 0.9, 0.45] },
  ],
  snowPine: [
    { geometry: trunk, color: '#8c6242', position: [0, 0.3, 0], scale: [0.9, 0.6, 0.9] },
    { geometry: cone6, color: '#5d9c78', position: [0, 1.1, 0], scale: [0.9, 1.3, 0.9] },
    { geometry: cone6, color: '#e8f1f7', position: [0, 1.75, 0], scale: [0.68, 1.1, 0.68] },
    { geometry: cone6, color: '#ffffff', position: [0, 2.3, 0], scale: [0.45, 0.9, 0.45] },
  ],
  palm: [
    { geometry: trunk, color: '#c49a6c', position: [0.05, 0.6, 0], rotation: [0, 0, -0.06], scale: [1, 1.2, 1] },
    { geometry: trunk, color: '#b98d5f', position: [0.18, 1.75, 0], rotation: [0, 0, -0.16], scale: [0.85, 1.2, 0.85] },
    { geometry: ball, color: '#7a5a3a', position: [0.3, 2.35, 0.1], scale: [0.14, 0.14, 0.14] },
    ...palmLeaves.map((leaf) => ({ ...leaf, position: [leaf.position![0] + 0.28, leaf.position![1], leaf.position![2]] as [number, number, number] })),
  ],
  bush: [
    { geometry: ico, color: GREENS, position: [0, 0.35, 0], scale: [0.55, 0.42, 0.55] },
    { geometry: ico, color: GREENS, position: [0.38, 0.25, 0.12], scale: [0.36, 0.3, 0.36] },
  ],
  rock: [
    { geometry: rockGeo, color: ['#b8b4ae', '#a9a49c', '#c4c0b9', '#9d978f', '#b0aaa2'], position: [0, 0.18, 0], scale: [0.55, 0.36, 0.48] },
  ],
  flower: [
    { geometry: thin, color: '#5aa84f', position: [0, 0.2, 0], scale: [0.025, 0.4, 0.025], castShadow: false },
    { geometry: ico, color: BLOOMS, position: [0, 0.44, 0], scale: [0.12, 0.1, 0.12], castShadow: false },
  ],
  balloon: [
    { geometry: thin, color: '#ffffff', position: [0, 0.75, 0], scale: [0.008, 1.5, 0.008], castShadow: false },
    { geometry: ball, color: BALLOONS, position: [0, 1.75, 0], scale: [0.28, 0.33, 0.28] },
  ],
  table: [
    { geometry: disc, color: '#fff6ea', position: [0, 0.72, 0], scale: [0.55, 0.06, 0.55] },
    { geometry: thin, color: '#8c6242', position: [0, 0.36, 0], scale: [0.05, 0.72, 0.05] },
    { geometry: thin, color: '#ffffff', position: [0, 1.4, 0], scale: [0.025, 1.4, 0.025] },
    { geometry: cone6, color: UMBRELLAS, position: [0, 2.15, 0], scale: [1.05, 0.4, 1.05] },
  ],
  lantern: [
    { geometry: thin, color: '#4a3d58', position: [0, 0.8, 0], scale: [0.05, 1.6, 0.05] },
    { geometry: box, color: '#ffe3a3', emissive: '#ffc766', position: [0, 1.75, 0], scale: [0.28, 0.34, 0.28] },
    { geometry: cone4, color: '#4a3d58', position: [0, 2.02, 0], rotation: [0, Math.PI / 4, 0], scale: [0.26, 0.18, 0.26] },
  ],
  snowman: [
    { geometry: ball, color: '#ffffff', position: [0, 0.5, 0], scale: [0.55, 0.5, 0.55] },
    { geometry: ball, color: '#ffffff', position: [0, 1.18, 0], scale: [0.38, 0.36, 0.38] },
    { geometry: ball, color: '#ffffff', position: [0, 1.7, 0], scale: [0.26, 0.26, 0.26] },
    { geometry: cone4, color: '#ff9a4d', position: [0, 1.7, 0.3], rotation: [Math.PI / 2, 0, 0], scale: [0.05, 0.22, 0.05] },
  ],
};

const tmpA = new THREE.Matrix4();
const tmpB = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

function partMatrix(part: Part): THREE.Matrix4 {
  const [px, py, pz] = part.position ?? [0, 0, 0];
  const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
  const [sx, sy, sz] = part.scale ?? [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

function placementMatrix(p: Placement, lift = 0): THREE.Matrix4 {
  tmpQ.setFromEuler(tmpE.set(0, p.rot, 0));
  return tmpA.compose(tmpV.set(p.x, lift, p.z), tmpQ, tmpS.setScalar(p.scale));
}

const PartInstances: React.FC<{ part: Part; placements: Placement[]; shadows: boolean; bob?: boolean }> = ({
  part, placements, shadows, bob,
}) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const local = useMemo(() => partMatrix(part), [part]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: Array.isArray(part.color) ? '#ffffff' : part.color,
    flatShading: true,
    roughness: 0.85,
    emissive: part.emissive ?? '#000000',
    emissiveIntensity: part.emissive ? 1.2 : 0,
  }), [part]);
  useLayoutEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    placements.forEach((p, i) => {
      mesh.setMatrixAt(i, tmpB.multiplyMatrices(placementMatrix(p), local));
      if (Array.isArray(part.color)) mesh.setColorAt(i, tmpC.set(part.color[(p.tint ?? 0) % part.color.length]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements, local, part]);

  // Balloons tug gently on their strings.
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!bob || !mesh) return;
    const t = clock.elapsedTime;
    placements.forEach((p, i) => {
      mesh.setMatrixAt(i, tmpB.multiplyMatrices(placementMatrix(p, Math.sin(t * 1.3 + i * 1.7) * 0.08), local));
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (placements.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      args={[part.geometry, material, placements.length]}
      castShadow={shadows && part.castShadow !== false}
      receiveShadow={false}
    />
  );
};

export const PropField: React.FC<{ kind: PropKind; placements: Placement[]; shadows: boolean }> = ({ kind, placements, shadows }) => (
  <>
    {PROPS[kind].map((part, i) => (
      // key on count: an InstancedMesh cannot grow after it is created.
      <PartInstances key={`${i}-${placements.length}`} part={part} placements={placements} shadows={shadows} bob={kind === 'balloon'} />
    ))}
  </>
);
