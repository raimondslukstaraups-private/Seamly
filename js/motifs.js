'use strict';
// Importing SVG files into "motifs": cleaned, id-prefixed groups with a measured bounding box.

let motifSeq = 0;

const DEFAULT_MOTIF_SETTINGS = {
  enabled: true,
  size: 100,     // % of imported size
  sizeVar: 0,    // ± % random size variation
  rot: 0,        // base rotation, degrees
  rotVar: 0,     // ± degrees random rotation
  flip: false,   // randomly mirror horizontally
  weight: 1,     // how often it is picked relative to the others
  hue: 0,        // hue shift, degrees
  hueVar: 0,     // ± degrees random hue shift
};

// Presentation attributes on the root <svg> that should still apply to its content.
const ROOT_ATTRS_TO_KEEP = new Set([
  'style', 'class', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'opacity', 'color',
  'font-family', 'font-size', 'font-weight', 'clip-rule',
]);
const DROP_ELEMENTS = new Set(['metadata', 'title', 'desc', 'script', 'foreignObject']);
const KEEP_ATTR_NS = new Set([XLINKNS, 'http://www.w3.org/XML/1998/namespace']);

/**
 * Parse SVG text into a motif.
 * @returns {Promise<object>} motif { id, name, source, inner, box, natW, natH, svgText, img, settings }
 */
async function createMotif(text, name, settings) {
  if (/^data:image\/(?!svg)/.test(text)) return createRasterMotif(text, name, settings);
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || !root || root.localName !== 'svg' || root.namespaceURI !== SVGNS) {
    throw new Error(`${name}: not a valid SVG file`);
  }
  const id = 'm' + (++motifSeq);

  cleanTree(root);
  prefixIds(root, id);

  // Move all content into one group carrying the root's presentation attributes.
  const g = doc.createElementNS(SVGNS, 'g');
  for (const attr of [...root.attributes]) {
    if (ROOT_ATTRS_TO_KEEP.has(attr.name)) g.setAttribute(attr.name, attr.value);
  }
  while (root.firstChild) g.appendChild(root.firstChild);
  root.appendChild(g);

  // Measure in the live document (getBBox needs rendering).
  const holder = document.createElementNS(SVGNS, 'svg');
  holder.setAttribute('width', '1');
  holder.setAttribute('height', '1');
  holder.setAttribute('style', 'position:absolute;left:-10000px;top:0;visibility:hidden');
  const live = document.importNode(root, true);
  holder.appendChild(live);
  document.body.appendChild(holder);

  let box = null, k = 1;
  try {
    const vb = live.viewBox && live.viewBox.baseVal;
    const hasVB = root.hasAttribute('viewBox') && vb && vb.width > 0 && vb.height > 0;
    const wAttr = root.getAttribute('width');
    if (hasVB && wAttr && !wAttr.includes('%')) {
      const wPx = live.width.baseVal.value;
      if (wPx > 0) k = wPx / vb.width;
    }
    let bb = null;
    try { bb = live.firstElementChild.getBBox(); } catch (_) { /* not rendered */ }
    if (bb && bb.width > 0 && bb.height > 0) {
      box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    } else if (hasVB) {
      box = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    }
  } finally {
    holder.remove();
  }
  if (!box) throw new Error(`${name}: the SVG has no visible content`);

  // Small padding so strokes (not included in getBBox) are not cut off.
  const pad = Math.max(box.w, box.h) * 0.015;
  box = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };

  const inner = new XMLSerializer().serializeToString(g);
  const natW = box.w * k, natH = box.h * k;
  const svgText =
    `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINKNS}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" ` +
    `width="${n(natW)}" height="${n(natH)}">${inner}</svg>`;
  const img = await loadImage(svgDataUrl(svgText));

  return {
    id, name, source: text, inner, box, k, natW, natH, svgText, img,
    thumbUrl: svgDataUrl(svgText),
    settings: Object.assign({}, DEFAULT_MOTIF_SETTINGS, settings || {}),
    _mask: null,
  };
}

/**
 * PNG / JPG / WebP motif: the picture is embedded in an SVG <image>, so everything else
 * (placement, hue, export) works the same. Transparent margins are trimmed off.
 * @param {string} dataUrl  the original file as a data URL (kept unchanged for full quality)
 */
async function createRasterMotif(dataUrl, name, settings) {
  const img = await loadImage(dataUrl).catch(() => { throw new Error(`${name}: could not read the image`); });
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) throw new Error(`${name}: the image is empty`);

  // Find the painted area on a downscaled copy (fast even for big photos).
  const sc = Math.min(1, 1024 / Math.max(iw, ih));
  const cw = Math.max(1, Math.round(iw * sc)), ch = Math.max(1, Math.round(ih * sc));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, cw, ch);
  const px = ctx.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (px[(y * cw + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error(`${name}: the image is fully transparent`);
  const box = {
    x: Math.max(0, (x0 - 1) / sc), y: Math.max(0, (y0 - 1) / sc),
    w: Math.min(iw, (x1 + 2) / sc) - Math.max(0, (x0 - 1) / sc),
    h: Math.min(ih, (y1 + 2) / sc) - Math.max(0, (y0 - 1) / sc),
  };

  const dpi = pngDpi(dataUrl) || 96;
  const k = 96 / dpi; // CSS px per image pixel
  const id = 'm' + (++motifSeq);
  const inner = `<g><image href="${dataUrl}" xlink:href="${dataUrl}" width="${iw}" height="${ih}"/></g>`;
  const natW = box.w * k, natH = box.h * k;
  const svgText =
    `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINKNS}" viewBox="${n(box.x)} ${n(box.y)} ${n(box.w)} ${n(box.h)}" ` +
    `width="${n(natW)}" height="${n(natH)}">${inner}</svg>`;
  const rendered = await loadImage(svgDataUrl(svgText));
  return {
    id, name, source: dataUrl, inner, box, k, natW, natH, svgText, img: rendered,
    thumbUrl: dataUrl,
    settings: Object.assign({}, DEFAULT_MOTIF_SETTINGS, settings || {}),
    _mask: null,
  };
}

/** DPI stored in a PNG's pHYs chunk, or null. */
function pngDpi(dataUrl) {
  if (!dataUrl.startsWith('data:image/png;base64,')) return null;
  const bin = atob(dataUrl.slice(22, 22 + 4096)); // pHYs sits near the start
  const at = bin.indexOf('pHYs');
  if (at < 0 || bin.charCodeAt(at + 12) !== 1) return null; // unit must be metres
  const ppm = ((bin.charCodeAt(at + 4) << 24) | (bin.charCodeAt(at + 5) << 16) |
    (bin.charCodeAt(at + 6) << 8) | bin.charCodeAt(at + 7)) >>> 0;
  const dpi = ppm * 0.0254;
  return dpi >= 20 && dpi <= 2400 ? dpi : null;
}

/** Remove editor metadata, foreign-namespace elements/attributes, scripts and event handlers. */
function cleanTree(root) {
  for (const el of [...root.getElementsByTagName('*')]) {
    if (el.namespaceURI !== SVGNS || DROP_ELEMENTS.has(el.localName)) {
      el.remove();
      continue;
    }
    stripAttrs(el);
  }
  stripAttrs(root);
}

function stripAttrs(el) {
  for (const a of [...el.attributes]) {
    const foreign = a.namespaceURI && !KEEP_ATTR_NS.has(a.namespaceURI) && a.namespaceURI !== 'http://www.w3.org/2000/xmlns/';
    if (foreign || /^on/i.test(a.name)) el.removeAttributeNode(a);
  }
}

/**
 * Make ids and class names unique per motif so several SVGs can live in one document
 * (e.g. two Illustrator files that both define ".st0" or "#linearGradient1").
 */
function prefixIds(root, prefix) {
  const ids = new Set();
  for (const el of root.querySelectorAll('[id]')) {
    ids.add(el.getAttribute('id'));
    el.setAttribute('id', `${prefix}-${el.getAttribute('id')}`);
  }
  const fixUrl = s => s.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
    (m, q, ref) => (ids.has(ref) ? `url(#${prefix}-${ref})` : m));

  for (const el of root.getElementsByTagName('*')) {
    for (const a of [...el.attributes]) {
      if (a.localName === 'href') {
        const ref = a.value.startsWith('#') ? a.value.slice(1) : null;
        if (ref && ids.has(ref)) a.value = `#${prefix}-${ref}`;
      } else if (a.localName === 'class') {
        a.value = a.value.split(/\s+/).filter(Boolean).map(c => `${prefix}-${c}`).join(' ');
      } else if (a.value.includes('url(')) {
        a.value = fixUrl(a.value);
      }
    }
    if (el.localName === 'style') {
      el.textContent = fixUrl(el.textContent)
        .replace(/\.(-?[_a-zA-Z][\w-]*)/g, `.${prefix}-$1`)
        .replace(/#([_a-zA-Z][\w-]*)/g, (m, ref) => (ids.has(ref) ? `#${prefix}-${ref}` : m));
    }
  }
  // Root-level class (moved onto the wrapper group later).
  if (root.hasAttribute('class')) {
    root.setAttribute('class', root.getAttribute('class').split(/\s+/).filter(Boolean).map(c => `${prefix}-${c}`).join(' '));
  }
}

/**
 * Effective hue of an instance: motif hue + the instance's own random offset,
 * snapped to 5° so only a few filters are needed. Hue never affects spacing, so it updates live.
 */
function instanceHue(inst, motif) {
  const h = Math.round(wrap(motif.settings.hue + (inst.h || 0), 360) / 5) * 5;
  return h % 360;
}
