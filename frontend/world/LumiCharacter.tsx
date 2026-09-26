/**
 * Lumi on the island: walks where the arrow keys (or joystick) point, bumps
 * into easels and trees, and is followed by the camera.
 *
 * A model with animation clips (the Mixamo-rigged Lumi) plays idle / walk /
 * run / wave. The unrigged TRELLIS model waddles instead: the whole body
 * bobs, rocks side to side and leans into the walk, all in code.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Dust, SprintGhosts } from './effects';
import { ZONE_R, type Interactable, type WorldLayout } from './layout';
import type { WorldRuntime } from './runtime';

export const LUMI_MODEL_URL = '/world/lumi.glb';
/**
 * Extra Mixamo clips, one per file ("Without Skin", "In Place"), made by
 * tools/mascot/phase5_mixamo_import.py. Each clip is named after its file,
 * and binds to the rigged model's bones by name. Empty until Lumi is rigged.
 */
export const LUMI_ANIMATION_URLS: string[] = [];

const HEIGHT = 1.25;
const RADIUS = 0.35;
/** Lumi runs by default; Q (or the sprint button) goes faster still. */
const RUN = 6.4;
const SPRINT = 10.5;
const JUMP_SPEED = 8.2;
const GRAVITY = 24;
/** A jump pressed this long before landing still happens. */
const JUMP_BUFFER_MS = 150;
const REACH = 2.3;
const BASE_FOV = 45;

type Clip = 'idle' | 'walk' | 'run' | 'jump' | 'wave';
const CLIP_NAMES: Record<Clip, RegExp> = {
  idle: /idle|breath/i,
  walk: /walk/i,
  run: /run|jog|sprint/i,
  jump: /jump/i,
  wave: /wave|greet|hello/i,
};

function dampAngle(from: number, to: number, lambda: number, dt: number): number {
  let delta = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * (1 - Math.exp(-lambda * dt));
}

/** Scale to HEIGHT, feet on the ground, centred; shadows on, no metal look. */
function prepareModel(root: THREE.Object3D): void {
  root.position.set(0, 0, 0);
  root.scale.setScalar(1);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = HEIGHT / (size.y || 1);
  root.scale.setScalar(s);
  root.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds lag behind the animation
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).metalness = 0;
    }
  });
}

export const LumiCharacter: React.FC<{
  layout: WorldLayout;
  runtime: React.MutableRefObject<WorldRuntime>;
  shadows: boolean;
  onNearest: (target: Interactable | null) => void;
  onZone: (zone: number) => void;
  onSprint: (sprinting: boolean) => void;
  onReady: () => void;
}> = ({ layout, runtime, shadows, onNearest, onZone, onSprint, onReady }) => {
  const loaded = useLoader(GLTFLoader, [LUMI_MODEL_URL, ...LUMI_ANIMATION_URLS], (l) => { l.setMeshoptDecoder(MeshoptDecoder); });
  const gltf = loaded[0];
  const model = useMemo(() => {
    prepareModel(gltf.scene);
    return gltf.scene;
  }, [gltf]);
  const clips = useMemo(() => {
    // Mixamo calls every clip "mixamo.com": name them after their files.
    const named = (clip: THREE.AnimationClip, name: string) => { clip.name = name; return clip; };
    const own = gltf.animations.map((c) => (/mixamo/i.test(c.name) ? named(c, 'idle') : c));
    const extra = loaded.slice(1).flatMap((g, i) =>
      g.animations.slice(0, 1).map((c) => named(c, LUMI_ANIMATION_URLS[i].split('/').pop()!.replace(/\.glb$/, ''))));
    return [...own, ...extra];
  }, [gltf, loaded]);
  const rigged = clips.length > 0;

  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const blob = useRef<THREE.Mesh>(null);
  const velocity = useRef(new THREE.Vector2());
  const phase = useRef(0);
  const lastHalfStep = useRef(0);
  const landSquash = useRef(0);
  const sprinting = useRef(false);
  const zone = useRef(-2);
  const tick = useRef(0);
  const { camera, size } = useThree();

  /* ---- rigged: one action per clip, cross-faded by speed ---- */
  const mixer = useMemo(() => (rigged ? new THREE.AnimationMixer(model) : null), [rigged, model]);
  const actions = useMemo(() => {
    const out: Partial<Record<Clip, THREE.AnimationAction>> = {};
    if (!mixer) return out;
    for (const clip of Object.keys(CLIP_NAMES) as Clip[]) {
      const found = clips.find((a) => CLIP_NAMES[clip].test(a.name));
      if (found) out[clip] = mixer.clipAction(found);
    }
    out.idle ??= mixer.clipAction(clips[0]);
    for (const once of [out.wave, out.jump]) {
      if (!once) continue;
      once.setLoop(THREE.LoopOnce, 1);
      once.clampWhenFinished = true;
    }
    return out;
  }, [mixer, clips]);
  const current = useRef<Clip | null>(null);
  const waving = useRef(0);
  const seenGesture = useRef(runtime.current.gesture);

  const play = (clip: Clip, fade = 0.25) => {
    const next = actions[clip] ?? actions.idle;
    const prev = current.current ? actions[current.current] : null;
    if (!next || current.current === clip) return;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    current.current = clip;
  };

  useEffect(() => {
    if (mixer) play('idle', 0);
    onReady();
    return () => { mixer?.stopAllAction(); };
  }, [mixer]); // eslint-disable-line react-hooks/exhaustive-deps

  const offset = useMemo(
    () => (size.height > size.width ? new THREE.Vector3(0, 9.5, 12) : new THREE.Vector3(0, 6.4, 8.8)),
    [size.width, size.height],
  );
  const camTarget = useRef(new THREE.Vector3());
  const placedCamera = useRef(false);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const rt = runtime.current;
    const g = root.current;
    const b = body.current;
    if (!g || !b) return;

    /* ---- movement ---- */
    const active = !rt.paused;
    const input = rt.input;
    const len = active ? Math.hypot(input.x, input.y) : 0;
    const mag = Math.min(1, len);
    const ix = len > 0 ? input.x / len : 0;
    const iz = len > 0 ? -input.y / len : 0;

    const wantSprint = active && input.sprint && mag > 0.3;
    rt.sprint += ((wantSprint ? 1 : 0) - rt.sprint) * (1 - Math.exp(-(wantSprint ? 6 : 4) * dt));
    if (wantSprint !== sprinting.current) {
      sprinting.current = wantSprint;
      if (wantSprint) {
        rt.audio?.sprintStart();
        if (rt.grounded) rt.fx?.dust(rt.pos.x, rt.pos.z, 7, 1.4);
      }
      onSprint(wantSprint);
    }

    const top = (RUN + (SPRINT - RUN) * rt.sprint) * mag;
    // Less grip in the air: jumps carry their momentum.
    const grip = mag > 0 ? (rt.grounded ? 10 : 3.5) : (rt.grounded ? 12 : 1.5);
    const accel = 1 - Math.exp(-grip * dt);
    velocity.current.x += (ix * top - velocity.current.x) * accel;
    velocity.current.y += (iz * top - velocity.current.y) * accel;
    rt.pos.x += velocity.current.x * dt;
    rt.pos.z += velocity.current.y * dt;

    // Slide around anything solid, and stay on the island.
    for (const o of layout.obstacles) {
      const dx = rt.pos.x - o.x;
      const dz = rt.pos.z - o.z;
      const min = o.r + RADIUS;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        rt.pos.x = o.x + (dx / d) * min;
        rt.pos.z = o.z + (dz / d) * min;
      }
    }
    const edge = layout.islandRadius - 0.9;
    const r = Math.hypot(rt.pos.x, rt.pos.z);
    if (r > edge) { rt.pos.x *= edge / r; rt.pos.z *= edge / r; }

    rt.speed = Math.hypot(velocity.current.x, velocity.current.y);
    if (mag > 0.05) {
      rt.lookAt = null;
      rt.facing = dampAngle(rt.facing, Math.atan2(ix, iz), 12, dt);
    } else if (rt.lookAt) {
      rt.facing = dampAngle(rt.facing, Math.atan2(rt.lookAt.x - rt.pos.x, rt.lookAt.z - rt.pos.z), 10, dt);
    }

    /* ---- jumping ---- */
    if (active && rt.grounded && input.jumpAt && performance.now() - input.jumpAt < JUMP_BUFFER_MS) {
      input.jumpAt = 0;
      rt.grounded = false;
      rt.vy = JUMP_SPEED + rt.sprint * 1.2;
      rt.audio?.jump();
      rt.fx?.dust(rt.pos.x, rt.pos.z, 5, 0.9);
      if (actions.jump) { actions.jump.reset(); play('jump', 0.08); }
    }
    if (!rt.grounded) {
      rt.vy -= GRAVITY * dt;
      rt.y += rt.vy * dt;
      if (rt.y <= 0) {
        const impact = -rt.vy;
        rt.y = 0;
        rt.vy = 0;
        rt.grounded = true;
        landSquash.current = Math.min(1, impact / 9);
        rt.audio?.land(impact);
        rt.fx?.dust(rt.pos.x, rt.pos.z, 10, 1.3);
      }
    }
    landSquash.current = Math.max(0, landSquash.current - dt * 5);

    g.position.set(rt.pos.x, 0.06, rt.pos.z);
    g.rotation.y = rt.facing + rt.flourish.spin;

    /* ---- stride: footsteps, dust, the waddle ---- */
    const k = Math.min(1.7, rt.speed / RUN);
    if (rt.grounded) phase.current += dt * (5 + rt.speed * 1.6);
    const half = Math.floor(phase.current / Math.PI);
    if (half !== lastHalfStep.current) {
      lastHalfStep.current = half;
      if (rt.grounded && rt.speed > 1.2) {
        rt.audio?.step(rt.sprint > 0.5);
        if (rt.sprint > 0.5 || Math.random() < 0.3) {
          const back = 0.25;
          rt.fx?.dust(rt.pos.x - Math.sin(rt.facing) * back, rt.pos.z - Math.cos(rt.facing) * back,
            rt.sprint > 0.5 ? 3 : 1, rt.sprint > 0.5 ? 1 : 0.5);
        }
      }
    }
    if (tick.current % 6 === 0) {
      rt.audio?.setWind(active ? Math.min(1, Math.max(0, (rt.speed - RUN * 0.8) / (SPRINT - RUN * 0.8))) : 0);
    }

    const squashY = 1 - landSquash.current * 0.22;
    const squashXZ = 1 + landSquash.current * 0.16;
    if (mixer) {
      if (rt.gesture !== seenGesture.current && actions.wave) {
        seenGesture.current = rt.gesture;
        waving.current = actions.wave.getClip().duration;
        play('wave', 0.15);
      }
      if (waving.current > 0) waving.current -= dt;
      else if (!rt.grounded && actions.jump) play('jump', 0.1);
      else play(rt.speed > 3.2 ? 'run' : rt.speed > 0.4 ? 'walk' : 'idle');
      if (current.current === 'walk' && actions.walk) actions.walk.timeScale = Math.max(0.6, rt.speed / 3.2);
      if (current.current === 'run' && actions.run) actions.run.timeScale = Math.max(0.7, rt.speed / RUN);
      mixer.update(dt);
      b.position.y = rt.y + rt.flourish.hop;
      b.rotation.x = rt.sprint * 0.18;
      b.scale.set(squashXZ, squashY, squashXZ);
    } else if (!rt.grounded) {
      // Stretch on the way up, tuck at the top, lean into the direction of travel.
      const stretch = Math.max(-1, Math.min(1, rt.vy / JUMP_SPEED));
      b.position.y = rt.y + rt.flourish.hop;
      b.rotation.z *= 0.8;
      b.rotation.x = 0.18 + rt.sprint * 0.2 - stretch * 0.12;
      b.scale.set(1 - 0.08 * stretch, 1 + 0.14 * stretch, 1 - 0.08 * stretch);
    } else {
      const t = performance.now() / 1000;
      const stride = Math.sin(phase.current);
      b.position.y = Math.abs(stride) * 0.1 * k + rt.flourish.hop;
      b.rotation.z = stride * 0.13 * Math.min(k, 1.1);
      b.rotation.x = 0.12 * Math.min(k, 1) + rt.sprint * 0.26; // lean into a sprint
      const breathe = k < 0.1 ? Math.sin(t * 2.2) * 0.018 : 0;
      const bounce = rt.flourish.hop > 0 ? 0 : Math.abs(Math.cos(phase.current)) * 0.04 * k;
      b.scale.set((1 + bounce) * squashXZ, (1 + breathe - bounce) * squashY, (1 + bounce) * squashXZ);
    }
    blob.current?.scale.setScalar(1 / (1 + rt.y * 0.5));

    /* ---- what is within reach, which moment we are in ---- */
    let best: Interactable | null = null;
    let bestD = REACH;
    for (const it of layout.interactables) {
      const d = Math.hypot(it.x - rt.pos.x, it.z - rt.pos.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    const nearestId = best?.id ?? null;
    if (nearestId !== rt.nearestId) {
      rt.nearestId = nearestId;
      onNearest(best);
    }
    if (++tick.current % 10 === 0) {
      const inZone = layout.zones.find((zn) => Math.hypot(zn.x - rt.pos.x, zn.z - rt.pos.z) < ZONE_R + 0.5);
      const next = inZone ? inZone.index : -1;
      if (next !== zone.current) { zone.current = next; onZone(next); }
    }

    /* ---- camera and sun follow ---- */
    camTarget.current.set(rt.pos.x, rt.y * 0.35, rt.pos.z).add(offset);
    const lag = rt.sprint * 1.3; // the camera trails a sprint a little
    camTarget.current.y += lag * 0.6;
    camTarget.current.z += lag;
    if (!placedCamera.current) { camera.position.copy(camTarget.current); placedCamera.current = true; }
    else camera.position.lerp(camTarget.current, 1 - Math.exp(-4 * dt));
    camera.lookAt(camera.position.x, 1, camera.position.z - offset.z);
    const cam = camera as THREE.PerspectiveCamera;
    const fov = BASE_FOV + rt.sprint * 9; // speed kick
    if (Math.abs(cam.fov - fov) > 0.02) { cam.fov = fov; cam.updateProjectionMatrix(); }

    const light = sun.current;
    if (light) {
      light.position.set(rt.pos.x + 7, 14, rt.pos.z + 5);
      light.target.position.set(rt.pos.x, 0, rt.pos.z);
      light.target.updateMatrixWorld();
    }
  });

  return (
    <>
      <directionalLight
        ref={sun}
        intensity={2.4}
        color="#fff4e2"
        castShadow={shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-bias={-0.0008}
        shadow-normalBias={0.04}
      />
      <group ref={root}>
        <group ref={body}>
          <primitive object={model} />
        </group>
        {/* soft blob under Lumi, so she reads as grounded even without shadows */}
        <mesh ref={blob} rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
          <circleGeometry args={[0.42, 20]} />
          <meshBasicMaterial color="#2b1f3a" transparent opacity={0.18} depthWrite={false} />
        </mesh>
      </group>
      <SprintGhosts model={model} source={body} runtime={runtime} />
      <Dust runtime={runtime} />
    </>
  );
};
