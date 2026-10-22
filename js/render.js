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

// ---------------------------------------------------------------- selection handles

const HANDLE_PX = 5;          // handle radius on screen
const ROT_HANDLE_GAP_PX = 26; // distance of the rotate handle above the motif
const TILE_OFFSETS = [-1, 0, 1].flatMap(j => [-1, 0, 1].map(i => [i, j]));

/** Corners, top-middle and rotate-handle positions of an instance (tile coords). `u` = units per screen px. */
function selectionGeometry(inst, m, u) {
  const w = m.natW * inst.s, h = m.natH * inst.s;
  const rad = inst.r * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const at = (lx, ly) => [inst.x + lx * c - ly * s, inst.y + lx * s + ly * c];
  return {
    corners: [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)],
    top: at(0, -h / 2),
    rot: at(0, -h / 2 - ROT_HANDLE_GAP_PX * u),
  };
}

/** Shortest signed distance from a to b on a wrap-around axis of length `size`. */
function wrapDelta(d, size) { return d - size * Math.round(d / size); }

/**
 * Selected instances laid out next to each other: each one's position is taken at the copy nearest
 * the first, so a group that straddles a tile edge stays together.
 * @returns {{ items: {i, x, y}[], cx, cy, box: {x0, y0, x1, y1} }}
 */
function groupLayout(instances, sel, byId, W, H) {
  const a = instances[sel[0]];
  const items = sel.map(i => {
    const it = instances[i];
    return { i, x: a.x + wrapDelta(it.x - a.x, W), y: a.y + wrapDelta(it.y - a.y, H) };
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of items) {
    const it = instances[p.i], m = byId.get(it.m);
    const { hw, hh } = rotatedHalfExtents(m.natW * it.s, m.natH * it.s, it.r);
    x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw);
    y0 = Math.min(y0, p.y - hh); y1 = Math.max(y1, p.y + hh);
  }
  return { items, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, box: { x0, y0, x1, y1 } };
}

/** Outline + handles on every selected motif, at every neighbouring tile offset (unclipped). */
function selectionMarkup(instances, sel, byId, W, H, u) {
  const r = HANDLE_PX * u;
  let s = '';
  for (const k of sel) {
    const it = instances[k];
    const g = selectionGeometry(it, byId.get(it.m), u);
    for (const [i, j] of TILE_OFFSETS) {
      const ox = i * W, oy = j * H;
      s += `<polygon class="sel" points="${g.corners.map(([x, y]) => `${n(x + ox)},${n(y + oy)}`).join(' ')}"/>`;
      s += `<line class="sel" x1="${n(g.top[0] + ox)}" y1="${n(g.top[1] + oy)}" x2="${n(g.rot[0] + ox)}" y2="${n(g.rot[1] + oy)}"/>`;
      for (const [x, y] of g.corners) {
        s += `<rect class="handle" x="${n(x + ox - r)}" y="${n(y + oy - r)}" width="${n(2 * r)}" height="${n(2 * r)}"/>`;
      }
      s += `<circle class="handle rot" cx="${n(g.rot[0] + ox)}" cy="${n(g.rot[1] + oy)}" r="${n(r * 1.2)}"/>`;
    }
  }
  return s;
}

/**
 * Which handle of which selected motif is under tile point (tx, ty)?
 * @returns {{ mode: 'rotate'|'resize', i: number } | null}  i = index of the motif whose handle it is
 */
function hitHandle(instances, sel, byId, W, H, u, tx, ty) {
  const tol = (HANDLE_PX + 4) * u;
  for (const k of [...sel].reverse()) { // topmost first
    const it = instances[k];
    const g = selectionGeometry(it, byId.get(it.m), u);
    for (const [i, j] of TILE_OFFSETS) {
      const ox = i * W, oy = j * H;
      if (Math.hypot(tx - g.rot[0] - ox, ty - g.rot[1] - oy) <= tol * 1.2) return { mode: 'rotate', i: k };
      for (const [x, y] of g.corners) if (Math.hypot(tx - x - ox, ty - y - oy) <= tol) return { mode: 'resize', i: k };
    }
  }
  return null;
}

// ---------------------------------------------------------------- preview

/** Faint template image behind the motifs (preview only, never exported). */
function templateUnderlay(st) {
  if (st.layout !== 'template' || !st.tpl.show || !st.tpl.dataUrl) return '';
  // The (large) image lives in one static element; the tile only references it.
  let img = document.getElementById('pvTplImg');
  if (!img) {
    img = document.createElementNS(SVGNS, 'image');
    img.id = 'pvTplImg';
    img.setAttribute('preserveAspectRatio', 'none');
    img.setAttribute('opacity', '0.35');
    document.getElementById('pvStatic').appendChild(img);
  }
  if (img.getAttribute('href') !== st.tpl.dataUrl) img.setAttribute('href', st.tpl.dataUrl);
  img.setAttribute('width', n(st.W));
  img.setAttribute('height', n(st.H));
  return '<use href="#pvTplImg"/>';
}

const Preview = {
  svg: null,
  lastMotifKey: '',

  init() {
    this.svg = document.getElementById('preview');
    // Overlay styles live inside the SVG so <use> copies pick them up.
    const style = document.createElementNS(SVGNS, 'style');
    style.textContent = `
      .sel { fill: none; stroke: #1a7cff; stroke-width: 2; vector-effect: non-scaling-stroke; }
      .handle { fill: #fff; stroke: #1a7cff; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
      .handle.rot { fill: #1a7cff; stroke: #fff; }
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
   * @param {object} st  { motifs, instances, W, H, bg, bgNone, repeat, zoom, seams, sel (Set of indices), overlaps }
   */
  draw(st) {
    const { W, H, repeat: r } = st;
    const byId = new Map(st.motifs.map(m => [m.id, m]));
    this.setMotifs(st.motifs);

    document.getElementById('pvTile').innerHTML =
      `<clipPath id="pvClip"><rect width="${n(W)}" height="${n(H)}"/></clipPath>` +
      hueFiltersMarkup(st.instances, byId) +
      `<g clip-path="url(#pvClip)">${templateUnderlay(st)}${tileUsesMarkup(st.instances, byId, W, H)}</g>`;

    // Size first: handle sizes depend on how many tile units one screen pixel is.
    this.svg.setAttribute('viewBox', `0 0 ${n(r * W)} ${n(r * H)}`);
    this.fit(st);
    const u = this.unitsPerPx(st);

    let overlay = '';
    st.overlaps.forEach(i => {
      const inst = st.instances[i], m = inst && byId.get(inst.m);
      if (m) overlay += outlineMarkup(inst, m, W, H, 'bad');
    });
    overlay = `<g clip-path="url(#pvClip)">${overlay}</g>`;
    const sel = [...st.sel].filter(i => st.instances[i] && byId.get(st.instances[i].m));
    if (sel.length) overlay += selectionMarkup(st.instances, sel, byId, W, H, u);
    document.getElementById('pvOverlay').innerHTML = overlay;

    // All tiles first, then all overlays, so handles are never hidden under a neighbouring tile.
    let tiles = '', overlays = '';
    for (let j = 0; j < r; j++) {
      for (let i = 0; i < r; i++) {
        tiles += `<use href="#pvTile" x="${n(i * W)}" y="${n(j * H)}"/>`;
        overlays += `<use href="#pvOverlay" x="${n(i * W)}" y="${n(j * H)}"/>`;
      }
    }
    document.getElementById('pvCopies').innerHTML = tiles + overlays;

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
  },

  /** Tile units per screen pixel at the current size and zoom. */
  unitsPerPx(st) {
    const px = parseFloat(this.svg.style.width) || this.svg.clientWidth || 1;
    return (st.repeat * st.W) / px;
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
