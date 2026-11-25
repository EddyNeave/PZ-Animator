// Parser for DirectX .x files in text format ("xof 0303txt"), as used by Project Zomboid.
// Produces plain data: frame hierarchy, skinned mesh and animation sets.

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = text.indexOf('\n'); // skip the "xof 0303txt 0032" header line
  if (i < 0) i = n;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',' || c === ';') { i++; continue; }
    if (c === '/' && text[i + 1] === '/' || c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { tokens.push(c); i++; continue; }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      tokens.push({ s: text.slice(i + 1, end) });
      i = end + 1; continue;
    }
    if (c === '<') { // GUID
      const end = text.indexOf('>', i);
      i = end + 1; continue;
    }
    if (c === '[') { const end = text.indexOf(']', i); i = end + 1; continue; }
    let j = i;
    while (j < n && !' \t\r\n,;{}"<['.includes(text[j])) j++;
    const word = text.slice(i, j);
    tokens.push(NUM_RE.test(word) ? +word : word);
    i = j;
  }
  return tokens;
}

// Generic data object: { type, name, data: [numbers/strings], children: [objects], refs: [names] }
function parseObjects(tokens) {
  let p = 0;
  function parseBody(obj) {
    // after '{'
    while (p < tokens.length) {
      const t = tokens[p];
      if (t === '}') { p++; return obj; }
      if (t === '{') { // reference: { Name }
        p++;
        if (typeof tokens[p] === 'string' && tokens[p] !== '}') obj.refs.push(tokens[p++]);
        while (tokens[p] !== '}') p++;
        p++;
        continue;
      }
      if (typeof t === 'string' && (tokens[p + 1] === '{' || (typeof tokens[p + 1] === 'string' && tokens[p + 2] === '{'))) {
        obj.children.push(parseObject());
        continue;
      }
      obj.data.push(typeof t === 'object' ? t.s : t);
      p++;
    }
    return obj;
  }
  function parseObject() {
    const type = tokens[p++];
    let name = null;
    if (tokens[p] !== '{') name = tokens[p++];
    p++; // '{'
    return parseBody({ type, name, data: [], children: [], refs: [] });
  }
  const roots = [];
  while (p < tokens.length) {
    if (tokens[p] === 'template') { // skip templates
      while (tokens[p] !== '{') p++;
      let depth = 0;
      do { if (tokens[p] === '{') depth++; else if (tokens[p] === '}') depth--; p++; } while (depth > 0);
      continue;
    }
    if (typeof tokens[p] === 'string') roots.push(parseObject());
    else p++;
  }
  return roots;
}

function interpretFrame(obj, parentName, out) {
  const frame = { name: obj.name, parent: parentName, matrix: null, children: [] };
  for (const c of obj.children) {
    if (c.type === 'FrameTransformMatrix') frame.matrix = c.data.slice(0, 16).map(Number);
    else if (c.type === 'Frame') frame.children.push(interpretFrame(c, obj.name, out));
    else if (c.type === 'Mesh') out.meshes.push(interpretMesh(c, obj.name));
  }
  if (!frame.matrix) frame.matrix = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return frame;
}

function interpretMesh(obj, frameName) {
  const d = obj.data;
  let k = 0;
  const nv = d[k++];
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) positions[i] = d[k++];
  const nf = d[k++];
  const faces = [];
  for (let f = 0; f < nf; f++) {
    const cnt = d[k++];
    const idx = d.slice(k, k + cnt); k += cnt;
    for (let t = 1; t + 1 < cnt; t++) faces.push(idx[0], idx[t], idx[t + 1]); // fan triangulation
  }
  const mesh = { name: obj.name, frame: frameName, positions, indices: faces, uvs: null, skins: [], textures: [] };
  for (const c of obj.children) {
    if (c.type === 'MeshTextureCoords') {
      const n = c.data[0];
      mesh.uvs = new Float32Array(c.data.slice(1, 1 + n * 2));
    } else if (c.type === 'SkinWeights') {
      const cd = c.data;
      const bone = cd[0];
      const n = cd[1];
      mesh.skins.push({
        bone,
        indices: cd.slice(2, 2 + n),
        weights: cd.slice(2 + n, 2 + 2 * n),
        offset: cd.slice(2 + 2 * n, 2 + 2 * n + 16),
      });
    } else if (c.type === 'MeshMaterialList') {
      const walk = (o) => { if (o.type === 'TextureFilename') mesh.textures.push(o.data[0]); o.children.forEach(walk); };
      c.children.forEach(walk);
      mesh.materialRefs = c.refs.slice(); // names of top-level Material objects
    }
  }
  return mesh;
}

function interpretAnimationSet(obj) {
  const set = { name: obj.name, tracks: [] };
  for (const a of obj.children) {
    if (a.type !== 'Animation') continue;
    let bone = a.refs[0];
    if (!bone) { const r = a.children.find(c => c.type !== 'AnimationKey' && c.type !== 'AnimationOptions'); if (r) bone = r.type; }
    const track = { bone, rot: null, scale: null, pos: null, matrix: null };
    for (const key of a.children) {
      if (key.type !== 'AnimationKey') continue;
      const d = key.data;
      const keyType = d[0], nKeys = d[1];
      const times = [], values = [];
      let k = 2;
      for (let i = 0; i < nKeys; i++) {
        times.push(d[k++]);
        const nVal = d[k++];
        for (let v = 0; v < nVal; v++) values.push(d[k++]);
      }
      const entry = { times, values };
      if (keyType === 0) track.rot = entry;        // quaternion w,x,y,z
      else if (keyType === 1) track.scale = entry;
      else if (keyType === 2) track.pos = entry;
      else if (keyType === 4) track.matrix = entry;
    }
    set.tracks.push(track);
  }
  return set;
}

export function parseX(text) {
  if (!text.startsWith('xof ')) throw new Error('Not a DirectX .x file');
  if (text.slice(8, 12) !== 'txt ') throw new Error('Only text-format .x files are supported (this one is ' + text.slice(8, 12).trim() + ')');
  const roots = parseObjects(tokenize(text));
  const out = { frames: [], meshes: [], animationSets: [], materials: {}, ticksPerSecond: 4800 };
  for (const r of roots) {
    if (r.type === 'Frame') out.frames.push(interpretFrame(r, null, out));
    else if (r.type === 'Mesh') out.meshes.push(interpretMesh(r, null));
    else if (r.type === 'AnimationSet') out.animationSets.push(interpretAnimationSet(r));
    else if (r.type === 'AnimTicksPerSecond') out.ticksPerSecond = r.data[0];
    else if (r.type === 'Material' && r.name) {
      const tex = [];
      const walk = (o) => { if (o.type === 'TextureFilename') tex.push(o.data[0]); o.children.forEach(walk); };
      r.children.forEach(walk);
      out.materials[r.name] = tex;
    }
  }
  // Resolve texture names referenced through top-level materials.
  for (const m of out.meshes) {
    for (const ref of m.materialRefs || []) for (const t of out.materials[ref] || []) if (!m.textures.includes(t)) m.textures.push(t);
  }
  return out;
}

// Flatten frame tree into an ordered list (parents before children).
export function flattenFrames(frames) {
  const list = [];
  const walk = (f) => { list.push(f); f.children.forEach(walk); };
  frames.forEach(walk);
  return list;
}
