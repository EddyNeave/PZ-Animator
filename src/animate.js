// Animate mode: ties the animation document, bone posing and the timeline together.
import * as THREE from 'three';
import { AnimDoc, docFromClip, reduceKeys, FPS, MODES } from './editor.js';
import { Poser } from './posing.js';
import { Timeline } from './timeline.js';
import { parseX } from './xparser.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'pzAnimAutosave';

export function initAnimate(app) {
  const { state, scene, camera, renderer, setStatus } = app;
  const ed = {
    active: false,
    doc: null,
    frame: 0,
    playing: false,
    undo: [], redo: [],
    template: null,     // { text, parsed, rel, label }
    before: null,       // snapshot taken when a drag starts
  };
  state.edit = ed;

  const poser = new Poser({
    scene, camera, dom: renderer.domElement,
    getCharacter: () => state.character,
    onSelect: (name) => { $('edBone').value = name || ''; timeline.draw(); },
    onBeginEdit: () => { ed.before = snapshot(); },
    onEndEdit: (bone, moved, isHip) => { if (moved) autoKey(bone, isHip); },
  });
  // Stop playback before picking so the handles sit on a whole frame.
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (ed.active && e.button === 0 && ed.playing) { setPlaying(false); applyPose(); }
  }, true);

  const timeline = new Timeline($('timeline'), {
    getDoc: () => ed.doc,
    getFrame: () => ed.frame,
    setFrame: (f) => { setPlaying(false); ed.frame = f; applyPose(); updateLabels(); },
    getBone: () => poser.selected,
    onSelectKey: () => updateInterpUI(),
    onMoveKey: (from, to) => change(() => ed.doc.moveFrame(from, to)),
  });

  // ---------- document helpers ----------
  function snapshot() { return JSON.stringify(ed.doc.toJSON()); }
  function change(fn) {
    const before = snapshot();
    const res = fn();
    if (res === false) return false;
    commit(before);
    return true;
  }
  function commit(before) {
    ed.undo.push(before);
    if (ed.undo.length > 200) ed.undo.shift();
    ed.redo.length = 0;
    afterChange();
  }
  function afterChange() {
    applyPose();
    updateLabels();
    updateInterpUI();
    timeline.draw();
    autosave();
  }
  function undo() {
    if (!ed.undo.length) return;
    ed.redo.push(snapshot());
    ed.doc = AnimDoc.fromJSON(JSON.parse(ed.undo.pop()));
    afterChange();
  }
  function redo() {
    if (!ed.redo.length) return;
    ed.undo.push(snapshot());
    ed.doc = AnimDoc.fromJSON(JSON.parse(ed.redo.pop()));
    afterChange();
  }

  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ doc: ed.doc.toJSON(), templateRel: ed.template?.rel || null, savedAt: Date.now() })); } catch {}
    }, 300);
  }

  const frameNow = () => Math.max(0, Math.round(ed.frame));

  function autoKey(boneName, isHip) {
    const bone = state.character.bones.get(boneName);
    const f = frameNow();
    const withPos = isHip || ed.doc.posBones.has(boneName);
    ed.doc.keyBone(boneName, f, bone.quaternion, withPos ? bone.position : null);
    commit(ed.before);
    timeline.selectedKey = f;
    updateInterpUI();
  }

  function keyPose() {
    change(() => {
      const f = frameNow();
      for (const [name, bone] of state.character.bones) {
        if (name === 'Translation_Data' || name === 'Dummy01') continue;
        const moved = bone.position.distanceTo(bone.userData.rest.position) > 0.0005;
        ed.doc.keyBone(name, f, bone.quaternion, name === 'Bip01' || moved || ed.doc.posBones.has(name) ? bone.position : null);
      }
      timeline.selectedKey = f;
    });
  }

  function resetBone() {
    const name = poser.selected;
    if (!name) return;
    const bone = state.character.bones.get(name);
    change(() => {
      bone.quaternion.copy(bone.userData.rest.quaternion);
      bone.position.copy(bone.userData.rest.position);
      ed.doc.keyBone(name, frameNow(), bone.quaternion, ed.doc.posBones.has(name) ? bone.position : null);
    });
  }

  function reduce() {
    const tol = Math.max(0.01, +$('edReduceTol').value || 0.5);
    let r;
    change(() => { r = reduceKeys(ed.doc, { angleTol: tol, posTol: tol * 0.002 }); });
    timeline.selectedKey = null;
    updateInterpUI();
    const pct = r.before ? Math.round(100 - (r.after / r.before) * 100) : 0;
    setStatus(`Reduced keys ${r.before} → ${r.after} (${pct}% fewer) · largest change ${r.maxErrorDeg.toFixed(2)}° · Ctrl+Z to undo`);
  }

  function deleteKey() {
    const k = timeline.selectedKey;
    if (k == null || !ed.doc.frames.has(k)) return;
    change(() => ed.doc.deleteFrame(k));
    timeline.selectedKey = null;
    updateInterpUI();
  }

  // ---------- pose / playback ----------
  function applyPose() {
    if (!ed.active || !state.character) return;
    ed.doc.applyTo(state.character, ed.frame, poser.dragBone);
  }

  function setPlaying(p) {
    ed.playing = p;
    if (!p) ed.frame = Math.round(ed.frame);
    $('playBtn').textContent = p ? '❚❚' : '▶';
  }

  function tick(dt) {
    if (!ed.active) return false;
    if (ed.playing && !poser.dragging) {
      const last = ed.doc.lastFrame();
      ed.frame += dt * FPS * (ed.doc.speed || 1);
      if (last > 0) ed.frame %= last; else ed.frame = 0;
      updateLabels();
      timeline.draw();
    }
    applyPose();
    poser.update();
    return true;
  }

  // ---------- UI ----------
  function updateLabels() {
    if (!ed.active) return;
    $('frameLabel').textContent = `${Math.round(ed.frame)} / ${ed.doc.lastFrame()}`;
  }

  function updateInterpUI() {
    const k = timeline.selectedKey;
    const key = k != null ? ed.doc?.frames.get(k) : null;
    $('edInterp').classList.toggle('disabled', !key);
    $('edKeyLabel').textContent = key ? `Key ${k}` : 'No key selected';
    for (const side of ['in', 'out']) {
      for (const b of $(`ed${side === 'in' ? 'In' : 'Out'}`).children) b.classList.toggle('on', !!key && key[side] === b.dataset.v);
    }
  }

  function fillBoneList() {
    const sel = $('edBone');
    sel.innerHTML = '<option value="">Select a bone…</option>';
    if (!state.character) return;
    const walk = (obj, depth) => {
      for (const c of obj.children) {
        if (!c.isBone) continue;
        if (c.name !== 'Dummy01' && c.name !== 'Translation_Data') {
          const o = document.createElement('option');
          o.value = c.name; o.textContent = '  '.repeat(Math.max(0, depth - 1)) + c.name.replace(/^Bip01_?/, '') || 'Bip01';
          if (c.name === 'Bip01') o.textContent = 'Bip01 (hips / whole body)';
          sel.appendChild(o);
        }
        walk(c, depth + 1);
      }
    };
    walk(state.character.root, 0);
    sel.value = poser.selected || '';
  }

  function syncFields() {
    $('edName').value = ed.doc.name;
    $('edForward').value = +ed.doc.forward.toFixed(3);
    $('speed').value = ed.doc.speed;
  }

  // ---------- entering / leaving ----------
  async function resolveTemplate(preferX, preferRel) {
    // Bones and header come from a real game file of the same skeleton.
    if (preferX?.sourceText && preferX.animationSets.length) return { text: preferX.sourceText, parsed: preferX, rel: preferRel || null, label: preferRel || 'current clip' };
    if (!state.customModel && state.index) {
      const rel = state.index.find('Bob_Walk.x', 'anims_x/');
      if (rel) { const text = await state.index.text(rel); return { text, parsed: parseX(text), rel, label: rel }; }
    }
    const cx = state.characterX;
    if (cx?.sourceText && cx.animationSets.length) return { text: cx.sourceText, parsed: cx, rel: null, label: 'model file' };
    return null;
  }

  async function enter(kind) {
    if (!state.character) { setStatus('Choose your game folder first.', true); return; }
    let doc, tpl;
    const cur = state.current;
    if (kind === 'copy' && cur) {
      const set = cur.x.animationSets[0];
      const name = (cur.rel ? cur.rel.split('/').pop().replace(/\.x$/i, '') : set.name);
      doc = docFromClip(set, cur.x.ticksPerSecond, state.character, name);
      tpl = await resolveTemplate(cur.x, cur.rel);
    } else if (kind === 'resume') {
      const saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY));
      doc = AnimDoc.fromJSON(saved.doc);
      if (saved.templateRel && state.index?.byLower.has(saved.templateRel.toLowerCase())) {
        const text = await state.index.text(saved.templateRel);
        tpl = { text, parsed: parseX(text), rel: saved.templateRel, label: saved.templateRel };
      } else tpl = await resolveTemplate(null, null);
    } else {
      doc = new AnimDoc({ name: state.customModel ? 'MyAnimation' : 'Bob_MyAnimation' });
      if (kind === 'frame' && state.action) {
        // Key the pose currently shown by the preview clip.
        for (const [name, bone] of state.character.bones) {
          if (name === 'Translation_Data' || name === 'Dummy01') continue;
          const moved = bone.position.distanceTo(bone.userData.rest.position) > 0.0005;
          doc.keyBone(name, 0, bone.quaternion, name === 'Bip01' || moved ? bone.position : null);
        }
      } else {
        const bip = state.character.bones.get('Bip01') || [...state.character.bones.values()][0];
        doc.keyBone(bip.name, 0, bip.userData.rest.quaternion, bip.userData.rest.position);
      }
      tpl = await resolveTemplate(kind === 'frame' ? cur?.x : null, kind === 'frame' ? cur?.rel : null);
    }
    if (!tpl) { setStatus("Couldn't find a game animation to use as the export template (e.g. Bob_Walk.x).", true); return; }

    ed.doc = doc; ed.template = tpl; ed.undo = []; ed.redo = [];
    ed.frame = 0; ed.active = true;
    state.mixer?.stopAllAction();
    app.setPreviewPlaying(false);
    setPlaying(false);
    document.body.classList.add('editing');
    $('speedLabel').textContent = 'Overall speed';
    $('animateDlg').classList.add('hidden');
    poser.setEnabled(true);
    poser.rebuild();
    fillBoneList();
    syncFields();
    timeline.selectedKey = null;
    afterChange();
    requestAnimationFrame(() => timeline.draw());
    setStatus(`Animating "${doc.name}" · export template: ${tpl.label.split('/').pop()}`);
  }

  function exit() {
    ed.active = false;
    ed.playing = false;
    poser.setEnabled(false);
    document.body.classList.remove('editing');
    $('speedLabel').textContent = 'Speed';
    app.onExitEdit();
  }

  function openMenu() {
    if (!state.character) { setStatus('Choose your game folder first.', true); return; }
    const cur = state.current;
    const clipName = cur ? (cur.rel ? cur.rel.split('/').pop().replace(/\.x$/i, '') : cur.x.animationSets[0]?.name) : null;
    $('anCopy').disabled = !cur;
    $('anFrame').disabled = !cur;
    $('anCopyName').textContent = clipName ? `"${clipName}"` : '(play an animation first)';
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)); } catch {}
    $('anResume').disabled = !saved;
    $('anResumeName').textContent = saved ? `"${saved.doc.name}", ${new Date(saved.savedAt).toLocaleString()}` : '(nothing saved yet)';
    $('animateDlg').classList.remove('hidden');
  }

  // ---------- events ----------
  $('animateBtn').addEventListener('click', openMenu);
  $('anNew').addEventListener('click', () => enter('new'));
  $('anFrame').addEventListener('click', () => enter('frame'));
  $('anCopy').addEventListener('click', () => enter('copy'));
  $('anResume').addEventListener('click', () => enter('resume'));
  $('anCancel').addEventListener('click', () => $('animateDlg').classList.add('hidden'));
  $('edExit').addEventListener('click', exit);
  $('edKey').addEventListener('click', keyPose);
  $('edDelete').addEventListener('click', deleteKey);
  $('edReduce').addEventListener('click', reduce);
  $('edReset').addEventListener('click', resetBone);
  $('edUndo').addEventListener('click', undo);
  $('edRedo').addEventListener('click', redo);
  $('edBone').addEventListener('change', () => { poser.select($('edBone').value || null); });
  for (const side of ['In', 'Out']) {
    $(`ed${side}`).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const k = timeline.selectedKey;
      if (!b || k == null || !ed.doc.frames.has(k)) return;
      change(() => { ed.doc.frames.get(k)[side.toLowerCase()] = b.dataset.v; });
    });
  }
  const fieldCommit = (id, apply) => {
    let before = null;
    $(id).addEventListener('focus', () => { before = snapshot(); });
    $(id).addEventListener('input', () => { apply($(id).value); applyPose(); updateLabels(); autosave(); });
    $(id).addEventListener('change', () => { if (before && before !== snapshot()) commit(before); before = snapshot(); });
  };
  fieldCommit('edName', (v) => { ed.doc.name = v.trim() || ed.doc.name; });
  fieldCommit('edForward', (v) => { ed.doc.forward = Math.max(0, +v || 0); });

  window.addEventListener('keydown', (e) => {
    if (!ed.active || e.target.matches('input, select, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteKey(); }
    else if (e.key === 'k' || e.key === 'K') keyPose();
    else if (e.key === 'ArrowLeft') { setPlaying(false); ed.frame = Math.max(0, frameNow() - 1); afterChange(); }
    else if (e.key === 'ArrowRight') { setPlaying(false); ed.frame = frameNow() + 1; afterChange(); }
  });

  return {
    get active() { return ed.active; },
    tick,
    togglePlay() { setPlaying(!ed.playing); },
    setSpeed(v) { if (ed.active) { ed.doc.speed = v > 0 ? v : 1; autosave(); } },
    onCharacterChanged() { if (ed.active) { poser.rebuild(); fillBoneList(); applyPose(); } },
    // For the export dialog.
    exportSource() {
      if (!ed.active || !ed.template) return null;
      return { anim: ed.doc.bake(ed.template.parsed, state.character), templateText: ed.template.text, templateRel: ed.template.rel, name: ed.doc.name, label: `Editor: ${ed.doc.name}` };
    },
    exitQuiet() { if (ed.active) { ed.active = false; ed.playing = false; poser.setEnabled(false); document.body.classList.remove('editing'); $('speedLabel').textContent = 'Speed'; $('speed').value = 1; setStatus('Left Animate mode (your animation is autosaved: Animate… → Resume).'); } },
    ed, poser, timeline, enter, keyPose, undo, redo,
  };
}
