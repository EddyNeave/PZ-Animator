// Animation document for the editor: per-bone keys on whole frames (30 fps, PZ's rate),
// with in/out interpolation modes stored per keyframe (shared by every bone keyed there).
import * as THREE from 'three';

export const FPS = 30;
export const TICKS_PER_FRAME = 160; // 4800 ticks/s
export const MODES = ['flat', 'linear', 'cubic'];

// Easing between two keys. `out` belongs to the earlier key, `inn` to the later one.
// flat on either side: hold the earlier pose, then snap. Otherwise a Hermite curve whose end
// slopes are 1 for linear (full speed) and 0 for cubic (eases to a stop).
export function ease(u, out, inn) {
  if (out === 'flat' || inn === 'flat') return u >= 1 ? 1 : 0;
  const m0 = out === 'linear' ? 1 : 0;
  const m1 = inn === 'linear' ? 1 : 0;
  const u2 = u * u, u3 = u2 * u;
  return (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) + (u3 - u2) * m1;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class AnimDoc {
  constructor({ name = 'Bob_MyAnimation', speed = 1, forward = 0 } = {}) {
    this.name = name;
    this.speed = speed;       // overall speed, baked into the export
    this.forward = forward;   // forward (root) motion per loop, in units
    this.frames = new Map();  // frame -> { in, out }
    this.channels = new Map(); // bone -> Map(frame -> { q:[x,y,z,w], p:[x,y,z]|null })
    this.posBones = new Set(); // bones whose keys also store a position
  }

  lastFrame() {
    let m = 0;
    for (const f of this.frames.keys()) m = Math.max(m, f);
    return m;
  }

  sortedFrames() { return [...this.frames.keys()].sort((a, b) => a - b); }

  ensureFrame(frame) {
    if (!this.frames.has(frame)) this.frames.set(frame, { in: 'cubic', out: 'cubic' });
    return this.frames.get(frame);
  }

  keyBone(bone, frame, quat, pos = null) {
    this.ensureFrame(frame);
    if (!this.channels.has(bone)) this.channels.set(bone, new Map());
    if (pos) this.posBones.add(bone);
    this.channels.get(bone).set(frame, {
      q: [quat.x, quat.y, quat.z, quat.w],
      p: this.posBones.has(bone) && pos ? [pos.x, pos.y, pos.z] : null,
    });
  }

  boneHasKey(bone, frame) { return !!this.channels.get(bone)?.has(frame); }

  deleteFrame(frame) {
    this.frames.delete(frame);
    for (const ch of this.channels.values()) ch.delete(frame);
    this.prune();
  }

  deleteBoneKey(bone, frame) {
    this.channels.get(bone)?.delete(frame);
    this.prune();
  }

  // Remove keyframes no bone uses and empty channels.
  prune() {
    for (const [b, ch] of this.channels) if (!ch.size) this.channels.delete(b);
    for (const f of [...this.frames.keys()]) {
      if (![...this.channels.values()].some(ch => ch.has(f))) this.frames.delete(f);
    }
  }

  // Move every key at `from` to `to` (refused if `to` already has a keyframe).
  moveFrame(from, to) {
    if (from === to || this.frames.has(to) || to < 0) return false;
    this.frames.set(to, this.frames.get(from));
    this.frames.delete(from);
    for (const ch of this.channels.values()) {
      if (ch.has(from)) { ch.set(to, ch.get(from)); ch.delete(from); }
    }
    return true;
  }

  // Pose of one bone at (fractional) frame t, or null if the bone has no keys.
  evaluateBone(bone, t, outQ, outP) {
    const ch = this.channels.get(bone);
    if (!ch || !ch.size) return false;
    const keys = [...ch.keys()].sort((a, b) => a - b);
    let a = keys[0], b = keys[keys.length - 1];
    if (t <= a) b = a;
    else if (t >= b) a = b;
    else {
      for (let i = 0; i < keys.length - 1; i++) if (keys[i] <= t && t < keys[i + 1]) { a = keys[i]; b = keys[i + 1]; break; }
    }
    const ka = ch.get(a), kb = ch.get(b);
    let s = 0;
    if (b !== a) s = ease((t - a) / (b - a), this.frames.get(a)?.out || 'cubic', this.frames.get(b)?.in || 'cubic');
    _qa.fromArray(ka.q); _qb.fromArray(kb.q);
    if (_qa.dot(_qb) < 0) _qb.set(-_qb.x, -_qb.y, -_qb.z, -_qb.w); // shortest path
    outQ.copy(_qa).slerp(_qb, s);
    if (outP) {
      if (ka.p && kb.p) outP.set(ka.p[0] + (kb.p[0] - ka.p[0]) * s, ka.p[1] + (kb.p[1] - ka.p[1]) * s, ka.p[2] + (kb.p[2] - ka.p[2]) * s);
      else if (ka.p) outP.fromArray(ka.p);
      else return 'rot';
      return 'both';
    }
    return 'rot';
  }

  // Apply the pose at frame t to a character (bones without keys get their rest pose).
  applyTo(character, t, skip = null) {
    const q = new THREE.Quaternion(), p = new THREE.Vector3();
    for (const [name, bone] of character.bones) {
      if (bone === skip) continue;
      const r = bone.userData.rest;
      const res = this.evaluateBone(name, t, q, p);
      bone.quaternion.copy(res ? q : r.quaternion);
      bone.position.copy(res === 'both' ? p : r.position);
      bone.scale.copy(r.scale);
    }
  }

  toJSON() {
    return {
      name: this.name, speed: this.speed, forward: this.forward,
      frames: [...this.frames],
      channels: [...this.channels].map(([b, ch]) => [b, [...ch]]),
      posBones: [...this.posBones],
    };
  }

  static fromJSON(j) {
    const d = new AnimDoc(j);
    d.frames = new Map(j.frames);
    d.channels = new Map(j.channels.map(([b, ch]) => [b, new Map(ch)]));
    d.posBones = new Set(j.posBones);
    return d;
  }

  clone() { return AnimDoc.fromJSON(JSON.parse(JSON.stringify(this.toJSON()))); }

  /**
   * Bake to the editor-form animation the exporter writes (one key per frame).
   * template: parsed vanilla .x of the same skeleton; its bone list and order are used, and bones
   * the character doesn't have keep the template's first key. character: the loaded model.
   */
  bake(template, character) {
    const set = template.animationSets[0];
    const last = Math.max(1, this.lastFrame());
    const speed = this.speed > 0 ? this.speed : 1;
    const frames = Array.from({ length: last + 1 }, (_, f) => f);
    const ticks = frames.map(f => Math.round((f * TICKS_PER_FRAME) / speed));
    const q = new THREE.Quaternion(), p = new THREE.Vector3();
    const tracks = [];
    const firstVec = (tr) => tr ? tr.values.slice(0, 3) : null;
    const firstQuat = (tr) => {
      if (!tr) return null;
      const v = tr.values; // x key order w,x,y,z -> three: (-x,-y,-z,w)
      return new THREE.Quaternion(-v[1], -v[2], -v[3], v[0]);
    };
    for (const t of set.tracks) {
      const bone = character.bones.get(t.bone);
      if (t.bone === 'Translation_Data') {
        // Forward motion: straight line along the template's own axis, scaled to `forward`.
        const v = t.pos ? t.pos.values : [0, 0, 0];
        const n = t.pos ? t.pos.times.length : 1;
        const dir = [v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]];
        const len = Math.hypot(...dir);
        const unit = len > 1e-6 ? dir.map(c => c / len) : [0, 0, -1];
        const rq = firstQuat(t.rot) || new THREE.Quaternion();
        tracks.push({
          bone: t.bone,
          rot: { times: [ticks[0], ticks.at(-1)], quats: [rq.clone(), rq.clone()] },
          scale: { times: [ticks[0], ticks.at(-1)], values: [1, 1, 1, 1, 1, 1] },
          pos: { times: ticks.slice(), values: frames.flatMap(f => unit.map((c, i) => v[i] + c * this.forward * (f / last))) },
        });
        continue;
      }
      if (!bone) {
        // Not in the loaded model (e.g. Dummy01, end "Nub" bones): keep the template's values.
        const rq = firstQuat(t.rot) || new THREE.Quaternion();
        const pv = firstVec(t.pos) || [0, 0, 0];
        tracks.push({
          bone: t.bone,
          rot: { times: [ticks[0], ticks.at(-1)], quats: [rq.clone(), rq.clone()] },
          scale: { times: [ticks[0], ticks.at(-1)], values: [1, 1, 1, 1, 1, 1] },
          pos: { times: [ticks[0], ticks.at(-1)], values: [...pv, ...pv] },
        });
        continue;
      }
      const r = bone.userData.rest;
      const quats = [], pos = [];
      for (const f of frames) {
        const res = this.evaluateBone(t.bone, f, q, p);
        quats.push((res ? q : r.quaternion).clone());
        const pp = res === 'both' ? p : r.position;
        pos.push(pp.x, pp.y, pp.z);
      }
      tracks.push({
        bone: t.bone,
        rot: { times: ticks.slice(), quats },
        scale: { times: [ticks[0], ticks.at(-1)], values: [r.scale.x, r.scale.y, r.scale.z, r.scale.x, r.scale.y, r.scale.z] },
        pos: { times: ticks.slice(), values: pos },
      });
    }
    return { name: this.name, ticksPerSecond: template.ticksPerSecond || 4800, tracks };
  }
}

/**
 * Key reduction: per bone, keep only the keys needed to reproduce the current motion within a
 * tolerance (degrees for rotation, units for position). Douglas-Peucker style: start from the first
 * and last key, then keep adding the key where the rebuilt motion is furthest off, until every
 * frame is within tolerance. The rebuild uses the document's own In/Out modes for the kept keys.
 * Returns { before, after, maxErrorDeg, maxErrorPos }.
 */
export function reduceKeys(doc, { angleTol = 0.5, posTol = 0.001 } = {}) {
  const tolRad = (angleTol * Math.PI) / 180;
  let before = 0, after = 0, maxErrRad = 0, maxErrPos = 0;
  const q = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qr = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const newChannels = new Map();
  const originals = new Map(); // bone -> { q: Map(frame->Quaternion), p: Map(frame->Vector3) }

  for (const [bone, ch] of doc.channels) {
    const keys = [...ch.keys()].sort((a, b) => a - b);
    before += keys.length;
    if (keys.length <= 2) { newChannels.set(bone, ch); after += keys.length; continue; }
    const first = keys[0], last = keys[keys.length - 1];
    // The motion as it plays now, at every whole frame.
    const origQ = new Map(), origP = new Map();
    for (let f = first; f <= last; f++) {
      const res = doc.evaluateBone(bone, f, q, p);
      origQ.set(f, q.clone());
      if (res === 'both') origP.set(f, p.clone());
    }
    originals.set(bone, { q: origQ, p: origP });
    const modeOut = (f) => doc.frames.get(f)?.out || 'cubic';
    const modeIn = (f) => doc.frames.get(f)?.in || 'cubic';
    const errorsBetween = (a, b) => {
      // Rebuild frames between kept keys a and b and measure the error at each frame.
      const ka = ch.get(a), kb = ch.get(b);
      qa.fromArray(ka.q); qb.fromArray(kb.q);
      if (qa.dot(qb) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w);
      let worstKey = null, worstErr = 0;
      for (let f = a + 1; f < b; f++) {
        const s = ease((f - a) / (b - a), modeOut(a), modeIn(b));
        qr.copy(qa).slerp(qb, s);
        const angErr = qr.angleTo(origQ.get(f));
        let posErr = 0;
        if (ka.p && kb.p && origP.has(f)) {
          const o = origP.get(f);
          posErr = Math.hypot(ka.p[0] + (kb.p[0] - ka.p[0]) * s - o.x, ka.p[1] + (kb.p[1] - ka.p[1]) * s - o.y, ka.p[2] + (kb.p[2] - ka.p[2]) * s - o.z);
        }
        // Normalise both errors against their tolerance so either can force a key.
        const score = Math.max(angErr / tolRad, posErr / posTol);
        if (score > worstErr && ch.has(f)) { worstErr = score; worstKey = f; }
      }
      return { worstKey, worstErr };
    };
    const kept = new Set([first, last]);
    const stack = [[first, last]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const { worstKey, worstErr } = errorsBetween(a, b);
      if (worstKey !== null && worstErr > 1) {
        kept.add(worstKey);
        stack.push([a, worstKey], [worstKey, b]);
      }
    }
    const reduced = new Map([...kept].sort((x, y) => x - y).map(f => [f, ch.get(f)]));
    newChannels.set(bone, reduced);
    after += reduced.size;
  }

  doc.channels = newChannels;
  doc.prune();

  // Measure the real remaining error against the original motion.
  for (const [bone, o] of originals) {
    for (const [f, oq] of o.q) {
      const res = doc.evaluateBone(bone, f, q, p);
      if (!res) continue;
      maxErrRad = Math.max(maxErrRad, q.angleTo(oq));
      if (res === 'both' && o.p.has(f)) maxErrPos = Math.max(maxErrPos, p.distanceTo(o.p.get(f)));
    }
  }
  return { before, after, maxErrorDeg: (maxErrRad * 180) / Math.PI, maxErrorPos: maxErrPos };
}

// Build a document from a parsed clip: a key at each of the clip's frames for every bone.
// Positions are kept for bones the clip actually moves (e.g. Bip01, or a stance that plants the feet).
export function docFromClip(set, ticksPerSecond, character, name) {
  const doc = new AnimDoc({ name });
  const q = new THREE.Quaternion(), p = new THREE.Vector3();
  const tickToFrame = (tk) => Math.round((tk / ticksPerSecond) * FPS);
  for (const t of set.tracks) {
    const bone = character.bones.get(t.bone);
    if (!bone || t.bone === 'Translation_Data' || !t.rot) continue;
    const r = bone.userData.rest;
    let movesPos = false;
    if (t.pos) {
      for (let i = 0; i < t.pos.times.length; i++) {
        p.fromArray(t.pos.values, i * 3);
        if (p.distanceTo(r.position) > 0.0005) { movesPos = true; break; }
      }
    }
    const frames = new Set(t.rot.times.map(tickToFrame));
    for (const f of frames) {
      sampleTrack(t, (f / FPS) * ticksPerSecond, q, p);
      doc.keyBone(t.bone, f, q, movesPos ? p : null);
    }
  }
  const td = set.tracks.find(t => t.bone === 'Translation_Data');
  if (td?.pos?.times.length > 1) {
    const v = td.pos.values, n = td.pos.times.length;
    doc.forward = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]);
  }
  for (const k of doc.frames.values()) { k.in = 'linear'; k.out = 'linear'; } // dense keys: linear matches the source
  return doc;
}

// Linear sample of a parsed track at a tick (rotation via slerp of DirectX keys converted to three).
function sampleTrack(t, tick, outQ, outP) {
  const pick = (times) => {
    if (tick <= times[0]) return [0, 0, 0];
    if (tick >= times[times.length - 1]) return [times.length - 1, times.length - 1, 0];
    for (let i = 0; i < times.length - 1; i++) if (times[i] <= tick && tick < times[i + 1]) return [i, i + 1, (tick - times[i]) / (times[i + 1] - times[i])];
    return [0, 0, 0];
  };
  const toQ = (v, i, out) => out.set(-v[i * 4 + 1], -v[i * 4 + 2], -v[i * 4 + 3], v[i * 4]);
  const [a, b, s] = pick(t.rot.times);
  toQ(t.rot.values, a, outQ); toQ(t.rot.values, b, _qb);
  if (outQ.dot(_qb) < 0) _qb.set(-_qb.x, -_qb.y, -_qb.z, -_qb.w);
  outQ.slerp(_qb, s);
  if (t.pos && outP) {
    const [c, d, w] = pick(t.pos.times);
    const v = t.pos.values;
    outP.set(v[c * 3] + (v[d * 3] - v[c * 3]) * w, v[c * 3 + 1] + (v[d * 3 + 1] - v[c * 3 + 1]) * w, v[c * 3 + 2] + (v[d * 3 + 2] - v[c * 3 + 2]) * w);
  }
}
