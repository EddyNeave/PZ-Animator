// Index of which AnimSet nodes use which animation clips, built from the game's media/AnimSets.
// Map: lowercased clip name -> [{ rel, set, node, role: 'main'|'blend'|'transition', ... }]

export async function buildRefIndex(index) {
  const files = index.under('animsets/', '.xml');
  const refs = new Map();
  const add = (clip, use) => {
    if (!clip) return;
    const k = clip.trim().toLowerCase();
    if (!refs.has(k)) refs.set(k, []);
    const list = refs.get(k);
    if (!list.some(u => u.rel === use.rel && u.role === use.role && u.target === use.target)) list.push(use);
  };
  const parser = new DOMParser();
  const BATCH = 32;
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const texts = await Promise.all(chunk.map(rel => index.text(rel).catch(() => null)));
    chunk.forEach((rel, j) => {
      if (!texts[j]) return;
      const doc = parser.parseFromString(texts[j], 'application/xml');
      const root = doc.documentElement;
      if (!root || root.tagName !== 'animNode') return;
      const kids = (el, tag) => [...el.children].filter(c => c.tagName === tag);
      const text = (el, tag) => kids(el, tag)[0]?.textContent?.trim() || '';
      const set = rel.replace(/^animsets\//i, '').split('/').slice(0, -1).join('/');
      const node = text(root, 'm_Name') || rel.split('/').pop().replace(/\.xml$/i, '');
      const conds = kids(root, 'm_Conditions')
        .filter(c => text(c, 'm_Name'))
        .map(c => `${text(c, 'm_Name')} = ${text(c, 'm_Value') || text(c, 'm_StringValue') || '…'}`);
      const base = { rel, set, node, extends: root.getAttribute('x_extends') || null };
      add(text(root, 'm_AnimName'), { ...base, role: 'main', conditions: conds });
      for (const b of kids(root, 'm_2DBlends')) add(text(b, 'm_AnimName'), { ...base, role: 'blend', x: text(b, 'm_XPos'), y: text(b, 'm_YPos') });
      for (const t of kids(root, 'm_Transitions')) add(text(t, 'm_AnimName'), { ...base, role: 'transition', target: text(t, 'm_Target') });
    });
  }
  return refs;
}

export function describeUse(u) {
  if (u.role === 'main') return u.conditions?.length ? `main clip · plays when ${u.conditions.slice(0, 2).join(', ')}` : 'main clip';
  if (u.role === 'blend') return `part of a blend${u.x !== '' || u.y !== '' ? ` (x ${u.x || '?'}, y ${u.y || '?'})` : ''}`;
  return `transition${u.target ? ` to ${u.target}` : ''}`;
}
