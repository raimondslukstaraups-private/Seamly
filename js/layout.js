'use strict';
// Random scatter ("dart throwing") on a wrap-around tile.
// An instance is { m: motifId, x, y, s: scale, r: rotation°, f: 1 | -1 (mirror), h: random hue offset° }.

function randomInstance(motif, rng, W, H) {
  const st = motif.settings;
  const sym = () => rng() * 2 - 1;
  return {
    m: motif.id,
    x: rng() * W,
    y: rng() * H,
    s: Math.max(0.01, (st.size / 100) * (1 + sym() * st.sizeVar / 100)),
    r: wrap(st.rot + sym() * st.rotVar, 360),
    f: st.flip && rng() < 0.5 ? -1 : 1,
    h: Math.round(sym() * st.hueVar),
  };
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
  const tryPlace = (m, attempts) => {
    for (let a = 0; a < attempts; a++) {
      const inst = randomInstance(m, rng, o.W, o.H);
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
    const w = m.natW * st.size / 100 * (1 + st.sizeVar / 100);
    const h = m.natH * st.size / 100 * (1 + st.sizeVar / 100);
    if (Math.hypot(w, h) + o.gap >= Math.min(o.W, o.H) && !placed.some(i => i.m === m.id)) tooBig.add(m.name);
  }
  return { instances: placed, missing: missing.filter(nm => !tooBig.has(nm)), tooBig: [...tooBig] };
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
