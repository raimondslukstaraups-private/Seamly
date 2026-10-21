'use strict';
// Overlap checking on a wrap-around (toroidal) tile.
// Both checkers share one interface:
//   tryFit(inst, motif) -> footprint | null   (null = would overlap or be too close)
//   footprint(inst, motif) -> footprint        (always, used to force-add existing motifs)
//   add(footprint)

const MASK_RES = 384; // resolution of the per-motif alpha mask (longest side, px)

/** Rasterise a motif once into an alpha mask (1 = paint). */
function getBaseMask(motif) {
  if (motif._mask) return motif._mask;
  const sc = MASK_RES / Math.max(motif.natW, motif.natH);
  const w = Math.max(1, Math.round(motif.natW * sc));
  const h = Math.max(1, Math.round(motif.natH * sc));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(motif.img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const raw = new Uint8Array(w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = px[i * 4 + 3] > 12 ? 1 : 0;
  // Grow by 1px so hairlines are not lost when sampling.
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (raw[y * w + x] ||
          (x > 0 && raw[y * w + x - 1]) || (x < w - 1 && raw[y * w + x + 1]) ||
          (y > 0 && raw[(y - 1) * w + x]) || (y < h - 1 && raw[(y + 1) * w + x])) data[y * w + x] = 1;
    }
  }
  motif._mask = { w, h, data };
  return motif._mask;
}

/** Is point (px, py) in tile space inside the painted shape of the instance? (used for clicking) */
function shapeContains(inst, motif, px, py) {
  const w = motif.natW * inst.s, h = motif.natH * inst.s;
  const rad = inst.r * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = px - inst.x, dy = py - inst.y;
  const lx = (dx * cos + dy * sin) * inst.f;
  const ly = -dx * sin + dy * cos;
  if (Math.abs(lx) > w / 2 || Math.abs(ly) > h / 2) return false;
  const m = getBaseMask(motif);
  const u = Math.min(m.w - 1, Math.floor((lx + w / 2) / w * m.w));
  const v = Math.min(m.h - 1, Math.floor((ly + h / 2) / h * m.h));
  return !!m.data[v * m.w + u];
}

class ShapeGrid {
  constructor(W, H, gap) {
    this.W = W;
    this.H = H;
    this.gap = gap;
    // ~250 cells along the long side, finer (up to 1000) when the gap is small; cells divide the tile exactly.
    const L = Math.max(W, H);
    const target = Math.min(L / 250, Math.max(L / 1000, gap > 0 ? gap / 2 : L / 250));
    this.gw = Math.max(8, Math.round(W / target));
    this.gh = Math.max(8, Math.round(H / target));
    this.cx = W / this.gw;
    this.cy = H / this.gh;
    this.zone = new Uint8Array(this.gw * this.gh); // painted cells + their gap halo
    // Disc of cell offsets covering gap + one cell of safety margin.
    const r = gap + Math.max(this.cx, this.cy);
    const ri = Math.ceil(r / this.cx), rj = Math.ceil(r / this.cy);
    this.disc = [];
    for (let dj = -rj; dj <= rj; dj++) {
      for (let di = -ri; di <= ri; di++) {
        if ((di * this.cx) ** 2 + (dj * this.cy) ** 2 <= r * r) this.disc.push(di, dj);
      }
    }
  }

  /** Rasterise an instance into grid cells. If `check` is set, abort with null on the first conflict. */
  _raster(inst, motif, check) {
    const w = motif.natW * inst.s, h = motif.natH * inst.s;
    const { hw, hh } = rotatedHalfExtents(w, h, inst.r);
    if (check && (2 * hw + this.gap >= this.W || 2 * hh + this.gap >= this.H)) return null; // would touch itself
    const { cx, cy, gw, gh, zone } = this;
    const i0 = Math.floor((inst.x - hw) / cx), i1 = Math.ceil((inst.x + hw) / cx);
    const j0 = Math.floor((inst.y - hh) / cy), j1 = Math.ceil((inst.y + hh) / cy);
    const cw = i1 - i0, ch = j1 - j0;
    const bits = new Uint8Array(cw * ch);
    const m = getBaseMask(motif);
    const sx = m.w / w, sy = m.h / h;
    const rad = inst.r * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const f = inst.f;
    // Coarse pass first (every 4th cell): most rejections are found here, cheaply.
    if (check) {
      for (let jj = 0; jj < ch; jj += 4) {
        const py = (j0 + jj + 0.5) * cy - inst.y;
        const row = (((j0 + jj) % gh) + gh) % gh * gw;
        for (let ii = (jj >> 2) & 3; ii < cw; ii += 4) {
          const px = (i0 + ii + 0.5) * cx - inst.x;
          const lx = (px * cos + py * sin) * f;
          const ly = -px * sin + py * cos;
          const u = Math.floor((lx + w / 2) * sx), v = Math.floor((ly + h / 2) * sy);
          if (u < 0 || v < 0 || u >= m.w || v >= m.h || !m.data[v * m.w + u]) continue;
          if (zone[row + ((((i0 + ii) % gw) + gw) % gw)]) return null;
        }
      }
    }
    for (let jj = 0; jj < ch; jj++) {
      const py = (j0 + jj + 0.5) * cy - inst.y;
      const row = (((j0 + jj) % gh) + gh) % gh * gw;
      for (let ii = 0; ii < cw; ii++) {
        const px = (i0 + ii + 0.5) * cx - inst.x;
        const lx = (px * cos + py * sin) * f;
        const ly = -px * sin + py * cos;
        const u = Math.floor((lx + w / 2) * sx), v = Math.floor((ly + h / 2) * sy);
        if (u < 0 || v < 0 || u >= m.w || v >= m.h || !m.data[v * m.w + u]) continue;
        if (check && zone[row + ((((i0 + ii) % gw) + gw) % gw)]) return null;
        bits[jj * cw + ii] = 1;
      }
    }
    return { i0, j0, cw, ch, bits };
  }

  tryFit(inst, motif) { return this._raster(inst, motif, true); }
  footprint(inst, motif) { return this._raster(inst, motif, false); }

  add(fp) {
    const { i0, j0, cw, ch, bits } = fp;
    const { gw, gh, zone, disc } = this;
    for (let jj = 0; jj < ch; jj++) {
      for (let ii = 0; ii < cw; ii++) {
        if (!bits[jj * cw + ii]) continue;
        const gi = i0 + ii, gj = j0 + jj;
        zone[wrap(gj, gh) * gw + wrap(gi, gw)] = 1;
        // Only edge cells need the gap halo; interior halos are covered by the shape itself.
        const edge = ii === 0 || jj === 0 || ii === cw - 1 || jj === ch - 1 ||
          !bits[jj * cw + ii - 1] || !bits[jj * cw + ii + 1] || !bits[(jj - 1) * cw + ii] || !bits[(jj + 1) * cw + ii];
        if (!edge) continue;
        for (let d = 0; d < disc.length; d += 2) {
          zone[wrap(gj + disc[d + 1], gh) * gw + wrap(gi + disc[d], gw)] = 1;
        }
      }
    }
  }
}

class CircleChecker {
  constructor(W, H, gap) {
    this.W = W;
    this.H = H;
    this.gap = gap;
    this.list = [];
  }

  footprint(inst, motif) {
    // Circle around the whole motif (half its diagonal) — safe for any rotation.
    return { x: inst.x, y: inst.y, r: Math.hypot(motif.natW * inst.s, motif.natH * inst.s) / 2 };
  }

  tryFit(inst, motif) {
    const fp = this.footprint(inst, motif);
    if (2 * fp.r + this.gap >= Math.min(this.W, this.H)) return null;
    for (const o of this.list) {
      let dx = Math.abs(fp.x - o.x), dy = Math.abs(fp.y - o.y);
      dx = Math.min(dx, this.W - dx);
      dy = Math.min(dy, this.H - dy);
      const min = fp.r + o.r + this.gap;
      if (dx * dx + dy * dy < min * min) return null;
    }
    return fp;
  }

  add(fp) { this.list.push(fp); }
}

function makeChecker(mode, W, H, gap) {
  return mode === 'circle' ? new CircleChecker(W, H, gap) : new ShapeGrid(W, H, gap);
}
