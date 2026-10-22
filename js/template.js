'use strict';
// Templates: an SVG or picture whose separate shapes ("spots") mark where motifs go.
// Both kinds are rasterised and analysed the same way: find the background, label connected
// shapes (wrapping around the edges for seamless tiles), and measure each one's centre, size and angle.

const TEMPLATE_RES = 1000; // analysis resolution (longest side, px)

// One colour per motif type in exported templates; same colour = same group on import.
const GROUP_COLORS = ['#e4572e', '#2e86ab', '#f3a712', '#3bb273', '#7768ae', '#e15a97', '#1b998b', '#8d6a9f',
  '#c5283d', '#255f85'];

// ---------------------------------------------------------------- export a layout as a template

/**
 * The current layout as a template SVG: every motif becomes a placeholder shape, coloured by motif type.
 * Each shape is tagged (data-seamly-spot) so Seamly can read it back exactly — even after the shapes
 * were moved or resized in another editor.
 * @param {'ellipse'|'circle'|'silhouette'} shape
 */
function layoutTemplateSvg(p, shape) {
  const inst = visibleInstances(p);
  const byId = new Map(p.motifs.map(m => [m.id, m]));
  const group = new Map(p.motifs.map((m, i) => [m.id, i]));
  const { W, H } = p;
  const color = g => GROUP_COLORS[g % GROUP_COLORS.length];
  let defs = '', body = '';
  if (shape === 'silhouette') {
    defs += motifDefsMarkup(usedMotifs(p, inst));
    for (const g of new Set(inst.map(i => group.get(i.m)))) {
      defs += `<filter id="solid-${g}" color-interpolation-filters="sRGB"><feFlood flood-color="${color(g)}"/>` +
        `<feComposite in2="SourceAlpha" operator="in"/></filter>`;
    }
  }
  for (const it of inst) {
    const m = byId.get(it.m);
    const g = group.get(it.m);
    const w = m.natW * it.s, h = m.natH * it.s;
    wrapOffsets(it, m, W, H).forEach(([ox, oy]) => {
      // The copies drawn across the edges are only for the picture; the main one carries the data.
      const tag = ox || oy ? 'data-seamly-copy="1"'
        : `data-seamly-spot="1" data-seamly-group="${g}" data-seamly-motif="${escapeXml(m.name)}"`;
      const tr = `translate(${n(it.x + ox)} ${n(it.y + oy)}) rotate(${n(it.r)})`;
      if (shape === 'silhouette') {
        body += useMarkup(it, m, ox, oy).replace(/ filter="[^"]*"/, '').replace('<use ', `<use ${tag} filter="url(#solid-${g})" `) + '\n';
      } else if (shape === 'circle') {
        body += `<circle ${tag} r="${n(Math.sqrt(w * h) / 2)}" transform="${tr}" fill="${color(g)}"/>\n`;
      } else {
        body += `<ellipse ${tag} rx="${n(w / 2)}" ry="${n(h / 2)}" transform="${tr}" fill="${color(g)}"/>\n`;
      }
    });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINKNS}" width="${mm(W)}" height="${mm(H)}" viewBox="0 0 ${n(W)} ${n(H)}" ` +
    `data-seamly-template="1" data-seamly-tile-w="${n(W)}" data-seamly-tile-h="${n(H)}">\n` +
    `<!-- Seamly template: each coloured shape is a spot for a motif; same colour = same motif. -->\n` +
    `<defs>${defs}<clipPath id="tileClip"><rect width="${n(W)}" height="${n(H)}"/></clipPath></defs>\n` +
    `<g clip-path="url(#tileClip)">\n${body}</g>\n</svg>\n`;
}

/**
 * Exact spots from a Seamly template, in the template's own units.
 * Geometry is measured from the shapes as they are now (so edits in other editors count).
 * @returns {{spots: object[], tileW: number|null, tileH: number|null} | null}  null = not a Seamly template
 */
function readSeamlyTemplate(root, vbW, vbH) {
  if (!root.querySelector('[data-seamly-spot]')) return null;
  const holder = document.createElementNS(SVGNS, 'svg');
  holder.setAttribute('style', 'position:absolute;left:-10000px;top:0;visibility:hidden');
  const live = document.importNode(root, true);
  live.setAttribute('width', vbW);
  live.setAttribute('height', vbH);
  holder.appendChild(live);
  document.body.appendChild(holder);
  const spots = [];
  try {
    const toRoot = live.getScreenCTM().inverse();
    for (const el of live.querySelectorAll('[data-seamly-spot]')) {
      const bb = el.getBBox();
      if (!(bb.width > 0 && bb.height > 0)) continue;
      const M = toRoot.multiply(el.getScreenCTM());
      const c = new DOMPoint(bb.x + bb.width / 2, bb.y + bb.height / 2).matrixTransform(M);
      const w = bb.width * Math.hypot(M.a, M.b), h = bb.height * Math.hypot(M.c, M.d);
      const r = Math.atan2(M.b, M.a) * 180 / Math.PI;
      const g = parseInt(el.getAttribute('data-seamly-group'), 10);
      spots.push({
        x: wrap(c.x, vbW), y: wrap(c.y, vbH),
        // Long axis first; the angle follows the long axis, the way detected spots do.
        len: Math.max(w, h), wid: Math.min(w, h), angle: w >= h ? r : r - 90,
        area: w * h, round: false, g: Number.isFinite(g) ? g : undefined,
        name: el.getAttribute('data-seamly-motif') || undefined,
      });
    }
  } finally {
    holder.remove();
  }
  const tw = parseFloat(root.getAttribute('data-seamly-tile-w')), th = parseFloat(root.getAttribute('data-seamly-tile-h'));
  return { spots, tileW: tw > 0 ? tw : null, tileH: th > 0 ? th : null };
}

/** Load an SVG / PNG / JPG file into an analysis-sized canvas. @returns {Promise<{name, dataUrl, w, h}>} */
async function loadTemplateFile(file) {
  const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
  let img, natW, natH, exact = null;
  if (isSvg) {
    const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
    const root = doc.documentElement;
    if (doc.getElementsByTagName('parsererror').length || root.localName !== 'svg') throw new Error('Not a valid SVG file');
    const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    natW = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(root.getAttribute('width')) || 1000;
    natH = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(root.getAttribute('height')) || 1000;
    if (!root.hasAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${natW} ${natH}`);
    exact = readSeamlyTemplate(root, natW, natH);
    const sc = TEMPLATE_RES / Math.max(natW, natH);
    root.setAttribute('width', Math.round(natW * sc));
    root.setAttribute('height', Math.round(natH * sc));
    img = await loadImage(svgDataUrl(new XMLSerializer().serializeToString(root)));
  } else {
    const url = URL.createObjectURL(file);
    try { img = await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    natW = img.naturalWidth;
    natH = img.naturalHeight;
  }
  // SVGs are drawn at analysis size; pictures are only ever scaled down.
  const fit = TEMPLATE_RES / Math.max(natW, natH);
  const sc = isSvg ? fit : Math.min(1, fit);
  const w = Math.max(1, Math.round(natW * sc));
  const h = Math.max(1, Math.round(natH * sc));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const out = { name: file.name, dataUrl: c.toDataURL('image/png'), w, h, exact: false };
  if (exact && exact.spots.length) {
    // Same units as detected spots: pixels of the analysis image.
    out.exact = true;
    out.spots = exact.spots.map(s => ({ ...s, x: s.x * sc, y: s.y * sc, len: s.len * sc, wid: s.wid * sc, area: s.area * sc * sc }));
    out.tileW = exact.tileW;
    out.tileH = exact.tileH;
  }
  return out;
}

async function templatePixels(tpl) {
  const img = await loadImage(tpl.dataUrl);
  const c = document.createElement('canvas');
  c.width = tpl.w;
  c.height = tpl.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, tpl.w, tpl.h);
  return ctx.getImageData(0, 0, tpl.w, tpl.h).data;
}

/** Foreground mask: by transparency if the image has any, otherwise "far from the background colour". */
function foregroundMask(px, w, h, sensitivity) {
  const N = w * h;
  const fg = new Uint8Array(N);
  let transparent = 0;
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] < 200) transparent++;
  if (transparent > N * 0.01) {
    for (let i = 0; i < N; i++) fg[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    return fg;
  }
  // Background = most common colour (quantised to 4 bits per channel).
  const counts = new Uint32Array(4096);
  for (let i = 0; i < N; i++) counts[((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4)]++;
  let best = 0;
  for (let b = 1; b < 4096; b++) if (counts[b] > counts[best]) best = b;
  let r = 0, g = 0, bl = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    if ((((px[i * 4] >> 4) << 8) | ((px[i * 4 + 1] >> 4) << 4) | (px[i * 4 + 2] >> 4)) === best) {
      r += px[i * 4]; g += px[i * 4 + 1]; bl += px[i * 4 + 2]; cnt++;
    }
  }
  r /= cnt; g /= cnt; bl /= cnt;
  const thr = Math.max(5, 160 - 1.5 * sensitivity);
  const thr2 = thr * thr;
  for (let i = 0; i < N; i++) {
    const dr = px[i * 4] - r, dg = px[i * 4 + 1] - g, db = px[i * 4 + 2] - bl;
    fg[i] = dr * dr + dg * dg + db * db > thr2 ? 1 : 0;
  }
  return fg;
}

/** Square dilation by `rad` pixels (separable), wrapping around the edges if `wrapEdges`. */
function dilate(mask, w, h, rad, wrapEdges) {
  if (rad <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const at = (v, size) => (wrapEdges ? wrap(v, size) : v);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let d = -rad; d <= rad; d++) {
        const xx = at(x + d, w);
        if (xx >= 0 && xx < w) tmp[y * w + xx] = 1;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tmp[y * w + x]) continue;
      for (let d = -rad; d <= rad; d++) {
        const yy = at(y + d, h);
        if (yy >= 0 && yy < h) out[yy * w + x] = 1;
      }
    }
  }
  return out;
}

/**
 * Find spots in a template.
 * @param {object} opt { sensitivity 0–100, merge px, minSize % of image area, wrap: seamless template }
 * @returns {Promise<{x, y, len, wid, angle, area, round}[]>}  in template pixels; len ≥ wid, angle in degrees
 */
async function detectSpots(tpl, opt) {
  const { w, h } = tpl;
  const px = await templatePixels(tpl);
  const fg = foregroundMask(px, w, h, opt.sensitivity);
  const conn = dilate(fg, w, h, Math.round(opt.merge), opt.wrap);
  const N = w * h;
  const label = new Int32Array(N);
  const ux = new Int32Array(N), uy = new Int32Array(N); // unwrapped coordinates within a component
  const queue = new Int32Array(N);
  const minArea = (opt.minSize / 100) * N;
  const spots = [];
  let next = 0;

  for (let start = 0; start < N; start++) {
    if (!conn[start] || label[start]) continue;
    next++;
    let head = 0, tail = 0;
    queue[tail++] = start;
    label[start] = next;
    ux[start] = start % w;
    uy[start] = (start / w) | 0;
    let wrapsBadly = false;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let nx = x + dx, ny = y + dy;
        if (!opt.wrap && (nx < 0 || ny < 0 || nx >= w || ny >= h)) continue;
        nx = wrap(nx, w);
        ny = wrap(ny, h);
        const q = ny * w + nx;
        if (!conn[q]) continue;
        const qx = ux[p] + dx, qy = uy[p] + dy;
        if (label[q]) {
          // Reached again by a different unwrapped route → the shape loops around the tile (e.g. a stripe).
          if (label[q] === next && (ux[q] !== qx || uy[q] !== qy)) wrapsBadly = true;
          continue;
        }
        label[q] = next;
        ux[q] = qx;
        uy[q] = qy;
        queue[tail++] = q;
      }
    }
    if (wrapsBadly) continue;

    // Moments over the real (undilated) pixels.
    let n = 0, sx = 0, sy = 0;
    for (let k = 0; k < tail; k++) {
      const p = queue[k];
      if (!fg[p]) continue;
      n++; sx += ux[p]; sy += uy[p];
    }
    if (n < Math.max(4, minArea) || n > N * 0.5) continue;
    const cx = sx / n, cy = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let k = 0; k < tail; k++) {
      const p = queue[k];
      if (!fg[p]) continue;
      const dx = ux[p] - cx, dy = uy[p] - cy;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    sxx /= n; syy /= n; sxy /= n;
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const tr = sxx + syy, dif = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    const l1 = tr / 2 + dif, l2 = tr / 2 - dif;
    // Extents along the main and cross axes.
    const c = Math.cos(theta), s = Math.sin(theta);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < tail; k++) {
      const p = queue[k];
      if (!fg[p]) continue;
      const dx = ux[p] - cx, dy = uy[p] - cy;
      const a = dx * c + dy * s, b = -dx * s + dy * c;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    spots.push({
      x: wrap(cx + 0.5, w),
      y: wrap(cy + 0.5, h),
      len: a1 - a0 + 1,
      wid: b1 - b0 + 1,
      angle: theta * 180 / Math.PI,
      area: n,
      round: l1 <= 0 || l2 / l1 > 0.8, // nearly round: angle is meaningless
    });
  }
  return spots;
}
