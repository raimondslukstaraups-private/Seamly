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
  // runtime
  motifs: [],
  instances: [],
  selected: -1,
  overlaps: new Set(),
  edited: false, // true after manual moves: settings changes then no longer auto-regenerate
};

const SAVED_KEYS = ['unit', 'W', 'H', 'gap', 'bg', 'bgNone', 'seed', 'maxCount', 'collision', 'effort',
  'ensureEach', 'dpi', 'outW', 'outH', 'repeat', 'zoom', 'seams'];

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
  const ovText = ov ? `<span class="bad">${ov} too close / overlapping (red)</span>` : `<span class="ok">no overlaps ✓</span>`;
  setStatus(`${count} motif${count === 1 ? '' : 's'} placed · ${ovText}${extra}`);
}

function recheckOverlaps() {
  S.overlaps = findOverlaps(S.instances, S.motifs, S.W, S.H, S.gap, S.collision);
}

// ------------------------------------------------------------------ generate

function generate(keepExisting) {
  if (!S.motifs.length) { setStatus('Add some SVG files to start.'); return; }
  setStatus('Generating…');
  // Let the status paint before the (synchronous) work.
  setTimeout(() => {
    const t0 = performance.now();
    const enabled = new Set(S.motifs.filter(m => m.settings.enabled).map(m => m.id));
    const res = scatter({
      motifs: S.motifs, W: S.W, H: S.H, gap: S.gap, collision: S.collision,
      seed: keepExisting ? (S.seed + S.instances.length * 7919) : S.seed,
      maxCount: S.maxCount, effort: S.effort, ensureEach: S.ensureEach,
      existing: keepExisting ? S.instances.filter(i => enabled.has(i.m)) : [],
    });
    S.instances = res.instances;
    S.selected = -1;
    if (!keepExisting) S.edited = false;
    recheckOverlaps();
    const ms = Math.round(performance.now() - t0);
    let extra = ` · ${ms} ms`;
    if (res.tooBig.length) extra += `<br><span class="bad">Too big for the tile: ${res.tooBig.map(escapeXml).join(', ')}</span>`;
    if (res.missing.length) extra += `<br><span class="bad">No room for: ${res.missing.map(escapeXml).join(', ')}</span>`;
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
  updateInfo();
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
  $('maxCount').addEventListener('change', e => { S.maxCount = Math.max(0, parseInt(e.target.value, 10) || 0); settingsChanged(); });
  $('collision').addEventListener('change', e => { S.collision = e.target.value; settingsChanged(); });
  $('effort').addEventListener('change', e => { S.effort = parseInt(e.target.value, 10); settingsChanged(); });
  $('ensureEach').addEventListener('change', e => { S.ensureEach = e.target.checked; settingsChanged(); });

  $('generate').addEventListener('click', () => generate(false));
  $('fillGaps').addEventListener('click', () => generate(true));
  $('clearAll').addEventListener('click', () => {
    S.instances = [];
    S.selected = -1;
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
  $('zoom').addEventListener('input', e => { S.zoom = parseFloat(e.target.value); Preview.fit(S); autosave(); });
  $('seams').addEventListener('change', e => { S.seams = e.target.checked; redraw(); autosave(); });
  window.addEventListener('resize', () => Preview.fit(S));

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
    const w = m.natW * st.size / 100, h = m.natH * st.size / 100;
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
      S.selected = -1;
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
      if (v > 0) st.size = toPx(v, S.unit) / m.natW * 100;
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
  const svgs = [...files].filter(f => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml');
  if (!svgs.length) { toast('Please choose .svg files'); return; }
  let added = 0;
  for (const f of svgs) {
    try {
      S.motifs.push(await createMotif(await f.text(), f.name.replace(/\.svg$/i, '')));
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

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = Preview.toTile(e, S.W, S.H);
    const idx = hitTest(S.instances, byId(), S.W, S.H, p.tx, p.ty);
    S.selected = idx;
    redraw();
    if (idx < 0) return;
    const inst = S.instances[idx];
    drag = {
      idx, sx: p.x, sy: p.y, ix: inst.x, iy: inst.y, moved: false,
      checker: checkerWithout(S.instances, idx, S.motifs, S.W, S.H, S.gap, S.collision),
    };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
  });

  svg.addEventListener('pointermove', e => {
    if (drag) {
      const p = Preview.toTile(e, S.W, S.H);
      const inst = S.instances[drag.idx];
      inst.x = wrap(drag.ix + p.x - drag.sx, S.W);
      inst.y = wrap(drag.iy + p.y - drag.sy, S.H);
      drag.moved = true;
      const fits = drag.checker.tryFit(inst, byId().get(inst.m));
      if (fits) S.overlaps.delete(drag.idx); else S.overlaps.add(drag.idx);
      redraw();
      return;
    }
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const p = Preview.toTile(e, S.W, S.H);
      svg.classList.toggle('hovering', hitTest(S.instances, byId(), S.W, S.H, p.tx, p.ty) >= 0);
    });
  });

  const end = () => {
    if (!drag) return;
    svg.classList.remove('dragging');
    if (drag.moved) afterManualEdit();
    drag = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  window.addEventListener('keydown', e => {
    if (e.target.closest?.('input, select, textarea')) return;
    const inst = S.instances[S.selected];
    if (e.key === 'Escape') { S.selected = -1; redraw(); return; }
    if (!inst) return;
    const step = e.shiftKey ? 1 : 15;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      S.instances.splice(S.selected, 1);
      S.selected = -1;
    } else if (e.key === '[') {
      inst.r = wrap(inst.r - step, 360);
    } else if (e.key === ']') {
      inst.r = wrap(inst.r + step, 360);
    } else if (e.key === '+' || e.key === '=') {
      inst.s *= 1.05;
    } else if (e.key === '-') {
      inst.s /= 1.05;
    } else {
      return;
    }
    e.preventDefault();
    afterManualEdit();
  });
}

function afterManualEdit() {
  S.edited = true;
  recheckOverlaps();
  statusAfterChange();
  redraw();
  autosave();
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
  for (const k of SAVED_KEYS) if (data.settings && k in data.settings) S[k] = data.settings[k];
  const motifs = [];
  for (const mm of data.motifs || []) motifs.push(await createMotif(mm.source, mm.name, mm.settings));
  S.motifs = motifs;
  S.instances = (data.instances || [])
    .filter(i => motifs[i.m])
    .map(i => ({ ...i, m: motifs[i.m].id }));
  S.selected = -1;
  S.edited = !!data.edited;
  syncInputs();
  renderMotifList();
  recheckOverlaps();
  if (S.motifs.length) statusAfterChange(); else setStatus('Add some SVG files to start.');
  redraw();
  autosave();
}

let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
    } catch (_) { /* storage full or blocked — autosave is only a convenience */ }
  }, 400);
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
  redraw();
})();
