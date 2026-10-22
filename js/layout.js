'use strict';
// Random scatter ("dart throwing") on a wrap-around tile.
// An instance is { m: motifId, x, y, s: scale, r: rotation°, f: 1 | -1 (mirror), h: random hue offset° }.

/**
 * @param {object} [opt] { scale: global size factor, inside: keep whole motif inside the tile, gap }
 * @returns {object|null} null when `inside` is set and the motif cannot fit in the tile at all
 */
function randomInstance(motif, rng, W, H, opt = {}) {
  const st = motif.settings;
  const sym = () => rng() * 2 - 1;
  const inst = {
    m: motif.id,
    x: 0,
    y: 0,
    s: Math.max(0.01, (st.size / 100) * (opt.scale || 1) * (1 + sym() * st.sizeVar / 100)),
    r: wrap(st.rot + sym() * st.rotVar, 360),
    f: st.flip && rng() < 0.5 ? -1 : 1,
    h: Math.round(sym() * st.hueVar),
  };
  if (opt.inside) {
    // Half the gap at each edge, so neighbouring tiles still keep the full gap.
    const { hw, hh } = rotatedHalfExtents(motif.natW * inst.s, motif.natH * inst.s, inst.r);
    const mx = hw + (opt.gap || 0) / 2, my = hh + (opt.gap || 0) / 2;
    if (2 * mx > W || 2 * my > H) return null;
    inst.x = mx + rng() * (W - 2 * mx);
    inst.y = my + rng() * (H - 2 * my);
  } else {
    inst.x = rng() * W;
    inst.y = rng() * H;
  }
  return inst;
}

/** Does the instance stick out of the tile (closer than half the gap to an edge)? */
function crossesEdge(inst, motif, W, H, gap) {
  const { hw, hh } = rotatedHalfExtents(motif.natW * inst.s, motif.natH * inst.s, inst.r);
  const e = 1e-6;
  return inst.x - hw - gap / 2 < -e || inst.x + hw + gap / 2 > W + e ||
    inst.y - hh - gap / 2 < -e || inst.y + hh + gap / 2 > H + e;
}

/** Move an instance just far enough to be fully inside the tile (shrinks it if it cannot fit). */
function pushInside(inst, motif, W, H, gap) {
  let { hw, hh } = rotatedHalfExtents(motif.natW * inst.s, motif.natH * inst.s, inst.r);
  const room = Math.min((W - gap) / (2 * hw), (H - gap) / (2 * hh));
  if (room < 1) {
    inst.s *= room * 0.98;
    ({ hw, hh } = rotatedHalfExtents(motif.natW * inst.s, motif.natH * inst.s, inst.r));
  }
  // The centre is always inside the tile, so most of the motif is on that side: just clamp.
  const mx = hw + gap / 2, my = hh + gap / 2;
  inst.x = Math.min(W - mx, Math.max(mx, inst.x));
  inst.y = Math.min(H - my, Math.max(my, inst.y));
}

/**
 * @param {object} o
 * @param {object[]} o.motifs
 * @param {number} o.W, o.H, o.gap       tile size and minimum gap (px)
 * @param {'shape'|'circle'} o.collision
 * @param {number} o.seed
 * @param {number} o.maxCount             0 = fill until full
 * @param {number} o.effort               consecutive failed attempts before giving up
 * @param {boolean} o.ensureEach          place one of every motif first
 * @param {object[]} [o.existing]         keep these and only add more
 */
function scatter(o) {
  const rng = makeRng(o.seed);
  const byId = new Map(o.motifs.map(m => [m.id, m]));
  const active = o.motifs.filter(m => m.settings.enabled && m.settings.weight > 0);
  const checker = makeChecker(o.collision, o.W, o.H, o.gap);
  const placed = [];
  const tooBig = new Set();

  for (const inst of o.existing || []) {
    const m = byId.get(inst.m);
    if (!m) continue;
    checker.add(checker.footprint(inst, m));
    placed.push(inst);
  }
  if (!active.length) return { instances: placed, missing: [], tooBig: [] };

  const limit = o.maxCount > 0 ? o.maxCount : Infinity;
  const instOpt = { scale: o.scale || 1, inside: o.inside, gap: o.gap };
  const tryPlace = (m, attempts) => {
    for (let a = 0; a < attempts; a++) {
      const inst = randomInstance(m, rng, o.W, o.H, instOpt);
      if (!inst) return false;
      const fp = checker.tryFit(inst, m);
      if (fp) {
        checker.add(fp);
        placed.push(inst);
        return true;
      }
    }
    return false;
  };

  // Bigger motifs first: they are the hardest to fit later.
  const missing = [];
  if (o.ensureEach) {
    const present = new Set(placed.map(i => i.m));
    const order = active.filter(m => !present.has(m.id))
      .sort((a, b) => b.natW * b.natH * b.settings.size ** 2 - a.natW * a.natH * a.settings.size ** 2);
    for (const m of order) {
      if (placed.length >= limit) break;
      if (!tryPlace(m, Math.max(500, o.effort * 2))) missing.push(m.name);
    }
  }

  const total = active.reduce((sum, m) => sum + m.settings.weight, 0);
  const pick = () => {
    let t = rng() * total;
    for (const m of active) { if ((t -= m.settings.weight) <= 0) return m; }
    return active[active.length - 1];
  };

  // Each motif type gets its own failure counter so small ones keep filling after big ones stop fitting.
  const fails = new Map(active.map(m => [m.id, 0]));
  let open = active.length;
  while (placed.length < limit && open > 0) {
    const m = pick();
    if (fails.get(m.id) >= o.effort) continue;
    if (tryPlace(m, 1)) {
      fails.set(m.id, 0);
    } else {
      const f = fails.get(m.id) + 1;
      fails.set(m.id, f);
      if (f >= o.effort) open--;
    }
  }

  for (const m of active) {
    const st = m.settings;
    const w = m.natW * st.size / 100 * (o.scale || 1) * (1 + st.sizeVar / 100);
    const h = m.natH * st.size / 100 * (o.scale || 1) * (1 + st.sizeVar / 100);
    if (Math.hypot(w, h) + o.gap >= Math.min(o.W, o.H) && !placed.some(i => i.m === m.id)) tooBig.add(m.name);
  }
  return { instances: placed, missing: missing.filter(nm => !tooBig.has(nm)), tooBig: [...tooBig] };
}

function weightedPicker(active, rng) {
  const total = active.reduce((sum, m) => sum + m.settings.weight, 0);
  return () => {
    let t = rng() * total;
    for (const m of active) { if ((t -= m.settings.weight) <= 0) return m; }
    return active[active.length - 1];
  };
}

/**
 * Lattice points of a (possibly rotated, row-shifted) grid that repeats exactly on a W×H tile.
 * The requested grid is nudged slightly so the tile's edges are whole lattice steps — that is what
 * makes it seamless at any angle.
 * @returns {{ pts: {x, y, i, j}[], d: number } | null}  d = nearest-neighbour distance
 */
function latticePoints(W, H, cols, rows, shift, angleDeg) {
  const t = angleDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const sx = W / cols, sy = H / rows;
  const A = [sx * c, sx * s];
  const B = [shift * sx * c - sy * s, shift * sx * s + sy * c];
  const det = A[0] * B[1] - A[1] * B[0];
  // Tile edges in lattice steps: (W,0) = m11·A + m21·B, (0,H) = m12·A + m22·B — rounded to integers.
  const m11 = Math.round(B[1] * W / det), m21 = Math.round(-A[1] * W / det);
  const m12 = Math.round(-B[0] * H / det), m22 = Math.round(A[0] * H / det);
  const dm = m11 * m22 - m12 * m21;
  if (dm === 0 || Math.abs(dm) > 20000) return null;
  // Adjusted basis that fits the tile exactly.
  const a = [W * m22 / dm, -H * m21 / dm];
  const b = [-W * m12 / dm, H * m11 / dm];
  const dl = a[0] * b[1] - a[1] * b[0];
  // Range of (i, j) whose points can land in the tile: invert the four corners.
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const i = (px * b[1] - py * b[0]) / dl, j = (py * a[0] - px * a[1]) / dl;
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  const eps = 1e-6 * Math.max(W, H);
  const pts = [];
  for (let j = Math.floor(j0) - 1; j <= Math.ceil(j1) + 1; j++) {
    for (let i = Math.floor(i0) - 1; i <= Math.ceil(i1) + 1; i++) {
      const x = i * a[0] + j * b[0], y = i * a[1] + j * b[1];
      if (x >= -eps && x < W - eps && y >= -eps && y < H - eps) pts.push({ x: Math.max(0, x), y: Math.max(0, y), i, j });
    }
  }
  const d = Math.min(Math.hypot(...a), Math.hypot(...b),
    Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(a[0] + b[0], a[1] + b[1]));
  // Offsets to nearby neighbours, used to size motifs so they do not touch.
  const near = [];
  for (let j = -3; j <= 3; j++) {
    for (let i = -3; i <= 3; i++) {
      if (!i && !j) continue;
      const v = [i * a[0] + j * b[0], i * a[1] + j * b[1]];
      if (Math.hypot(...v) < 3 * d) near.push(v);
    }
  }
  return { pts, d, near, a, b };
}

/**
 * Largest scale at which a box of half extents (hw, hh) at every lattice point keeps `gap` from
 * its neighbours: for each neighbour the boxes must be apart along x or along y.
 */
function fitScale(near, hw, hh, gap) {
  let s = Infinity;
  for (const [vx, vy] of near) {
    s = Math.min(s, Math.max((Math.abs(vx) - gap) / (2 * hw), (Math.abs(vy) - gap) / (2 * hh)));
  }
  return Math.max(0.01, s);
}

/**
 * Brick grid: rows of motifs, each row shifted by `shift` of a step, optionally rotated by `angle`.
 * @param {object} o { motifs, W, H, gap, seed, grid: { cols, rows, shift, angle, jitter, order, fit, rotateWithGrid } }
 */
function gridLayout(o) {
  const g = o.grid;
  const notes = [];
  const rng = makeRng(o.seed);
  const active = o.motifs.filter(m => m.settings.enabled && m.settings.weight > 0);
  if (!active.length) return { instances: [], notes };

  const cols = Math.max(1, Math.round(g.cols));
  let rows = Math.max(1, Math.round(g.rows));
  // Without rotation the row shift only repeats when rows × shift is whole (½ → even rows, ⅓ → multiples of 3).
  if (g.shift > 0 && Math.round(g.angle) % 180 === 0) {
    const den = Math.round(1 / g.shift);
    if (rows % den) {
      rows = Math.ceil(rows / den) * den;
      notes.push(`Rows set to ${rows} so the shifted rows repeat seamlessly.`);
    }
  }
  const lat = latticePoints(o.W, o.H, cols, rows, g.shift, g.angle);
  if (!lat) {
    notes.push('That grid cannot be made seamless — try other numbers or angle.');
    return { instances: [], notes };
  }
  if (lat.pts.length !== cols * rows) notes.push(`Adjusted to ${lat.pts.length} positions to stay seamless at this angle.`);

  const pick = weightedPicker(active, rng);
  const sym = () => rng() * 2 - 1;
  const instances = lat.pts.map(p => {
    const m = g.order === 'sequence'
      ? active[(((p.i + p.j) % active.length) + active.length) % active.length]
      : pick();
    const st = m.settings;
    const r = wrap(st.rot + sym() * st.rotVar + (g.rotateWithGrid ? g.angle : 0), 360);
    const jit = (g.jitter / 100) * lat.d * 0.5;
    let s;
    if (g.fit) {
      // Fit the motif's turned outline between its grid neighbours; random size may only shrink it.
      const { hw, hh } = rotatedHalfExtents(m.natW, m.natH, r);
      s = fitScale(lat.near, hw, hh, o.gap + 2 * jit) * (1 - rng() * st.sizeVar / 100);
    } else {
      s = (st.size / 100) * (1 + sym() * st.sizeVar / 100);
    }
    return {
      m: m.id,
      x: wrap(p.x + sym() * jit, o.W),
      y: wrap(p.y + sym() * jit, o.H),
      s: Math.max(0.01, s * (o.scale || 1)),
      r,
      f: st.flip && rng() < 0.5 ? -1 : 1,
      h: Math.round(sym() * st.hueVar),
    };
  });
  if (o.inside) return keepGridInside(instances, lat, o, notes);
  return { instances, notes };
}

/**
 * Slide the whole grid to the position where the fewest motifs touch the tile edges,
 * then leave out the ones that still would be cut.
 */
function keepGridInside(instances, lat, o, notes) {
  const byId = new Map(o.motifs.map(m => [m.id, m]));
  const steps = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
  let best = null;
  for (const u of steps) {
    for (const v of steps) {
      const dx = u * lat.a[0] + v * lat.b[0], dy = u * lat.a[1] + v * lat.b[1];
      let cut = 0;
      for (const it of instances) {
        const moved = { ...it, x: wrap(it.x + dx, o.W), y: wrap(it.y + dy, o.H) };
        if (crossesEdge(moved, byId.get(it.m), o.W, o.H, o.gap)) cut++;
      }
      if (!best || cut < best.cut) best = { cut, dx, dy };
      if (cut === 0) break;
    }
    if (best.cut === 0) break;
  }
  const kept = [];
  for (const it of instances) {
    const moved = { ...it, x: wrap(it.x + best.dx, o.W), y: wrap(it.y + best.dy, o.H) };
    if (!crossesEdge(moved, byId.get(it.m), o.W, o.H, o.gap)) kept.push(moved);
  }
  if (best.cut) notes.push(`${best.cut} motif${best.cut === 1 ? '' : 's'} left out so none are cut by the tile edge.`);
  return { instances: kept, notes };
}

/**
 * Put a motif on every template spot. Biggest spots get the biggest motifs; how many spots each
 * motif gets follows its weight. Motifs are scaled to fit inside their spot.
 * @param {object} o { motifs, W, H, seed, tpl: { spots, w, h, scale, useAngle } }
 */
function templateLayout(o) {
  const notes = [];
  const t = o.tpl;
  const rng = makeRng(o.seed);
  const active = o.motifs.filter(m => m.settings.enabled && m.settings.weight > 0)
    .sort((a, b) => b.natW * b.natH - a.natW * a.natH);
  if (!active.length || !t || !t.spots || !t.spots.length) {
    if (t && t.spots && !t.spots.length) notes.push('No spots found in the template — try other detection settings.');
    return { instances: [], notes };
  }
  const kx = o.W / t.w, ky = o.H / t.h, k = Math.sqrt(kx * ky);
  const spots = [...t.spots].sort((a, b) => b.area - a.area);
  const total = active.reduce((sum, m) => sum + m.settings.weight, 0);
  const sym = () => rng() * 2 - 1;

  const instances = spots.map((sp, rank) => {
    // Rank → motif, using cumulative weights (largest motifs take the largest spots).
    const q = (rank + 0.5) / spots.length * total;
    let acc = 0, m = active[active.length - 1];
    for (const cand of active) { acc += cand.settings.weight; if (q <= acc) { m = cand; break; } }
    const st = m.settings;
    const mLong = Math.max(m.natW, m.natH), mShort = Math.min(m.natW, m.natH);
    const s = (t.fitMode === 'area'
      ? Math.sqrt((sp.len * sp.wid * k * k) / (m.natW * m.natH))
      : Math.min(sp.len * k / mLong, sp.wid * k / mShort)) * t.scale / 100 * (o.scale || 1);
    let r = 0;
    if (t.useAngle && !sp.round) r = sp.angle + (m.natW >= m.natH ? 0 : 90);
    const inst = {
      m: m.id,
      x: wrap(sp.x * kx, o.W),
      y: wrap(sp.y * ky, o.H),
      s: Math.max(0.01, s),
      r: wrap(r + st.rot + sym() * st.rotVar, 360),
      f: st.flip && rng() < 0.5 ? -1 : 1,
      h: Math.round(sym() * st.hueVar),
    };
    if (o.inside) pushInside(inst, m, o.W, o.H, o.gap);
    return inst;
  });
  return { instances, notes };
}

/** Indices of instances that overlap (or are closer than the gap to) an earlier one. */
function findOverlaps(instances, motifs, W, H, gap, collision) {
  const byId = new Map(motifs.map(m => [m.id, m]));
  const checker = makeChecker(collision, W, H, gap);
  const bad = new Set();
  instances.forEach((inst, i) => {
    const m = byId.get(inst.m);
    if (!m) return;
    const fp = checker.tryFit(inst, m);
    if (!fp) bad.add(i);
    checker.add(fp || checker.footprint(inst, m));
  });
  return bad;
}

/** Shrink overlapping instances a little at a time until they fit (or give up). Mutates `instances`. */
function shrinkToFit(instances, motifs, W, H, gap, collision, rounds = 15) {
  let shrunk = 0;
  for (let k = 0; k < rounds; k++) {
    const bad = findOverlaps(instances, motifs, W, H, gap, collision);
    if (!bad.size) break;
    for (const i of bad) instances[i].s *= 0.92;
    shrunk = Math.max(shrunk, bad.size);
  }
  return shrunk;
}

/** Checker containing every instance except `skip` — used while dragging one motif. */
function checkerWithout(instances, skip, motifs, W, H, gap, collision) {
  const byId = new Map(motifs.map(m => [m.id, m]));
  const checker = makeChecker(collision, W, H, gap);
  instances.forEach((inst, i) => {
    const m = byId.get(inst.m);
    if (i !== skip && m) checker.add(checker.footprint(inst, m));
  });
  return checker;
}
