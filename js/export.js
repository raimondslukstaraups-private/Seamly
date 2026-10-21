'use strict';
// SVG / PNG / CSS export. `p` = { motifs, instances, W, H, bg, bgNone }.

function visibleInstances(p) {
  const ids = new Set(p.motifs.filter(m => m.settings.enabled).map(m => m.id));
  return p.instances.filter(i => ids.has(i.m));
}

/** Only motifs that are actually used, to keep files small. */
function usedMotifs(p, instances) {
  const used = new Set(instances.map(i => i.m));
  return p.motifs.filter(m => used.has(m.id));
}

function svgHeader(widthAttr, heightAttr, vbW, vbH) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" xmlns:xlink="${XLINKNS}" width="${widthAttr}" height="${heightAttr}" viewBox="0 0 ${n(vbW)} ${n(vbH)}">\n`;
}

const mm = px => `${n(px / 96 * 25.4)}mm`;

/**
 * One repeat tile. Motifs crossing the edges are drawn on both sides and clipped.
 * @param {object} [opt] { pixelW, pixelH } to give the SVG an exact pixel size (for rasterising),
 *                       { noBg } to leave the background out.
 */
function tileSvg(p, opt = {}) {
  const inst = visibleInstances(p);
  const byId = new Map(p.motifs.map(m => [m.id, m]));
  const { W, H } = p;
  const wAttr = opt.pixelW ? String(opt.pixelW) : mm(W);
  const hAttr = opt.pixelH ? String(opt.pixelH) : mm(H);
  const bg = p.bgNone || opt.noBg ? '' : `<rect width="${n(W)}" height="${n(H)}" fill="${p.bg}"/>\n`;
  return svgHeader(wAttr, hAttr, W, H) +
    `<defs>${motifDefsMarkup(usedMotifs(p, inst))}${hueFiltersMarkup(inst, byId)}` +
    `<clipPath id="tileClip"><rect width="${n(W)}" height="${n(H)}"/></clipPath></defs>\n` +
    bg +
    `<g clip-path="url(#tileClip)">\n${tileUsesMarkup(inst, byId, W, H)}\n</g>\n</svg>\n`;
}

/**
 * The pattern repeated over outW × outH. Every motif is drawn whole at each repeat
 * (no cut at tile edges), so there are no hairline seams when printed.
 */
function outputSvg(p, outW, outH) {
  const inst = visibleInstances(p);
  const byId = new Map(p.motifs.map(m => [m.id, m]));
  const { W, H } = p;
  const cols = Math.ceil(outW / W), rows = Math.ceil(outH / H);
  let uses = '';
  for (const it of inst) {
    const m = byId.get(it.m);
    const { hw, hh } = rotatedHalfExtents(m.natW * it.s, m.natH * it.s, it.r);
    for (let j = -1; j <= rows; j++) {
      const y = it.y + j * H;
      if (y + hh <= 0 || y - hh >= outH) continue;
      for (let i = -1; i <= cols; i++) {
        const x = it.x + i * W;
        if (x + hw <= 0 || x - hw >= outW) continue;
        uses += useMarkup(it, m, i * W, j * H) + '\n';
      }
    }
  }
  const bg = p.bgNone ? '' : `<rect width="${n(outW)}" height="${n(outH)}" fill="${p.bg}"/>\n`;
  return svgHeader(mm(outW), mm(outH), outW, outH) +
    `<defs>${motifDefsMarkup(usedMotifs(p, inst))}${hueFiltersMarkup(inst, byId)}` +
    `<clipPath id="outClip"><rect width="${n(outW)}" height="${n(outH)}"/></clipPath></defs>\n` +
    bg + `<g clip-path="url(#outClip)">\n${uses}</g>\n</svg>\n`;
}

/** Tile rendered to a canvas at `dpi`. Size is rounded to whole pixels so it repeats exactly. */
async function tileCanvas(p, dpi) {
  const tw = Math.max(1, Math.round(p.W / 96 * dpi));
  const th = Math.max(1, Math.round(p.H / 96 * dpi));
  if (!canvasFits(tw, th)) throw new Error(`Tile would be ${tw}×${th}px — too large. Lower the DPI.`);
  const img = await loadImage(svgDataUrl(tileSvg(p, { pixelW: tw, pixelH: th })));
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').drawImage(img, 0, 0, tw, th);
  return c;
}

async function tilePng(p, dpi) {
  const c = await tileCanvas(p, dpi);
  return pngWithDpi(await canvasToBlob(c), dpi);
}

async function outputPng(p, outW, outH, dpi) {
  const ow = Math.round(outW / 96 * dpi), oh = Math.round(outH / 96 * dpi);
  if (!canvasFits(ow, oh)) {
    throw new Error(`Output would be ${ow}×${oh}px — more than the browser can draw. Lower the DPI or use SVG.`);
  }
  const tile = await tileCanvas(p, dpi);
  const c = document.createElement('canvas');
  c.width = ow;
  c.height = oh;
  const ctx = c.getContext('2d');
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, ow, oh);
  return pngWithDpi(await canvasToBlob(c), dpi);
}

/** CSS that uses the tile as a repeating website background. */
function cssBackground(p) {
  const url = svgDataUrl(tileSvg(p, { pixelW: n(p.W), pixelH: n(p.H), noBg: true }).replace(/^<\?xml[^>]*>\s*/, ''));
  const color = p.bgNone ? '' : `background-color: ${p.bg};\n`;
  return `${color}background-image: url("${url}");\nbackground-size: ${n(p.W)}px ${n(p.H)}px;\nbackground-repeat: repeat;`;
}
