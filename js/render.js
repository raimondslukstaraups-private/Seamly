'use strict';
// Builds SVG markup for motifs and instances, and draws the live preview.

/** <g id="m1">…</g> for every motif (in the motif's own coordinates). */
function motifDefsMarkup(motifs) {
  return motifs.map(m => `<g id="${m.id}">${m.inner}</g>`).join('');
}

/** Hue-rotate filters for the hues actually used. */
function hueFiltersMarkup(instances, byId) {
  const hues = new Set();
  for (const inst of instances) {
    const m = byId.get(inst.m);
    if (m) hues.add(instanceHue(inst, m));
  }
  hues.delete(0);
  return [...hues].map(h =>
    `<filter id="hue-${h}" color-interpolation-filters="sRGB"><feColorMatrix type="hueRotate" values="${h}"/></filter>`).join('');
}

/** One placed motif, shifted by (ox, oy). */
function useMarkup(inst, m, ox, oy) {
  const sc = inst.s * m.k;
  const cx = m.box.x + m.box.w / 2, cy = m.box.y + m.box.h / 2;
  const hue = instanceHue(inst, m);
  const filter = hue ? ` filter="url(#hue-${hue})"` : '';
  return `<use href="#${m.id}" xlink:href="#${m.id}"${filter} transform="translate(${n(inst.x + ox)} ${n(inst.y + oy)}) ` +
    `rotate(${n(inst.r)}) scale(${n(sc * inst.f)} ${n(sc)}) translate(${n(-cx)} ${n(-cy)})"/>`;
}

/** Offsets at which an instance has to be drawn so it wraps around the tile edges. */
function wrapOffsets(inst, m, W, H) {
  const { hw, hh } = rotatedHalfExtents(m.natW * inst.s, m.natH * inst.s, inst.r);
  const out = [];
  for (const oy of [-H, 0, H]) {
    if (inst.y + oy - hh >= H || inst.y + oy + hh <= 0) continue;
    for (const ox of [-W, 0, W]) {
      if (inst.x + ox - hw >= W || inst.x + ox + hw <= 0) continue;
      out.push([ox, oy]);
    }
  }
  return out;
}

/** All <use> elements for one tile, including the wrapped copies that cross the edges. */
function tileUsesMarkup(instances, byId, W, H) {
  let s = '';
  for (const inst of instances) {
    const m = byId.get(inst.m);
    if (!m || !m.settings.enabled) continue;
    for (const [ox, oy] of wrapOffsets(inst, m, W, H)) s += useMarkup(inst, m, ox, oy);
  }
  return s;
}

/** Rotated rectangle outline around an instance (selection / overlap marker). */
function outlineMarkup(inst, m, W, H, cls) {
  const w = m.natW * inst.s, h = m.natH * inst.s;
  let s = '';
  for (const [ox, oy] of wrapOffsets(inst, m, W, H)) {
    s += `<rect class="${cls}" x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}" ` +
      `transform="translate(${n(inst.x + ox)} ${n(inst.y + oy)}) rotate(${n(inst.r)})"/>`;
  }
  return s;
}

// ---------------------------------------------------------------- preview

const Preview = {
  svg: null,
  lastMotifKey: '',

  init() {
    this.svg = document.getElementById('preview');
    // Overlay styles live inside the SVG so <use> copies pick them up.
    const style = document.createElementNS(SVGNS, 'style');
    style.textContent = `
      .sel { fill: none; stroke: #1a7cff; stroke-width: 2; vector-effect: non-scaling-stroke; }
      .bad { fill: rgba(220,40,40,.12); stroke: #e02020; stroke-width: 2; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
      .seam { stroke: rgba(0,0,0,.45); stroke-width: 1; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
      .seam2 { stroke: rgba(255,255,255,.6); stroke-width: 1; stroke-dasharray: 6 4; stroke-dashoffset: 6; vector-effect: non-scaling-stroke; }`;
    this.svg.prepend(style);
  },

  /** Re-insert motif definitions (only when the set of motifs changed). */
  setMotifs(motifs) {
    const key = motifs.map(m => m.id).join(',');
    if (key === this.lastMotifKey) return;
    this.lastMotifKey = key;
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINKNS}"><defs>${motifDefsMarkup(motifs)}</defs></svg>`, 'image/svg+xml');
    const defs = document.getElementById('pvDefs');
    defs.replaceChildren(...[...doc.documentElement.firstElementChild.childNodes].map(nd => document.importNode(nd, true)));
  },

  /**
   * @param {object} st  { motifs, instances, W, H, bg, bgNone, repeat, zoom, seams, selected, overlaps }
   */
  draw(st) {
    const { W, H, repeat: r } = st;
    const byId = new Map(st.motifs.map(m => [m.id, m]));
    this.setMotifs(st.motifs);

    document.getElementById('pvTile').innerHTML =
      `<clipPath id="pvClip"><rect width="${n(W)}" height="${n(H)}"/></clipPath>` +
      hueFiltersMarkup(st.instances, byId) +
      `<g clip-path="url(#pvClip)">${tileUsesMarkup(st.instances, byId, W, H)}</g>`;

    let overlay = '';
    st.overlaps.forEach(i => {
      const inst = st.instances[i], m = inst && byId.get(inst.m);
      if (m) overlay += outlineMarkup(inst, m, W, H, 'bad');
    });
    const sel = st.instances[st.selected];
    if (sel && byId.get(sel.m)) overlay += outlineMarkup(sel, byId.get(sel.m), W, H, 'sel');
    document.getElementById('pvOverlay').innerHTML = `<g clip-path="url(#pvClip)">${overlay}</g>`;

    let copies = '';
    for (let j = 0; j < r; j++) {
      for (let i = 0; i < r; i++) {
        copies += `<use href="#pvTile" x="${n(i * W)}" y="${n(j * H)}"/><use href="#pvOverlay" x="${n(i * W)}" y="${n(j * H)}"/>`;
      }
    }
    document.getElementById('pvCopies').innerHTML = copies;

    let seams = '';
    if (st.seams) {
      for (let i = 0; i <= r; i++) {
        for (const c of ['seam', 'seam2']) {
          seams += `<line class="${c}" x1="${n(i * W)}" y1="0" x2="${n(i * W)}" y2="${n(r * H)}"/>`;
          seams += `<line class="${c}" x1="0" y1="${n(i * H)}" x2="${n(r * W)}" y2="${n(i * H)}"/>`;
        }
      }
    }
    document.getElementById('pvSeams').innerHTML = seams;

    const bg = document.getElementById('pvBg');
    bg.setAttribute('width', n(r * W));
    bg.setAttribute('height', n(r * H));
    bg.setAttribute('fill', st.bgNone ? 'none' : st.bg);

    this.svg.setAttribute('viewBox', `0 0 ${n(r * W)} ${n(r * H)}`);
    this.fit(st);
  },

  /** Size the preview to the stage, times the zoom factor. */
  fit(st) {
    const stage = document.getElementById('stage');
    const availW = Math.max(100, stage.clientWidth - 48), availH = Math.max(100, stage.clientHeight - 48);
    const vw = st.repeat * st.W, vh = st.repeat * st.H;
    const base = Math.min(availW / vw, availH / vh);
    this.svg.style.width = `${Math.round(vw * base * st.zoom)}px`;
    this.svg.style.height = `${Math.round(vh * base * st.zoom)}px`;
  },

  /** Screen point -> tile coordinates (wrapped into the tile). */
  toTile(evt, W, H) {
    const pt = this.svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y, tx: wrap(p.x, W), ty: wrap(p.y, H) };
  },
};

/** Topmost instance whose real shape is under the tile point, or -1. */
function hitTest(instances, byId, W, H, tx, ty) {
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i], m = byId.get(inst.m);
    if (!m || !m.settings.enabled) continue;
    for (const [ox, oy] of wrapOffsets(inst, m, W, H)) {
      if (shapeContains(inst, m, tx - ox, ty - oy)) return i;
    }
  }
  return -1;
}
