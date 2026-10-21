'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clamp01 = x => Math.max(0, Math.min(1, x || 0));
const pct = it => Math.round(clamp01(it.progress) * 100);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const IDLE_MS = 3 * 60 * 1000; // stop the clock after 3 min with no scrolling / typing / mouse

function fmt12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
function fmtDur(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtMin(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min' : ''}`.trim();
}
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const scripts = {};
function loadScript(src) {
  return scripts[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = () => { delete scripts[src]; rej(new Error('Could not load ' + src + ' — are you online?')); };
    document.head.append(s);
  });
}
async function loadPdfjs() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return window.pdfjsLib;
}
async function loadMammoth() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
  return window.mammoth;
}
let ytReady;
function loadYT() {
  if (window.YT?.Player) return Promise.resolve();
  return ytReady ||= new Promise(res => {
    window.onYouTubeIframeAPIReady = res;
    loadScript('https://www.youtube.com/iframe_api').catch(() => { ytReady = null; });
  });
}

/* ---------- storage (IndexedDB: items + uploaded files) ---------- */
const db = {
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('study-desk', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('items', { keyPath: 'id' });
        r.result.createObjectStore('files', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  },
  all: (s) => db.tx(s, 'readonly', st => st.getAll()),
  get: (s, id) => db.tx(s, 'readonly', st => st.get(id)),
  put: (s, v) => db.tx(s, 'readwrite', st => st.put(v)),
  del: (s, id) => db.tx(s, 'readwrite', st => st.delete(id)),
};

let items = [];
const save = it => db.put('items', it).catch(e => console.error('save failed', e));
function normalize(it) {
  it.hist ||= {};
  it.progress ||= 0; it.pos ||= 0; it.total ||= 0; it.timeSpent ||= 0;
  return it;
}
function todayHist(it) {
  return it.hist[dayKey()] ||= { s: 0, p0: it.progress, p1: it.progress };
}

const TYPES = {
  pdf: { label: 'PDF', accept: '.pdf,application/pdf' },
  youtube: { label: 'YT' },
  html: { label: 'HTML', accept: '.html,.htm,text/html' },
  docx: { label: 'DOC', accept: '.docx' },
  web: { label: 'WEB' },
};

/* ---------- scheduling ---------- */
// Unfinished items keep showing up on their study days until they reach 100%.
function scheduledOn(it, day) {
  const s = it.schedule;
  if (!s || s.start > day) return false;
  if (it.done) return it.doneOn === day;
  const dow = new Date(day + 'T00:00').getDay();
  if (s.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (s.repeat === 'once') return true; // its day, then overdue until finished
  return true;
}
function scheduleText(it) {
  const s = it.schedule;
  if (!s) return 'Not scheduled';
  const when = fmt12(s.time);
  if (s.repeat === 'once') return `${s.start === dayKey() ? 'Today' : s.start} · ${when}`;
  return `${s.repeat === 'weekdays' ? 'Mon–Fri' : 'Daily'} · ${when}`;
}
function posText(it) {
  if (it.done) return 'Finished';
  switch (it.type) {
    case 'youtube': return it.total ? `${it.pos > 0 ? 'Resume at ' + fmtDur(it.pos) : 'Starts at 0:00'} / ${fmtDur(it.total)}` : 'Not started';
    case 'pdf': return it.total ? `Page ${Math.max(1, it.pos)} of ${it.total}` : 'Not started';
    default: return it.timeSpent ? `${fmtMin(it.timeSpent)} spent` : 'Not started';
  }
}

/* ---------- views ---------- */
let tab = 'today', libFilter = 'all';

function card(it, { time } = {}) {
  const t = dayKey();
  const h = it.hist[t];
  const gain = h ? Math.round((h.p1 - h.p0) * 100) : 0;
  let timeCol = '', status = '';
  if (time && it.schedule) {
    const due = !it.done && it.schedule.time <= hm() && !(h?.s >= 60);
    const overdue = it.schedule.repeat === 'once' && it.schedule.start < t;
    timeCol = `<div class="time${due ? ' due' : ''}">${fmt12(it.schedule.time).replace(' ', '<small>')}</small></div>`;
    status = it.done ? 'Finished today 🎉'
      : h?.s >= 60 ? `Studied ${fmtMin(h.s)} today`
      : overdue ? 'Overdue'
      : due ? 'Due now' : 'Upcoming';
  } else {
    status = it.done ? `Finished${it.doneOn ? ' ' + it.doneOn : ''}` : scheduleText(it);
  }
  return `<article class="card${it.done ? ' done' : ''}" data-id="${it.id}">
    ${timeCol}
    <div class="main" data-act="open">
      <div class="ttl"><span class="tag ${it.type}">${TYPES[it.type].label}</span><span class="t">${esc(it.title)}</span></div>
      <div class="bar"><i style="width:${pct(it)}%"></i></div>
      <div class="meta"><span><b>${pct(it)}%</b> · ${esc(posText(it))}</span><span>${esc(status)}${gain > 0 ? ` · <span class="gain">+${gain}% today</span>` : ''}</span></div>
    </div>
    <div class="acts">
      <button class="btn primary sm" data-act="open">${it.done ? 'Open' : it.progress > 0 || it.pos > 0 ? 'Continue' : 'Start'}</button>
      <button class="iconbtn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button>
    </div>
  </article>`;
}

function dayTotals() {
  const m = {};
  for (const it of items) for (const [d, h] of Object.entries(it.hist)) m[d] = (m[d] || 0) + (h.s || 0);
  return m;
}
function streak(totals) {
  const d = new Date();
  if (!(totals[dayKey(d)] >= 60)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (totals[dayKey(d)] >= 60) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderToday() {
  const t = dayKey();
  const plan = items.filter(it => scheduledOn(it, t)).sort((a, b) => a.schedule.time.localeCompare(b.schedule.time));
  const others = items.filter(it => !it.done && !plan.includes(it) && (it.progress > 0 || it.timeSpent > 0))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0)).slice(0, 6);
  const totals = dayTotals();
  const touched = plan.filter(it => it.hist[t]?.s >= 60 || it.done).length;
  const st = streak(totals);
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  let html = `<div class="dayhead"><h2>${esc(date)}</h2>
    <p>${plan.length ? `${touched} of ${plan.length} planned tasks done today · ` : ''}${fmtMin(totals[t] || 0)} studied${st ? ` · 🔥 ${st}-day streak` : ''}</p></div>`;
  if (!items.length) {
    html += `<div class="empty"><b>Your study desk is empty</b>Add a PDF, YouTube video, HTML file, Word file or any webpage,
      pick a time like 5:00 PM, and it will show up here every day — opening right where you stopped.
      <br><button class="btn primary" data-act="add">+ Add study material</button></div>`;
  } else if (!plan.length) {
    html += `<div class="empty"><b>Nothing scheduled for today</b>Use ⋯ → Edit on an item in the Library to give it a study time.</div>`;
  } else {
    html += `<div class="list">${plan.map(it => card(it, { time: true })).join('')}</div>`;
  }
  if (others.length) html += `<div class="sec">Continue where you left off</div><div class="list">${others.map(it => card(it)).join('')}</div>`;
  $('#view-today').innerHTML = html;
}

function renderLibrary() {
  const counts = { all: items.length };
  items.forEach(it => counts[it.type] = (counts[it.type] || 0) + 1);
  const filters = [['all', 'All'], ['pdf', 'PDF'], ['youtube', 'YouTube'], ['html', 'HTML'], ['docx', 'Word'], ['web', 'Webpages']]
    .filter(([k]) => k === 'all' || counts[k]);
  const list = items.filter(it => libFilter === 'all' || it.type === libFilter)
    .sort((a, b) => (a.done - b.done) || ((b.lastOpened || b.createdAt) - (a.lastOpened || a.createdAt)));
  $('#view-library').innerHTML = `
    <div class="filters">${filters.map(([k, l]) => `<button data-filter="${k}" class="${libFilter === k ? 'on' : ''}">${l} ${counts[k] || 0}</button>`).join('')}</div>
    ${list.length ? `<div class="list">${list.map(it => card(it)).join('')}</div>`
      : `<div class="empty"><b>No items yet</b>Tap + Add, or drag a PDF / HTML / Word file onto this page.<br><button class="btn primary" data-act="add">+ Add study material</button></div>`}`;
}

function renderStats() {
  const totals = dayTotals();
  const t = dayKey();
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const week = days.slice(-7).reduce((s, d) => s + (totals[dayKey(d)] || 0), 0);
  const max = Math.max(600, ...days.map(d => totals[dayKey(d)] || 0));
  const top = [...items].sort((a, b) => b.timeSpent - a.timeSpent).filter(it => it.timeSpent > 0).slice(0, 10);
  $('#view-stats').innerHTML = `
    <div class="tiles">
      <div class="tile"><b>${fmtMin(totals[t] || 0)}</b><span>Today</span></div>
      <div class="tile"><b>${fmtMin(week)}</b><span>Last 7 days</span></div>
      <div class="tile"><b>${streak(totals)} 🔥</b><span>Day streak</span></div>
      <div class="tile"><b>${items.filter(i => i.done).length} / ${items.length}</b><span>Finished</span></div>
    </div>
    <div class="sec">Minutes studied · last 14 days</div>
    <div class="chart">${days.map(d => {
      const k = dayKey(d), s = totals[k] || 0;
      return `<div class="col${k === t ? ' today' : ''}" title="${k}: ${fmtMin(s)}"><em>${s >= 60 ? Math.round(s / 60) : ''}</em><i style="height:${Math.round(s / max * 100)}%"></i><small>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</small></div>`;
    }).join('')}</div>
    <div class="sec">Time per item</div>
    ${top.length ? `<div class="rows">${top.map(it => `<div class="r"><span class="tag ${it.type}">${TYPES[it.type].label}</span><span class="t">${esc(it.title)}</span><span class="v">${fmtMin(it.timeSpent)} · ${pct(it)}%</span></div>`).join('')}</div>`
      : `<div class="empty">Open something from Today or Library — your study time shows up here.</div>`}`;
}

function render() {
  if (tab === 'today') renderToday();
  else if (tab === 'library') renderLibrary();
  else renderStats();
}
function setTab(t) {
  tab = t;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['today', 'library', 'stats'].forEach(k => $('#view-' + k).classList.toggle('hidden', k !== t));
  render();
}

/* ---------- add / edit dialog ---------- */
const dlg = $('#itemDlg');
let dlgType = 'pdf', editing = null;

function setDlgType(type) {
  dlgType = type;
  $$('#typeSeg button').forEach(b => b.classList.toggle('on', b.dataset.type === type));
  const isFile = !!TYPES[type].accept;
  $('#fFileWrap').classList.toggle('hidden', !isFile || !!editing);
  $('#fUrlWrap').classList.toggle('hidden', isFile || !!editing);
  $('#fEstWrap').classList.toggle('hidden', type !== 'web');
  if (isFile) $('#fFile').accept = TYPES[type].accept;
  $('#fUrlLabel').textContent = type === 'youtube' ? 'YouTube link' : 'Webpage link';
  $('#fUrl').placeholder = type === 'youtube' ? 'https://www.youtube.com/watch?v=…' : 'https://';
}
function syncSched() { $('#fSchedRow').classList.toggle('hidden', !$('#fSched').checked); }

function openDialog(it = null, presetType) {
  editing = it;
  $('#itemForm').reset();
  $('#fErr').textContent = '';
  $('#dlgTitle').textContent = it ? 'Edit' : 'Add study material';
  $('#fSave').textContent = it ? 'Save' : 'Add';
  $('#typeSeg').classList.toggle('hidden', !!it);
  $('#fDelete').classList.toggle('hidden', !it);
  $('#fProgWrap').classList.toggle('hidden', !it);
  $('#fStart').value = dayKey();
  if (it) {
    $('#fTitle').value = it.title;
    $('#fEst').value = it.est || '';
    $('#fProg').value = pct(it);
    $('#fProgVal').textContent = pct(it) + '%';
    $('#fSched').checked = !!it.schedule;
    if (it.schedule) {
      $('#fStart').value = it.schedule.start;
      $('#fTime').value = it.schedule.time;
      $('#fRepeat').value = it.schedule.repeat;
    }
  }
  setDlgType(it ? it.type : presetType || dlgType);
  syncSched();
  dlg.showModal();
}

function ytId(u) {
  u = u.trim();
  try {
    const x = new URL(u);
    const h = x.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return x.pathname.slice(1).split('/')[0] || null;
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (x.searchParams.get('v')) return x.searchParams.get('v');
      const m = x.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
      return m ? m[1] : null;
    }
  } catch { /* not a URL */ }
  return /^[\w-]{11}$/.test(u) ? u : null;
}
function ytStart(u) {
  try {
    const t = new URL(u).searchParams.get('t');
    if (!t) return 0;
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  } catch { return 0; }
}
async function ytTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    if (r.ok) return (await r.json()).title;
  } catch { /* offline or blocked — the player fills it in later */ }
  return null;
}
function docxPage(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
body{font:17px/1.7 Georgia,'Times New Roman',serif;max-width:760px;margin:0 auto;padding:28px 20px 80px;color:#1d1f24;background:#fff}
h1,h2,h3,h4{font-family:Inter,system-ui,sans-serif;line-height:1.3}
img{max-width:100%;height:auto} table{border-collapse:collapse;margin:1em 0} td,th{border:1px solid #ccc;padding:5px 9px;vertical-align:top}
a{color:#2f6fde}
@media (prefers-color-scheme:dark){body{background:#1c1f27;color:#eceef3} td,th{border-color:#3a4050} a{color:#6b9cff}}
</style></head><body>${body}</body></html>`;
}

async function submitItem(e) {
  e.preventDefault();
  const btn = $('#fSave');
  const schedule = $('#fSched').checked
    ? { start: $('#fStart').value || dayKey(), time: $('#fTime').value || '17:00', repeat: $('#fRepeat').value }
    : null;
  const title = $('#fTitle').value.trim();
  const est = Math.max(0, parseInt($('#fEst').value, 10) || 0) || null;
  $('#fErr').textContent = '';

  if (editing) {
    const it = editing;
    it.title = title || it.title;
    it.schedule = schedule;
    if (it.type === 'web') it.est = est;
    const p = +$('#fProg').value / 100;
    if (Math.round(p * 100) !== pct(it)) {
      it.progress = p;
      it.done = p >= 0.995;
      it.doneOn = it.done ? dayKey() : null;
      if (it.type === 'pdf') it.pos = Math.max(1, Math.round(p * it.total));
      else if (it.type === 'youtube') it.pos = p * it.total;
      else it.pos = p;
      if (it.hist[dayKey()]) it.hist[dayKey()].p1 = p;
    }
    await save(it);
    dlg.close();
    render();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const it = normalize({ id: uid(), type: dlgType, title, createdAt: Date.now(), schedule });
    if (dlgType === 'youtube') {
      const url = $('#fUrl').value.trim();
      const id = ytId(url);
      if (!id) throw new Error("That doesn't look like a YouTube video link.");
      it.videoId = id;
      it.url = url;
      it.pos = ytStart(url);
      if (!it.title) {
        it.title = await ytTitle(id) || 'YouTube video';
        it.autoTitle = it.title === 'YouTube video';
      }
    } else if (dlgType === 'web') {
      let url = $('#fUrl').value.trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      let host;
      try { host = new URL(url).hostname; } catch { throw new Error('Enter a webpage link, e.g. https://example.com/article'); }
      it.url = url;
      it.est = est;
      it.title ||= host.replace(/^www\./, '');
    } else {
      const f = $('#fFile').files[0];
      if (!f) throw new Error('Choose a file first.');
      let blob = f;
      if (dlgType === 'docx') {
        if (!/\.docx$/i.test(f.name)) throw new Error('Only .docx Word files are supported (save older .doc files as .docx).');
        const m = await loadMammoth();
        const r = await m.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
        blob = new Blob([docxPage(r.value)], { type: 'text/html' });
      } else if (dlgType === 'pdf') {
        const lib = await loadPdfjs();
        const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
        it.total = pdf.numPages;
        pdf.destroy();
      }
      it.fileId = uid();
      await db.put('files', { id: it.fileId, name: f.name, blob });
      it.title ||= f.name.replace(/\.[^.]+$/, '');
    }
    items.push(it);
    await save(it);
    navigator.storage?.persist?.();
    dlg.close();
    toast(schedule ? `Added — scheduled ${scheduleText(it).toLowerCase()}` : 'Added to your library');
    render();
  } catch (err) {
    console.error(err);
    $('#fErr').textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
    btn.textContent = editing ? 'Save' : 'Add';
  }
}

async function deleteItem(it) {
  if (!confirm(`Delete “${it.title}”? Its progress will be lost.`)) return;
  items = items.filter(x => x !== it);
  await db.del('items', it.id);
  if (it.fileId) await db.del('files', it.fileId);
  dlg.close();
  render();
}

/* ---------- reader ---------- */
let R = null;

function on(target, ev, fn, r, opts) {
  target.addEventListener(ev, fn, opts);
  r.offs.push(() => target.removeEventListener(ev, fn, opts));
}

function setProgress(r, p, { force = false } = {}) {
  const it = r.it;
  const h = todayHist(it);
  p = clamp01(p);
  it.progress = force ? p : Math.max(it.progress, p);
  h.p1 = it.progress;
  if (it.progress >= 0.995 && !it.done) {
    it.done = true;
    it.doneOn = dayKey();
    save(it);
    toast('🎉 Finished! Marked as done.');
  } else if (force && it.progress < 0.995) {
    it.done = false;
    it.doneOn = null;
  }
}

function updateReaderBar() {
  const r = R;
  if (!r) return;
  const it = r.it;
  $('#rProg').style.width = pct(it) + '%';
  const sub = $('#rSub');
  const state = r.paused ? ' · paused' : r.active ? '' : it.type === 'youtube' ? ' · clock runs while playing' : ' · idle, clock stopped';
  sub.textContent = `${pct(it)}% · this session ${fmtDur(r.secs)}${state}`;
  sub.classList.toggle('idle', r.paused || !r.active);
  const range = $('#webRange');
  if (range && document.activeElement !== range) { range.value = pct(it); $('#webPct').textContent = pct(it) + '%'; }
}

function tick(r) {
  if (R !== r) return;
  const it = r.it;
  if (r.paused) r.active = false;
  else if (it.type === 'youtube') r.active = r.playing;
  else if (it.type === 'web') r.active = true; // the page may be open in another tab
  else r.active = document.visibilityState === 'visible' && Date.now() - r.lastActive < IDLE_MS;
  if (r.active) {
    r.secs++;
    it.timeSpent++;
    todayHist(it).s++;
    if (it.type === 'web' && it.est) setProgress(r, it.timeSpent / (it.est * 60));
  }
  if (++r.ticks % 5 === 0) save(it);
  updateReaderBar();
}

async function openReader(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  if (R) await closeReader();
  todayHist(it);
  it.lastOpened = Date.now();
  const r = R = { it, secs: 0, ticks: 0, lastActive: Date.now(), playing: false, paused: false, active: false, timers: [], offs: [] };
  $('#reader').classList.remove('hidden');
  document.body.classList.add('reading');
  $('#rTitle').textContent = it.title;
  $('#rTools').innerHTML = '';
  $('#rTools').onclick = null;
  $('#rPause').textContent = 'Pause';
  $('#rBody').innerHTML = '<div class="rload">Loading…</div>';
  updateReaderBar();
  r.timers.push(setInterval(() => tick(r), 1000));
  const act = () => { r.lastActive = Date.now(); };
  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => on(window, ev, act, r, { passive: true }));
  on(window, 'scroll', act, r, { capture: true, passive: true });
  try {
    await OPENERS[it.type](it, r);
  } catch (err) {
    console.error(err);
    if (R === r) $('#rBody').innerHTML = `<div class="rerr">Could not open this item.<br>${esc(err.message || err)}</div>`;
  }
}

async function closeReader() {
  const r = R;
  if (!r) return;
  R = null;
  r.timers.forEach(clearInterval);
  r.offs.forEach(f => f());
  try { r.player?.destroy(); } catch { /* already gone */ }
  r.io?.disconnect();
  r.pdf?.destroy();
  await save(r.it);
  $('#reader').classList.add('hidden');
  $('#rBody').innerHTML = '';
  document.body.classList.remove('reading');
  if (r.secs >= 30 && !r.it.done) toast(`Saved — studied ${fmtMin(r.secs)}, now at ${pct(r.it)}%. Next time it opens right here.`, 3500);
  render();
}

const OPENERS = {
  async youtube(it, r) {
    $('#rBody').innerHTML = '<div class="ytbox"><div class="ytin"><div id="ytp"></div></div></div>';
    await loadYT();
    if (R !== r) return;
    let start = Math.floor(it.pos || 0);
    if (it.done || (it.total && start >= it.total - 3)) start = 0;
    r.player = new YT.Player('ytp', {
      videoId: it.videoId,
      playerVars: { start, rel: 0, playsinline: 1, autoplay: 1 },
      events: {
        onReady(e) {
          const d = e.target.getDuration();
          if (d) it.total = d;
          const t = e.target.getVideoData?.()?.title;
          if (t && it.autoTitle) { it.title = t; it.autoTitle = false; $('#rTitle').textContent = t; }
        },
        onStateChange(e) {
          r.playing = e.data === YT.PlayerState.PLAYING;
          if (e.data === YT.PlayerState.ENDED) { it.pos = 0; setProgress(r, 1); save(it); }
        },
      },
    });
    r.timers.push(setInterval(() => {
      const p = r.player;
      if (R !== r || !p?.getCurrentTime || !r.playing) return;
      const t = p.getCurrentTime(), d = p.getDuration();
      if (!d) return;
      it.total = d;
      it.pos = t;
      setProgress(r, t / d);
    }, 1000));
  },

  async pdf(it, r) {
    const f = await db.get('files', it.fileId);
    if (!f) throw new Error('The file is missing from this browser.');
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
    if (R !== r) { pdf.destroy(); return; }
    r.pdf = pdf;
    it.total = pdf.numPages;
    const vp1 = (await pdf.getPage(1)).getViewport({ scale: 1 });
    r.zoom = it.zoom || 1;

    const body = $('#rBody');
    body.innerHTML = '';
    const sc = document.createElement('div');
    sc.className = 'pdfscroll';
    body.append(sc);
    $('#rTools').innerHTML = `<span class="pgnum" id="pgNum"></span>
      <button class="iconbtn" data-z="-1" title="Zoom out">−</button><button class="iconbtn" data-z="1" title="Zoom in">+</button>`;
    $('#rTools').onclick = e => {
      const z = e.target.closest('[data-z]');
      if (!z) return;
      r.zoom = Math.min(3, Math.max(0.5, +(r.zoom + z.dataset.z * 0.15).toFixed(2)));
      it.zoom = r.zoom;
      build(it.pos || 1);
    };

    async function renderPage(el, gen) {
      el.dataset.done = '1';
      const page = await pdf.getPage(+el.dataset.n);
      if (gen !== r.gen || R !== r || !el.dataset.done) return;
      const vp = page.getViewport({ scale: r.scale });
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      el.replaceChildren(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: page.getViewport({ scale: r.scale * dpr }) }).promise.catch(() => {});
    }
    function build(goTo) {
      r.io?.disconnect();
      const gen = r.gen = (r.gen || 0) + 1;
      r.scale = Math.min(sc.clientWidth - 16, 860) / vp1.width * r.zoom;
      sc.innerHTML = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const d = document.createElement('div');
        d.className = 'pg';
        d.dataset.n = i;
        d.style.width = vp1.width * r.scale + 'px';
        d.style.height = vp1.height * r.scale + 'px';
        sc.append(d);
      }
      r.pages = [...sc.children];
      // render pages near the viewport, free the canvases of pages far away
      r.io = new IntersectionObserver(ents => {
        for (const e of ents) {
          if (e.isIntersecting && !e.target.dataset.done) renderPage(e.target, gen);
          else if (!e.isIntersecting && e.target.dataset.done) { delete e.target.dataset.done; e.target.replaceChildren(); }
        }
      }, { root: sc, rootMargin: '1200px 0px' });
      r.pages.forEach(p => r.io.observe(p));
      if (goTo > 1) sc.scrollTop = r.pages[Math.min(goTo, pdf.numPages) - 1].offsetTop - 8;
      onScroll();
    }
    function onScroll() {
      if (!r.pages) return;
      const mid = sc.scrollTop + sc.clientHeight * 0.35;
      let n = 1;
      for (const p of r.pages) { if (p.offsetTop <= mid) n = +p.dataset.n; else break; }
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4 && sc.scrollTop > 0;
      it.pos = n;
      $('#pgNum').textContent = `${n} / ${pdf.numPages}`;
      setProgress(r, atEnd ? 1 : (n - 1) / pdf.numPages);
    }
    on(sc, 'scroll', onScroll, r, { passive: true });
    let rt;
    on(window, 'resize', () => { clearTimeout(rt); rt = setTimeout(() => build(it.pos || 1), 250); }, r);
    requestAnimationFrame(() => build(it.done ? 1 : Math.max(1, it.pos || 1)));
  },

  async html(it, r) {
    const f = await db.get('files', it.fileId);
    if (!f) throw new Error('The file is missing from this browser.');
    let html = await f.blob.text();
    const base = '<base target="_blank">';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + base) : base + html;
    const fr = document.createElement('iframe');
    fr.className = 'docframe';
    // same-origin so scroll position can be read; no scripts allowed to run
    fr.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    const body = $('#rBody');
    body.innerHTML = '';
    body.append(fr);
    await new Promise(res => { fr.onload = res; fr.srcdoc = html; });
    if (R !== r) return;
    const w = fr.contentWindow, d = fr.contentDocument;
    const se = () => d.scrollingElement || d.documentElement;
    const max = () => Math.max(0, se().scrollHeight - w.innerHeight);
    if (it.pos > 0 && !it.done) se().scrollTop = it.pos * max();
    const onScroll = () => {
      const m = max();
      const ratio = m > 0 ? se().scrollTop / m : 1;
      it.pos = ratio;
      setProgress(r, ratio);
      r.lastActive = Date.now();
    };
    w.addEventListener('scroll', onScroll, { passive: true });
    ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
      w.addEventListener(ev, () => { r.lastActive = Date.now(); }, { passive: true }));
    onScroll();
    fr.focus();
  },

  async web(it, r) {
    $('#rTools').innerHTML = `<a class="btn sm" href="${esc(it.url)}" target="_blank" rel="noopener">Open in new tab ↗</a>`;
    $('#rBody').innerHTML = `<div class="webbar">
        <span>How far have you got?</span>
        <input type="range" id="webRange" min="0" max="100" step="5" value="${pct(it)}"><b id="webPct">${pct(it)}%</b>
        <small>${it.est ? `Fills on its own: ${it.est} min of reading = 100%. ` : ''}If the page stays blank, the site doesn't allow being shown here — use “Open in new tab” and keep this reader open; the clock keeps running.</small>
      </div>
      <iframe class="webframe" src="${esc(it.url)}" referrerpolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox"></iframe>`;
    $('#webRange').oninput = e => {
      const v = +e.target.value / 100;
      it.pos = v;
      setProgress(r, v, { force: true });
      $('#webPct').textContent = Math.round(v * 100) + '%';
      updateReaderBar();
    };
  },
};
OPENERS.docx = OPENERS.html;

/* ---------- reminders ---------- */
const reminded = new Set();
function remindersOn() { return 'Notification' in window && Notification.permission === 'granted'; }
function syncBell() { $('#bellBtn').classList.toggle('on', remindersOn()); }
function checkReminders() {
  const t = dayKey(), now = hm();
  for (const it of items) {
    if (!scheduledOn(it, t) || it.done || it.hist[t]?.s >= 60) continue;
    const s = it.schedule.time;
    const key = t + '|' + it.id;
    // fire once, within 30 minutes after the scheduled time
    const late = (new Date(`${t}T${now}`) - new Date(`${t}T${s}`)) / 60000;
    if (late < 0 || late > 30 || reminded.has(key)) continue;
    reminded.add(key);
    const msg = `${it.title} — ${pct(it)}% done. ${posText(it)}`;
    toast('⏰ Study time: ' + msg, 6000);
    if (remindersOn()) {
      const n = new Notification('Study time · ' + fmt12(s), { body: msg, icon: 'icon.svg', tag: key });
      n.onclick = () => { window.focus(); openReader(it.id); n.close(); };
    }
  }
}

/* ---------- backup ---------- */
const blobToDataURL = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
async function exportBackup() {
  toast('Preparing backup…');
  const files = await db.all('files');
  const data = {
    app: 'study-desk', version: 1, exportedAt: new Date().toISOString(), items,
    files: await Promise.all(files.map(async f => ({ id: f.id, name: f.name, data: await blobToDataURL(f.blob) }))),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `study-desk-backup-${dayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'study-desk' || !Array.isArray(data.items)) throw new Error('This is not a Study Desk backup file.');
    if (!confirm(`Import ${data.items.length} items? Items that already exist here will be replaced by the backup's copy.`)) return;
    for (const f of data.files || []) await db.put('files', { id: f.id, name: f.name, blob: await (await fetch(f.data)).blob() });
    for (const it of data.items) await db.put('items', normalize(it));
    items = (await db.all('items')).map(normalize);
    render();
    toast(`Imported ${data.items.length} items`);
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

/* ---------- wiring ---------- */
function typeFromFile(f) {
  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') return 'pdf';
  if (/\.html?$/i.test(f.name)) return 'html';
  if (/\.docx$/i.test(f.name)) return 'docx';
  return null;
}

$('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); };
$('#addBtn').onclick = () => openDialog();
$('#main').onclick = e => {
  const f = e.target.closest('[data-filter]');
  if (f) { libFilter = f.dataset.filter; renderLibrary(); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  if (a.dataset.act === 'add') return openDialog();
  const id = a.closest('[data-id]')?.dataset.id;
  if (a.dataset.act === 'open') openReader(id);
  if (a.dataset.act === 'edit') openDialog(items.find(x => x.id === id));
};
$('#typeSeg').onclick = e => { const b = e.target.closest('[data-type]'); if (b) setDlgType(b.dataset.type); };
$('#fSched').onchange = syncSched;
$('#fProg').oninput = e => { $('#fProgVal').textContent = e.target.value + '%'; };
$('#fCancel').onclick = () => dlg.close();
$('#fDelete').onclick = () => editing && deleteItem(editing);
$('#itemForm').onsubmit = submitItem;
$('#fFile').onchange = e => {
  const f = e.target.files[0];
  const t = f && typeFromFile(f);
  if (t && t !== dlgType) setDlgType(t);
};
$('#fUrl').addEventListener('change', e => { if (!editing && ytId(e.target.value) && dlgType === 'web') setDlgType('youtube'); });

$('#rClose').onclick = closeReader;
$('#rPause').onclick = () => {
  if (!R) return;
  R.paused = !R.paused;
  $('#rPause').textContent = R.paused ? 'Resume' : 'Pause';
  updateReaderBar();
};
$('#rDone').onclick = async () => {
  if (!R) return;
  const r = R;
  setProgress(r, 1, { force: true });
  if (r.it.type === 'youtube') r.it.pos = 0;
  await closeReader();
  toast('🎉 Marked as finished');
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && R && !dlg.open) closeReader();
});

$('#bellBtn').onclick = async () => {
  if (!('Notification' in window)) return toast('This browser does not support notifications. Reminders still pop up inside the page.');
  if (Notification.permission === 'default') await Notification.requestPermission();
  syncBell();
  toast(remindersOn()
    ? 'Reminders on — you get a notification at each study time while Study Desk is open in a tab.'
    : 'Notifications are blocked in the browser settings. Reminders still pop up inside the page.', 4500);
};
$('#menuBtn').onclick = e => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('#menu').classList.add('hidden'));
$('#menu').onclick = e => {
  const b = e.target.closest('[data-menu]');
  if (!b) return;
  if (b.dataset.menu === 'export') exportBackup();
  else $('#importFile').click();
};
$('#importFile').onchange = e => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; };

// drag & drop a file anywhere to add it
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files') && !R) { dragDepth++; $('#drop').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.add('hidden');
  const f = e.dataTransfer?.files?.[0];
  if (!f || R) return;
  const t = typeFromFile(f);
  if (!t) return toast('Drop a PDF, HTML or .docx file');
  openDialog(null, t);
  $('#fFile').files = e.dataTransfer.files;
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && R) save(R.it); });
window.addEventListener('pagehide', () => { if (R) save(R.it); });

(async function init() {
  items = (await db.all('items')).map(normalize);
  syncBell();
  render();
  checkReminders();
  setInterval(() => {
    checkReminders();
    if (!R && !dlg.open && tab === 'today') renderToday();
  }, 20000);
})();
