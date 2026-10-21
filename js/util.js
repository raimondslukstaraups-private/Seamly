'use strict';
// Shared helpers. Internal unit everywhere is the CSS pixel (96 px = 1 inch).

const SVGNS = 'http://www.w3.org/2000/svg';
const XLINKNS = 'http://www.w3.org/1999/xlink';

const PX_PER_UNIT = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

function toPx(value, unit) { return value * PX_PER_UNIT[unit]; }
function fromPx(px, unit) { return px / PX_PER_UNIT[unit]; }

/** Round for display in an input, depending on unit. */
function fmt(px, unit) {
  const v = fromPx(px, unit);
  const digits = unit === 'px' ? 0 : unit === 'mm' ? 1 : 2;
  return +v.toFixed(digits);
}

/** Number formatting for SVG output (short, no exponent). */
function n(v) { return +v.toFixed(3); }

/** Deterministic PRNG (mulberry32) so the same seed always gives the same pattern. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wrap a value into [0, size). */
function wrap(v, size) { return ((v % size) + size) % size; }

/** Axis-aligned half extents of a w×h rectangle rotated by `deg`. */
function rotatedHalfExtents(w, h, deg) {
  const r = deg * Math.PI / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return { hw: (w * c + h * s) / 2, hh: (w * s + h * c) / 2 };
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not render SVG as image'));
    img.src = src;
  });
}

function svgDataUrl(svgText) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
}

// ---- PNG DPI metadata (pHYs chunk) so print software knows the physical size ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function pngWithDpi(blob, dpi) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Insert right after the IHDR chunk (8-byte signature + 25-byte IHDR).
  const at = 33;
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Image is too large for this browser'))), 'image/png'));
}

// Browser canvas limits (Chrome/Edge/Firefox are roughly here; Safari is lower).
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 16384 * 16384;
function canvasFits(w, h) { return w <= MAX_CANVAS_SIDE && h <= MAX_CANVAS_SIDE && w * h <= MAX_CANVAS_AREA; }
