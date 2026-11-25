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
// "Keep base skeleton": which bones keep their animated position. Everything else keeps the
// loaded model's bone lengths, so a clip can't bring its own body proportions along.
// Root-level bones (e.g. Bip01: hip bob and sway) and Translation_Data (forward motion) keep
// their movement because that's part of the motion, not the proportions.
export function animatedPositionBones(bones) {
  const keep = new Set(['Translation_Data']);
  for (const b of bones.values()) {
    let depth = 0;
    for (let p = b.parent; p && p.isBone; p = p.parent) depth++;
    if (depth <= 1) keep.add(b.name);
  }
  return keep;
}

export function clipFromSet(set, ticksPerSecond, bones, { includeRootMotion = false, keepBaseSkeleton = false } = {}) {
  const tracks = [];
  let maxT = 0;
  const keepPos = keepBaseSkeleton ? animatedPositionBones(bones) : null;
  for (const t of set.tracks) {
    if (!bones.has(t.bone)) continue;
    const lockProportions = keepPos && !keepPos.has(t.bone);
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
    if (t.pos && !lockProportions && (includeRootMotion || t.bone !== 'Translation_Data')) {
      const times = t.pos.times.map(x => x / ticksPerSecond);
      tracks.push(new THREE.VectorKeyframeTrack(`${t.bone}.position`, times, t.pos.values));
      maxT = Math.max(maxT, times[times.length - 1]);
    }
    if (t.scale && !lockProportions) {
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

// Apply "Keep base skeleton" to an editor-form animation for export: non-root bones get the loaded
// model's rest offsets (and rest scale) at every key, exactly what the viewer shows.
export function applyBaseSkeleton(anim, bones) {
  const keep = animatedPositionBones(bones);
  return {
    ...anim,
    tracks: anim.tracks.map(t => {
      const b = bones.get(t.bone);
      if (!b || keep.has(t.bone)) return t;
      const r = b.userData.rest;
      const fill = (track, v) => track && { times: track.times.slice(), values: track.times.flatMap(() => [v.x, v.y, v.z]) };
      return { ...t, pos: fill(t.pos, r.position), scale: fill(t.scale, r.scale) };
    }),
  };
}

// Forward (root) motion of a clip, from its Translation_Data track.
export function forwardMotion(set, ticksPerSecond) {
  const t = set.tracks.find(t => t.bone === 'Translation_Data');
  if (!t || !t.pos || t.pos.times.length < 2) return { distance: 0, duration: 0, speed: 0 };
  const v = t.pos.values, n = t.pos.times.length;
  const distance = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]);
  const duration = (t.pos.times[n - 1] - t.pos.times[0]) / ticksPerSecond;
  return { distance, duration, speed: duration > 0 ? distance / duration : 0 };
}

// Scale an editor-form animation's forward motion by k (used by "Match vanilla speed").
export function scaleForwardMotion(anim, k) {
  return {
    ...anim,
    tracks: anim.tracks.map(t => {
      if (t.bone !== 'Translation_Data' || !t.pos) return t;
      const v = t.pos.values, o = v.slice(0, 3);
      return { ...t, pos: { times: t.pos.times.slice(), values: v.map((x, i) => o[i % 3] + (x - o[i % 3]) * k) } };
    }),
  };
}

// Use a clip's first frame as the rest pose (e.g. Bob_Idle for the PZ bodies). The rest pose is
// what unkeyed bones, "Reset bone", new animations and exports start from. Skinning is unaffected.
export function setRestFromClip(character, parsed) {
  const set = parsed.animationSets[0];
  if (!set) return 0;
  let n = 0;
  for (const t of set.tracks) {
    const bone = character.bones.get(t.bone);
    if (!bone) continue;
    const r = bone.userData.rest;
    if (t.rot) { const v = t.rot.values; r.quaternion.copy(xKeyToQuat(v[0], v[1], v[2], v[3])); }
    if (t.pos) r.position.fromArray(t.pos.values, 0);
    if (t.scale) r.scale.fromArray(t.scale.values, 0);
    bone.position.copy(r.position); bone.quaternion.copy(r.quaternion); bone.scale.copy(r.scale);
    n++;
  }
  return n;
}
