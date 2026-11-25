// Bone posing: a handle sits at the end of each bone (its joint with the next bone). Dragging a
// handle rotates that bone so its end follows the mouse. Shift-drag twists the bone around its
// own length. The hip handle (Bip01) moves the whole body instead.
//
// All rotation maths happens in the character root's local space: the root mirrors Z to convert
// DirectX's left-handed space, and rotations can't be decomposed through a mirror.
import * as THREE from 'three';

const HANDLE_PX = 12;
const SKIP = new Set(['Dummy01', 'Translation_Data']);
const HIP = 'Bip01';
const VIRTUAL_END = 0.06; // length used for bones with no child (head, hands' last joints, props)

function circleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Poser {
  constructor({ scene, camera, dom, onSelect, onBeginEdit, onEndEdit, getCharacter }) {
    this.scene = scene; this.camera = camera; this.dom = dom;
    this.onSelect = onSelect; this.onBeginEdit = onBeginEdit; this.onEndEdit = onEndEdit;
    this.getCharacter = getCharacter;
    this.enabled = false;
    this.selected = null;   // bone name
    this.hover = null;
    this.drag = null;
    this.items = [];        // [{ bone, tailOf: child|null, isHip }]

    const geo = new THREE.BufferGeometry();
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 13, sizeAttenuation: false, vertexColors: true, map: circleTexture(),
      transparent: true, alphaTest: 0.3, depthTest: false, depthWrite: false,
    }));
    this.points.renderOrder = 999;
    this.points.frustumCulled = false;
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9,
    }));
    this.lines.renderOrder = 998;
    this.lines.frustumCulled = false;
    scene.add(this.points, this.lines);
    this.points.visible = this.lines.visible = false;

    dom.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
  }

  setEnabled(on) {
    this.enabled = on;
    this.points.visible = this.lines.visible = on;
    if (!on) { this.drag = null; this.hover = null; }
  }

  // Work out which bones get a handle and where each one's end is.
  rebuild() {
    const ch = this.getCharacter();
    this.items = [];
    if (!ch) return;
    for (const [name, bone] of ch.bones) {
      if (SKIP.has(name) || /Nub$/i.test(name)) continue;
      if (name === HIP) { this.items.push({ bone: name, tailOf: null, isHip: true }); continue; }
      const kids = bone.children.filter(c => c.isBone && !SKIP.has(c.name));
      // The bone's end is the child that lies furthest along its length (biped bones point down +X).
      let best = null, bestScore = -Infinity;
      for (const k of kids) {
        const len = k.position.length();
        if (len < 1e-4) continue;
        const score = k.position.x / len + (/Nub$/i.test(k.name) ? 0.01 : 0);
        if (score > bestScore) { bestScore = score; best = k; }
      }
      this.items.push({ bone: name, tailOf: best && bestScore > 0.3 ? best.name : null, isHip: false });
    }
    const n = this.items.length;
    this.points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.points.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.lines.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
  }

  // World positions of a bone's pivot and its end.
  ends(item, outPivot, outTail) {
    const ch = this.getCharacter();
    const bone = ch.bones.get(item.bone);
    bone.getWorldPosition(outPivot);
    if (item.isHip) { outTail.copy(outPivot); return; }
    if (item.tailOf) { ch.bones.get(item.tailOf).getWorldPosition(outTail); return; }
    outTail.set(VIRTUAL_END, 0, 0).applyMatrix4(bone.matrixWorld);
  }

  update() {
    if (!this.enabled || !this.items.length) return;
    const ch = this.getCharacter();
    if (!ch) return;
    ch.root.updateMatrixWorld(true);
    const pos = this.points.geometry.attributes.position, col = this.points.geometry.attributes.color;
    const lp = this.lines.geometry.attributes.position, lc = this.lines.geometry.attributes.color;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    const C = {
      normal: new THREE.Color(0x4fc3f7), hip: new THREE.Color(0xffa726), sel: new THREE.Color(0xffe14d),
      hover: new THREE.Color(0xffffff), prop: new THREE.Color(0x8a9099), line: new THREE.Color(0x4fc3f7), lineSel: new THREE.Color(0xffe14d),
    };
    this.items.forEach((it, i) => {
      this.ends(it, a, b);
      const p = it.isHip ? a : b;
      pos.setXYZ(i, p.x, p.y, p.z);
      const c = it.bone === this.selected ? C.sel : it.bone === this.hover ? C.hover : it.isHip ? C.hip : /Prop\d/.test(it.bone) ? C.prop : C.normal;
      col.setXYZ(i, c.r, c.g, c.b);
      lp.setXYZ(i * 2, a.x, a.y, a.z); lp.setXYZ(i * 2 + 1, b.x, b.y, b.z);
      const lcol = it.bone === this.selected ? C.lineSel : C.line;
      lc.setXYZ(i * 2, lcol.r * 0.6, lcol.g * 0.6, lcol.b * 0.6); lc.setXYZ(i * 2 + 1, lcol.r, lcol.g, lcol.b);
    });
    pos.needsUpdate = col.needsUpdate = lp.needsUpdate = lc.needsUpdate = true;
  }

  // Nearest handle to a screen point, within HANDLE_PX.
  pick(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let best = null, bestD = HANDLE_PX;
    for (const it of this.items) {
      this.ends(it, a, b);
      const p = (it.isHip ? a : b).clone().project(this.camera);
      if (p.z > 1) continue;
      const sx = rect.left + (p.x + 1) / 2 * rect.width, sy = rect.top + (1 - p.y) / 2 * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      // Prefer the selected bone when handles overlap.
      if (d < bestD || (d <= bestD + 2 && it.bone === this.selected)) { bestD = d; best = it; }
    }
    return best;
  }

  rayPoint(clientX, clientY, planePoint) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, hit) ? hit : null;
  }

  select(name) {
    this.selected = name;
    this.onSelect?.(name);
  }

  down(e) {
    if (!this.enabled || e.button !== 0) return;
    const it = this.pick(e.clientX, e.clientY);
    if (!it) return;
    e.preventDefault();
    this.select(it.bone);
    const ch = this.getCharacter();
    const bone = ch.bones.get(it.bone);
    ch.root.updateMatrixWorld(true);
    const pivot = new THREE.Vector3(), tail = new THREE.Vector3();
    this.ends(it, pivot, tail);
    const rootInv = ch.root.matrixWorld.clone().invert();
    const rl = (obj) => { // root-local rotation of an object (no mirror inside the root)
      const m = rootInv.clone().multiply(obj.matrixWorld);
      const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return q;
    };
    this.drag = {
      it, bone, startX: e.clientX, startY: e.clientY, twist: e.shiftKey,
      pivot, tail, rootInv,
      startQ: bone.quaternion.clone(), startPos: bone.position.clone(),
      boneRL: rl(bone), parentRL: bone.parent?.isBone ? rl(bone.parent) : new THREE.Quaternion(),
      startHit: this.rayPoint(e.clientX, e.clientY, it.isHip ? pivot : tail),
      moved: false,
    };
    this.onBeginEdit?.(it.bone);
    this.dom.setPointerCapture?.(e.pointerId);
  }

  move(e) {
    if (!this.enabled) return;
    if (!this.drag) {
      if (e.target !== this.dom) return;
      const it = this.pick(e.clientX, e.clientY);
      const h = it ? it.bone : null;
      if (h !== this.hover) { this.hover = h; this.dom.style.cursor = h ? 'grab' : ''; }
      return;
    }
    const d = this.drag;
    d.moved = true;
    this.dom.style.cursor = 'grabbing';
    const toRL = (v) => v.clone().applyMatrix4(d.rootInv);
    if (d.it.isHip) {
      // Move the hips in the view plane.
      const hit = this.rayPoint(e.clientX, e.clientY, d.pivot);
      if (!hit || !d.startHit) return;
      const deltaRL = toRL(hit).sub(toRL(d.startHit));
      const local = deltaRL.applyQuaternion(d.parentRL.clone().invert());
      d.bone.position.copy(d.startPos).add(local);
      return;
    }
    const pivotRL = toRL(d.pivot), tailRL = toRL(d.tail);
    const u = tailRL.clone().sub(pivotRL).normalize();
    let delta;
    if (d.twist || e.shiftKey) {
      delta = new THREE.Quaternion().setFromAxisAngle(u, (e.clientX - d.startX) * 0.012);
    } else {
      const hit = this.rayPoint(e.clientX, e.clientY, d.tail);
      if (!hit) return;
      const v = toRL(hit).sub(pivotRL);
      if (v.lengthSq() < 1e-10) return;
      delta = new THREE.Quaternion().setFromUnitVectors(u, v.normalize());
    }
    // new local = parentRL^-1 * delta * boneRL
    d.bone.quaternion.copy(d.parentRL.clone().invert().multiply(delta).multiply(d.boneRL));
  }

  up(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.dom.style.cursor = '';
    this.onEndEdit?.(d.it.bone, d.moved, d.it.isHip);
  }

  get dragging() { return !!this.drag; }
  get dragBone() { return this.drag?.bone || null; }
}
