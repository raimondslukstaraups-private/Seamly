'use strict';
// UI wiring: state, controls, motif list, interaction, exports, autosave.

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'seamly.project.v1';

const S = {
  unit: 'cm',
  W: toPx(20, 'cm'),
  H: toPx(20, 'cm'),
  gap: toPx(0.5, 'cm'),
  bg: '#fdf6ec',
  bgNone: false,
  seed: Math.floor(Math.random() * 1e6),
  maxCount: 0,
  collision: 'shape',
  effort: 1000,
  ensureEach: true,
  dpi: 150,
  outW: toPx(100, 'cm'),
  outH: toPx(70, 'cm'),
  repeat: 3,
  zoom: 1,
  seams: true,
  globalScale: 100, // % applied to every motif on top of its own size
  inside: false,    // keep motifs fully inside the tile (no cut-offs at the edges)
  layout: 'scatter', // 'scatter' | 'grid' | 'template'
  grid: { cols: 4, rows: 4, shift: 0.5, angle: 0, jitter: 0, order: 'random', fit: true, rotateWithGrid: false },
  tpl: {
    name: '', dataUrl: '', w: 0, h: 0, spots: [],
    sensitivity: 50, merge: 3, minSize: 0.05, scale: 100, wrap: true, useAngle: true, show: true, shrink: true,
    fitMode: 'inside',
    exact: false,      // read from a Seamly template (no detection)
    useGroups: true,   // same colour = same motif
  },
  tplShape: 'ellipse', // shape used when exporting the layout as a template
  // runtime
  motifs: [],
  instances: [],
  sel: new Set(), // indices of selected instances
  overlaps: new Set(),
  edited: false, // true after manual moves: settings changes then no longer auto-regenerate
};

const SAVED_KEYS = ['unit', 'W', 'H', 'gap', 'bg', 'bgNone', 'seed', 'maxCount', 'collision', 'effort',
  'ensureEach', 'dpi', 'outW', 'outH', 'repeat', 'zoom', 'seams', 'layout', 'grid', 'tpl', 'globalScale', 'inside',
  'tplShape'];
const NESTED_KEYS = new Set(['grid', 'tpl']);
const DEFAULTS = { grid: { ...S.grid }, tpl: { ...S.tpl } };

const byId = () => new Map(S.motifs.map(m => [m.id, m]));
const project = () => ({ motifs: S.motifs, instances: S.instances, W: S.W, H: S.H, bg: S.bg, bgNone: S.bgNone });

// ------------------------------------------------------------------ drawing / status

let drawQueued = false;
function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    $('empty').hidden = S.motifs.length > 0;
    Preview.draw(S);
  });
}

function setStatus(html) { $('status').innerHTML = html; }

function statusAfterChange(extra = '') {
  const count = S.instances.filter(i => byId().get(i.m)?.settings.enabled).length;
  const ov = S.overlaps.size;
  const problem = S.inside ? 'too close, overlapping or cut by the edge (red)' : 'too close / overlapping (red)';
  const ovText = ov ? `<span class="bad">${ov} ${problem}</span>` : `<span class="ok">no overlaps ✓</span>`;
  setStatus(`${count} motif${count === 1 ? '' : 's'} placed · ${ovText}${extra}`);
}

function recheckOverlaps() {
  S.overlaps = findOverlaps(S.instances, S.motifs, S.W, S.H, S.gap, S.collision);
  if (S.inside) {
    // With "keep inside" on, a motif cut by the tile edge counts as a problem too.
    const ids = byId();
    S.instances.forEach((inst, i) => {
      const m = ids.get(inst.m);
      if (m && crossesEdge(inst, m, S.W, S.H, S.gap)) S.overlaps.add(i);
    });
  }
}

// ------------------------------------------------------------------ generate

function generate(keepExisting) {
  if (!S.motifs.length) { setStatus('Add some SVG files to start.'); return; }
  setStatus('Generating…');
  // Let the status paint before the (synchronous) work.
  setTimeout(() => {
    const t0 = performance.now();
    const enabled = new Set(S.motifs.filter(m => m.settings.enabled).map(m => m.id));
    let res;
    const common = { motifs: S.motifs, W: S.W, H: S.H, gap: S.gap, seed: S.seed, scale: S.globalScale / 100, inside: S.inside };
    if (keepExisting || S.layout === 'scatter') {
      // "Fill gaps" always scatters into the free space, whatever the layout mode.
      res = scatter({
        ...common, collision: S.collision,
        seed: keepExisting ? (S.seed + S.instances.length * 7919) : S.seed,
        maxCount: S.maxCount, effort: S.effort, ensureEach: S.ensureEach && !keepExisting,
        existing: keepExisting ? S.instances.filter(i => enabled.has(i.m)) : [],
      });
    } else if (S.layout === 'grid') {
      res = gridLayout({ ...common, grid: S.grid });
    } else {
      if (!S.tpl.dataUrl) { setStatus('Choose a template file first.'); return; }
      res = templateLayout({ ...common, tpl: S.tpl });
      if (S.tpl.shrink && shrinkToFit(res.instances, S.motifs, S.W, S.H, S.gap, S.collision)) {
        res.notes.push('Some motifs were made smaller so they do not overlap.');
      }
    }
    S.instances = res.instances;
    S.sel = new Set();
    if (!keepExisting) S.edited = false;
    recheckOverlaps();
    const ms = Math.round(performance.now() - t0);
    let extra = ` · ${ms} ms`;
    if (res.tooBig && res.tooBig.length) extra += `<br><span class="bad">Too big for the tile: ${res.tooBig.map(escapeXml).join(', ')}</span>`;
    if (res.missing && res.missing.length) extra += `<br><span class="bad">No room for: ${res.missing.map(escapeXml).join(', ')}</span>`;
    if (S.layout === 'template' && !keepExisting) extra += `<br>${S.tpl.spots.length} spots found in the template.`;
    for (const note of res.notes || []) extra += `<br>${escapeXml(note)}`;
    statusAfterChange(extra);
    redraw();
    autosave();
  }, 20);
}

let regenTimer = null;
/** Settings changed: regenerate automatically unless the user has hand-edited the layout. */
function settingsChanged() {
  autosave();
  updateInfo();
  if (!S.motifs.length) { redraw(); return; }
  if (S.edited) {
    recheckOverlaps();
    statusAfterChange('<br>Settings changed — press <b>Generate</b> to re-scatter (your manual edits would be replaced).');
    redraw();
    return;
  }
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => generate(false), 250);
}

// ------------------------------------------------------------------ controls

const LENGTH_INPUTS = { tileW: 'W', tileH: 'H', gap: 'gap', outW: 'outW', outH: 'outH' };

function syncInputs() {
  $('unit').value = S.unit;
  for (const [id, key] of Object.entries(LENGTH_INPUTS)) $(id).value = fmt(S[key], S.unit);
  for (const id of ['tileW', 'tileH', 'gap', 'outW', 'outH']) {
    $(id).step = S.unit === 'px' ? '1' : S.unit === 'mm' ? '1' : '0.1';
  }
  $('bg').value = S.bg;
  $('bgNone').checked = S.bgNone;
  $('seed').value = S.seed;
  $('maxCount').value = S.maxCount;
  $('collision').value = S.collision;
  $('effort').value = String(S.effort);
  $('ensureEach').checked = S.ensureEach;
  $('dpi').value = S.dpi;
  $('repeat').value = String(S.repeat);
  $('zoom').value = S.zoom;
  $('seams').checked = S.seams;
  $('globalScale').value = +S.globalScale.toFixed(1);
  $('tplShape').value = S.tplShape;
  $('inside').checked = S.inside;
  for (const [id, key] of Object.entries(GRID_INPUTS)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = S.grid[key]; else el.value = S.grid[key];
  }
  for (const [id, key] of Object.entries(TPL_INPUTS)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = S.tpl[key]; else el.value = S.tpl[key];
  }
  syncLayoutMode();
  syncTemplateInfo();
  updateInfo();
}

const GRID_INPUTS = {
  gridCols: 'cols', gridRows: 'rows', gridShift: 'shift', gridAngle: 'angle',
  gridOrder: 'order', gridJitter: 'jitter', gridFit: 'fit', gridRotate: 'rotateWithGrid',
};
// Inputs that need the template re-analysed when they change.
const TPL_DETECT_KEYS = new Set(['sensitivity', 'merge', 'minSize', 'wrap']);
const TPL_INPUTS = {
  tplSens: 'sensitivity', tplMerge: 'merge', tplMin: 'minSize', tplScale: 'scale',
  tplWrap: 'wrap', tplAngle: 'useAngle', tplShow: 'show', tplShrink: 'shrink', tplFit: 'fitMode',
  tplGroups: 'useGroups',
};

function syncLayoutMode() {
  for (const b of document.querySelectorAll('#layoutMode button')) b.classList.toggle('active', b.dataset.mode === S.layout);
  for (const p of document.querySelectorAll('.mode-panel')) p.classList.toggle('active', p.dataset.for === S.layout);
}

function syncTemplateInfo() {
  const has = !!S.tpl.dataUrl;
  $('tplThumbWrap').hidden = !has;
  if (has) $('tplThumb').src = S.tpl.dataUrl;
  $('tplName').textContent = has ? `${S.tpl.name} — ${S.tpl.spots.length} spots` : 'Choose a template';
  // Seamly templates are read exactly, so the detection settings do not apply.
  $('tplDetect').hidden = !!S.tpl.exact;
  $('tplExactInfo').hidden = !S.tpl.exact;
  $('tplGroupsRow').hidden = !S.tpl.spots.some(sp => sp.g !== undefined);
}

async function loadTemplate(file) {
  try {
    const t = await loadTemplateFile(file);
    Object.assign(S.tpl, {
      name: t.name, dataUrl: t.dataUrl, w: t.w, h: t.h, exact: t.exact, spots: t.exact ? t.spots : [],
    });
    if (t.exact && t.tileW && t.tileH) {
      // Seamly templates remember their tile size: use it, so spots keep their real size.
      if (Math.abs(t.tileW - S.W) > 0.5 || Math.abs(t.tileH - S.H) > 0.5) {
        S.W = t.tileW;
        S.H = t.tileH;
        toast(`Tile set to the template's size: ${fmt(S.W, S.unit)} × ${fmt(S.H, S.unit)} ${S.unit}`);
      }
    } else {
      // Match the tile's proportions to the template so spots keep their shape.
      const newH = S.W * t.h / t.w;
      if (Math.abs(newH - S.H) > 0.5) {
        S.H = newH;
        toast('Tile height adjusted to match the template proportions');
      }
    }
    $('tileW').value = fmt(S.W, S.unit);
    $('tileH').value = fmt(S.H, S.unit);
    S.layout = 'template';
    syncLayoutMode();
    await redetect();
  } catch (err) {
    console.error(err);
    toast('Could not read template: ' + err.message, 4000);
  }
}

async function redetect() {
  if (!S.tpl.dataUrl) return;
  if (!S.tpl.exact) S.tpl.spots = await detectSpots(S.tpl, S.tpl);
  syncTemplateInfo();
  S.edited = false;
  settingsChanged();
}

function updateInfo() {
  const tw = Math.round(S.W / 96 * S.dpi), th = Math.round(S.H / 96 * S.dpi);
  $('tilePxInfo').textContent = `Tile = ${tw} × ${th} px`;
  const ow = Math.round(S.outW / 96 * S.dpi), oh = Math.round(S.outH / 96 * S.dpi);
  const tiles = `${+(S.outW / S.W).toFixed(1)} × ${+(S.outH / S.H).toFixed(1)} tiles`;
  const warn = canvasFits(ow, oh) ? '' : ' — too big for PNG, use SVG or lower DPI';
  $('outInfo').textContent = `${ow} × ${oh} px at ${S.dpi} DPI · ${tiles}${warn}`;
}

function bindControls() {
  $('unit').addEventListener('change', e => { S.unit = e.target.value; syncInputs(); renderMotifList(); autosave(); });

  for (const [id, key] of Object.entries(LENGTH_INPUTS)) {
    $(id).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      const min = key === 'gap' ? 0 : 1;
      if (!(v >= 0)) { e.target.value = fmt(S[key], S.unit); return; }
      S[key] = Math.max(min, toPx(v, S.unit));
      if (key === 'outW' || key === 'outH') { updateInfo(); autosave(); return; }
      settingsChanged();
    });
  }

  $('bg').addEventListener('input', e => { S.bg = e.target.value; redraw(); autosave(); });
  $('bgNone').addEventListener('change', e => { S.bgNone = e.target.checked; redraw(); autosave(); });

  $('seed').addEventListener('change', e => { S.seed = parseInt(e.target.value, 10) || 0; S.edited = false; settingsChanged(); });
  $('shuffle').addEventListener('click', () => {
    S.seed = Math.floor(Math.random() * 1e6);
    $('seed').value = S.seed;
    S.edited = false;
    settingsChanged();
  });
  const setGlobalScale = v => {
    const next = Math.min(1000, Math.max(5, v));
    const ratio = next / S.globalScale;
    S.globalScale = next;
    $('globalScale').value = +next.toFixed(1);
    renderMotifList();
    if (S.edited) {
      // Hand-edited layout: resize the motifs where they are instead of re-laying out.
      for (const inst of S.instances) inst.s *= ratio;
      afterManualEdit();
      return;
    }
    settingsChanged();
  };
  $('globalScale').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (v > 0) setGlobalScale(v); else e.target.value = S.globalScale;
  });
  $('globalDown').addEventListener('click', () => setGlobalScale(Math.round(S.globalScale / 1.1)));
  $('globalUp').addEventListener('click', () => setGlobalScale(Math.round(S.globalScale * 1.1)));

  $('inside').addEventListener('change', e => {
    S.inside = e.target.checked;
    if (S.inside && S.edited) {
      // Hand-edited layout: nudge the existing motifs inward rather than re-laying out.
      const ids = byId();
      for (const inst of S.instances) {
        const m = ids.get(inst.m);
        if (m && crossesEdge(inst, m, S.W, S.H, S.gap)) pushInside(inst, m, S.W, S.H, S.gap);
      }
      afterManualEdit();
      return;
    }
    settingsChanged();
  });

  $('layoutMode').addEventListener('click', e => {
    const mode = e.target.dataset.mode;
    if (!mode || mode === S.layout) return;
    S.layout = mode;
    S.edited = false;
    syncLayoutMode();
    if (mode === 'template' && !S.tpl.dataUrl) { setStatus('Choose a template file.'); redraw(); autosave(); return; }
    settingsChanged();
  });

  for (const [id, key] of Object.entries(GRID_INPUTS)) {
    $(id).addEventListener('change', e => {
      const el = e.target;
      if (el.type === 'checkbox') S.grid[key] = el.checked;
      else if (key === 'order') S.grid[key] = el.value;
      else {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) { el.value = S.grid[key]; return; }
        S.grid[key] = key === 'cols' || key === 'rows' ? Math.min(100, Math.max(1, Math.round(v))) : v;
        el.value = S.grid[key];
      }
      settingsChanged();
    });
  }

  for (const [id, key] of Object.entries(TPL_INPUTS)) {
    $(id).addEventListener('change', e => {
      const el = e.target;
      if (el.type === 'checkbox') S.tpl[key] = el.checked;
      else if (el.tagName === 'SELECT') S.tpl[key] = el.value;
      else {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) { el.value = S.tpl[key]; return; }
        S.tpl[key] = v;
      }
      if (key === 'show') { redraw(); autosave(); return; }
      if (TPL_DETECT_KEYS.has(key)) redetect(); else settingsChanged();
    });
  }
  $('tplFromLayout').addEventListener('click', () => {
    if (!visibleInstances(project()).length) { toast('Make a layout first, then turn it into a template.'); return; }
    const svg = layoutTemplateSvg(project(), 'ellipse');
    loadTemplate(new File([svg], 'Current layout', { type: 'image/svg+xml' }));
  });
  $('tplShape').addEventListener('change', e => { S.tplShape = e.target.value; autosave(); });
  $('exportTemplate').addEventListener('click', () => guardExport(async () =>
    downloadBlob(new Blob([layoutTemplateSvg(project(), S.tplShape)], { type: 'image/svg+xml' }), 'seamly-template.svg')));

  $('tplInput').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadTemplate(f);
  });
  $('tplDrop').addEventListener('drop', e => {
    // Keep the window-level handler from importing the file as a motif.
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files[0]) loadTemplate(e.dataTransfer.files[0]);
  });

  $('maxCount').addEventListener('change', e => { S.maxCount = Math.max(0, parseInt(e.target.value, 10) || 0); settingsChanged(); });
  $('collision').addEventListener('change', e => { S.collision = e.target.value; settingsChanged(); });
  $('effort').addEventListener('change', e => { S.effort = parseInt(e.target.value, 10); settingsChanged(); });
  $('ensureEach').addEventListener('change', e => { S.ensureEach = e.target.checked; settingsChanged(); });

  $('generate').addEventListener('click', () => generate(false));
  $('fillGaps').addEventListener('click', () => generate(true));
  $('clearAll').addEventListener('click', () => {
    S.instances = [];
    S.sel = new Set();
    S.overlaps = new Set();
    S.edited = true;
    statusAfterChange();
    redraw();
    autosave();
  });

  $('dpi').addEventListener('change', e => {
    S.dpi = Math.min(1200, Math.max(10, parseInt(e.target.value, 10) || 150));
    e.target.value = S.dpi;
    updateInfo();
    autosave();
  });

  $('repeat').addEventListener('change', e => { S.repeat = parseInt(e.target.value, 10); redraw(); autosave(); });
  $('undo').addEventListener('click', () => History.undo());
  $('redo').addEventListener('click', () => History.redo());

  // Full redraw (not just fit): handle sizes depend on the zoom.
  $('zoom').addEventListener('input', e => { S.zoom = parseFloat(e.target.value); redraw(); autosave(); });
  $('seams').addEventListener('change', e => { S.seams = e.target.checked; redraw(); autosave(); });
  window.addEventListener('resize', () => redraw());

  // Exports
  $('exportTileSvg').addEventListener('click', () => guardExport(async () =>
    downloadBlob(new Blob([tileSvg(project())], { type: 'image/svg+xml' }), 'seamly-tile.svg')));
  $('exportTilePng').addEventListener('click', () => guardExport(async () =>
    downloadBlob(await tilePng(project(), S.dpi), `seamly-tile-${S.dpi}dpi.png`)));
  $('exportOutSvg').addEventListener('click', () => guardExport(async () =>
    downloadBlob(new Blob([outputSvg(project(), S.outW, S.outH)], { type: 'image/svg+xml' }), 'seamly-output.svg')));
  $('exportOutPng').addEventListener('click', () => guardExport(async () =>
    downloadBlob(await outputPng(project(), S.outW, S.outH, S.dpi), `seamly-output-${S.dpi}dpi.png`), 'Rendering large PNG…'));
  $('copyCss').addEventListener('click', () => guardExport(async () => {
    const css = cssBackground(project());
    try {
      await navigator.clipboard.writeText(css);
      toast('CSS copied to clipboard');
    } catch (_) {
      downloadBlob(new Blob([css], { type: 'text/css' }), 'seamly-background.css');
    }
  }));
  $('saveProject').addEventListener('click', () => {
    downloadBlob(new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' }), 'seamly-project.json');
  });
  $('openProject').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await restore(JSON.parse(await file.text()));
      toast('Project opened');
    } catch (err) {
      toast('Could not open project: ' + err.message, 4000);
    }
  });
}

async function guardExport(fn, busyMsg) {
  if (!S.instances.length) { toast('Nothing to export yet — generate a pattern first.'); return; }
  if (busyMsg) toast(busyMsg, 60000);
  try {
    await fn();
    if (busyMsg) toast('Done');
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 5000);
  }
}

// ------------------------------------------------------------------ motif list

function renderMotifList() {
  const list = $('motifList');
  const open = new Set([...list.querySelectorAll('.motif.open')].map(li => li.dataset.id));
  list.innerHTML = '';
  for (const m of S.motifs) {
    const st = m.settings;
    const li = document.createElement('li');
    li.className = 'motif' + (st.enabled ? '' : ' disabled') + (open.has(m.id) ? ' open' : '');
    li.dataset.id = m.id;
    const u = S.unit;
    // Shown size includes the "All motifs" factor, so it is what actually gets printed.
    const g = S.globalScale / 100;
    const w = m.natW * st.size / 100 * g, h = m.natH * st.size / 100 * g;
    li.innerHTML = `
      <div class="motif-head">
        <span class="chev">▶</span>
        <span class="motif-thumb"><img alt="" src="${m.thumbUrl}"></span>
        <span class="motif-name"><b title="${escapeXml(m.name)}">${escapeXml(m.name)}</b>
          <small>${fmt(w, u)} × ${fmt(h, u)} ${u}</small></span>
        <input type="checkbox" data-k="enabled" title="Use this motif" ${st.enabled ? 'checked' : ''}>
        <button type="button" data-act="remove" title="Remove">✕</button>
      </div>
      <div class="motif-body">
        <div class="grid">
          <label>Width (${u}) <input type="number" data-k="width" min="0" step="any" value="${fmt(w, u)}"></label>
          <label>Size % <input type="number" data-k="size" min="1" step="1" value="${+st.size.toFixed(1)}"></label>
          <label>Size random ± % <input type="number" data-k="sizeVar" min="0" max="90" step="1" value="${st.sizeVar}"></label>
          <label>How often (weight) <input type="number" data-k="weight" min="0" step="0.5" value="${st.weight}"></label>
          <label>Rotation ° <input type="number" data-k="rot" step="1" value="${st.rot}"></label>
          <label>Rotation random ± ° <input type="number" data-k="rotVar" min="0" max="180" step="1" value="${st.rotVar}"></label>
          <label>Hue shift ° <input type="number" data-k="hue" min="-180" max="180" step="5" value="${st.hue}"></label>
          <label>Hue random ± ° <input type="number" data-k="hueVar" min="0" max="180" step="5" value="${st.hueVar}"></label>
        </div>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-k="flip" ${st.flip ? 'checked' : ''}> Randomly mirror</label>
      </div>`;
    list.appendChild(li);
  }
}

function bindMotifList() {
  const list = $('motifList');
  list.addEventListener('click', e => {
    const li = e.target.closest('.motif');
    if (!li) return;
    if (e.target.dataset.act === 'remove') {
      S.motifs = S.motifs.filter(m => m.id !== li.dataset.id);
      S.instances = S.instances.filter(i => i.m !== li.dataset.id);
      S.sel = new Set();
      renderMotifList();
      settingsChanged();
      return;
    }
    if (e.target.closest('input, label, button')) return;
    li.classList.toggle('open');
  });

  list.addEventListener('change', e => {
    const k = e.target.dataset.k;
    const li = e.target.closest('.motif');
    if (!k || !li) return;
    const m = S.motifs.find(x => x.id === li.dataset.id);
    const st = m.settings;
    if (k === 'enabled' || k === 'flip') {
      st[k] = e.target.checked;
    } else if (k === 'width') {
      const v = parseFloat(e.target.value);
      if (v > 0) st.size = toPx(v, S.unit) / m.natW * 100 / (S.globalScale / 100);
    } else {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) st[k] = k === 'size' ? Math.max(1, v) : v;
    }
    renderMotifList();
    if (k === 'hue' || k === 'hueVar') {
      // Hue does not change spacing; apply the motif hue live, keep layout.
      if (k === 'hueVar' && !S.edited) { settingsChanged(); return; }
      autosave();
      redraw();
      return;
    }
    settingsChanged();
  });
}

// ------------------------------------------------------------------ import

async function importFiles(files) {
  const isSvg = f => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml';
  const isRaster = f => /\.(png|jpe?g|webp)$/i.test(f.name) || /^image\/(png|jpeg|webp)$/.test(f.type);
  const usable = [...files].filter(f => isSvg(f) || isRaster(f));
  if (!usable.length) { toast('Please choose SVG, PNG, JPG or WebP files'); return; }
  let added = 0;
  for (const f of usable) {
    try {
      const content = isSvg(f) ? await f.text() : await readAsDataUrl(f);
      S.motifs.push(await createMotif(content, f.name.replace(/\.(svg|png|jpe?g|webp)$/i, '')));
      added++;
    } catch (err) {
      console.error(err);
      toast(err.message, 4000);
    }
  }
  if (!added) return;
  renderMotifList();
  S.edited = false;
  settingsChanged();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`${file.name}: could not read the file`));
    r.readAsDataURL(file);
  });
}

function bindDropzone() {
  $('fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
  let depth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------ preview interaction

function bindPreview() {
  const svg = $('preview');
  let drag = null;
  let hoverQueued = false;

  const MODE_CLASS = { move: 'dragging', resize: 'resizing', rotate: 'rotating' };

  /** Selection handle under the pointer, if any. */
  const handleAt = p => {
    const sel = selList();
    return sel.length ? hitHandle(S.instances, sel, byId(), S.W, S.H, Preview.unitsPerPx(S), p.tx, p.ty) : null;
  };

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = Preview.toTile(e, S.W, S.H);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const handle = additive ? null : handleAt(p);
    let mode = handle && handle.mode;
    if (!mode) {
      const idx = hitTest(S.instances, byId(), S.W, S.H, p.tx, p.ty);
      if (additive) {
        // Ctrl/Shift+click adds a motif to the selection or takes it out.
        if (idx >= 0) {
          S.sel = new Set(S.sel);
          if (S.sel.has(idx)) S.sel.delete(idx); else S.sel.add(idx);
        }
        redraw();
        return;
      }
      if (idx < 0) { S.sel = new Set(); redraw(); return; }
      // Clicking a motif that is already selected keeps the group, so it can be dragged together.
      if (!S.sel.has(idx)) S.sel = new Set([idx]);
      mode = 'move';
      redraw();
    }
    const sel = selList();
    const g = groupLayout(S.instances, sel, byId(), S.W, S.H);
    // Rotate/resize are measured around the centre of the motif whose handle was grabbed
    // (its copy nearest the pointer); the same change is then applied to every selected motif.
    const lead = handle ? S.instances[handle.i] : null;
    const cx = lead ? lead.x + S.W * Math.round((p.x - lead.x) / S.W) : p.x;
    const cy = lead ? lead.y + S.H * Math.round((p.y - lead.y) / S.H) : p.y;
    drag = {
      mode, sx: p.x, sy: p.y, moved: false, cx, cy,
      leadR: lead ? lead.r : 0,
      a0: Math.atan2(p.y - cy, p.x - cx),
      d0: Math.max(1e-6, Math.hypot(p.x - cx, p.y - cy)),
      start: g.items.map(it => ({ i: it.i, x: it.x, y: it.y, s: S.instances[it.i].s, r: S.instances[it.i].r })),
      checker: checkerWithout(S.instances, new Set(sel), S.motifs, S.W, S.H, S.gap, S.collision),
    };
    try { svg.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
    svg.classList.add(MODE_CLASS[mode]);
  });

  svg.addEventListener('pointerleave', () => { pointerTile = null; });
  svg.addEventListener('pointermove', e => {
    const pt = Preview.toTile(e, S.W, S.H);
    pointerTile = { x: pt.tx, y: pt.ty };
    if (drag) {
      const p = pt;
      const ids = byId();
      let ang = 0, k = 1;
      if (drag.mode === 'rotate') {
        ang = (Math.atan2(p.y - drag.cy, p.x - drag.cx) - drag.a0) * 180 / Math.PI;
        // Shift snaps the grabbed motif to 15° steps; the others turn by the same amount.
        if (e.shiftKey) ang = Math.round((drag.leadR + ang) / 15) * 15 - drag.leadR;
      } else if (drag.mode === 'resize') {
        k = Math.hypot(p.x - drag.cx, p.y - drag.cy) / drag.d0;
      }
      for (const st of drag.start) {
        const inst = S.instances[st.i];
        if (drag.mode === 'move') {
          const x = st.x + p.x - drag.sx, y = st.y + p.y - drag.sy;
          // With "keep inside", slide along the edge instead of wrapping to the other side.
          inst.x = S.inside ? x : wrap(x, S.W);
          inst.y = S.inside ? y : wrap(y, S.H);
        } else {
          // Every selected motif turns / grows around its own centre and stays where it is.
          inst.r = wrap(st.r + ang, 360);
          inst.s = Math.max(0.01, st.s * k);
        }
        const m = ids.get(inst.m);
        if (S.inside) pushInside(inst, m, S.W, S.H, S.gap);
        if (drag.checker.tryFit(inst, m)) S.overlaps.delete(st.i); else S.overlaps.add(st.i);
      }
      drag.moved = true;
      redraw();
      return;
    }
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const p = Preview.toTile(e, S.W, S.H);
      const hit = handleAt(p);
      const h = hit && hit.mode;
      svg.classList.toggle('on-resize', h === 'resize');
      svg.classList.toggle('on-rotate', h === 'rotate');
      svg.classList.toggle('hovering', !h && hitTest(S.instances, byId(), S.W, S.H, p.tx, p.ty) >= 0);
    });
  });

  const end = () => {
    if (!drag) return;
    svg.classList.remove('dragging', 'resizing', 'rotating');
    if (drag.moved) afterManualEdit();
    drag = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  window.addEventListener('keydown', e => {
    // Inside a text/number field, Ctrl+Z keeps its normal meaning (undo typing).
    if (e.target.closest?.('input:not([type=checkbox]):not([type=color]), textarea')) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) History.redo(); else History.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === 'a' && !e.target.closest?.('input, select, textarea')) {
      e.preventDefault();
      const ids = byId();
      S.sel = new Set(S.instances.map((it, i) => (ids.get(it.m)?.settings.enabled ? i : -1)).filter(i => i >= 0));
      redraw();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && 'cxvd'.includes(key) && key.length === 1) {
      const sel = selList();
      if (key === 'v') {
        if (!clip) return;
        e.preventDefault();
        pasteGroup(clip);
        return;
      }
      if (!sel.length) return; // nothing selected: leave normal copy behaviour alone
      e.preventDefault();
      if (key === 'd') { pasteCount = 0; pasteGroup(sel.map(i => ({ ...S.instances[i] })), false); return; }
      clip = sel.map(i => ({ ...S.instances[i] }));
      pasteCount = 0;
      const what = sel.length === 1 ? '' : ` ${sel.length} motifs`;
      if (key === 'x') {
        removeInstances(sel);
        afterManualEdit();
        toast(`Cut${what} — press Ctrl+V to paste`, 1500);
      } else {
        toast(`Copied${what} — press Ctrl+V to paste`, 1500);
      }
      return;
    }
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'Escape') { S.sel = new Set(); redraw(); return; }
    const sel = selList();
    if (!sel.length) return;
    const step = e.shiftKey ? 1 : 15;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      removeInstances(sel);
    } else if (['[', ']', '+', '=', '-'].includes(e.key)) {
      // Each selected motif turns / grows around its own centre.
      for (const i of sel) {
        const inst = S.instances[i];
        if (e.key === '[') inst.r = wrap(inst.r - step, 360);
        else if (e.key === ']') inst.r = wrap(inst.r + step, 360);
        else if (e.key === '-') inst.s /= 1.05;
        else inst.s *= 1.05;
      }
    } else {
      return;
    }
    e.preventDefault();
    afterManualEdit();
  });
}

/** Selected indices that still point at a motif. */
function selList() {
  const ids = byId();
  return [...S.sel].filter(i => S.instances[i] && ids.get(S.instances[i].m)).sort((a, b) => a - b);
}

function removeInstances(indices) {
  const drop = new Set(indices);
  S.instances = S.instances.filter((_, i) => !drop.has(i));
  S.sel = new Set();
}

// ------------------------------------------------------------------ copy / paste

let clip = null;          // copied motif instances
let pasteCount = 0;       // successive pastes without a pointer position step further away
let pointerTile = null;   // last pointer position over the preview (tile coords), or null

/**
 * Add copies of `items` (keeping their arrangement): centred on the mouse pointer if it is over
 * the preview (paste only), otherwise offset from the originals. The copies become the selection.
 */
function pasteGroup(items, atPointer = true) {
  const ids = byId();
  items = items.filter(it => ids.has(it.m));
  if (!items.length) { toast('Those motifs were removed'); return; }
  const g = groupLayout(items, items.map((_, k) => k), ids, S.W, S.H);
  let dx, dy;
  if (atPointer && pointerTile) {
    dx = pointerTile.x - g.cx;
    dy = pointerTile.y - g.cy;
  } else {
    pasteCount++;
    const size = Math.max(...items.map(it => { const m = ids.get(it.m); return Math.max(m.natW, m.natH) * it.s; }));
    dx = dy = size * 0.25 * pasteCount;
  }
  const first = S.instances.length;
  g.items.forEach((p, k) => {
    const inst = { ...items[k], x: wrap(p.x + dx, S.W), y: wrap(p.y + dy, S.H) };
    if (S.inside) pushInside(inst, ids.get(inst.m), S.W, S.H, S.gap);
    S.instances.push(inst);
  });
  S.sel = new Set(items.map((_, k) => first + k));
  afterManualEdit();
}

function afterManualEdit() {
  S.edited = true;
  recheckOverlaps();
  statusAfterChange();
  redraw();
  saveNow(); // each hand edit (drag, paste, delete…) is its own undo step, however quick
}

// ------------------------------------------------------------------ save / restore

function serialize() {
  const index = new Map(S.motifs.map((m, i) => [m.id, i]));
  const settings = {};
  for (const k of SAVED_KEYS) settings[k] = S[k];
  return {
    app: 'seamly',
    version: 1,
    settings,
    motifs: S.motifs.map(m => ({ name: m.name, source: m.source, settings: m.settings })),
    instances: S.instances.map(i => ({ ...i, m: index.get(i.m) })),
    edited: S.edited,
  };
}

async function restore(data) {
  if (!data || data.app !== 'seamly') throw new Error('not a Seamly project file');
  for (const k of SAVED_KEYS) {
    if (!data.settings || !(k in data.settings)) continue;
    S[k] = NESTED_KEYS.has(k) ? { ...DEFAULTS[k], ...data.settings[k] } : data.settings[k];
  }
  const motifs = [];
  for (const mm of data.motifs || []) motifs.push(await createMotif(mm.source, mm.name, mm.settings));
  S.motifs = motifs;
  S.instances = (data.instances || [])
    .filter(i => motifs[i.m])
    .map(i => ({ ...i, m: motifs[i.m].id }));
  S.sel = new Set();
  S.edited = !!data.edited;
  syncInputs();
  renderMotifList();
  recheckOverlaps();
  if (S.motifs.length) statusAfterChange(); else setStatus('Add some SVG files to start.');
  redraw();
  autosave();
}

let saveTimer = null;
/** Called after every change: saves the session and records an undo step (both debounced). */
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!History.restoring) History.record();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
  } catch (_) { /* storage full or blocked — autosave is only a convenience */ }
}

// ------------------------------------------------------------------ undo / redo

// View-only settings are not undo steps.
const NOT_UNDOABLE = new Set(['unit', 'repeat', 'zoom', 'seams', 'tplShape']);

const History = {
  steps: [],      // snapshots, oldest first
  index: -1,      // current position in `steps`
  limit: 100,
  restoring: false,
  motifs: new Map(), // every motif ever loaded, so removed ones can come back

  snapshot() {
    const settings = {};
    for (const k of SAVED_KEYS) {
      if (NOT_UNDOABLE.has(k)) continue;
      // Copy nested settings; the (large) template image string is shared, not copied.
      settings[k] = NESTED_KEYS.has(k) ? { ...S[k], spots: S[k].spots && [...S[k].spots] } : S[k];
    }
    return {
      settings,
      motifs: S.motifs.map(m => ({ id: m.id, settings: { ...m.settings } })),
      instances: S.instances.map(i => ({ ...i })),
      edited: S.edited,
    };
  },

  /** Add the current state as a step, unless nothing changed since the last one. */
  record() {
    for (const m of S.motifs) this.motifs.set(m.id, m);
    const snap = this.snapshot();
    const key = JSON.stringify(snap, (k, v) => (k === 'dataUrl' ? v.length : v));
    if (this.steps[this.index] && this.steps[this.index].key === key) return;
    this.steps.length = this.index + 1; // a new change drops the redo steps
    this.steps.push({ key, snap });
    if (this.steps.length > this.limit) this.steps.shift();
    this.index = this.steps.length - 1;
    updateUndoButtons();
  },

  undo() { this.go(-1, 'Nothing to undo'); },
  redo() { this.go(1, 'Nothing to redo'); },

  go(dir, emptyMsg) {
    // A change still waiting for its debounce becomes a step first, so it is the one undone.
    if (saveTimer) saveNow();
    clearTimeout(regenTimer);
    const next = this.index + dir;
    if (next < 0 || next >= this.steps.length) { toast(emptyMsg, 1500); return; }
    this.index = next;
    this.apply(this.steps[next].snap);
    updateUndoButtons();
  },

  apply(snap) {
    this.restoring = true;
    for (const [k, v] of Object.entries(snap.settings)) {
      S[k] = NESTED_KEYS.has(k) ? { ...v, spots: v.spots && [...v.spots] } : v;
    }
    S.motifs = snap.motifs.map(({ id, settings }) => {
      const m = this.motifs.get(id);
      m.settings = { ...settings };
      return m;
    });
    S.instances = snap.instances.map(i => ({ ...i }));
    S.edited = snap.edited;
    S.sel = new Set();
    syncInputs();
    renderMotifList();
    recheckOverlaps();
    if (S.motifs.length) statusAfterChange(); else setStatus('Add some SVG files to start.');
    redraw();
    saveNow();
    this.restoring = false;
  },
};

function updateUndoButtons() {
  $('undo').disabled = History.index <= 0;
  $('redo').disabled = History.index >= History.steps.length - 1;
}

// ------------------------------------------------------------------ start

(async function main() {
  Preview.init();
  bindControls();
  bindMotifList();
  bindDropzone();
  bindPreview();
  syncInputs();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { /* ignore */ }
  if (saved) {
    try { await restore(saved); } catch (err) { console.warn('Could not restore last session', err); }
  }
  saveNow(); // the starting point for undo
  redraw();
})();
