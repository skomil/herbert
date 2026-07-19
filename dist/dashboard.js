/**
 * Self-contained dashboard page (inline CSS/JS, no external assets).
 * Rendered client-side from GET /api/summary, refreshed every 5s.
 * Views: overall (all sessions) and per-session drill-down, both filtered by
 * report period (all/current/last/p<from>, from the configured report window).
 * State lives in the URL hash (#range=current&session=<id>).
 */
export function dashboardHtml() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>herbert — Claude Code analytics</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100; --s4: #008300;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --s1: #3987e5; --s2: #199e70; --s3: #c98500; --s4: #008300;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--page); color: var(--ink-1);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px; max-width: 1100px; margin: 0 auto;
  }
  h1 { font-size: 18px; font-weight: 600; }
  h1 small { color: var(--ink-muted); font-weight: 400; font-size: 13px; margin-left: 8px; }
  h2 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin-bottom: 12px; }
  .filters { display: flex; gap: 6px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  .filters .flabel, .meta-line .flabel { font-size: 12px; color: var(--ink-muted); margin-right: 4px; }
  .pill {
    border: 1px solid var(--border); background: var(--surface-1); color: var(--ink-2);
    border-radius: 999px; padding: 3px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .pill:hover { border-color: var(--baseline); }
  .pill.active { background: var(--ink-1); color: var(--page); border-color: var(--ink-1); font-weight: 600; }
  .back { font-size: 13px; color: var(--s1); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  .meta-line { font-size: 13px; color: var(--ink-2); margin-top: 8px; }
  .meta-line .mono { margin-right: 12px; }
  .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; margin-top: 16px;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 16px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
  .tile .label { font-size: 12px; color: var(--ink-2); }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
  .tile .sub { font-size: 12px; color: var(--ink-muted); }
  .barrow { display: grid; grid-template-columns: 140px 1fr; align-items: center; gap: 10px; margin: 6px 0; }
  .barrow .name { font-size: 12px; color: var(--ink-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .barrow .name a { color: inherit; text-decoration: none; }
  .barrow .name a:hover { color: var(--s1); }
  .track { display: flex; align-items: center; gap: 8px; min-height: 16px; }
  .bar { height: 16px; border-radius: 0 4px 4px 0; background: var(--s1); min-width: 2px; }
  .stack { display: flex; gap: 2px; height: 16px; flex: 1; min-width: 0; align-items: stretch; }
  .seg { min-width: 2px; }
  .seg:last-child { border-radius: 0 4px 4px 0; }
  .val { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
  .legend span { font-size: 12px; color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--ink-muted); font-weight: 500; font-size: 12px;
       border-bottom: 1px solid var(--baseline); padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid var(--grid); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: color-mix(in srgb, var(--s1) 7%, transparent); }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; color: var(--ink-2); }
  .scroll { overflow-x: auto; }
  .entry { padding: 10px 0; border-bottom: 1px solid var(--grid); }
  .entry:last-child { border-bottom: none; }
  .entry .meta { font-size: 12px; color: var(--ink-muted); margin-bottom: 2px; }
  .entry .meta a { color: var(--s1); text-decoration: none; }
  .entry .ctx { color: var(--ink-muted); font-weight: 600; }
  .entry .annrow { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  input.sann {
    border: 1px solid var(--border); background: var(--surface-1); color: var(--ink-2);
    border-radius: 999px; padding: 1px 8px; font-size: 11px; font-family: inherit; width: 140px;
  }
  input.sann:hover { border-color: var(--baseline); }
  input.sann[data-ann="deps"], input.sann[data-ann="revision"] { width: 260px; }
  .specdag .gedges path { stroke: var(--grid); fill: none; }
  .specdag .gdeps path { stroke: var(--baseline); stroke-dasharray: 4 3; fill: none; }
  .specdag .gnode rect { fill: var(--surface-1); stroke: var(--border); cursor: pointer; }
  .specdag .gnode:hover rect { stroke: var(--baseline); }
  .specdag .gnode.gactive rect { stroke: var(--s1); stroke-width: 1.5; }
  .specdag .gnode text { fill: var(--ink-2); font-size: 11px; pointer-events: none; }
  .specdag .gnode.glevel text { fill: var(--ink-1); font-weight: 600; }
  .specdag .gnode.gext rect { stroke-dasharray: 3 3; }
  .specdag .gnode.gext text { fill: var(--ink-muted); }
  .edge-solid, .edge-dashed { display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--grid); vertical-align: middle; margin-right: 4px; }
  .edge-dashed { border-top-style: dashed; border-top-color: var(--baseline); }
  select.feedback, select.rw, input.rw {
    border: 1px solid var(--border); background: var(--surface-1); color: var(--ink-2);
    border-radius: 999px; padding: 1px 8px; font-size: 11px; font-family: inherit; cursor: pointer;
  }
  select.feedback:hover, select.rw:hover, input.rw:hover { border-color: var(--baseline); }
  select.rw { padding: 3px 8px; font-size: 12px; }
  input.rw { padding: 3px 8px; font-size: 12px; width: 72px; cursor: text; }
  .retro-sec { font-size: 13px; color: var(--ink-2); margin-top: 4px; }
  .retro-sec .sec-label { color: var(--ink-muted); font-size: 12px; font-weight: 600; margin-right: 4px; }
  .empty { color: var(--ink-muted); font-size: 13px; padding: 8px 0; }
  .badge { display: inline-block; border: 1px dashed var(--baseline); color: var(--ink-muted); border-radius: 999px; padding: 0 8px; font-size: 11px; }
  .propose { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .propose input.sann { width: 180px; }
  .propose input.prop-sum { flex: 1; min-width: 240px; }
  .specdag .gnode.gproposed rect { stroke-dasharray: 4 3; }
  .mdview h3 { font-size: 14px; margin: 10px 0 4px; }
  .mdview h4, .mdview h5, .mdview h6 { font-size: 13px; color: var(--ink-2); margin: 8px 0 4px; }
  .mdview p { margin: 6px 0; font-size: 13px; color: var(--ink-2); }
  .mdview ul { margin: 6px 0 6px 20px; font-size: 13px; color: var(--ink-2); }
  .mdview code { font-family: ui-monospace, monospace; font-size: 12px; background: color-mix(in srgb, var(--ink-1) 6%, transparent); border-radius: 3px; padding: 0 4px; }
  .prd-doc textarea {
    width: 100%; min-height: 160px; resize: vertical; box-sizing: border-box;
    border: 1px solid var(--border); border-radius: 6px; background: var(--page); color: var(--ink-1);
    font-family: ui-monospace, monospace; font-size: 12px; padding: 8px;
  }
  #tooltip {
    position: fixed; pointer-events: none; display: none; z-index: 10;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 10px; font-size: 12px; color: var(--ink-1);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  .scroll table { min-width: 560px; }
  .kboard { display: flex; gap: 12px; margin-top: 16px; overflow-x: auto; padding-bottom: 8px; align-items: flex-start; }
  .kcol { flex: 1 0 220px; min-width: 220px; background: var(--page); border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
  .kcol.drop { border-color: var(--s1); background: color-mix(in srgb, var(--s1) 8%, var(--page)); }
  .kcolhead { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 4px 8px; }
  .kcount { background: color-mix(in srgb, var(--ink-1) 8%, transparent); color: var(--ink-2); border-radius: 10px; padding: 0 7px; font-size: 11px; }
  .kcards { display: flex; flex-direction: column; gap: 8px; min-height: 40px; }
  .kcard { background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; cursor: grab; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .kcard:active { cursor: grabbing; }
  .kcard.dragging { opacity: 0.4; }
  .kctx { font-size: 11px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 3px; }
  .ksum { font-size: 13px; color: var(--ink-1); line-height: 1.35; }
  .krev { font-size: 11px; color: var(--s3); margin-top: 4px; }
  .kcard input.sann { width: 100%; box-sizing: border-box; margin-top: 6px; font-size: 11px; }
  .kempty { font-size: 12px; color: var(--ink-muted); text-align: center; padding: 8px 0; }
  @media (max-width: 640px) {
    body { padding: 12px; }
    .card { padding: 12px; margin-top: 12px; }
    .tiles { grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 12px; }
    .tile { padding: 10px 12px; }
    .tile .value { font-size: 20px; }
    h1 small { display: block; margin: 2px 0 0; }
    .barrow { grid-template-columns: 1fr; gap: 2px; margin: 10px 0; }
    .barrow .name { text-align: left; }
    .meta-line { display: flex; flex-wrap: wrap; gap: 2px 12px; }
    .legend { gap: 10px; }
  }
</style>
</head>
<body>
  <h1>herbert <small>Claude Code session analytics · <span id="updated">loading…</span></small></h1>
  <div class="filters" id="filters"></div>
  <div id="main"></div>
  <div id="tooltip"></div>
<script>
const TOKEN_TYPES = [
  { key: 'input', label: 'Input', color: 'var(--s1)' },
  { key: 'output', label: 'Output', color: 'var(--s2)' },
  { key: 'cacheRead', label: 'Cache read', color: 'var(--s3)' },
  { key: 'cacheCreation', label: 'Cache write', color: 'var(--s4)' },
];
const FEEDBACK = ['dispute', 'contentious', 'mildly agree', 'strongly agree', 'too much detail', 'too little detail'];
const RANGES = [
  { key: 'all', label: 'All time' },
  { key: 'current', label: 'Current period' },
  { key: 'last', label: 'Last period' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const num = (n) => new Intl.NumberFormat('en').format(Math.round(n || 0));
const usd = (n) => '$' + (n || 0).toFixed(2);
const when = (t) => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const shortId = (s) => s === 'unknown' ? 'unknown' : String(s).slice(0, 8);
const sumTokens = (tokens) => Object.values(tokens || {}).reduce((a, b) => a + b, 0);
const totalCalls = (toolCalls) => Object.values(toolCalls || {}).reduce((a, c) => a + c.count, 0);
const duration = (sec) => sec >= 3600 ? (sec / 3600).toFixed(1) + 'h' : Math.round(sec / 60) + 'm';

function state() {
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    range: h.get('range') || 'all',
    session: h.get('session') || '',
    // spec-map node filter: repo / component (spec context) / single spec
    srepo: h.get('srepo') || '',
    sctx: h.get('sctx') || '',
    sspec: h.get('sspec') || '',
    // PRD page ('prd'; old 'specs' links fold in) and its component drill-down
    view: h.get('view') === 'specs' ? 'prd' : h.get('view') || '',
    pcomp: h.get('pcomp') || '',
    // show only proposed (not yet implemented) specs
    sprop: h.get('sprop') || '',
    // spec map: hide spec nodes / dependency edges when set to '0'
    mspecs: h.get('mspecs') || '',
    mdeps: h.get('mdeps') || '',
    // kanban board: hide the Complete column when set to '1'
    khide: h.get('khide') || '',
  };
}
function hashFor(patch) {
  const s = { ...state(), ...patch };
  const h = new URLSearchParams();
  if (s.range && s.range !== 'all') h.set('range', s.range);
  if (s.session) h.set('session', s.session);
  for (const k of ['srepo', 'sctx', 'sspec', 'view', 'pcomp', 'sprop', 'mspecs', 'mdeps', 'khide']) if (s[k]) h.set(k, s[k]);
  return '#' + h.toString();
}
const repoNameOf = (r) => (r ? r.split('/').pop() || r : 'unknown');
let WIN = null; // latest /api/report-window payload: { config, windows: [{from,to,hasData,cost}], pid }
let SERVER_PID = 0; // server pid at page load; a change means the server (and UI code) was replaced

// 'current'/'last'/'p<from>' resolve to a configured report window; 'all' to null
function resolveRange(key, windows) {
  if (key === 'current') return windows[0];
  if (key === 'last') return windows[1];
  if (key && key[0] === 'p') return windows.find((w) => String(w.from) === key.slice(1)) || null;
  return null;
}

const tooltip = document.getElementById('tooltip');
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) {
    tooltip.textContent = t.dataset.tip;
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(e.clientX + 12, innerWidth - 220) + 'px';
    tooltip.style.top = (e.clientY + 12) + 'px';
  } else tooltip.style.display = 'none';
});

function feedbackSelect(current, attrs) {
  return '<select class="feedback" ' + attrs + '><option value="">feedback…</option>' +
    FEEDBACK.map((c) =>
      '<option value="' + c + '"' + (current === c ? ' selected' : '') + '>' + c + '</option>').join('') +
    '</select>';
}

document.addEventListener('click', (e) => {
  const impl = e.target.closest('[data-impl]');
  if (impl) {
    fetch(new URL('api/specs/annotate', document.baseURI), {
      method: 'POST',
      body: JSON.stringify({ spec: Number(impl.dataset.impl), status: 'complete' }),
    }).then(refresh);
    return;
  }
  const rm = e.target.closest('[data-remove-spec]');
  if (rm) {
    if (!confirm('Remove this proposed spec?')) return;
    fetch(new URL('api/specs/annotate', document.baseURI), {
      method: 'POST',
      body: JSON.stringify({ spec: Number(rm.dataset.removeSpec), deleted: true }),
    }).then(refresh);
    return;
  }
  const ed = e.target.closest('[data-edit-spec]');
  if (ed) {
    const sum = ed.closest('.entry').querySelector('.esum');
    const inp = document.createElement('input');
    inp.className = 'sann';
    inp.style.width = '100%';
    inp.value = ed.dataset.raw;
    inp.dataset.espec = ed.dataset.editSpec;
    sum.textContent = '';
    sum.appendChild(inp);
    inp.focus();
    return;
  }
  const prop = e.target.closest('[data-propose]');
  if (!prop) return;
  const box = prop.closest('.propose');
  const summary = box.querySelector('.prop-sum').value.trim();
  if (!summary) return;
  const compInput = box.querySelector('#prop-comp');
  const context = prop.dataset.propose || (compInput ? compInput.value.trim() : '');
  const body = { type: 'specification', summary, status: 'proposed' };
  if (context) body.context = context;
  if (prop.dataset.session) body.sessionId = prop.dataset.session; // board: tie the spec to its session
  if (prop.dataset.cwd) body.cwd = prop.dataset.cwd;
  else if (REPO_HINT) body.cwd = REPO_HINT;
  fetch(new URL('api/events', document.baseURI), { method: 'POST', body: JSON.stringify(body) })
    .then(refresh);
});

const knownComponents = (specs) => '<datalist id="known-components">' +
  [...new Set(specs.map((e) => e.context).filter(Boolean))].map((c) => '<option value="' + esc(c) + '">').join('') +
  '</datalist>';

document.addEventListener('change', (e) => {
  const es = e.target.closest('input[data-espec]');
  if (es) {
    es.blur();
    fetch(new URL('api/specs/annotate', document.baseURI), {
      method: 'POST',
      body: JSON.stringify({ spec: Number(es.dataset.espec), summary: es.value }),
    }).then(refresh);
    return;
  }
  const ann = e.target.closest('input.sann');
  if (ann) {
    ann.blur();
    const body = { spec: Number(ann.dataset.spec) };
    // spec annotations group inside a PRD list entry or a kanban card
    (ann.closest('.entry') || ann.closest('.kcard')).querySelectorAll('input.sann[data-ann]').forEach((x) => {
      body[x.dataset.ann] = x.dataset.ann === 'deps'
        ? x.value.split(',').map((v) => v.trim()).filter(Boolean)
        : x.value;
    });
    fetch(new URL('api/specs/annotate', document.baseURI), {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(refresh);
    return;
  }
  const rs = e.target.closest('#range-select');
  if (rs) {
    rs.blur();
    if (rs.value) location.hash = hashFor({ range: rs.value });
    return;
  }
  const rw = e.target.closest('.rw');
  if (rw) {
    rw.blur();
    const cfg = {};
    document.querySelectorAll('.rw').forEach((x) => {
      cfg[x.dataset.rw] = x.dataset.rw === 'period' ? x.value : Number(x.value);
    });
    // the weekday select is absent in daily mode; the server keeps the stored value
    fetch(new URL('api/report-window', document.baseURI), {
      method: 'POST',
      body: JSON.stringify(cfg),
    }).then(refresh);
    return;
  }
  const sel = e.target.closest('select.feedback');
  if (!sel) return;
  sel.blur(); // release focus so the post-save refresh isn't suppressed
  // data-spec targets one spec; data-specs (session-level box) fans out to all of them
  const specs = sel.dataset.spec ? [sel.dataset.spec] : (sel.dataset.specs || '').split(',').filter(Boolean);
  Promise.all(specs.map((t) => fetch(new URL('api/specs/feedback', document.baseURI), {
    method: 'POST',
    body: JSON.stringify({ spec: Number(t), feedback: sel.value }),
  }))).then(refresh);
});

// Kanban drag-and-drop: cards carry data-kcard=<spec t>, columns carry data-lane=<status>
// ('complete' for the Complete column). Delegated so the handlers survive the 5s re-render.
let DRAG_SPEC = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-kcard]');
  if (!card) return;
  DRAG_SPEC = card.dataset.kcard;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', DRAG_SPEC); // Firefox requires data to be set
  card.classList.add('dragging');
});
document.addEventListener('dragend', (e) => {
  const card = e.target.closest('[data-kcard]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.kcol.drop').forEach((c) => c.classList.remove('drop'));
});
document.addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-lane]');
  if (!col || DRAG_SPEC === null) return;
  e.preventDefault(); // signals a valid drop target
  e.dataTransfer.dropEffect = 'move';
  col.classList.add('drop');
});
document.addEventListener('dragleave', (e) => {
  const col = e.target.closest('[data-lane]');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drop');
});
document.addEventListener('drop', (e) => {
  const col = e.target.closest('[data-lane]');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('drop');
  const spec = DRAG_SPEC || e.dataTransfer.getData('text/plain');
  DRAG_SPEC = null;
  if (!spec) return;
  // the target lane's key is the new status ('complete' for the Complete column)
  fetch(new URL('api/specs/annotate', document.baseURI), {
    method: 'POST',
    body: JSON.stringify({ spec: Number(spec), status: col.dataset.lane }),
  }).then(refresh);
});

const opt = (v, label, cur) =>
  '<option value="' + v + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + label + '</option>';

function windowConfigControls(cfg) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const tz = (o) => 'UTC' + (o >= 0 ? '+' : '') + o + (o === 0 ? ' (GMT)' : o === -5 ? ' (EST)' : o === -8 ? ' (PST)' : '');
  let offs = '';
  for (let o = -12; o <= 14; o++) offs += opt(o, tz(o), cfg.utcOffset);
  return '<span class="flabel">Window</span>' +
    '<select class="rw" data-rw="period">' + opt('daily', 'daily', cfg.period) + opt('weekly', 'weekly', cfg.period) + '</select>' +
    (cfg.period === 'weekly'
      ? '<select class="rw" data-rw="weekday">' + days.map((d, i) => opt(i, d, cfg.weekday)).join('') + '</select>'
      : '') +
    '<span class="flabel">at</span>' +
    '<select class="rw" data-rw="hour">' +
    Array.from({ length: 24 }, (_, h) => opt(h, String(h).padStart(2, '0') + ':00', cfg.hour)).join('') +
    '</select>' +
    '<select class="rw" data-rw="utcOffset">' + offs + '</select>' +
    '<span class="flabel">plan $/window</span>' +
    '<input class="rw" data-rw="costPerWindow" type="number" min="0" step="0.01" value="' + (cfg.costPerWindow || 0) + '">';
}

function filterRow() {
  const s = state();
  if (s.view === 'kanban') {
    const hidden = s.khide === '1';
    document.getElementById('filters').innerHTML =
      '<a class="pill" href="' + hashFor({ view: '' }) + '">← Session ' + esc(shortId(s.session)) + '</a>' +
      '<span class="flabel">Spec board</span>' +
      '<a class="pill' + (hidden ? ' active' : '') + '" href="' + hashFor({ khide: hidden ? '' : '1' }) + '">' +
      (hidden ? 'Show complete' : 'Hide complete') + '</a>';
    return;
  }
  if (s.view === 'prd') {
    document.getElementById('filters').innerHTML =
      '<a class="pill" href="' + hashFor({ view: '', pcomp: '', sctx: '', srepo: '', sspec: '', sprop: '' }) + '">← Dashboard</a>' +
      (s.pcomp
        ? '<a class="pill" href="' + hashFor({ pcomp: '' }) + '">← All components</a>' +
          '<span class="flabel">' + esc(s.pcomp) + '</span>'
        : '<span class="flabel">Product requirements & specs</span>');
    return;
  }
  const label = (w) => when(w.from) + ' → ' + when(w.to);
  // periods beyond current/last, offered only when they contain data
  const earlier = WIN.windows.slice(2).filter((w) => w.hasData);
  const periodSelect = earlier.length
    ? '<select class="pill' + (s.range[0] === 'p' ? ' active' : '') + '" id="range-select">' +
      opt('', 'earlier period…', s.range[0] === 'p' ? '' : s.range) +
      earlier.map((w) => opt('p' + w.from, label(w), s.range)).join('') + '</select>'
    : '';
  const sel = resolveRange(s.range, WIN.windows);
  const csv = sel && sel.hasData
    ? '<a class="back" style="margin-left:8px" href="api/report.csv?from=' + sel.from + '&to=' + sel.to + '" download>Download CSV</a>'
    : '';
  document.getElementById('filters').innerHTML =
    windowConfigControls(WIN.config) +
    '<span class="flabel" style="margin-left:16px">Range</span>' +
    RANGES.map((r) =>
      '<button class="pill' + (s.range === r.key ? ' active' : '') + '" data-range="' + r.key + '">' + r.label + '</button>').join('') +
    periodSelect + csv +
    (s.session ? '<span class="flabel" style="margin-left:16px">Session</span><span class="mono">' + esc(shortId(s.session)) + '</span>' : '') +
    '<a class="pill" style="margin-left:16px" href="' + hashFor({ view: 'prd' }) + '">PRD & specs →</a>';
  document.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => { location.hash = hashFor({ range: b.dataset.range }); }));
}

function netVsPlanTile() {
  const cfg = WIN.config;
  if (!cfg.costPerWindow) return null;
  const sel = resolveRange(state().range, WIN.windows);
  const wins = sel ? [sel] : WIN.windows.filter((w) => w.hasData);
  if (!wins.length) return null;
  const net = wins.reduce((a, w) => a + (w.cost || 0), 0) - cfg.costPerWindow * wins.length;
  return {
    label: 'Net vs plan',
    value: (net >= 0 ? '+' : '−') + usd(Math.abs(net)),
    sub: 'API − ' + usd(cfg.costPerWindow) + ' × ' + wins.length + ' window' + (wins.length === 1 ? '' : 's'),
  };
}

function tiles(d, session) {
  const t = session ?? d.totals;
  const items = [
    { label: session ? 'Cost' : 'Total cost', value: usd(t.cost) },
    ...(session ? [] : [netVsPlanTile()].filter(Boolean)),
    { label: session ? 'Tokens' : 'Total tokens', value: compact(sumTokens(t.tokens)) },
    session
      ? { label: 'Active time', value: duration(session.activeTimeSec || 0) }
      : { label: 'Sessions', value: d.sessionCount },
    { label: 'Prompts', value: num(t.prompts) },
    { label: 'Tool calls', value: num(totalCalls(t.toolCalls)) },
    { label: 'Lines changed', value: '+' + num(t.linesAdded), sub: '−' + num(t.linesRemoved) + ' removed' },
  ];
  return tileRow(items);
}

const tileRow = (items) => '<div class="tiles">' + items.map((i) =>
  '<div class="tile"><div class="label">' + esc(i.label) + '</div><div class="value">' + esc(i.value) + '</div>' +
  (i.sub ? '<div class="sub">' + esc(i.sub) + '</div>' : '') + '</div>').join('') + '</div>';

function lastDayCard(day) {
  if (!day) return '';
  const t = day.totals;
  const items = [
    { label: 'Sessions', value: num(day.sessionCount) },
    { label: 'Cost', value: usd(t.cost) },
    { label: 'Tokens', value: compact(sumTokens(t.tokens)) },
    { label: 'Prompts', value: num(t.prompts) },
    { label: 'Tool calls', value: num(totalCalls(t.toolCalls)) },
    { label: 'Specs · corrections · retros', value: day.specifications.length + ' · ' + day.corrections.length + ' · ' + day.retros.length },
  ];
  return card('Last 24 hours', tileRow(items));
}

function toolChart(toolCalls) {
  const rows = Object.entries(toolCalls).sort((a, b) => b[1].count - a[1].count).slice(0, 14);
  if (!rows.length) return '<div class="empty">No tool telemetry in this range — run /herbert:setup and restart Claude Code to enable OTel export.</div>';
  const max = rows[0][1].count;
  return rows.map(([name, tc]) =>
    '<div class="barrow"><div class="name" title="' + esc(name) + '">' + esc(name) + '</div>' +
    '<div class="track"><div class="bar" data-tip="' + esc(name + ': ' + num(tc.count) + ' calls' + (tc.errors ? ', ' + tc.errors + ' failed' : '')) +
    '" style="width:' + Math.max(1, (tc.count / max) * 100) + '%"></div>' +
    '<span class="val">' + num(tc.count) + (tc.errors ? ' <span style="color:var(--ink-muted)">(' + tc.errors + ' failed)</span>' : '') + '</span></div></div>').join('');
}

const tokenLegend = () => '<div class="legend">' + TOKEN_TYPES.map((t) =>
  '<span><span class="swatch" style="background:' + t.color + '"></span>' + t.label + '</span>').join('') + '</div>';

function tokenChartBySession(d) {
  const rows = d.sessions.filter((s) => sumTokens(s.tokens) > 0).slice(0, 12);
  if (!rows.length) return '<div class="empty">No token telemetry in this range.</div>';
  const max = Math.max(...rows.map((s) => sumTokens(s.tokens)));
  return tokenLegend() + rows.map((s) => {
    const total = sumTokens(s.tokens);
    const segs = TOKEN_TYPES.filter((t) => (s.tokens[t.key] || 0) > 0).map((t) =>
      '<div class="seg" data-tip="' + esc(shortId(s.sessionId) + ' · ' + t.label + ': ' + num(s.tokens[t.key])) +
      '" style="background:' + t.color + ';width:' + ((s.tokens[t.key] / max) * 100) + '%"></div>').join('');
    return '<div class="barrow"><div class="name mono" title="' + esc(s.sessionId) + '"><a href="' + hashFor({ session: s.sessionId }) + '">' + esc(shortId(s.sessionId)) + '</a></div>' +
      '<div class="track"><div class="stack" style="flex:0 1 ' + ((total / max) * 100) + '%">' + segs + '</div>' +
      '<span class="val">' + compact(total) + '</span></div></div>';
  }).join('');
}

function tokenChartByType(session) {
  const rows = TOKEN_TYPES.filter((t) => (session.tokens[t.key] || 0) > 0);
  if (!rows.length) return '<div class="empty">No token telemetry in this range.</div>';
  const max = Math.max(...rows.map((t) => session.tokens[t.key]));
  return rows.map((t) =>
    '<div class="barrow"><div class="name">' + t.label + '</div>' +
    '<div class="track"><div class="bar" style="background:' + t.color + ';width:' + Math.max(1, (session.tokens[t.key] / max) * 100) +
    '%" data-tip="' + esc(t.label + ': ' + num(session.tokens[t.key])) + '"></div>' +
    '<span class="val">' + compact(session.tokens[t.key]) + '</span></div></div>').join('');
}

function modelCostChart(costByModel) {
  const rows = Object.entries(costByModel || {}).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="empty">No cost telemetry in this range.</div>';
  const max = rows[0][1];
  return rows.map(([model, cost]) =>
    '<div class="barrow"><div class="name" title="' + esc(model) + '">' + esc(model) + '</div>' +
    '<div class="track"><div class="bar" data-tip="' + esc(model + ': ' + usd(cost)) +
    '" style="width:' + Math.max(1, (cost / max) * 100) + '%"></div>' +
    '<span class="val">' + usd(cost) + '</span></div></div>').join('');
}

function agentChart(agents) {
  const rows = (agents || []).slice().sort((a, b) => b.tokens - a.tokens);
  if (!rows.length) return '<div class="empty">No sub-agents ran in this session in this range.</div>';
  const max = rows[0].tokens || 1;
  return rows.map((a) => {
    const secs = Math.round((a.durationMs || 0) / 1000);
    const tip = a.type + ' · ' + num(a.tokens) + ' tok · ' + num(a.toolUses) + ' tools · ' +
      duration(secs) + (a.model ? ' · ' + a.model : '');
    return '<div class="barrow"><div class="name" title="' + esc(a.type) + '">' + esc(a.type) + '</div>' +
      '<div class="track"><div class="bar" data-tip="' + esc(tip) +
      '" style="width:' + Math.max(1, (a.tokens / max) * 100) + '%"></div>' +
      '<span class="val">' + compact(a.tokens) + '</span></div></div>';
  }).join('');
}

function sessionsTable(d) {
  if (!d.sessions.length) return '<div class="empty">No sessions in this range.</div>';
  const rows = d.sessions.map((s) =>
    '<tr class="clickable" data-session="' + esc(s.sessionId) + '">' +
    '<td class="mono" title="' + esc(s.sessionId) + '">' + esc(shortId(s.sessionId)) + '</td>' +
    '<td class="mono">' + esc((s.cwd || '—').split('/').pop() || s.cwd || '—') + '</td>' +
    '<td>' + esc(when(s.startedAt)) + '</td>' +
    '<td>' + (s.endedAt ? esc(when(s.endedAt)) : (s.startedAt ? 'active' : '—')) + '</td>' +
    '<td class="num">' + num(s.prompts) + '</td>' +
    '<td class="num">' + num(totalCalls(s.toolCalls)) + '</td>' +
    '<td class="num">' + compact(sumTokens(s.tokens)) + '</td>' +
    '<td class="num">' + usd(s.cost) + '</td></tr>').join('');
  return '<table><thead><tr><th>Session</th><th>Project</th><th>Started</th><th>Ended</th>' +
    '<th class="num">Prompts</th><th class="num">Tool calls</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function entryList(items, emptyMsg, linkSessions) {
  if (!items.length) return '<div class="empty">' + esc(emptyMsg) + '</div>';
  return items.slice().reverse().map((e) => {
    const sid = e.sessionId || 'unknown';
    const sessionRef = linkSessions && e.sessionId
      ? '<a href="' + hashFor({ session: e.sessionId }) + '">' + esc(shortId(sid)) + '</a>'
      : esc(shortId(sid));
    const sections = [['Worked', e.whatWorked], ["Didn't work", e.whatDidnt], ['Change next', e.changeNext]]
      .filter(([, v]) => v)
      .map(([k, v]) => '<div class="retro-sec"><span class="sec-label">' + k + ':</span> ' + esc(v) + '</div>').join('');
    const repo = e.repo ? ' · ' + esc(e.repo.split('/').pop() || e.repo) : '';
    const feedback = e.type === 'specification'
      ? ' · ' + feedbackSelect(e.feedback, 'data-spec="' + e.t + '"') +
        (e.status === 'proposed' ? ' <span class="badge">proposed</span>' : '')
      : '';
    const ctx = e.context ? '<span class="ctx">' + esc(e.context) + ':</span> ' : '';
    const revision = e.revision
      ? '<div class="retro-sec"><span class="sec-label">Pending revision:</span> ' + esc(e.revision) + '</div>'
      : '';
    const ann = e.type === 'specification'
      ? revision + '<div class="annrow">' +
        '<input class="sann" data-spec="' + e.t + '" data-ann="context" list="known-components" placeholder="component" value="' + esc(e.context || '') + '">' +
        '<input class="sann" data-spec="' + e.t + '" data-ann="deps" placeholder="deps (comma-separated components)" value="' + esc((e.deps || []).join(', ')) + '">' +
        '<input class="sann" data-spec="' + e.t + '" data-ann="revision" placeholder="revision comment (reopens spec)" value="' + esc(e.revision || '') + '">' +
        (e.status === 'proposed'
          ? '<button class="pill" data-impl="' + e.t + '">mark implemented</button>' +
            '<button class="pill" data-edit-spec="' + e.t + '" data-raw="' + esc(e.summary) + '">edit</button>' +
            '<button class="pill" data-remove-spec="' + e.t + '">remove</button>'
          : '') +
        '</div>'
      : '';
    return '<div class="entry"><div class="meta">' + esc(when(e.t)) + ' · session ' + sessionRef + repo + feedback + '</div>' +
      '<div class="esum">' + ctx + esc(e.summary) + '</div>' + sections + ann + '</div>';
  }).join('');
}

const card = (title, body) => '<div class="card"><h2>' + esc(title) + '</h2>' + body + '</div>';

// minimal markdown: headings, lists, paragraphs, bold/italic/inline code (input is escaped first)
// backticks are written as \\u0060 escapes so they survive inside the page template literal
const mdInline = (s) => s
  .replace(/\u0060([^\u0060]+)\u0060/g, '<code>$1</code>')
  .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
  .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
function renderMd(src) {
  const out = [];
  let list = false, para = [];
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  const flush = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; } };
  for (const line of esc(src).split('\\n')) {
    const h = line.match(/^(#{1,4})\\s+(.*)/);
    if (h) { flush(); closeList(); const lv = h[1].length + 2; out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>'); continue; }
    if (/^[-*]\\s+/.test(line)) { flush(); if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + mdInline(line.replace(/^[-*]\\s+/, '')) + '</li>'); continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    para.push(line);
  }
  flush(); closeList();
  return '<div class="mdview">' + out.join('') + '</div>';
}

let REPO_HINT = ''; // most common repo among visible specs; attached to user-proposed specs

// user-authored, not-yet-implemented spec; component fixed (drill-down) or free input (root)
function proposeForm(component, opts) {
  const o = opts || {};
  // on the kanban board the new spec is tied to the board's session + repo
  const scope = (o.session ? ' data-session="' + esc(o.session) + '"' : '') +
    (o.cwd ? ' data-cwd="' + esc(o.cwd) + '"' : '');
  return '<div class="propose">' +
    (component === null
      ? '<input class="sann" id="prop-comp" list="known-components" placeholder="component">'
      : '') +
    '<input class="sann prop-sum" placeholder="Propose a spec (not yet implemented)…">' +
    '<button class="pill" data-propose' + (component === null ? '' : '="' + esc(component) + '"') + scope + '>Add proposed spec</button></div>';
}

function prdDoc(component, doc, placeholder) {
  const raw = doc ? doc.md : '';
  return '<div class="prd-doc" data-component="' + esc(component) + '">' +
    (raw ? renderMd(raw) : '<div class="empty">' + esc(placeholder) + '</div>') +
    '<div class="editor" hidden><textarea>' + esc(raw) + '</textarea>' +
    '<div style="margin-top:8px"><button class="pill" data-save>Save</button> <button class="pill" data-cancel>Cancel</button></div></div>' +
    '<button class="pill" data-edit style="margin-top:8px">Edit</button></div>';
}

// Repo scope selector for the PRD page; '' value is the unassigned bucket for legacy docs.
function prdRepoPicker(repos, current) {
  const list = repos.includes(current) ? repos : [current, ...repos];
  const opts = list.map((r) =>
    '<option value="' + esc(r) + '"' + (r === current ? ' selected' : '') + '>' +
    esc(r ? repoNameOf(r) : '(unassigned)') + '</option>').join('');
  return '<span class="flabel">Repo</span><select class="pill" id="prd-repo">' + opts + '</select>';
}

function renderPrd(d, prd, s) {
  REPO_HINT = s.srepo; // specs proposed on this page belong to the repo being viewed
  const repoPicker = prdRepoPicker(prd.repos || [], s.srepo);
  // the PRD is scoped to one repo: only that repo's specs feed the components table and map
  const repoSpecs = d.specifications.filter((e) => (e.repo || 'unknown') === s.srepo);
  if (s.pcomp) {
    const specs = repoSpecs.filter((e) => (e.context || 'general') === s.pcomp);
    document.getElementById('main').innerHTML =
      '<div class="filters" style="margin-top:16px">' + repoPicker + '</div>' +
      card('Requirements — ' + s.pcomp,
        prdDoc(s.pcomp, prd.components[s.pcomp], 'No requirements written for this component yet — click Edit.')) +
      specGraphCard(specs, s) +
      card('Specifications (' + specs.length + ')',
        entryList(specs, 'No specifications logged for this component.', true) + proposeForm(s.pcomp)) +
      knownComponents(d.specifications);
    bindSpecMap();
    bindPrdRepo();
  } else {
    const filtered = filterSpecs(d.specifications, s);
    const comps = new Map();
    repoSpecs.forEach((e) => { const c = e.context || 'general'; comps.set(c, (comps.get(c) || 0) + 1); });
    Object.keys(prd.components).forEach((c) => { if (!comps.has(c)) comps.set(c, 0); });
    const rows = [...comps.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) =>
      '<tr class="clickable" data-pcomp="' + esc(c) + '"><td>' + esc(c) + '</td>' +
      '<td class="num">' + n + '</td>' +
      '<td>' + (prd.components[c] ? 'written' : '—') + '</td></tr>').join('');
    document.getElementById('main').innerHTML =
      '<div class="filters" style="margin-top:16px">' +
        repoPicker +
        '<a class="pill" href="api/prd/export?repo=' + encodeURIComponent(s.srepo) + '" download="herbert.json">Export herbert.json</a>' +
        '<label class="pill" style="cursor:pointer">Import herbert.json<input type="file" id="prd-import" accept=".json,application/json" hidden></label>' +
        '<span class="flabel">commit herbert.json to the repo to share the PRD</span>' +
      '</div>' +
      card('Product summary', prdDoc('', prd.summary, 'No product summary yet — click Edit to add one.')) +
      card('Components', comps.size
        ? '<table><thead><tr><th>Component</th><th class="num">Specs</th><th>Requirements</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty">No components yet — they come from spec classifications.</div>') +
      specGraphCard(filtered, s) +
      specsSection(d, filtered, s) +
      knownComponents(d.specifications);
    document.querySelectorAll('tr[data-pcomp]').forEach((tr) =>
      tr.addEventListener('click', () => { location.hash = hashFor({ pcomp: tr.dataset.pcomp }); }));
    bindSpecMap();
    bindSpecsSection(s);
    bindPrdRepo();
    const imp = document.getElementById('prd-import');
    imp.addEventListener('change', () => {
      const f = imp.files[0];
      if (!f) return;
      imp.blur(); // release focus so the post-import refresh isn't suppressed
      f.text()
        // file the imported PRD under the repo currently in view
        .then((raw) => JSON.stringify({ ...JSON.parse(raw), repo: s.srepo }))
        .then((body) => fetch(new URL('api/prd/import', document.baseURI), { method: 'POST', body }))
        .then(refresh);
    });
  }
  document.querySelectorAll('.prd-doc').forEach((box) => {
    const editor = box.querySelector('.editor');
    const editBtn = box.querySelector('[data-edit]');
    editBtn.addEventListener('click', () => { editor.hidden = false; editBtn.hidden = true; });
    box.querySelector('[data-cancel]').addEventListener('click', () => { editor.hidden = true; editBtn.hidden = false; });
    box.querySelector('[data-save]').addEventListener('click', () => {
      editor.hidden = true; // close first so the refresh guard doesn't block the re-render
      fetch(new URL('api/prd', document.baseURI), {
        method: 'POST',
        body: JSON.stringify({ repo: s.srepo, component: box.dataset.component, md: editor.querySelector('textarea').value }),
      }).then(refresh);
    });
  });
}

// The repo scope selector re-scopes the whole PRD page, clearing any component/spec drill-down.
function bindPrdRepo() {
  const sel = document.getElementById('prd-repo');
  if (sel) sel.addEventListener('change', () => {
    sel.blur(); // release focus so the hashchange refresh isn't suppressed by the activeElement guard
    location.hash = hashFor({ srepo: sel.value, pcomp: '', sctx: '', sspec: '' });
  });
}

// Left-to-right containment DAG: repo → component (spec context) → specification.
// Nodes double as filters for the Specifications card (state in the hash).
function specGraphCard(specs, s) {
  if (!specs.length) return '';
  const tree = new Map(); // repo (full path) → (component → specs), in logged order
  specs.forEach((e) => {
    const r = e.repo || 'unknown';
    const c = e.context || 'general';
    if (!tree.has(r)) tree.set(r, new Map());
    const comps = tree.get(r);
    if (!comps.has(c)) comps.set(c, []);
    comps.get(c).push(e);
  });
  const showSpecs = s.mspecs !== '0';
  const showDeps = s.mdeps !== '0';
  const ROW = 26, NH = 20;
  const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const mid = (ys) => ys.reduce((a, b) => a + b, 0) / ys.length;
  const nodes = [], paths = [];
  const specYByT = new Map(), compYByName = new Map();
  let y = 2;
  for (const [r, comps] of tree) {
    const compYs = [];
    for (const [c, list] of comps) {
      let cy;
      if (showSpecs) {
        const specYs = [];
        for (const e of list) {
          specYs.push(y);
          specYByT.set(e.t, y);
          nodes.push({
            x: 380, w: 368, y, label: trunc(e.summary, 56), tip: e.summary,
            data: 'data-sspec="' + e.t + '"', active: s.sspec === String(e.t),
            level: e.status === 'proposed' ? ' gproposed' : '',
          });
          y += ROW;
        }
        cy = mid(specYs);
        specYs.forEach((sy) => paths.push([340, cy + NH / 2, 380, sy + NH / 2]));
      } else {
        cy = y;
        y += ROW;
      }
      compYs.push(cy);
      if (!compYByName.has(c)) compYByName.set(c, cy);
      nodes.push({
        x: 190, w: 150, y: cy, label: trunc(c, 20), tip: c + ' (' + list.length + ' spec' + (list.length === 1 ? '' : 's') + ')',
        data: 'data-srepo="' + esc(r) + '" data-sctx="' + esc(c) + '"',
        active: !s.sspec && s.srepo === r && s.sctx === c, level: '',
      });
    }
    const ry = mid(compYs);
    nodes.push({
      x: 0, w: 150, y: ry, label: trunc(repoNameOf(r), 20), tip: r,
      data: 'data-srepo="' + esc(r) + '"',
      active: !s.sspec && s.srepo === r && !s.sctx, level: ' glevel',
    });
    compYs.forEach((cy) => paths.push([150, ry + NH / 2, 190, cy + NH / 2]));
  }
  // dep targets outside the filtered set still get dimmed nodes so their edges can draw
  if (showDeps) {
    const externals = new Set();
    specs.forEach((e) => (e.deps || []).forEach((dep) => {
      if (!compYByName.has(dep) && dep !== (e.context || 'general')) externals.add(dep);
    }));
    for (const c of externals) {
      compYByName.set(c, y);
      nodes.push({
        x: 190, w: 150, y, label: trunc(c, 20), tip: c + ' (dependency)',
        data: 'data-sctx="' + esc(c) + '"', active: false, level: ' gext',
      });
      y += ROW;
    }
  }
  const edgeSvg = paths.map((p) =>
    '<path d="M' + p[0] + ' ' + p[1] + ' C ' + (p[0] + 25) + ' ' + p[1] + ', ' + (p[2] - 25) + ' ' + p[3] + ', ' + p[2] + ' ' + p[3] + '"/>').join('');
  // dashed dependency edges: spec → component when specs are shown,
  // aggregated component → component arcs when they're hidden
  let depSvg = '';
  if (showDeps && showSpecs) {
    depSvg = specs.flatMap((e) => (e.deps || []).map((dep) => {
      const sy = specYByT.get(e.t), cy = compYByName.get(dep);
      if (sy === undefined || cy === undefined || dep === (e.context || 'general')) return '';
      return '<path d="M380 ' + (sy + NH / 2) + ' C 350 ' + (sy + NH / 2) + ', 370 ' + (cy + NH / 2) + ', 340 ' + (cy + NH / 2) + '"/>';
    })).join('');
  } else if (showDeps) {
    const pairs = new Set();
    specs.forEach((e) => (e.deps || []).forEach((dep) => {
      const from = e.context || 'general';
      if (dep !== from && compYByName.has(from) && compYByName.has(dep)) pairs.add(from + '|' + dep);
    }));
    depSvg = [...pairs].map((pair) => {
      const [a, b] = pair.split('|');
      const y1 = compYByName.get(a) + NH / 2, y2 = compYByName.get(b) + NH / 2;
      return '<path d="M340 ' + y1 + ' C 400 ' + y1 + ', 400 ' + y2 + ', 340 ' + y2 + '"/>';
    }).join('');
  }
  const nodeSvg = nodes.map((n) =>
    '<g class="gnode' + (n.active ? ' gactive' : '') + n.level + '" ' + n.data + ' data-tip="' + esc(n.tip) + '">' +
    '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + NH + '" rx="5"></rect>' +
    '<text x="' + (n.x + 8) + '" y="' + (n.y + 14) + '">' + esc(n.label) + '</text></g>').join('');
  const H = y + 2;
  const toggles = '<div class="filters" style="margin-top:0;margin-bottom:8px">' +
    '<span class="flabel">Show</span>' +
    '<button class="pill' + (showSpecs ? ' active' : '') + '" data-mtoggle="mspecs">specs</button>' +
    '<button class="pill' + (showDeps ? ' active' : '') + '" data-mtoggle="mdeps">deps</button>' +
    '<span class="legend" style="margin:0 0 0 12px">' +
    '<span><span class="edge-solid"></span>contains</span>' +
    '<span><span class="edge-dashed"></span>depends</span></span></div>';
  return card('Specification map (click a node to filter)',
    toggles +
    '<div class="scroll"><svg class="specdag" viewBox="0 0 750 ' + H + '" width="750" height="' + H + '">' +
    '<g class="gedges">' + edgeSvg + '</g><g class="gdeps">' + depSvg + '</g>' + nodeSvg + '</svg></div>');
}

// per-window difference between tracked standard-API cost and what the user pays
function costVsPlanCard() {
  const cfg = WIN.config;
  if (!cfg.costPerWindow) return '';
  const rows = WIN.windows.filter((w) => w.hasData).map((w) => {
    const diff = w.cost - cfg.costPerWindow;
    return '<tr><td>' + esc(when(w.from) + ' → ' + when(w.to)) + '</td>' +
      '<td class="num">' + usd(w.cost) + '</td>' +
      '<td class="num">' + (diff >= 0 ? '+' : '−') + usd(Math.abs(diff)) + '</td></tr>';
  }).join('');
  if (!rows) return '';
  return card('API cost vs plan (' + usd(cfg.costPerWindow) + ' per window)',
    '<table><thead><tr><th>Window</th><th class="num">API cost</th><th class="num">Difference</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>');
}

function renderOverall(d, day) {
  document.getElementById('main').innerHTML =
    card('Sessions', '<div class="scroll">' + sessionsTable(d) + '</div>') +
    tiles(d) +
    lastDayCard(day) +
    card('Tool usage (all sessions)', toolChart(d.totals.toolCalls)) +
    card('Cost by model (all sessions)', modelCostChart(d.totals.costByModel)) +
    costVsPlanCard() +
    card('Tokens by session', tokenChartBySession(d)) +
    card('Corrections', entryList(d.corrections, 'No corrections logged in this range.', true)) +
    card('Retros', entryList(d.retros, 'No retros saved in this range.', true));
  document.querySelectorAll('tr[data-session]').forEach((tr) =>
    tr.addEventListener('click', () => { location.hash = hashFor({ session: tr.dataset.session }); }));
}

// spec map nodes filter the PRD page: components drill down, repos/specs filter the list
function bindSpecMap() {
  document.querySelectorAll('.specdag .gnode').forEach((g) =>
    g.addEventListener('click', () => {
      const patch = g.dataset.sspec
        ? { pcomp: '', sspec: g.dataset.sspec, srepo: '', sctx: '' }
        : g.dataset.sctx
          ? { pcomp: g.dataset.sctx, sspec: '', srepo: '', sctx: '' }
          : { pcomp: '', sspec: '', sctx: '', srepo: g.dataset.srepo };
      location.hash = hashFor({ view: 'prd', ...patch });
    }));
  document.querySelectorAll('[data-mtoggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const patch = {};
      patch[b.dataset.mtoggle] = state()[b.dataset.mtoggle] === '0' ? '' : '0';
      location.hash = hashFor(patch);
    }));
}

// the active spec filters, applied identically to the map and the list
function filterSpecs(specs, s) {
  let out = specs;
  if (s.sspec) out = out.filter((e) => String(e.t) === s.sspec);
  else {
    if (s.srepo) out = out.filter((e) => (e.repo || 'unknown') === s.srepo);
    if (s.sctx) out = out.filter((e) => (e.context || 'general') === s.sctx);
  }
  if (s.sprop) out = out.filter((e) => e.status === 'proposed');
  return out;
}

// filterable specifications section of the PRD page (specs arrive pre-filtered)
function specsSection(d, specs, s) {
  const comps = [...new Set(d.specifications.map((e) => e.context || 'general'))].sort();
  const controls = '<div class="filters" style="margin-top:0;margin-bottom:8px">' +
    '<span class="flabel">Component</span>' +
    '<select class="pill" id="spec-comp-filter"><option value="">all</option>' +
    comps.map((c) => opt(c, c, s.sctx)).join('') + '</select>' +
    '<button class="pill' + (s.sprop ? ' active' : '') + '" id="spec-prop-filter">proposed only</button>' +
    (s.sspec ? '<a class="pill" href="' + hashFor({ sspec: '' }) + '">clear spec filter</a>' : '') +
    '</div>';
  return card('Specifications (' + specs.length + ')',
    controls +
    entryList(specs, s.sprop ? 'No proposed specs match this filter.' : 'No specifications match this filter.', true) +
    proposeForm(s.sctx || null));
}

function bindSpecsSection(s) {
  document.getElementById('spec-comp-filter').addEventListener('change', (ev) => {
    ev.target.blur(); // release focus so the hashchange refresh isn't suppressed
    location.hash = hashFor({ sctx: ev.target.value, sspec: '' });
  });
  document.getElementById('spec-prop-filter').addEventListener('click', () => {
    location.hash = hashFor({ sprop: s.sprop ? '' : '1', sspec: '' });
  });
}

const KANBAN_LANES = [
  { key: 'proposed', label: 'Proposed' },
  { key: 'ready', label: 'Ready to pick up' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
];

function kanbanCard(e) {
  return '<div class="kcard" draggable="true" data-kcard="' + e.t + '">' +
    (e.context ? '<div class="kctx">' + esc(e.context) + '</div>' : '') +
    '<div class="ksum">' + esc(e.summary) + '</div>' +
    (e.revision ? '<div class="krev">Pending revision: ' + esc(e.revision) + '</div>' : '') +
    '<input class="sann" data-spec="' + e.t + '" data-ann="revision" placeholder="revision (reopens spec)" value="' + esc(e.revision || '') + '">' +
    '</div>';
}

// Single-session spec board: columns are lifecycle statuses, cards drag between them.
function renderKanban(d, sid, s) {
  const specs = d.specifications;
  const cwd = (d.sessions.find((x) => x.sessionId === sid) || {}).cwd || '';
  const lanes = KANBAN_LANES.filter((l) => !(s.khide === '1' && l.key === 'complete'));
  const board = lanes.map((l) => {
    const items = specs.filter((e) => (e.status || 'complete') === l.key);
    // the Proposed column carries an "add" form; new specs are tied to this session + repo
    const add = l.key === 'proposed' ? proposeForm(null, { session: sid, cwd }) : '';
    return '<div class="kcol" data-lane="' + l.key + '">' +
      '<div class="kcolhead"><span>' + esc(l.label) + '</span><span class="kcount">' + items.length + '</span></div>' +
      '<div class="kcards">' + (items.map(kanbanCard).join('') || '<div class="kempty">drop here</div>') + '</div>' +
      add + '</div>';
  }).join('');
  const empty = specs.length ? '' : '<div class="empty">No specifications for this session yet.</div>';
  document.getElementById('main').innerHTML =
    '<div class="kboard">' + board + '</div>' + empty + knownComponents(specs);
}

function renderSession(d, sid) {
  const s = d.sessions.find((x) => x.sessionId === sid) ??
    { sessionId: sid, tokens: {}, toolCalls: {}, agents: [], cost: 0, prompts: 0, linesAdded: 0, linesRemoved: 0, activeTimeSec: 0 };
  const specs = d.specifications;
  const common = specs.length && specs.every((x) => x.feedback === specs[0].feedback)
    ? (specs[0].feedback || '') : '';
  const sessionFeedback = specs.length
    ? '<div class="meta-line"><span class="flabel">Feedback on all ' + specs.length + ' specification' + (specs.length === 1 ? '' : 's') + '</span>' +
      feedbackSelect(common, 'data-specs="' + specs.map((x) => x.t).join(',') + '"') + '</div>'
    : '';
  // per-session preview URL: read-only link; the URL is set by the agent via the set_preview_url MCP tool
  const previewRow =
    '<div class="meta-line"><span class="flabel">Preview</span>' +
    (s.previewUrl
      ? '<a class="pill" href="' + esc(s.previewUrl) + '" target="_blank" rel="noopener">Open ↗</a>' +
        '<span class="mono">' + esc(s.previewUrl) + '</span>'
      : '<span class="flabel">set via the set_preview_url MCP tool</span>') +
    '</div>';
  const meta =
    '<div class="meta-line"><a class="back" href="' + hashFor({ session: '' }) + '">← All sessions</a>' +
    '<a class="pill" href="' + hashFor({ view: 'kanban' }) + '">Spec board →</a></div>' +
    '<div class="meta-line"><span class="mono">' + esc(s.sessionId) + '</span>' +
    (s.cwd ? '<span class="mono">' + esc(s.cwd) + '</span>' : '') +
    esc(when(s.startedAt)) + ' → ' + (s.endedAt ? esc(when(s.endedAt)) : 'active') +
    (s.source ? ' · ' + esc(s.source) : '') + '</div>' +
    previewRow +
    sessionFeedback;
  document.getElementById('main').innerHTML =
    meta +
    tiles(d, s) +
    card('Tool usage', toolChart(s.toolCalls)) +
    card('Tokens by type', tokenChartByType(s)) +
    card('Cost by model', modelCostChart(s.costByModel)) +
    card('Sub-agents', agentChart(s.agents)) +
    card('Specifications', entryList(d.specifications, 'No specifications logged for this session in this range.', false)) +
    card('Corrections', entryList(d.corrections, 'No corrections logged for this session in this range.', false)) +
    card('Retros', entryList(d.retros, 'No retros saved for this session in this range.', false)) +
    knownComponents(d.specifications);
}

async function refresh() {
  // don't re-render out from under an open dropdown, a half-typed input, or an open PRD editor
  if (document.activeElement && document.activeElement.matches('select, input, textarea')) return;
  if (document.querySelector('.editor:not([hidden])')) return;
  const s = state();
  try {
    // relative to the page URL so the dashboard works behind any vhost/path proxy
    WIN = await fetch(new URL('api/report-window', document.baseURI)).then((r) => r.json());
    // server restarted since this page loaded → pick up the new UI code
    if (SERVER_PID && WIN.pid && WIN.pid !== SERVER_PID) { location.reload(); return; }
    SERVER_PID = WIN.pid || 0;
    filterRow();
    const params = new URLSearchParams();
    const sel = resolveRange(s.range, WIN.windows);
    if (sel) {
      params.set('from', String(sel.from));
      params.set('to', String(sel.to));
    }
    if (s.session) params.set('session', s.session);
    const get = (q) => fetch(new URL('api/summary?' + q, document.baseURI)).then((r) => r.json());
    if (s.view === 'kanban') {
      if (!s.session) { location.hash = hashFor({ view: '' }); return; } // the board needs a session
      // all-time, session-scoped: the board tracks every spec of the session regardless of range
      const d = await get('session=' + encodeURIComponent(s.session));
      document.getElementById('updated').textContent = 'updated ' + new Date(d.generatedAt).toLocaleTimeString();
      renderKanban(d, s.session, s);
      return;
    }
    if (s.view === 'prd') {
      const d = await get(new URLSearchParams()); // the PRD always reflects all specs, not the range filter
      // scope to one repo: the explicit picker choice, else the repo of the session you clicked in
      // from (the active repo), else the most recently active session's repo, else the busiest
      const sessionRepo = s.session ? (d.sessions.find((x) => x.sessionId === s.session) || {}).cwd || '' : '';
      const recentRepo = (d.sessions.find((x) => x.cwd) || {}).cwd || '';
      const counts = {};
      d.specifications.forEach((e) => { const r = e.repo || ''; if (r) counts[r] = (counts[r] || 0) + 1; });
      const busiest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const repo = s.srepo || sessionRepo || recentRepo || busiest;
      const prd = await fetch(new URL('api/prd?repo=' + encodeURIComponent(repo), document.baseURI)).then((r) => r.json());
      document.getElementById('updated').textContent = 'updated ' + new Date(d.generatedAt).toLocaleTimeString();
      // pass the resolved repo so docs, specs, and the components table all scope to it
      renderPrd(d, prd, { ...s, srepo: repo });
      return;
    }
    const [d, day] = await Promise.all([get(params), s.session ? null : get('from=' + (Date.now() - 864e5))]);
    document.getElementById('updated').textContent = 'updated ' + new Date(d.generatedAt).toLocaleTimeString();
    if (s.session) renderSession(d, s.session);
    else renderOverall(d, day);
  } catch (e) {
    document.getElementById('updated').textContent = 'refresh failed';
  }
}
window.addEventListener('hashchange', refresh);
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
