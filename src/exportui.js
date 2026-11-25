import { animFromSet } from './character.js';
import { buildExportFiles, inspectNode, modIdFromName, folderFromName } from './exporter.js';
import { modsDefaultDir, pickModsDir, listMods, checkModFiles, writeModFiles } from './fsbridge.js';

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[A-Za-z0-9_]+$/;

export function initExport({ state, setStatus }) {
  const ui = {
    modsDir: null,
    mods: [],
    nodeTemplates: [],
    nodeInfo: null,
    nodeText: null,
    pendingOverwrite: null,
  };

  const dlg = $('exportDlg');
  const msg = (text, kind = '') => { $('exMsg').textContent = text; $('exMsg').className = 'exmsg ' + kind; };

  function mediaRelOf(rel) { return rel; } // index paths are already relative to media
  function dirOf(rel) { return rel ? rel.slice(0, rel.lastIndexOf('/')) : ''; }

  function vanillaAnim(name) {
    return state.index?.find(name + '.x', 'anims_x/') || null;
  }

  function currentTarget() {
    const v = $('exMod').value;
    if (v === '__new') {
      const name = $('exModName').value.trim() || 'My Animations';
      return { isNew: true, name, id: modIdFromName(name), folder: folderFromName(name), mediaRel: '42/media' };
    }
    const m = ui.mods.find(m => m.folder === v);
    return m ? { ...m, isNew: false } : null;
  }

  // Work out every path from the current form values.
  function plan() {
    const name = $('exName').value.trim();
    const mode = document.querySelector('input[name="exMode"]:checked').value;
    const errors = [];
    if (!NAME_RE.test(name)) errors.push('Animation name can only use letters, numbers and _');
    const vanilla = vanillaAnim(name);
    const srcRel = state.current?.actualRel;
    const fallbackDir = srcRel ? dirOf(srcRel) : 'anims_X';
    const animRel = vanilla ? mediaRelOf(vanilla) : `${fallbackDir}/${name}.x`;

    let kateRel = null;
    const isBob = /^Bob_/i.test(name);
    if (isBob && $('exKate').checked) {
      const kName = 'Kate_' + name.slice(4);
      kateRel = vanillaAnim(kName) || `${dirOf(animRel)}/${kName}.x`;
    }

    let node = null;
    if (mode === 'node') {
      const nodeName = $('exNodeName').value.trim();
      if (!ui.nodeText) errors.push('Pick a vanilla node to base the new one on');
      if (!NAME_RE.test(nodeName)) errors.push('Node name can only use letters, numbers and _');
      if (ui.nodeText && NAME_RE.test(nodeName)) {
        node = {
          templateText: ui.nodeText,
          rel: `${dirOf($('exNodeList').value)}/${nodeName}.xml`,
          nodeName,
          conditionValue: ui.nodeInfo?.condition ? $('exCondValue').value : null,
        };
      }
    }
    const mod = currentTarget();
    if (!mod) errors.push('Choose a mod to export into');
    return { name, mode, vanilla, animRel, kateRel, node, mod, errors, isBob };
  }

  function refresh() {
    if (!state.current) return;
    const p = plan();
    const mode = p.mode;
    $('exNodeBox').classList.toggle('hidden', mode !== 'node');
    $('exKateRow').classList.toggle('hidden', !p.isBob);
    $('exNewModBox').classList.toggle('hidden', $('exMod').value !== '__new');

    let note = '';
    if (mode === 'replace') {
      note = p.vanilla
        ? `Replaces the vanilla ${p.name}. The game will play yours instead, everywhere it's used.`
        : `No vanilla animation is called ${p.name}, so nothing will play it. Use the same name as a vanilla animation, or switch to "Add a new node".`;
    } else if (p.vanilla) {
      note = `Heads up: ${p.name} is also a vanilla name, so this replaces that animation too. Pick a new name to leave vanilla alone.`;
    }
    $('exModeNote').textContent = note;
    $('exModeNote').classList.toggle('warn', mode === 'replace' ? !p.vanilla : !!p.vanilla);

    if (p.mod?.layout === 'flat') $('exModNote').textContent = 'This mod uses the old layout (no 42 folder), so files go in its media folder.';
    else if (p.mod?.isNew) $('exModNote').textContent = `Creates ${p.mod.folder}/42/mod.info and ${p.mod.folder}/common/`;
    else $('exModNote').textContent = '';

    const list = $('exFiles');
    list.innerHTML = '';
    if (!p.errors.length) {
      try {
        const { files } = buildFiles(p);
        for (const f of files) { const li = document.createElement('li'); li.textContent = `${p.mod.folder}/${f.rel}`; list.appendChild(li); }
      } catch (e) { p.errors.push(e.message); }
    }
    msg(p.errors.join(' · '), p.errors.length ? 'error' : '');
    $('exGo').disabled = !!p.errors.length;
    $('exGo').textContent = 'Export';
    ui.pendingOverwrite = null;
  }

  function buildFiles(p) {
    const x = state.current.x;
    const set = x.animationSets[0];
    return buildExportFiles({
      anim: animFromSet(set, x.ticksPerSecond),
      templateText: x.sourceText,
      name: p.name,
      animRel: p.animRel,
      kateRel: p.kateRel,
      node: p.node,
      mod: p.mod,
    });
  }

  async function loadMods() {
    ui.mods = await listMods(ui.modsDir);
    const sel = $('exMod');
    const prev = sel.value;
    sel.innerHTML = '<option value="__new">+ New mod…</option>' +
      ui.mods.map(m => `<option value="${escapeAttr(m.folder)}">${escapeHtml(m.name)}${m.layout === 'flat' ? ' (old layout)' : ''}</option>`).join('');
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    $('exModsDir').textContent = ui.modsDir;
  }

  function renderNodeList() {
    const q = $('exNodeSearch').value.trim().toLowerCase();
    const sel = $('exNodeList');
    const prev = sel.value;
    const hits = ui.nodeTemplates.filter(p => !q || p.toLowerCase().includes(q)).slice(0, 300);
    sel.innerHTML = hits.map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p.replace(/^AnimSets\//i, ''))}</option>`).join('');
    if (hits.includes(prev)) sel.value = prev;
  }

  async function pickNode() {
    const rel = $('exNodeList').value;
    if (!rel) return;
    ui.nodeText = await state.index.text(rel);
    ui.nodeInfo = inspectNode(ui.nodeText);
    const c = ui.nodeInfo.condition;
    $('exCondRow').classList.toggle('hidden', !c);
    if (c) {
      $('exCondLabel').textContent = c.name === '(inherited)'
        ? `Plays when (condition from ${ui.nodeInfo.extends || 'parent'}) =`
        : `Plays when ${c.name}${c.type ? ` (${c.type})` : ''} =`;
      $('exCondValue').value = c.value;
    }
    const extra = [];
    if (ui.nodeInfo.extends) extra.push(`extends ${ui.nodeInfo.extends}`);
    if (ui.nodeInfo.has2DBlends) extra.push('blends several clips (walk-style): the blend clips stay vanilla');
    $('exNodeInfo').textContent = `Based on ${ui.nodeInfo.name} (plays ${ui.nodeInfo.animName || 'inherited animation'})${extra.length ? ' · ' + extra.join(' · ') : ''}. Its events and transitions are kept.`;
    // Vanilla node names have no species prefix (DigHoe, idle1), so drop Bob_/Cow_ etc.
    if (!$('exNodeName').dataset.touched) $('exNodeName').value = $('exName').value.trim().replace(/^[A-Za-z]+_(?=.)/, '');
    refresh();
  }

  async function open() {
    if (!state.current) { setStatus('Play an animation first, then export it.', true); return; }
    const set = state.current.x.animationSets[0];
    $('exSource').textContent = state.current.label || state.current.actualRel || set.name;
    // If a Bob_ animation is playing as its Kate_ variant, export under the Bob_ name.
    const listed = state.current.rel ? state.current.rel.split('/').pop().replace(/\.x$/i, '') : null;
    $('exName').value = listed && /^Bob_/i.test(listed) ? listed : set.name;
    $('exNodeName').dataset.touched = '';
    const nm = $('exName').value;
    const kateVanilla = /^Bob_/i.test(nm) && vanillaAnim('Kate_' + nm.slice(4));
    $('exKate').checked = !!kateVanilla;
    if (!ui.modsDir) ui.modsDir = await modsDefaultDir();
    await loadMods();
    ui.nodeTemplates = state.index.under('animsets/', '.xml').sort();
    renderNodeList();
    dlg.classList.remove('hidden');
    refresh();
    $('exName').focus();
  }

  async function doExport() {
    const p = plan();
    if (p.errors.length) return;
    const { files, dirs } = buildFiles(p);
    try {
      if (!ui.pendingOverwrite) {
        const existing = await checkModFiles(ui.modsDir, p.mod.folder, files.map(f => f.rel));
        if (existing.length) {
          ui.pendingOverwrite = true;
          msg(`These already exist and will be overwritten: ${existing.join(', ')}. Click Overwrite to continue.`, 'warn');
          $('exGo').textContent = 'Overwrite';
          return;
        }
      }
      const written = await writeModFiles(ui.modsDir, p.mod.folder, files, dirs);
      ui.pendingOverwrite = null;
      $('exGo').textContent = 'Export';
      await loadMods();
      $('exMod').value = p.mod.folder;
      refresh();
      msg(`Exported ${written.length} file${written.length > 1 ? 's' : ''} to ${p.mod.folder}. Enable the mod in-game to test it.`, 'ok');
      setStatus(`Exported ${p.name} to ${p.mod.folder}`);
    } catch (e) {
      console.error(e);
      msg(e.message || String(e), 'error');
    }
  }

  // ---------- events ----------
  $('exportBtn').addEventListener('click', open);
  $('exCancel').addEventListener('click', () => dlg.classList.add('hidden'));
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.classList.add('hidden'); });
  $('exGo').addEventListener('click', doExport);
  for (const id of ['exName', 'exModName', 'exCondValue', 'exNodeName']) $(id).addEventListener('input', refresh);
  $('exNodeName').addEventListener('input', () => { $('exNodeName').dataset.touched = '1'; });
  for (const id of ['exKate', 'exMod']) $(id).addEventListener('change', refresh);
  for (const r of document.querySelectorAll('input[name="exMode"]')) r.addEventListener('change', refresh);
  $('exNodeSearch').addEventListener('input', renderNodeList);
  $('exNodeList').addEventListener('change', pickNode);
  $('exModsDirBtn').addEventListener('click', async () => {
    const d = await pickModsDir();
    if (d) { ui.modsDir = d; await loadMods(); refresh(); }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') dlg.classList.add('hidden'); });

  window.__pzExport = { open, plan, doExport, pickNode, refresh, ui };
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
