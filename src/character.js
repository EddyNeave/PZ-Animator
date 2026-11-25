import * as THREE from 'three';
import { flattenFrames } from './xparser.js';

// DirectX .x quaternion keys (w,x,y,z) are the conjugate of the rotation three.js derives
// from the same frame matrix. Verified against vanilla files: frame matrices match key 0
// only after conjugation. Keep this pair of helpers in sync with the exporter.
export function xKeyToQuat(w, x, y, z) { return new THREE.Quaternion(-x, -y, -z, w); }
export function quatToXKey(q) { return [q.w, -q.x, -q.y, -q.z]; }

function matrixToTRS(arr, obj) {
  const m = new THREE.Matrix4().fromArray(arr);
  m.decompose(obj.position, obj.quaternion, obj.scale);
}

// Build a skinned character from a parsed body .x file.
// skeletonSource: optional parsed animation file whose (fuller) bone list should be used,
// e.g. it includes the *Nub end bones that animation files carry.
export function buildCharacter(bodyX, skeletonSource = null) {
  const root = new THREE.Group();
  root.name = 'PZCharacterRoot';
  // .x is left-handed; mirroring Z converts to three.js's right-handed space.
  // three.js flips face winding automatically for negative-determinant transforms.
  root.scale.z = -1;

  const meshFrames = new Set(bodyX.meshes.map(m => m.frame));
  const bones = new Map();

  const buildFrames = (frames, parentObj) => {
    for (const f of frames) {
      if (meshFrames.has(f.name)) continue;
      const b = new THREE.Bone();
      b.name = f.name;
      matrixToTRS(f.matrix, b);
      b.userData.rest = { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() };
      parentObj.add(b);
      bones.set(f.name, b);
      buildFrames(f.children, b);
    }
  };
  buildFrames((skeletonSource || bodyX).frames, root);
  // Make sure every bone the mesh is skinned to exists (fall back to body file frames).
  if (skeletonSource) {
    const bodyFrames = flattenFrames(bodyX.frames);
    for (const f of bodyFrames) {
      if (!bones.has(f.name) && !meshFrames.has(f.name)) console.warn('Bone missing from skeleton source:', f.name);
    }
  }

  if (!bodyX.meshes.length) throw new Error('This file has no mesh to display');
  const src = bodyX.meshes.find(m => m.skins.length) || bodyX.meshes[0];
  const nv = src.positions.length / 3;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(src.positions, 3));
  if (src.uvs) geom.setAttribute('uv', new THREE.BufferAttribute(src.uvs, 2));
  geom.setIndex(src.indices);

  // Gather influences per vertex, keep the 4 strongest, renormalise.
  const infl = Array.from({ length: nv }, () => []);
  const skelBones = [];
  const inverses = [];
  src.skins.forEach((s, si) => {
    const bone = bones.get(s.bone);
    if (!bone) { console.warn('Skin references unknown bone', s.bone); return; }
    const bi = skelBones.length;
    skelBones.push(bone);
    inverses.push(new THREE.Matrix4().fromArray(s.offset));
    s.indices.forEach((vi, j) => infl[vi].push([bi, s.weights[j]]));
  });
  const skinIndex = new Uint16Array(nv * 4);
  const skinWeight = new Float32Array(nv * 4);
  infl.forEach((list, vi) => {
    list.sort((a, b) => b[1] - a[1]);
    const top = list.slice(0, 4);
    const sum = top.reduce((t, x) => t + x[1], 0) || 1;
    top.forEach(([bi, w], k) => { skinIndex[vi * 4 + k] = bi; skinWeight[vi * 4 + k] = w / sum; });
  });
  geom.computeVertexNormals();

  // Body textures use alpha to hide unused parts of the mesh (e.g. the skirt flap), so cut them out.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaTest: 0.5 });

  if (!skelBones.length) {
    // Static (unskinned) model, e.g. a prop: attach it to its frame so it still follows animation.
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = src.name || 'Mesh';
    const frame = flattenFrames(bodyX.frames).find(f => f.name === src.frame);
    if (frame) matrixToTRS(frame.matrix, mesh);
    root.add(mesh);
    return { root, mesh, bones, material, skinnedBoneNames: [], textureNames: src.textures };
  }

  geom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  const mesh = new THREE.SkinnedMesh(geom, material);
  mesh.name = 'Body';
  mesh.frustumCulled = false;
  root.add(mesh);
  // Bones beyond the skinned ones (nubs, props, Translation_Data) are still part of the
  // skeleton so they can be posed and exported, but only skinned ones carry inverses.
  const skeleton = new THREE.Skeleton(skelBones, inverses);
  mesh.bind(skeleton, new THREE.Matrix4());

  return { root, mesh, bones, material, skinnedBoneNames: skelBones.map(b => b.name), textureNames: src.textures };
}

export function resetPose(character) {
  for (const b of character.bones.values()) {
    const r = b.userData.rest;
    b.position.copy(r.position); b.quaternion.copy(r.quaternion); b.scale.copy(r.scale);
  }
}

// Convert a parsed AnimationSet into a three.js AnimationClip for preview playback.
export function clipFromSet(set, ticksPerSecond, bones, { includeRootMotion = false } = {}) {
  const tracks = [];
  let maxT = 0;
  for (const t of set.tracks) {
    if (!bones.has(t.bone)) continue;
    if (t.rot) {
      const times = t.rot.times.map(x => x / ticksPerSecond);
      const vals = [];
      for (let i = 0; i < t.rot.times.length; i++) {
        const v = t.rot.values.slice(i * 4, i * 4 + 4);
        const q = xKeyToQuat(v[0], v[1], v[2], v[3]);
        vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${t.bone}.quaternion`, times, vals));
      maxT = Math.max(maxT, times[times.length - 1]);
    }
    if (t.pos && (includeRootMotion || t.bone !== 'Translation_Data')) {
      const times = t.pos.times.map(x => x / ticksPerSecond);
      tracks.push(new THREE.VectorKeyframeTrack(`${t.bone}.position`, times, t.pos.values));
      maxT = Math.max(maxT, times[times.length - 1]);
    }
    if (t.scale) {
      const times = t.scale.times.map(x => x / ticksPerSecond);
      tracks.push(new THREE.VectorKeyframeTrack(`${t.bone}.scale`, times, t.scale.values));
    }
  }
  return new THREE.AnimationClip(set.name, maxT || -1, tracks);
}

// Convert a parsed .x AnimationSet into editor form (three.js quaternions), the same form the
// editor will produce from keyframes. Used for export, including the round-trip test.
export function animFromSet(set, ticksPerSecond, name = set.name) {
  return {
    name,
    ticksPerSecond,
    tracks: set.tracks.map(t => ({
      bone: t.bone,
      rot: t.rot && {
        times: t.rot.times.slice(),
        quats: t.rot.times.map((_, i) => { const v = t.rot.values; return xKeyToQuat(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]); }),
      },
      scale: t.scale && { times: t.scale.times.slice(), values: t.scale.values.slice() },
      pos: t.pos && { times: t.pos.times.slice(), values: t.pos.values.slice() },
    })),
  };
}
