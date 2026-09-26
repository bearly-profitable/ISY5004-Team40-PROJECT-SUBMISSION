/**
 * The island itself: faceted grass, a sandy shore, water, drifting clouds,
 * the stepping-stone path, each moment's clearing and all the scenery.
 */
import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAZA_R, THEME_GROUND, ZONE_R, type PropKind, type WorldLayout } from './layout';
import { PropField } from './props';

const GRASS = ['#8fd06c', '#86c963', '#97d574', '#7fc15f', '#9ad978'];

/**
 * A disc of evenly sized triangles, nudged and coloured per face for the
 * low-poly look. Rings get more vertices the further out they are, and
 * neighbouring rings are stitched together in angle order, so there are no
 * long slivers fanning out from the centre.
 */
function facetedDisc(radius: number, colors: string[], seed: number, edge: number): THREE.BufferGeometry {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ringCount = Math.max(3, Math.round(radius / edge));
  const rings: Array<Array<{ a: number; p: [number, number, number] }>> = [[{ a: 0, p: [0, 0, 0] }]];
  for (let k = 1; k <= ringCount; k++) {
    const r = (k / ringCount) * radius;
    const n = Math.max(6, Math.round((2 * Math.PI * r) / edge));
    const offset = rand() * ((Math.PI * 2) / n);
    const rim = k === ringCount;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = offset + (i / n) * Math.PI * 2 + (rim ? 0 : (rand() - 0.5) * (Math.PI / n) * 0.8);
      const rr = rim ? r : r + (rand() - 0.5) * edge * 0.45;
      ring.push({ a, p: [Math.cos(a) * rr, rim ? 0 : (rand() - 0.5) * 0.08, Math.sin(a) * rr] as [number, number, number] });
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  // Wind every face so it points up, whatever order the corners arrive in.
  const tri = (a: number[], b: number[], c: number[]) => {
    const cross = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (cross >= 0) positions.push(...a, ...b, ...c);
    else positions.push(...a, ...c, ...b);
  };
  const TAU = Math.PI * 2;
  for (let k = 1; k < rings.length; k++) {
    const inner = rings[k - 1];
    const outer = rings[k];
    const m = inner.length;
    const n = outer.length;
    if (m === 1) {
      for (let i = 0; i < n; i++) tri(inner[0].p, outer[i].p, outer[(i + 1) % n].p);
      continue;
    }
    // Unwrap both rings' angles from the outer ring's first vertex, with the
    // inner ring starting at its vertex just before that.
    const base = outer[0].a;
    const rel = inner.map((v) => (((v.a - base) % TAU) + TAU) % TAU);
    const start = rel.indexOf(Math.max(...rel));
    const innerU = (t: number) => (t === 0 ? rel[start] - TAU : t === m ? rel[start] : rel[(start + t) % m]);
    const outerU = (t: number) => (t === n ? TAU : outer[t].a - base);
    const innerP = (t: number) => inner[(start + t) % m].p;
    const outerP = (t: number) => outer[t % n].p;
    // Walk both rings once around, always advancing the one that lags.
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (j < n && (i >= m || outerU(j + 1) <= innerU(i + 1))) {
        tri(innerP(i), outerP(j), outerP(j + 1));
        j += 1;
      } else {
        tri(innerP(i), outerP(j), innerP(i + 1));
        i += 1;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const color = new THREE.Color();
  const cols = new Float32Array(positions.length);
  for (let f = 0; f < cols.length / 9; f++) {
    color.set(colors[Math.floor(rand() * colors.length)]);
    for (let v = 0; v < 3; v++) color.toArray(cols, f * 9 + v * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

const Ground: React.FC<{ radius: number }> = ({ radius }) => {
  const grass = useMemo(() => facetedDisc(radius, GRASS, 11, 1.8), [radius]);
  useLayoutEffect(() => () => grass.dispose(), [grass]);
  return (
    <group>
      <mesh geometry={grass} receiveShadow>
        <meshStandardMaterial vertexColors flatShading roughness={0.95} />
      </mesh>
      {/* cliff under the grass */}
      <mesh position={[0, -0.9, 0]}>
        <cylinderGeometry args={[radius + 0.05, radius * 0.9, 1.8, Math.round(radius * 2.4), 1, true]} />
        <meshStandardMaterial color="#c49a6c" flatShading roughness={1} side={THREE.DoubleSide} />
      </mesh>
      {/* sandy shore */}
      <mesh position={[0, -0.72, 0]} receiveShadow>
        <cylinderGeometry args={[radius + 2.2, radius + 3.4, 0.5, Math.round(radius * 2.4)]} />
        <meshStandardMaterial color="#f3dfa9" flatShading roughness={1} />
      </mesh>
    </group>
  );
};

const Water: React.FC<{ radius: number }> = ({ radius }) => {
  const foam = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const mesh = foam.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    mesh.scale.setScalar(1 + Math.sin(t * 0.8) * 0.012);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 + Math.sin(t * 0.8) * 0.2;
  });
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.62, 0]} receiveShadow>
        <circleGeometry args={[radius * 5 + 80, 48]} />
        <meshStandardMaterial color="#86cdea" roughness={0.35} metalness={0.05} />
      </mesh>
      <mesh ref={foam} rotation-x={-Math.PI / 2} position={[0, -0.58, 0]}>
        <ringGeometry args={[radius + 3.3, radius + 4.3, 64]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
};

const Clouds: React.FC<{ radius: number }> = ({ radius }) => {
  const group = useRef<THREE.Group>(null);
  const puffs = useMemo(() => {
    const out: Array<{ pos: [number, number, number]; scale: number }> = [];
    let s = 99;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const count = Math.round(8 + radius / 4);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = rand() * (radius + 20);
      const cx = Math.cos(a) * d;
      const cz = Math.sin(a) * d;
      const y = 15 + rand() * 6;
      for (let k = 0; k < 3; k++) {
        out.push({ pos: [cx + (k - 1) * 1.6, y + (k === 1 ? 0.5 : 0), cz + (rand() - 0.5)], scale: k === 1 ? 1.6 : 1.1 });
      }
    }
    return out;
  }, [radius]);
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.006;
  });
  return (
    <group ref={group}>
      {puffs.map((p, i) => (
        <mesh key={i} position={p.pos} scale={p.scale}>
          <icosahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color="#ffffff" flatShading roughness={1} emissive="#ffffff" emissiveIntensity={0.25} />
        </mesh>
      ))}
    </group>
  );
};

const Clearings: React.FC<{ layout: WorldLayout }> = ({ layout }) => (
  <group>
    <mesh rotation-x={-Math.PI / 2} position={[0, 0.07, 0]} receiveShadow>
      <circleGeometry args={[PLAZA_R, 10]} />
      <meshStandardMaterial color="#efe3cf" flatShading roughness={1} />
    </mesh>
    {layout.zones.map((zone) => (
      <mesh key={zone.key} rotation-x={-Math.PI / 2} position={[zone.x, 0.07, zone.z]} receiveShadow>
        <circleGeometry args={[ZONE_R, 11]} />
        <meshStandardMaterial color={THEME_GROUND[zone.theme]} flatShading roughness={1} />
      </mesh>
    ))}
  </group>
);

const Stones: React.FC<{ layout: WorldLayout }> = ({ layout }) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    layout.stones.forEach((s, i) => {
      m.compose(new THREE.Vector3(s.x, 0.07, s.z), q.setFromAxisAngle(up, s.rot), new THREE.Vector3(s.scale, 1, s.scale));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [layout]);
  if (layout.stones.length === 0) return null;
  return (
    <instancedMesh key={layout.stones.length} ref={ref} args={[undefined, undefined, layout.stones.length]} receiveShadow>
      <cylinderGeometry args={[0.42, 0.48, 0.1, 6]} />
      <meshStandardMaterial color="#e9dcc6" flatShading roughness={1} />
    </instancedMesh>
  );
};

export const Island: React.FC<{ layout: WorldLayout; shadows: boolean }> = ({ layout, shadows }) => (
  <group>
    <Ground radius={layout.islandRadius} />
    <Water radius={layout.islandRadius} />
    <Clouds radius={layout.islandRadius} />
    <Clearings layout={layout} />
    <Stones layout={layout} />
    {(Object.keys(layout.props) as PropKind[]).map((kind) => (
      <PropField key={kind} kind={kind} placements={layout.props[kind]} shadows={shadows} />
    ))}
  </group>
);
