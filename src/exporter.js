// Builds the list of files an export writes into a mod folder.
import { writeAnimationX } from './xwriter.js';

const NL = '\r\n';

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function modIdFromName(name) {
  return name.replace(/[^A-Za-z0-9]+/g, '') || 'MyAnimationMod';
}
export function folderFromName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim() || 'MyAnimationMod';
}

export function modInfoText({ name, id, description }) {
  return [
    `name=${name}`,
    `id=${id}`,
    `description=${description || 'Animations made with PZ Animator'}`,
    `versionMin=42.0`,
    '',
  ].join(NL);
}

// Read what the dialog needs from a vanilla AnimSet node.
export function inspectNode(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const root = doc.documentElement;
  const child = (el, tag) => [...el.children].find(c => c.tagName === tag);
  const cond = [...root.children].find(c => c.tagName === 'm_Conditions' && child(c, 'm_Value'));
  return {
    name: child(root, 'm_Name')?.textContent || '',
    animName: child(root, 'm_AnimName')?.textContent || '',
    extends: root.getAttribute('x_extends'),
    condition: cond ? { name: child(cond, 'm_Name')?.textContent || '(inherited)', type: child(cond, 'm_Type')?.textContent || '', value: child(cond, 'm_Value').textContent } : null,
    has2DBlends: !!child(root, 'm_2DBlends'),
  };
}

// Copy a vanilla node, pointing it at a new animation.
export function makeNodeXml(templateText, { nodeName, animName, conditionValue }) {
  const doc = new DOMParser().parseFromString(templateText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not read the template XML');
  const root = doc.documentElement;
  const child = (el, tag) => [...el.children].find(c => c.tagName === tag);
  child(root, 'm_Name').textContent = nodeName;
  let an = child(root, 'm_AnimName');
  if (!an) { an = doc.createElement('m_AnimName'); root.insertBefore(an, child(root, 'm_Name').nextSibling); }
  an.textContent = animName;
  const cond = [...root.children].find(c => c.tagName === 'm_Conditions' && child(c, 'm_Value'));
  if (cond && conditionValue != null) child(cond, 'm_Value').textContent = conditionValue;
  // Nodes that extend another file match their overrides to the parent by x_name, so those must
  // be kept. Stand-alone copies get fresh IDs.
  if (!root.hasAttribute('x_extends')) {
    for (const el of root.querySelectorAll('[x_name]')) el.setAttribute('x_name', uuid());
  }
  let xml = new XMLSerializer().serializeToString(doc);
  xml = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const eol = templateText.includes('\r\n') ? '\r\n' : '\n';
  xml = xml.replace(/\r?\n/g, eol);
  return `<?xml version="1.0" encoding="utf-8"?>${eol}${xml}${eol}`;
}

/**
 * plan = {
 *   anim,                // editor-form animation (from animFromSet or the editor)
 *   templateText,        // vanilla .x file of the same skeleton (header + skeleton are copied)
 *   name,                // animation name to export as, e.g. Bob_MyAnim or Cow_Idle01
 *   animRel,             // where it goes under media, e.g. anims_X/Bob/Bob_MyAnim.x
 *   kateRel,             // optional: also write a Kate_ copy here
 *   node: { templateText, rel, nodeName, conditionValue } | null,
 *   mod: { folder, mediaRel, isNew, name, id },
 * }
 */
export function buildExportFiles(plan) {
  const files = [];
  const dirs = [];
  const media = plan.mod.mediaRel;
  const animText = writeAnimationX(plan.templateText, { ...plan.anim, name: plan.name });
  files.push({ rel: `${media}/${plan.animRel}`, content: animText });
  if (plan.kateRel) {
    const kateName = 'Kate_' + plan.name.replace(/^Bob_/i, '');
    files.push({ rel: `${media}/${plan.kateRel}`, content: writeAnimationX(plan.templateText, { ...plan.anim, name: kateName }) });
  }
  if (plan.node) {
    files.push({
      rel: `${media}/${plan.node.rel}`,
      content: makeNodeXml(plan.node.templateText, { nodeName: plan.node.nodeName, animName: plan.name, conditionValue: plan.node.conditionValue }),
    });
  }
  if (plan.mod.isNew) {
    files.push({ rel: '42/mod.info', content: modInfoText(plan.mod) });
    dirs.push('common');
  }
  return { files, dirs };
}
