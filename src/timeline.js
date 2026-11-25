// Canvas timeline: frame ruler, keyframe diamonds, playhead. Its length follows the keys
// (always a little past the last key, so there's room to add the next one).

export class Timeline {
  constructor(canvas, { getDoc, getFrame, setFrame, getBone, onSelectKey, onMoveKey, onMoveLoop }) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.getDoc = getDoc; this.getFrame = getFrame; this.setFrame = setFrame; this.getBone = getBone;
    this.onSelectKey = onSelectKey; this.onMoveKey = onMoveKey; this.onMoveLoop = onMoveLoop;
    this.selectedKey = null;
    this.drag = null;
    this.pad = 14;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', () => this.up());
  }

  span() {
    const doc = this.getDoc();
    const last = doc ? doc.lastFrame() : 0;
    return Math.max(30, last + 10, Math.ceil(this.getFrame()) + 5);
  }
  frameToX(f) { const w = this.c.clientWidth - this.pad * 2; return this.pad + (f / this.span()) * w; }
  xToFrame(x) { const w = this.c.clientWidth - this.pad * 2; return Math.max(0, Math.round(((x - this.pad) / w) * this.span())); }

  keyAt(x) {
    const doc = this.getDoc();
    if (!doc) return null;
    let best = null, bestD = 7;
    for (const f of doc.frames.keys()) {
      const d = Math.abs(this.frameToX(f) - x);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (doc.loop && Math.abs(this.frameToX(doc.loopFrame()) - x) < bestD) best = 'loop';
    return best;
  }

  down(e) {
    const r = this.c.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const k = y > 22 ? this.keyAt(x) : null;
    if (k === 'loop') {
      this.drag = { mode: 'loop', to: this.getDoc().loopFrame() };
    } else if (k !== null) {
      this.select(k);
      this.drag = { mode: 'key', from: k, to: k };
      this.setFrame(k);
    } else {
      this.drag = { mode: 'scrub' };
      this.setFrame(this.xToFrame(x));
    }
    this.c.setPointerCapture?.(e.pointerId);
    this.draw();
  }

  move(e) {
    if (!this.drag) return;
    const r = this.c.getBoundingClientRect();
    const f = this.xToFrame(e.clientX - r.left);
    if (this.drag.mode === 'scrub') this.setFrame(f);
    else this.drag.to = f;
    this.draw();
  }

  up() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.mode === 'loop') {
      const doc = this.getDoc();
      const gap = Math.max(1, d.to - doc.realLastFrame());
      if (gap !== doc.loopGap) this.onMoveLoop?.(gap);
    }
    if (d.mode === 'key' && d.to !== d.from) {
      if (this.onMoveKey?.(d.from, d.to)) { this.selectedKey = d.to; this.setFrame(d.to); }
    }
    this.draw();
  }

  select(frame) {
    this.selectedKey = frame;
    this.onSelectKey?.(frame);
    this.draw();
  }

  draw() {
    const c = this.c, g = this.g;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#1a1c20'; g.fillRect(0, 0, W, H);
    const doc = this.getDoc();
    const span = this.span();
    const ppf = (W - this.pad * 2) / span;
    const last = doc ? doc.lastFrame() : 0;

    // Clip length shading (0 .. last key).
    if (last > 0) {
      g.fillStyle = 'rgba(201,162,39,0.07)';
      g.fillRect(this.frameToX(0), 0, this.frameToX(last) - this.frameToX(0), H);
    }
    // Ruler.
    const labelEvery = ppf > 14 ? 5 : ppf > 6 ? 10 : 20;
    g.font = '10px ui-monospace, Consolas, monospace';
    g.textAlign = 'center';
    for (let f = 0; f <= span; f++) {
      const x = Math.round(this.frameToX(f)) + 0.5;
      const major = f % labelEvery === 0;
      if (!major && ppf < 4) continue;
      g.strokeStyle = major ? '#4a5058' : '#30343a';
      g.beginPath(); g.moveTo(x, 18); g.lineTo(x, major ? 26 : 22); g.stroke();
      if (major) { g.fillStyle = '#8b939b'; g.fillText(String(f), x, 13); }
    }
    g.strokeStyle = '#2b2f35'; g.beginPath(); g.moveTo(0, 26.5); g.lineTo(W, 26.5); g.stroke();

    // Keys.
    if (doc) {
      const bone = this.getBone();
      const y = 26 + (H - 26) / 2;
      for (const f of doc.frames.keys()) {
        let x = this.frameToX(f);
        if (this.drag?.mode === 'key' && this.drag.from === f) x = this.frameToX(this.drag.to);
        const forBone = bone && doc.boneHasKey(bone, f);
        const sel = f === this.selectedKey;
        const s = sel ? 7 : 5.5;
        g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
        g.fillStyle = forBone ? '#e0b93a' : (bone ? '#5c6168' : '#b8963a');
        g.fill();
        g.lineWidth = sel ? 2 : 1;
        g.strokeStyle = sel ? '#ffffff' : '#111';
        g.stroke();
      }
      if (last > 0) { // loop point
        const lf = this.drag?.mode === 'loop' ? this.drag.to : last;
        const x = Math.round(this.frameToX(lf)) + 0.5;
        g.strokeStyle = 'rgba(224,185,58,0.5)'; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(x, 27); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
        if (doc.loop) { // live copy of the start pose: hollow diamond, drag to change the gap
          const s = 6;
          g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
          g.lineWidth = 2; g.strokeStyle = '#e0b93a'; g.stroke(); g.lineWidth = 1;
          g.fillStyle = '#e0b93a'; g.font = '10px system-ui, sans-serif'; g.textAlign = 'left';
          g.fillText('loop', x + 8, y + 3);
        }
      }
    }
    // Playhead.
    const ph = this.frameToX(this.getFrame());
    g.strokeStyle = '#e5534b'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(ph, 0); g.lineTo(ph, H); g.stroke();
    g.lineWidth = 1;
  }
}
