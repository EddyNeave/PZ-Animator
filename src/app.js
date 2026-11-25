import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { parseX } from './xparser.js';
import { buildCharacter, clipFromSet, resetPose, forwardMotion } from './character.js';
import { buildRefIndex, describeUse } from './refs.js';
import { pickFolder, indexFolder, FileIndex, isDesktop } from './fsbridge.js';
import { initExport } from './exportui.js';

const FPS = 30; // PZ animations: 4800 ticks/s, a key every 160 ticks

// ---------- scene ----------
const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2e33);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(1.2, 0.9, 1.8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
// Left mouse is reserved for bone posing (next milestone).
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4036, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 4, 3);
scene.add(sun);
const grid = new THREE.GridHelper(4, 16, 0x555b62, 0x3a3f45);
scene.add(grid);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

// ---------- state ----------
const state = {
  index: null,
  gender: 'female',
  type: 'human',
  character: null,
  skeletonHelper: null,
  showBones: false,
  mixer: null,
  action: null,
  clip: null,
  playing: false,
  animPath: null,
  cache: new Map(),
  keepBase: (() => { try { return localStorage.getItem('pzKeepBase') === '1'; } catch { return false; } })(),
  refs: null,
};
const textureLoader = new THREE.TextureLoader();
const clock = new THREE.Clock();

// ---------- ui refs ----------
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : 'muted';
}

// ---------- loading ----------
async function loadX(rel) {
  if (state.cache.has(rel)) return state.cache.get(rel);
  const text = await state.index.text(rel);
  const parsed = parseX(text);
  parsed.sourceText = text; // kept for export (used as the template file)
  state.cache.set(rel, parsed);
  return parsed;
}

async function openFolder(folder) {
  try {
    setStatus('Indexing game files…');
    const info = await indexFolder(folder);
    state.index = new FileIndex(info);
    const body = state.index.find('MaleBody.x', 'models_x/');
    if (!body) throw new Error("Couldn't find MaleBody.x under media/models_X. Is this the Project Zomboid install folder?");
    $('folderPath').textContent = info.root;
    try { localStorage.setItem('pzFolder', folder); } catch {}
    $('modelSection').classList.remove('disabled');
    $('animSection').classList.remove('disabled');
    buildAnimList();
    scanRefs();
    refreshSkinOptions();
    await rebuildCharacter();
    const defaultAnim = state.index.find('Bob_Walk.x', 'anims_x/');
    if (defaultAnim) await playAnim(defaultAnim);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

function skinCandidates() {
  const g = state.gender === 'male';
  const re = state.type === 'human'
    ? (g ? /^malebody(\d+[a-z]?)\.png$/ : /^femalebody(\d+[a-z]?)\.png$/)
    : (g ? /^m_zedbody(\d+)\.png$/ : /^f_zedbody(\d+)\.png$/);
  const found = [];
  for (const [base, paths] of state.index.byBase) {
    const m = base.match(re);
    if (m) found.push({ id: m[1], path: paths.find(p => p.toLowerCase().includes('textures/')) || paths[0] });
  }
  found.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return found;
}

function refreshSkinOptions() {
  const sel = $('skinSel');
  const prev = sel.value;
  sel.innerHTML = '';
  const list = skinCandidates();
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.path; o.textContent = s.id;
    sel.appendChild(o);
  }
  if (!list.length) {
    const o = document.createElement('option'); o.textContent = '(none found)'; o.value = ''; sel.appendChild(o);
  }
  const keep = [...sel.options].find(o => o.textContent === [...sel.options].find(x => x.value === prev)?.textContent);
  if (keep) sel.value = keep.value;
  $('rotRow').classList.toggle('hidden', state.type !== 'zombie');
}

async function textureFromBuffer(buf, mime = 'image/png') {
  const url = URL.createObjectURL(new Blob([buf], { type: mime }));
  try {
    const tex = await textureLoader.loadAsync(url);
    tex.flipY = false;               // .x UVs are top-down
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  } finally { URL.revokeObjectURL(url); }
}

function setMap(tex) {
  const mat = state.character.material;
  if (mat.map) mat.map.dispose();
  mat.map = tex;
  mat.needsUpdate = true;
}

async function applyTexture() {
  if (!state.character) return;
  state.customTextureName = null;
  updateCustomLabel();
  if (state.customModel) {
    // Custom models keep their own texture unless a skin is chosen explicitly.
    if (!state.skinChosenForCustom) return;
  }
  let rel = $('skinSel').value;
  if (!rel) { state.character.material.map = null; state.character.material.needsUpdate = true; return; }
  if (state.type === 'zombie' && $('rotSel').value) {
    const leveled = rel.replace(/\.png$/i, $('rotSel').value + '.png');
    const hit = state.index.byLower.get(leveled.toLowerCase());
    if (hit) rel = hit; else setStatus('Rot texture not found: ' + leveled.split('/').pop(), true);
  }
  const buf = await state.index.binary(rel);
  setMap(await textureFromBuffer(buf));
}

async function rebuildCharacter() {
  state.customModel = null;
  state.skinChosenForCustom = false;
  const file = state.gender === 'male' ? 'MaleBody.x' : 'FemaleBody.x';
  const rel = state.index.find(file, 'models_x/');
  if (!rel) { setStatus(`Couldn't find ${file}`, true); return; }
  await setCharacter(await loadX(rel));
  await applyTexture();
  await replayCurrent();
  updateCustomLabel();
}

async function setCharacter(bodyX) {
  const time = state.action ? state.action.time : 0;
  state.resumeTime = time;

  if (state.character) {
    scene.remove(state.character.root);
    state.character.mesh.geometry.dispose();
    if (state.character.material.map) state.character.material.map.dispose();
    state.character.material.dispose();
  }
  if (state.skeletonHelper) { scene.remove(state.skeletonHelper); state.skeletonHelper = null; }

  state.character = buildCharacter(bodyX);
  scene.add(state.character.root);
  state.skeletonHelper = new THREE.SkeletonHelper(state.character.root);
  state.skeletonHelper.visible = state.showBones;
  scene.add(state.skeletonHelper);
  state.mixer = new THREE.AnimationMixer(state.character.root);
  state.action = null;
  setStatus('');
}

async function replayCurrent() {
  if (state.customAnim) { state.current = { x: state.customAnim.x, rel: null, actualRel: null, label: state.customAnim.label }; playParsed(state.customAnim.x, state.customAnim.label, state.resumeTime || 0); }
  else if (state.animPath) await playAnim(state.animPath, state.resumeTime || 0);
}

async function playAnim(rel, startTime = 0) {
  try {
    state.animPath = rel;
    state.customAnim = null;
    const x = await loadX(rel);
    state.current = { x, rel, actualRel: rel, label: null };
    playParsed(x, null, startTime);
    highlightAnim(rel);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

// Play the first animation set of a parsed .x file on the current character.
function playParsed(x, label, startTime = 0, note = '') {
  if (!x.animationSets.length) throw new Error('No animation in ' + (label || 'file'));
  const set = x.animationSets[0];
  resetPose(state.character);
  state.mixer.stopAllAction();
  if (state.clip) state.mixer.uncacheClip(state.clip);
  state.clip = clipFromSet(set, x.ticksPerSecond, state.character.bones, { keepBaseSkeleton: state.keepBase });
  const matched = new Set(state.clip.tracks.map(t => t.name.split('.')[0])).size;
  state.action = state.mixer.clipAction(state.clip);
  state.action.play();
  state.action.time = Math.min(startTime, Math.max(state.clip.duration, 0));
  state.mixer.timeScale = +$('speed').value || 1;
  state.mixer.update(0);
  $('transport').classList.remove('disabled');
  setPlaying(true);
  // End-of-chain "Nub" bones exist in animation files but not in body meshes; ignore them.
  const total = set.tracks.filter(t => !/Nub$/i.test(t.bone)).length;
  const mismatch = matched < total ? ` · ${matched}/${total} bones match this model` : '';
  const fm = forwardMotion(set, x.ticksPerSecond);
  const motion = fm.speed > 0.001 ? ` · moves ${fm.speed.toFixed(2)} units/s` : ' · in place';
  setStatus(`${label ? label + ' · ' : ''}${set.name}${note} · ${Math.round(state.clip.duration * FPS)} frames${motion}${mismatch}`);
  renderUsedBy();
}

// Name the game knows this clip by: the file name for game files, else the animation set name.
export function currentClipName() {
  if (!state.current) return null;
  if (state.current.rel) return state.current.rel.split('/').pop().replace(/\.x$/i, '');
  return state.current.x.animationSets[0]?.name || null;
}

function renderUsedBy() {
  const box = $('usedBy');
  const name = currentClipName();
  if (!name) { box.innerHTML = ''; return; }
  if (!state.refs) { box.innerHTML = '<div class="muted small">Scanning AnimSets…</div>'; return; }
  const uses = state.refs.get(name.toLowerCase()) || [];
  $('usedByTitle').textContent = `Used by (${uses.length})`;
  if (!uses.length) { box.innerHTML = `<div class="muted small">No vanilla AnimSet node plays ${escapeHtml(name)} directly.</div>`; return; }
  box.innerHTML = uses.map(u => `<div class="use" title="${escapeHtml(u.rel)}"><span class="node">${escapeHtml(u.set)}/${escapeHtml(u.node)}</span> <span class="role">${escapeHtml(describeUse(u))}</span></div>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function scanRefs() {
  state.refs = null;
  renderUsedBy();
  try {
    state.refs = await buildRefIndex(state.index);
  } catch (e) { console.error(e); state.refs = new Map(); }
  renderUsedBy();
}

// ---------- drag and drop ----------
function updateCustomLabel() {
  const parts = [];
  if (state.customModel) parts.push(`Model: ${state.customModel}`);
  if (state.customTextureName) parts.push(`Texture: ${state.customTextureName}`);
  if (state.customAnim) parts.push(`Animation: ${state.customAnim.label}`);
  $('customInfo').textContent = parts.join(' · ');
  $('customInfo').classList.toggle('hidden', !parts.length);
  $('customHint').classList.toggle('hidden', !state.customModel);
  if (state.customModel) for (const b of $('genderSeg').children) b.classList.remove('on');
}

function askModelOrAnim(name) {
  return new Promise((resolve) => {
    const dlg = $('dropChoice');
    $('dropChoiceName').textContent = name;
    dlg.classList.remove('hidden');
    const done = (v) => { dlg.classList.add('hidden'); dlg.onclick = null; resolve(v); };
    dlg.onclick = (e) => { const b = e.target.closest('button'); if (b) done(b.dataset.v); };
  });
}

async function loadCustomModel(x, name, droppedImages) {
  state.customModel = name;
  state.skinChosenForCustom = false;
  await setCharacter(x);
  frameCharacter(true);
  // Find its texture: dropped alongside it first, then in the game folder.
  const wanted = (state.character.textureNames || [])[0];
  if (wanted) {
    const base = wanted.split(/[\\/]/).pop().toLowerCase();
    const dropped = droppedImages.find(f => f.name.toLowerCase() === base);
    if (dropped) { setMap(await textureFromBuffer(await dropped.arrayBuffer(), dropped.type || 'image/png')); state.customTextureName = dropped.name; }
    else if (state.index) {
      const rel = state.index.find(base, 'textures/');
      if (rel) { setMap(await textureFromBuffer(await state.index.binary(rel))); state.customTextureName = base + ' (game)'; }
    }
  }
  updateCustomLabel();
  await replayCurrent();
}

async function handleDrop(fileList) {
  const files = [...fileList];
  const images = files.filter(f => /\.(png|jpe?g)$/i.test(f.name));
  const xs = files.filter(f => /\.x$/i.test(f.name));
  const other = files.filter(f => !images.includes(f) && !xs.includes(f));
  if (!state.character) { setStatus('Choose your game folder first, then drop files onto the view.', true); return; }
  try {
    let modelLoaded = false;
    const anims = [];
    for (const f of xs) {
      const text = await f.text();
      const x = parseX(text);
      x.sourceText = text;
      const hasMesh = x.meshes.length > 0;
      const hasAnim = x.animationSets.length > 0;
      let use = hasMesh && hasAnim ? await askModelOrAnim(f.name) : hasMesh ? 'model' : hasAnim ? 'anim' : null;
      if (!use) { setStatus(`${f.name} has no model or animation`, true); continue; }
      if (use === 'model' && !modelLoaded) { await loadCustomModel(x, f.name, images); modelLoaded = true; }
      else if (use === 'anim') anims.push({ x, label: f.name });
    }
    // Images not consumed by a model become the current texture.
    const used = state.customTextureName && !state.customTextureName.endsWith('(game)') ? state.customTextureName : null;
    const img = images.find(f => f.name !== used);
    if (img) {
      setMap(await textureFromBuffer(await img.arrayBuffer(), img.type || 'image/png'));
      state.customTextureName = img.name;
      updateCustomLabel();
    }
    if (anims.length) {
      const a = anims[anims.length - 1];
      state.customAnim = a;
      state.current = { x: a.x, rel: null, actualRel: null, label: a.label };
      highlightAnim(null);
      playParsed(a.x, a.label);
      updateCustomLabel();
    }
    if (other.length) setStatus(`Not supported yet: ${other.map(f => f.name).join(', ')} (only .x, .png and .jpg)`, true);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.remove('hidden'); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.add('hidden');
  if (e.dataTransfer.files.length) handleDrop(e.dataTransfer.files);
});

// ---------- animation list ----------
let animEntries = [];
function buildAnimList() {
  animEntries = state.index.under('anims_x/', '.x').map(p => {
    const parts = p.split('/');
    return { path: p, name: parts[parts.length - 1].replace(/\.x$/i, ''), dir: parts.slice(1, -1).join('/') };
  });
  animEntries.sort((a, b) => a.name.localeCompare(b.name));
  renderAnimList();
}

function renderAnimList() {
  const q = $('animSearch').value.trim().toLowerCase();
  const list = $('animList');
  list.innerHTML = '';
  const hits = q ? animEntries.filter(e => e.name.toLowerCase().includes(q) || e.dir.toLowerCase().includes(q)) : animEntries;
  const frag = document.createDocumentFragment();
  for (const e of hits.slice(0, 400)) {
    const li = document.createElement('li');
    li.dataset.path = e.path;
    li.title = e.path;
    li.innerHTML = `${e.name} <span class="dir">${e.dir}</span>`;
    if (e.path === state.animPath) li.classList.add('on');
    frag.appendChild(li);
  }
  list.appendChild(frag);
  $('animCount').textContent = hits.length > 400 ? `Showing 400 of ${hits.length}, refine search` : `${hits.length} animations`;
}

function highlightAnim(rel) {
  for (const li of $('animList').children) li.classList.toggle('on', li.dataset.path === rel);
}

// ---------- transport ----------
function setPlaying(p) {
  state.playing = p;
  $('playBtn').textContent = p ? '❚❚' : '▶';
}

function updateTransport() {
  if (!state.action || !state.clip) return;
  const d = state.clip.duration;
  const t = state.action.time % d;
  if (document.activeElement !== $('scrub')) $('scrub').value = Math.round((t / d) * 1000);
  $('frameLabel').textContent = `${Math.round(t * FPS)} / ${Math.round(d * FPS)}`;
}

// ---------- events ----------
$('pickFolder').addEventListener('click', async () => {
  const folder = await pickFolder();
  if (folder) openFolder(folder);
});

function segHandler(id, key, after) {
  $(id).addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $(id).children) x.classList.toggle('on', x === b);
    state[key] = b.dataset.v;
    await after();
  });
}
segHandler('genderSeg', 'gender', async () => { refreshSkinOptions(); await rebuildCharacter(); });
segHandler('typeSeg', 'type', async () => { refreshSkinOptions(); await applyTexture(); });
$('skinSel').addEventListener('change', () => { state.skinChosenForCustom = true; applyTexture(); });
$('rotSel').addEventListener('change', applyTexture);
$('animSearch').addEventListener('input', renderAnimList);
$('keepBase').checked = state.keepBase;
$('keepBase').addEventListener('change', () => setKeepBase($('keepBase').checked));
function setKeepBase(on) {
  state.keepBase = on;
  try { localStorage.setItem('pzKeepBase', on ? '1' : '0'); } catch {}
  $('keepBase').checked = on;
  if (state.current && state.action) {
    const t = state.action.time, playing = state.playing;
    playParsed(state.current.x, state.current.label, t);
    setPlaying(playing);
  }
}
$('animList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) playAnim(li.dataset.path);
});
$('playBtn').addEventListener('click', () => setPlaying(!state.playing));
$('scrub').addEventListener('input', () => {
  if (!state.action) return;
  setPlaying(false);
  state.action.time = ($('scrub').value / 1000) * state.clip.duration;
  state.mixer.update(0);
});
$('speed').addEventListener('input', () => { if (state.mixer) state.mixer.timeScale = +$('speed').value || 1; });

function frameCharacter(fit = false) {
  if (fit && state.character) {
    // Fit the camera to the model's size (custom models can be much smaller or bigger).
    state.character.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(state.character.mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 0.05);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.6, 0.35, 1).normalize().multiplyScalar(r * 2.4));
    camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
  } else {
    controls.target.set(0, 0.5, 0);
    camera.position.set(1.2, 0.9, 1.8);
    camera.near = 0.01; camera.far = 100; camera.updateProjectionMatrix();
  }
  controls.update();
}
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); if (state.action) setPlaying(!state.playing); }
  if (e.key === 'f' || e.key === 'F') frameCharacter(!!state.customModel);
  if (e.key === 'b' || e.key === 'B') {
    state.showBones = !state.showBones;
    if (state.skeletonHelper) state.skeletonHelper.visible = state.showBones;
  }
});

// ---------- loop ----------
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (state.mixer && state.playing) state.mixer.update(dt);
  updateTransport();
  controls.update();
  renderer.render(scene, camera);
});

initExport({ state, setStatus, setKeepBase, currentClipName });

// Test hooks (used by automated render checks).
window.__pz = { state, openFolder, handleDrop, playAnim, rebuildCharacter, applyTexture, camera, controls, setPlaying,
  setOption: async (key, v) => { $(key === 'gender' ? 'genderSeg' : 'typeSeg').querySelector(`[data-v="${v}"]`).click(); await new Promise(r => setTimeout(r, 300)); } };

// ---------- startup ----------
if (!isDesktop) {
  $('folderPath').textContent = 'Browser dev mode: using bundled test files';
  openFolder('testdata');
} else {
  let last = null;
  try { last = localStorage.getItem('pzFolder'); } catch {}
  if (last) openFolder(last);
}
