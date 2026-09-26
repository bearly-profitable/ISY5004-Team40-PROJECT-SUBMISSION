/**
 * A tiny skeleton for the unrigged TRELLIS Lumi, built in the browser.
 *
 * The model is one solid mesh, so on its own Lumi can only bob and sway. This
 * turns it into a SkinnedMesh with five bones (body, two legs, two arms) and
 * weights every vertex by where it sits on Lumi's body, measured from the
 * model (tools/mascot/out/3d, height 1, feet at y -0.5, facing +Z):
 *
 *   legs   below y -0.37, split left/right at x = 0, hips at (±0.085, -0.37)
 *   arms   outside |x| 0.2 between y -0.33 and -0.02, shoulders at (±0.2, -0.03)
 *
 * with a soft blend at each joint so the skin stretches instead of tearing.
 * The Mixamo-rigged model, when present, is used instead of this.
 */
import * as THREE from 'three';

export interface LumiRig {
  legL: THREE.Bone;
  legR: THREE.Bone;
  armL: THREE.Bone;
  armR: THREE.Bone;
}

const HIP_Y = -0.37;
const HIP_X = 0.085;
const SHOULDER_Y = -0.03;
const SHOULDER_X = 0.2;

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Put every limb back at rest (before measuring the model). */
export function restRig(rig: LumiRig | undefined): void {
  if (!rig) return;
  for (const bone of [rig.legL, rig.legR, rig.armL, rig.armR]) bone.rotation.set(0, 0, 0);
}

/**
 * Rig `root` (the glTF scene, before it is scaled) once; later calls return
 * the same bones. Returns undefined if the model is not the expected single mesh.
 */
export function rigLumi(root: THREE.Object3D): LumiRig | undefined {
  if (root.userData.lumiRig) return root.userData.lumiRig as LumiRig;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  if (meshes.length !== 1 || (meshes[0] as THREE.SkinnedMesh).isSkinnedMesh) return undefined;
  const mesh = meshes[0];
  const parent = mesh.parent;
  if (!parent) return undefined;

  root.updateMatrixWorld(true);
  // Mesh-local (possibly quantised) positions -> the model's own coordinates.
  const toModel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const p = new THREE.Vector3();

  // Measure in units of Lumi's height, centred, feet at -0.5, whatever the
  // file's own scale, so the thresholds above always land in the same place.
  const box = new THREE.Box3();
  for (let i = 0; i < count; i++) box.expandByPoint(p.fromBufferAttribute(pos, i).applyMatrix4(toModel));
  const height = box.max.y - box.min.y || 1;
  const cx = (box.max.x + box.min.x) / 2;
  const cz = (box.max.z + box.min.z) / 2;
  const toUnit = (v: THREE.Vector3) => v.set((v.x - cx) / height, (v.y - box.min.y) / height - 0.5, (v.z - cz) / height);
  const fromUnit = (x: number, y: number) => new THREE.Vector3(cx + x * height, box.min.y + (y + 0.5) * height, cz);

  // Bone order: 0 body, 1 left leg (+x), 2 right leg, 3 left arm (+x), 4 right arm.
  for (let i = 0; i < count; i++) {
    toUnit(p.fromBufferAttribute(pos, i).applyMatrix4(toModel));
    const left = p.x >= 0;
    const leg = smooth(HIP_Y + 0.05, HIP_Y - 0.02, p.y);
    const arm = (1 - leg)
      * smooth(SHOULDER_X - 0.005, SHOULDER_X + 0.035, Math.abs(p.x))
      * smooth(SHOULDER_Y + 0.05, SHOULDER_Y - 0.03, p.y);
    // Legs meet at the crotch: share the middle so it stretches smoothly.
    const legSide = smooth(-0.025, 0.025, p.x);
    const o = i * 4;
    skinIndex.set([1, 2, left ? 3 : 4, 0], o);
    skinWeight.set([leg * legSide, leg * (1 - legSide), arm, Math.max(0, 1 - leg - arm)], o);
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  const body = new THREE.Bone();
  body.position.copy(fromUnit(0, HIP_Y));
  const bone = (x: number, y: number) => {
    const b = new THREE.Bone();
    b.position.copy(fromUnit(x, y)).sub(body.position); // relative to the body bone
    body.add(b);
    return b;
  };
  const legL = bone(HIP_X, HIP_Y);
  const legR = bone(-HIP_X, HIP_Y);
  const armL = bone(SHOULDER_X, SHOULDER_Y);
  const armR = bone(-SHOULDER_X, SHOULDER_Y);
  root.add(body);

  const skinned = new THREE.SkinnedMesh(geometry, mesh.material);
  skinned.name = mesh.name;
  skinned.position.copy(mesh.position);
  skinned.quaternion.copy(mesh.quaternion);
  skinned.scale.copy(mesh.scale);
  parent.add(skinned);
  parent.remove(mesh);

  root.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([body, legL, legR, armL, armR]));

  const rig = { legL, legR, armL, armR };
  root.userData.lumiRig = rig;
  return rig;
}
