// Onion skin: see-through copies of the character posed at the previous (blue) and next (orange)
// keyframe, as the full body or just the selected bone (its whole arm/leg for limb bones).
import * as THREE from 'three';
import { buildCharacter } from './character.js';

const LIMBS = [
  ['Bip01_L_UpperArm', 'Bip01_L_Forearm', 'Bip01_L_Hand'],
  ['Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand'],
  ['Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot', 'Bip01_L_Toe0'],
  ['Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot', 'Bip01_R_Toe0'],
];
const VIRTUAL_END = 0.06;

export class Onion {
  constructor({ scene, getCharacter, getCharacterX, getDoc, getFrame, getSelected, getTail }) {
    Object.assign(this, { scene, getCharacter, getCharacterX, getDoc, getFrame, getSelected, getTail });
    this.mode = 'off';      // off | prev | both
    this.boneOnly = false;
    this.ghosts = [];       // [{ ch, lines, points, color }]
    this.frames = [null, null];
  }

  dispose() {
    for (const g of this.ghosts) {
      this.scene.remove(g.ch.root, g.lines, g.points);
      g.ch.mesh.geometry.dispose(); g.ch.material.dispose();
      g.lines.geometry.dispose(); g.points.geometry.dispose();
    }
    this.ghosts = [];
  }

  build() {
    this.dispose();
    const x = this.getCharacterX(), main = this.getCharacter();
    if (!x || !main) return;
    for (const color of [0x5ab4ff, 0xffa64d]) {
      const ch = buildCharacter(x);
      // Same rest pose as the real character (e.g. Bob_Idle).
      for (const [name, b] of ch.bones) {
        const r = main.bones.get(name)?.userData.rest;
        if (r) { b.userData.rest = { position: r.position.clone(), quaternion: r.quaternion.clone(), scale: r.scale.clone() }; }
      }
      ch.mesh.material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false });
      ch.material.dispose();
      ch.material = ch.mesh.material;
      ch.mesh.renderOrder = 2;
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }));
      const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false, depthTest: false }));
      lines.renderOrder = points.renderOrder = 997;
      lines.frustumCulled = points.frustumCulled = false;
      ch.root.visible = lines.visible = points.visible = false;
      this.scene.add(ch.root, lines, points);
      this.ghosts.push({ ch, lines, points });
    }
  }

  hide() { for (const g of this.ghosts) g.ch.root.visible = g.lines.visible = g.points.visible = false; }

  // Previous / next keyframe around the current frame (for the selected bone in bone mode).
  neighbours() {
    const doc = this.getDoc();
    const f = Math.round(this.getFrame());
    const bone = this.boneOnly ? this.getSelected() : null;
    const keys = bone ? [...(doc.channels.get(bone)?.keys() || [])] : [...doc.frames.keys()];
    if (doc.loop && keys.length) keys.push(doc.loopFrame());
    keys.sort((a, b) => a - b);
    let prev = null, next = null;
    for (const k of keys) { if (k < f) prev = k; else if (k > f && next === null) next = k; }
    return [prev, next];
  }

  chainFor(bone) {
    return LIMBS.find(l => l.includes(bone)) || [bone];
  }

  update() {
    if (this.mode === 'off' || !this.ghosts.length) { this.hide(); return; }
    const doc = this.getDoc();
    if (!doc) { this.hide(); return; }
    const [prev, next] = this.neighbours();
    this.frames = [prev, this.mode === 'both' ? next : null];
    const bone = this.getSelected();
    this.ghosts.forEach((g, i) => {
      const fr = this.frames[i];
      const show = fr !== null && (!this.boneOnly || !!bone);
      g.ch.root.visible = show;
      g.lines.visible = g.points.visible = show && this.boneOnly;
      if (!show) return;
      doc.applyTo(g.ch, fr);
      g.ch.mesh.visible = !this.boneOnly;
      if (this.boneOnly) this.drawChain(g, this.chainFor(bone));
    });
  }

  drawChain(g, names) {
    g.ch.root.updateMatrixWorld(true);
    const pts = [], segs = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const n of names) {
      const bone = g.ch.bones.get(n);
      if (!bone) continue;
      bone.getWorldPosition(a);
      const tail = this.getTail(n);
      if (tail && g.ch.bones.get(tail)) g.ch.bones.get(tail).getWorldPosition(b);
      else b.set(VIRTUAL_END, 0, 0).applyMatrix4(bone.matrixWorld);
      segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    g.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    g.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }
}
