// Writes Project Zomboid animation .x files.
//
// Strategy: keep everything from a vanilla "template" file of the same skeleton up to its
// AnimationSet (templates, material, preview mesh, skeleton frames, tick rate) byte for byte,
// then append a freshly generated AnimationSet. That keeps the file as close as possible to
// what the game already loads.

import { quatToXKey } from './character.js';

const NL = '\r\n';
const f6 = (n) => (Math.abs(n) < 5e-7 ? 0 : n).toFixed(6);

// Animation data in editor form:
// { name, ticksPerSecond, tracks: [{ bone, rot?: {times, quats:[THREE.Quaternion]}, pos?: {times, values:[x,y,z...]}, scale?: {times, values} }] }
export function writeAnimationX(templateText, anim) {
  const at = templateText.search(/^AnimationSet\b/m);
  if (at < 0) throw new Error('Template file has no AnimationSet to replace');
  let head = templateText.slice(0, at);
  if (!/^AnimTicksPerSecond\b/m.test(head)) {
    head += `AnimTicksPerSecond  {${NL} ${anim.ticksPerSecond};${NL}}${NL}${NL}`;
  } else {
    head = head.replace(/^(AnimTicksPerSecond\s*\{\s*)\d+/m, `$1${anim.ticksPerSecond}`);
  }

  const out = [head, `AnimationSet ${anim.name} {${NL} ${NL}`];
  for (const t of anim.tracks) {
    out.push(`${NL} Animation {${NL}  ${NL}  { ${t.bone} }${NL}`);
    if (t.rot) {
      const lines = t.rot.times.map((time, i) => {
        const [w, x, y, z] = quatToXKey(t.rot.quats[i]);
        return `   ${Math.round(time)};4;${f6(w)},${f6(x)},${f6(y)},${f6(z)};;`;
      });
      out.push(keyBlock('R', 0, lines));
    }
    if (t.scale) out.push(keyBlock('S', 1, vecLines(t.scale)));
    if (t.pos) out.push(keyBlock('T', 2, vecLines(t.pos)));
    out.push(` }${NL}`);
  }
  out.push(`}`);
  return out.join('');
}

function vecLines(track) {
  return track.times.map((time, i) => {
    const v = track.values;
    return `   ${Math.round(time)};3;${f6(v[i * 3])},${f6(v[i * 3 + 1])},${f6(v[i * 3 + 2])};;`;
  });
}

function keyBlock(label, type, lines) {
  return `${NL}  AnimationKey ${label} {${NL}   ${type};${NL}   ${lines.length};${NL}` +
    lines.map((l, i) => l + (i === lines.length - 1 ? ';' : ',')).join(NL) + `${NL}  }${NL}`;
}
