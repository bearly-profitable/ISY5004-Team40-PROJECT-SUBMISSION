/**
 * Movement effects: dust kicked up by Lumi's feet, and the afterimages she
 * leaves behind while sprinting.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { WorldRuntime } from './runtime';

/* ------------------------------------------------------------------ */
/* Dust: a pool of low-poly puffs that swell, drift and shrink away    */
/* ------------------------------------------------------------------ */

const DUST = 72;

export const Dust: React.FC<{ runtime: React.MutableRefObject<WorldRuntime> }> = ({ runtime }) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const parts = useMemo(() => ({
    pos: new Float32Array(DUST * 3),
    vel: new Float32Array(DUST * 3),
    age: new Float32Array(DUST).fill(1),
    life: new Float32Array(DUST).fill(1),
    size: new Float32Array(DUST),
    spin: new Float32Array(DUST),
    next: 0,
  }), []);
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 0), []);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#fffaf0', emissive: '#fff6e6', emissiveIntensity: 0.45, flatShading: true, roughness: 1,
    transparent: true, opacity: 0.82, depthWrite: false,
  }), []);
  useLayoutEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useEffect(() => {
    const rt = runtime.current;
    rt.fx = {
      dust: (x, z, count, power) => {
        for (let n = 0; n < count; n++) {
          const i = parts.next;
          parts.next = (parts.next + 1) % DUST;
          const a = Math.random() * Math.PI * 2;
          const out = (0.6 + Math.random() * 1.2) * power;
          parts.pos.set([x + Math.cos(a) * 0.15, 0.08, z + Math.sin(a) * 0.15], i * 3);
          parts.vel.set([Math.cos(a) * out, (0.9 + Math.random() * 1.2) * power, Math.sin(a) * out], i * 3);
          parts.age[i] = 0;
          parts.life[i] = 0.4 + Math.random() * 0.4;
          parts.size[i] = (0.09 + Math.random() * 0.1) * (0.8 + power * 0.4);
          parts.spin[i] = Math.random() * Math.PI;
        }
      },
    };
    return () => { rt.fx = null; };
  }, [runtime, parts]);

  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const s = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, rawDt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);
    const drag = Math.exp(-3.5 * dt);
    for (let i = 0; i < DUST; i++) {
      if (parts.age[i] >= parts.life[i]) {
        mesh.setMatrixAt(i, m.makeScale(0, 0, 0));
        continue;
      }
      parts.age[i] += dt;
      const k = i * 3;
      parts.vel[k] *= drag;
      parts.vel[k + 2] *= drag;
      parts.vel[k + 1] = parts.vel[k + 1] * drag - 0.25 * dt; // dust hangs in the air
      parts.pos[k] += parts.vel[k] * dt;
      parts.pos[k + 1] = Math.max(0.05, parts.pos[k + 1] + parts.vel[k + 1] * dt);
      parts.pos[k + 2] += parts.vel[k + 2] * dt;
      const t = Math.min(1, parts.age[i] / parts.life[i]);
      const r = parts.size[i] * Math.sin(Math.PI * Math.sqrt(t)); // swell fast, fade slow
      mesh.setMatrixAt(i, m.compose(
        p.set(parts.pos[k], parts.pos[k + 1], parts.pos[k + 2]),
        q.setFromEuler(e.set(parts.spin[i], parts.spin[i] * 1.3 + t, 0)),
        s.setScalar(Math.max(0, r)),
      ));
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[geometry, material, DUST]} frustumCulled={false} />;
};

/* ------------------------------------------------------------------ */
/* Afterimages: frozen, fading copies of Lumi's pose while sprinting   */
/* ------------------------------------------------------------------ */

const GHOSTS = 7;
const GHOST_LIFE = 0.34;
const GHOST_EVERY = 0.05;

export const SprintGhosts: React.FC<{
  model: THREE.Object3D;
  /** The group whose world transform is Lumi's (position, facing, waddle). */
  source: React.RefObject<THREE.Object3D | null>;
  runtime: React.MutableRefObject<WorldRuntime>;
}> = ({ model, source, runtime }) => {
  const ghosts = useMemo(() => {
    const srcNodes: THREE.Object3D[] = [];
    model.traverse((n) => { srcNodes.push(n); });
    return Array.from({ length: GHOSTS }, (_, i) => {
      const inner = cloneSkinned(model);
      const material = new THREE.MeshBasicMaterial({
        color: i % 2 ? '#c7b3ff' : '#ffc2dc', transparent: true, opacity: 0, depthWrite: false,
      });
      const nodes: THREE.Object3D[] = [];
      inner.traverse((n) => {
        nodes.push(n);
        const mesh = n as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.material = material;
          mesh.castShadow = false;
          mesh.frustumCulled = false;
        }
      });
      const wrap = new THREE.Group();
      wrap.add(inner);
      wrap.visible = false;
      return { wrap, nodes, srcNodes, material, age: GHOST_LIFE };
    });
  }, [model]);
  useLayoutEffect(() => () => ghosts.forEach((g) => g.material.dispose()), [ghosts]);

  const timer = useRef(0);
  const next = useRef(0);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const rt = runtime.current;
    const src = source.current;
    timer.current += dt;
    if (src && rt.sprint > 0.6 && rt.speed > 7 && timer.current >= GHOST_EVERY) {
      timer.current = 0;
      const g = ghosts[next.current];
      next.current = (next.current + 1) % GHOSTS;
      src.updateWorldMatrix(true, false);
      src.matrixWorld.decompose(g.wrap.position, g.wrap.quaternion, g.wrap.scale);
      // Freeze the current pose (bones and all) into the copy.
      for (let i = 0; i < g.nodes.length && i < g.srcNodes.length; i++) {
        g.nodes[i].position.copy(g.srcNodes[i].position);
        g.nodes[i].quaternion.copy(g.srcNodes[i].quaternion);
        g.nodes[i].scale.copy(g.srcNodes[i].scale);
      }
      g.age = 0;
      g.wrap.visible = true;
    }
    for (const g of ghosts) {
      if (!g.wrap.visible) continue;
      g.age += dt;
      const t = g.age / GHOST_LIFE;
      if (t >= 1) { g.wrap.visible = false; continue; }
      g.material.opacity = 0.55 * (1 - t) * (1 - t);
    }
  });

  return (
    <>
      {ghosts.map((g, i) => <primitive key={i} object={g.wrap} />)}
    </>
  );
};
