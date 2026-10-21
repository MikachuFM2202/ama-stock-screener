// app.js: AMA Stock Screener. Unlocks the encrypted snapshot on the `market` branch and renders every view.
// Data flow: GitHub Actions (scripts/build.py) -> `market` branch (daily/weekly, AES-GCM gzip'd JSON) and `live`
// branch (quotes + breaking news every ~10 min) -> this page. An optional Cloudflare Worker gives 1-minute quotes.
// Family data (profiles, watchlists, notes, paper trading, push subscriptions) lives encrypted on the `data` branch;
// writes need a GitHub token, stored encrypted there too (vault.bin), so every device unlocks it with the password.
import { LEARN, PATTERNS, GLOSSARY, RESOURCES, candleSvg } from './learn.js';
import * as PT from './paper.js';

const qs = new URLSearchParams(location.search);
const REPO = qs.get('repo') || (() => {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/), p = location.pathname.split('/')[1];
  return m && p ? `${m[1]}/${p}` : 'MikachuFM2202/ama-stock-screener';
})();
const RAW = qs.get('data') || `https://raw.githubusercontent.com/${REPO}/`;
const VAPID = 'BJIdRX6WvAnQGUXn8UX-ZnLxmmNiqxw_J3zZd7H_K_KiIpYUwvT9LIdvtIilKX2a07QkkajLu1mJ1YbeNPmiMPQ';
const FEATURED = 'v8pxKa9ks7Y';
const te = new TextEncoder(), td = new TextDecoder();
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = u => /^https?:\/\//i.test(u || '') ? u : '#';  // feed and AI links must never be javascript: URLs
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {  // localStorage can throw (private mode); the app must still work
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------------------------------------------------------------- crypto
let KEY = null, META = null;
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const pipe = (buf, t) => new Response(new Blob([buf]).stream().pipeThrough(t)).arrayBuffer();
async function derive(pass, meta) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(meta.salt), iterations: meta.iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function unseal(buf) {
  const u = new Uint8Array(buf);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, KEY, u.subarray(12));
  return JSON.parse(td.decode(await pipe(pt, new DecompressionStream('gzip'))));
}
async function seal(obj) {
  const z = await pipe(te.encode(JSON.stringify(obj)), new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, KEY, z));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}

// ---------------------------------------------------------------- data
const files = new Map();
function mk(path) {
  if (!files.has(path)) files.set(path, fetch(`${RAW}market/${path}?v=${encodeURIComponent(META.at || '')}`)
    .then(r => { if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); return r.arrayBuffer(); })
    .then(unseal).catch(e => { files.delete(path); throw e; }));
  return files.get(path);
}
const D = { summary: null, uni: null, bySym: new Map() };
async function universe() {
  if (!D.uni) { D.uni = await mk('universe.bin'); D.uni.forEach(r => D.bySym.set(r.s, r)); fillCmd(); }
  return D.uni;
}
function macroRow(s) { for (const rows of Object.values(D.summary.macro)) { const r = rows.find(x => x.s === s); if (r) return r; } return null; }

// ---------------------------------------------------------------- GitHub (family data on the `data` branch)
let TOKEN = null, CFG = {};  // CFG: family settings sealed in vault.bin (token, optional worker)
async function gh(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { ...opt, headers: {
    Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opt.headers || {}) } });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
  return r;
}
async function readBranch(branch, name) {
  if (TOKEN) {  // the API is fresh; raw.githubusercontent caches for ~5 minutes
    try { return await unseal(await (await gh(`contents/${name}?ref=${branch}&_=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw+json' } })).arrayBuffer()); }
    catch (e) { if (e.status === 404) return null; }
  }
  const r = await fetch(`${RAW}${branch}/${name}?_=${Date.now()}`, { cache: 'no-store' });
  return r.ok ? unseal(await r.arrayBuffer()) : null;
}
const readData = name => readBranch('data', name);
async function putData(name, bytes, message) {
  for (let i = 0; i < 4; i++) {
    let sha;
    try { sha = (await (await gh(`contents/${name}?ref=data&_=${Date.now()}`)).json()).sha; } catch (e) { if (e.status !== 404) throw e; }
    try { return await gh(`contents/${name}`, { method: 'PUT', body: JSON.stringify({ message, content: b64(bytes), branch: 'data', sha }) }); }
    catch (e) { if (![409, 422].includes(e.status) || i === 3) throw e; await sleep(400 * (i + 1) + Math.random() * 300); }
  }
}
async function loadVault() {
  try { const v = await readData('vault.bin'); if (v) { CFG = v; TOKEN = v.token || null; store.set('cfg', CFG); } }
  catch { CFG = store.get('cfg', {}); TOKEN = CFG.token || null; }
}
async function saveVault(next) {
  const prev = TOKEN; TOKEN = next.token || TOKEN;
  try { await putData('vault.bin', await seal(next), 'vault: family settings'); CFG = next; store.set('cfg', CFG); }
  catch (e) { TOKEN = prev; throw e; }
}

// ---------------------------------------------------------------- profiles
const COLORS = ['#ffa028', '#2bd96b', '#5fb4ff', '#c38cff', '#ff6b9d', '#3fd0d0', '#ffe14d', '#ff4d4d'];
// Breaking-news outlets the family chose (2026-10-21); ids match NEWS_SOURCES in scripts/build.py.
const NEWS_SOURCES = [['reuters', 'Reuters', 'reuters.com'], ['bloomberg', 'Bloomberg', 'bloomberg.com'], ['cnbc', 'CNBC', 'cnbc.com'], ['bbc', 'BBC News', 'bbc.com'],
  ['aljazeera', 'Al Jazeera', 'aljazeera.com'], ['ft', 'Financial Times', 'ft.com'], ['wsj', 'Wall Street Journal', 'wsj.com'], ['yahoo', 'Yahoo Finance', 'finance.yahoo.com'],
  ['cna', 'CNA', 'channelnewsasia.com'], ['st', 'The Straits Times', 'straitstimes.com'], ['bt', 'The Business Times', 'businesstimes.com.sg'],
  ['bernama', 'Bernama', 'bernama.com'], ['edge', 'The Edge Malaysia', 'theedgemalaysia.com'], ['star', 'The Star', 'thestar.com.my']];
const DEF_PREFS = { home: 'mkt', mkt: 'US', risk: 1.5, acct: 1500, move: 5, ticker: true, shariahOnly: true,
  news: { popup: true, sources: NEWS_SOURCES.map(x => x[0]) },
  notify: { daily: true, weekly: true, alerts: true, moves: true, orders: true, breaking: false } };
const now = () => new Date().toISOString();
const blank = () => ({ v: 2, at: 0, wl: [], notes: {}, journal: [], later: [], quick: [], subs: [], prefs: structuredClone(DEF_PREFS), paper: PT.newAccount() });
let FAMILY = store.get('family', { list: [], at: 0 });
let ME = null, ST = blank();
const people = () => FAMILY.list.filter(p => !p.del);
const P = () => ({ ...DEF_PREFS, ...ST.prefs, notify: { ...DEF_PREFS.notify, ...(ST.prefs?.notify || {}) }, news: { ...DEF_PREFS.news, ...(ST.prefs?.news || {}) } });
const myNews = list => { const mine = new Set(P().news.sources); return (list || []).filter(n => !n.src || mine.has(n.src)); };

async function loadFamily() {
  try { const f = await readData('profiles.bin'); if (f) FAMILY = { ...f, list: PT.mergeList(FAMILY.list, f.list) }; } catch {}
  store.set('family', FAMILY);
}
async function saveFamily() {
  FAMILY.at = Date.now(); store.set('family', FAMILY);
  if (!TOKEN) return;
  const remote = await readData('profiles.bin').catch(() => null);
  FAMILY.list = PT.mergeList(remote?.list, FAMILY.list);
  await putData('profiles.bin', await seal(FAMILY), 'profiles: update');
}
// Two devices editing the same profile: lists merge by id (newer `u` wins), plain settings come from the newer copy.
function mergeState(a, b) {
  if (!a) return b; if (!b) return a;
  const [o, n] = (a.at || 0) > (b.at || 0) ? [b, a] : [a, b];
  const notes = { ...o.notes };
  for (const [k, v] of Object.entries(n.notes || {})) if (!notes[k] || (v.u || '') >= (notes[k].u || '')) notes[k] = v;
  const op = o.paper || PT.newAccount(), np = n.paper || PT.newAccount();
  return { ...blank(), ...o, ...n, notes, wl: PT.mergeList(o.wl, n.wl, 's'), later: PT.mergeList(o.later, n.later), journal: PT.mergeList(o.journal, n.journal), quick: PT.mergeList(o.quick, n.quick),
    subs: PT.mergeList(o.subs, n.subs, 'endpoint'), paper: { ...op, ...np, trades: PT.mergeList(op.trades, np.trades), orders: PT.mergeList(op.orders, np.orders), eq: PT.mergeList(op.eq, np.eq, 'd') } };
}
// Copies a merged state into the existing ST / ST.paper objects. Views hold references to them (the paper ticket,
// watchlist inputs), so replacing the objects would make later edits land on a stale copy and be lost.
function adopt(m) {
  const paper = Object.assign(ST.paper, m.paper);
  Object.assign(ST, m, { paper });
}
async function loadMe(id) {
  ME = people().find(p => p.id === id) || null;
  if (!ME) return;
  store.set('me', id);
  ST = mergeState(blank(), store.get(`st:${id}`, null));
  try { const remote = await readData(`p/${id}.bin`); if (remote) ST = mergeState(ST, remote); } catch {}
  ST.paper ||= PT.newAccount();
  store.set(`st:${id}`, ST);
  paintMe();
}
let saveT = null, syncMsg = '';
function saveState() {
  ST.at = Date.now(); store.set(`st:${ME.id}`, ST);
  clearTimeout(saveT);
  if (!TOKEN) { syncMsg = 'Saved on this device only. Connect GitHub in Settings → Family to sync.'; return; }
  const id = ME.id;
  saveT = setTimeout(async () => {
    try {
      const remote = await readData(`p/${id}.bin`).catch(() => null);
      const merged = mergeState(remote, ST);
      if (ME?.id === id) { adopt(merged); store.set(`st:${id}`, ST); }
      await putData(`p/${id}.bin`, await seal(merged), `profile ${id}: update`);
      syncMsg = `Synced ${new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) { syncMsg = `Sync failed (${e.message}). Kept on this device; will retry on the next change.`; toast(syncMsg); }
  }, 800);
}
const wlItems = () => ST.wl.filter(w => !w.del);
const inWl = s => wlItems().some(w => w.s === s);
function toggleWl(s, n) {
  const w = ST.wl.find(x => x.s === s);
  if (w && !w.del) Object.assign(w, { del: true, u: now() });
  else if (w) Object.assign(w, { del: false, u: now(), add: now().slice(0, 10) });
  else ST.wl.unshift({ s, n: n || D.bySym.get(s)?.n || s, add: now().slice(0, 10), u: now() });
  saveState(); toast(inWl(s) ? `Added ${s} to ${ME.name}'s watchlist` : `Removed ${s}`);
}
async function sha(text) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text)))); }
function paintMe() {
  const b = $('#me'); if (!b || !ME) return;
  b.textContent = ME.name.slice(0, 1).toUpperCase(); b.style.background = ME.color; b.title = `${ME.name} · switch profile`;
}

// Profile picker: shown after unlock when this device has no profile yet, or from the avatar button.
function pickProfile(msg = '') {
  const el = $('#who');
  el.hidden = false;
  const list = people();
  el.innerHTML = `<div class="who-box"><div class="brand"><span class="logo">AMA</span> WHO'S USING THE SCREENER?</div>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <div class="people">${list.map(p => `<button class="person" data-id="${esc(p.id)}"><span class="avatar lg" style="background:${esc(p.color)}">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}${p.pin ? ' 🔒' : ''}</button>`).join('')}</div>
    <form id="addP" class="panel pb" style="display:grid;gap:10px"><b class="amber">${list.length ? 'Add a family member' : 'Create the first profile'}</b>
      <input class="f" id="pName" maxlength="20" placeholder="Name" required>
      <div class="swatches">${COLORS.map((c, i) => `<input type="radio" name="pc" id="pc${i}" value="${c}" ${i === list.length % COLORS.length ? 'checked' : ''}><label for="pc${i}" style="background:${c}" title="${c}"></label>`).join('')}</div>
      <input class="f" id="pPin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="Optional PIN (4–8 digits)" autocomplete="off">
      <button class="btn">CREATE PROFILE</button>
      <p class="note">Everyone in the family shares the family password; profiles keep watchlists, notes, paper trading and notifications separate. A PIN stops casual switching. It is a lock on the door, not separate encryption.${TOKEN ? '' : ' GitHub sync is not connected yet, so new profiles stay on this device until it is (Settings → Family).'}</p></form>
    ${ME ? '<button class="btn ghost" id="pBack">BACK</button>' : ''}</div>`;
  $$('.person', el).forEach(b => b.onclick = async () => {
    const p = people().find(x => x.id === b.dataset.id);
    if (p.pin && store.get('me') !== p.id) {
      const pin = await askPin(p.name);
      if (pin == null) return;
      if (await sha(p.pin.salt + pin) !== p.pin.h) return pickProfile('Wrong PIN.');
    }
    el.hidden = true; await loadMe(p.id); route(); popNews();
  });
  $('#pBack')?.addEventListener('click', () => { el.hidden = true; });
  $('#addP').onsubmit = async e => {
    e.preventDefault();
    const name = $('#pName').value.trim(), pin = $('#pPin').value.trim();
    if (!name) return;
    if (pin && !/^\d{4,8}$/.test(pin)) return pickProfile('PIN must be 4–8 digits.');
    const id = (name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'p') + Math.random().toString(36).slice(2, 6);
    const salt = PT.rid();
    FAMILY.list.push({ id, name, color: $('input[name=pc]:checked').value, pin: pin ? { salt, h: await sha(salt + pin) } : null, at: now(), u: now() });
    try { await saveFamily(); } catch (x) { toast(`Saved here only: ${x.message}`); }
    el.hidden = true; await loadMe(id); saveState(); route();
  };
}
function askPin(name) {
  return new Promise(res => {
    const d = document.createElement('div');
    d.className = 'login'; d.style.zIndex = 60;
    d.innerHTML = `<form class="login-box"><b class="amber">PIN for ${esc(name)}</b><input class="f" type="password" inputmode="numeric" maxlength="8" autocomplete="off" autofocus>
      <div class="row"><button class="btn">OK</button><button type="button" class="btn ghost">CANCEL</button></div></form>`;
    document.body.append(d);
    const inp = $('input', d); inp.focus();
    $('form', d).onsubmit = e => { e.preventDefault(); d.remove(); res(inp.value); };
    $('button[type=button]', d).onclick = () => { d.remove(); res(null); };
  });
}

// ---------------------------------------------------------------- live quotes + breaking news
let LIVE = null, liveFrom = '';
function liveSyms() {
  const s = new Set(Object.values(D.summary.macro).flat().map(r => r.s));
  wlItems().forEach(w => s.add(w.s));
  (ST.quick || []).filter(x => !x.del && ['planned', 'open'].includes(x.status)).forEach(x => s.add(x.s));
  Object.keys(PT.holdings(ST.paper).pos).forEach(x => s.add(x));
  ST.paper.orders.filter(o => o.status === 'open').forEach(o => s.add(o.s));
  const [v, a] = location.hash.slice(1).split('/');
  if (v === 'stock' && a) s.add(decodeURIComponent(a));
  ['SGD=X', 'MYR=X'].forEach(x => s.add(x));
  return [...s];
}
async function loadLive() {
  let data = null;
  if (CFG.worker?.url) {  // optional Cloudflare Worker: quotes straight from Yahoo every minute
    try {
      const u = CFG.worker.url.replace(/\/$/, ''), k = encodeURIComponent(CFG.worker.key || '');
      const syms = liveSyms().slice(0, 180), chunks = [];
      for (let i = 0; i < syms.length; i += 45) chunks.push(syms.slice(i, i + 45));  // free Workers allow 50 subrequests per call
      const [qs, n] = await Promise.all([Promise.all(chunks.map(c => fetch(`${u}/q?k=${k}&s=${encodeURIComponent(c.join(','))}`).then(r => r.json()))), fetch(`${u}/news?k=${k}&d=${encodeURIComponent(NEWS_SOURCES.filter(x => P().news.sources.includes(x[0])).map(x => x[2]).join(','))}`).then(r => r.json())]);
      const q = { at: qs[0]?.at || new Date().toISOString(), q: Object.assign({}, ...qs.map(x => x.q || {})) };
      const fx = {}; for (const [s, v] of Object.entries(q.q || {})) if (s.endsWith('=X')) fx[s.slice(0, -2)] = v.p;
      const byDom = Object.fromEntries(NEWS_SOURCES.map(x => [x[2], x]));
      data = { at: q.at, q: q.q, fx, news: (n.news || []).map(x => byDom[x.dom] ? { ...x, src: byDom[x.dom][0], s: byDom[x.dom][1] } : x) }; liveFrom = 'worker';
    } catch (e) { console.warn('worker', e); }
  }
  if (!data) { try { data = await readBranch('live', 'live.bin'); liveFrom = 'github'; } catch {} }
  if (!data) return false;
  const changed = !LIVE || data.at !== LIVE.at;
  LIVE = data; applyLive(); paintTicker(); tick();
  popNews();
  return changed;
}
function applyLive() {
  if (!LIVE) return;
  D.fx = { ...(D.summary.fx || {}), ...(LIVE.fx || {}), USD: 1 };
  if (D.fx.GBP) D.fx.GBp = D.fx.GBP * 100;
  for (const [s, q] of Object.entries(LIVE.q || {})) {
    const r = D.bySym.get(s) || macroRow(s);
    if (r && q.p && (!r.d || !q.d || q.d >= r.d)) Object.assign(r, { px: q.p, r1: q.c, d: q.d || r.d, live: true });
  }
}
function quoteOf(s) {
  const r = D.bySym.get(s) || macroRow(s), q = LIVE?.q?.[s];
  const px = q?.p ?? r?.px;
  return px ? { px, h: q?.h, l: q?.l, d: q?.d || r?.d, cur: r?.cur || curOf(s), st: r?.st, n: r?.n || s } : null;
}
const curOf = s => ({ KL: 'MYR', SI: 'SGD', T: 'JPY', HK: 'HKD', L: 'GBp', TO: 'CAD', AX: 'AUD', KS: 'KRW', TW: 'TWD', SS: 'CNY', SZ: 'CNY', JK: 'IDR', SW: 'CHF', AS: 'EUR' })[s.split('.')[1]] || 'USD';
function paintTicker() {
  const el = $('#ticker'), tr = $('#tickerTrack');
  el.hidden = !P().ticker;
  if (el.hidden) return;
  const marks = ['^GSPC', '^IXIC', '^KLSE', '^STI', 'GC=F', 'CL=F', 'SGD=X'].map(macroRow).filter(Boolean)
    .map(r => `<span class="q">${esc(r.n)} <span class="mono">${px(r.px)}</span> ${pct(r.r1)}</span>`);
  const news = myNews(LIVE?.news?.length ? LIVE.news : D.summary.news || []).slice(0, 25)
    .map(n => `<a href="${esc(safe(n.u))}" target="_blank" rel="noopener"><b>${esc(n.s || 'NEWS')}</b>${esc(n.t)}${n.at ? ` <span class="dim">${esc(ago(n.at))}</span>` : ''}</a>`);
  const items = [...marks, ...news].join('');
  tr.innerHTML = items + items;  // doubled so the -50% scroll loops seamlessly
  tr.style.setProperty('--dur', `${Math.max(60, (marks.length + news.length) * 7)}s`);
}

// Breaking-news pop-ups: new headlines from the profile's chosen outlets slide in at the top (max 3 at once).
// The "seen" mark is per profile and device, so reopening the app doesn't replay old headlines.
function popNews() {
  if (!ME || !LIVE || !P().news.popup) return;
  const key = `seen:${ME.id}`, seen = store.get(key, null);
  const items = myNews(LIVE.news).filter(n => n.src).map(n => ({ ...n, ts: Date.parse(n.at) || 0 })).filter(n => n.ts);
  if (!items.length) return;
  const cutoff = seen ?? Date.now() - 45 * 60000;  // first run: only the last 45 minutes
  const fresh = items.filter(n => n.ts > cutoff).sort((a, b) => b.ts - a.ts).slice(0, 3);
  store.set(key, Math.max(cutoff, ...items.map(n => n.ts)));
  fresh.reverse().forEach(showPop);
}
function showPop(n) {
  let box = $('#pops');
  if (!box) { box = Object.assign(document.createElement('div'), { id: 'pops', className: 'pops' }); box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const card = document.createElement('div');
  card.className = 'pop';
  card.innerHTML = `<a href="${esc(safe(n.u))}" target="_blank" rel="noopener"><b>${esc(n.s || 'NEWS')} · ${Date.now() - (Date.parse(n.at) || 0) < 3600000 ? 'BREAKING' : 'LATEST'}</b><span>${esc(n.t)}</span><small>${esc(ago(n.at))}</small></a><button aria-label="Dismiss">✕</button>`;
  let t = setTimeout(() => card.remove(), 15000);
  card.onmouseenter = () => clearTimeout(t);
  card.onmouseleave = () => { t = setTimeout(() => card.remove(), 5000); };
  $('button', card).onclick = () => card.remove();
  $('a', card).onclick = () => setTimeout(() => card.remove(), 300);
  box.append(card);
}

// ---------------------------------------------------------------- formatting
const STATUS = { C: 'Certified: on an official Shariah list / Shariah index', P: 'Passes our Shariah ratio screen, not certified', R: 'Needs manual review', F: 'Fails or officially non-compliant' };
const MKT = { MY: 'Malaysia', SG: 'Singapore', US: 'United States', GL: 'Global' };
function px(v) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 2 : a >= 1 ? 2 : 3, maximumFractionDigits: a >= 1000 ? 2 : a >= 1 ? 3 : 4 });
}
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
const pct = (v, d = 2) => {
  if (v == null || !isFinite(v)) return '<span class="flat">–</span>';
  if (Math.abs(v * 100) < 0.5 * 10 ** -d) v = 0;  // no red "-0.00%"
  return `<span class="${cls(v)}">${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%</span>`;
};
const money = v => v == null || !isFinite(v) ? '–' : (Math.abs(v) < 0.005 ? 0 : v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctp = v => v == null || !isFinite(v) ? '–' : `${(v * 100).toFixed(0)}%`;
function big(v) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 1e12 ? (v / 1e12).toFixed(2) + 'T' : a >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v.toFixed(0);
}
const badge = st => st ? `<span class="badge st-${st}" title="${esc(STATUS[st])}">${st}</span>` : '';
const biasHtml = b => `<span class="bias ${/bull/i.test(b) ? 'up' : /bear/i.test(b) ? 'down' : 'flat'}">${esc(b || '–')}</span>`;
function fcCell(fc, h) {
  const f = fc && (fc[h] || fc[String(h)]);
  if (!f) return '<span class="flat">–</span>';
  return `<span class="${f.up >= .55 ? 'up' : f.up <= .45 ? 'down' : 'flat'}" title="Likely range ${px(f.lo)} – ${px(f.hi)} (68%), based on ${f.n} similar past setups">${pctp(f.up)}</span>`;
}
const ago = iso => { const m = (Date.now() - new Date(iso)) / 60000; return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const sgt = (iso, o = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) => new Date(iso).toLocaleString('en-SG', { ...o, timeZone: 'Asia/Singapore' });
function toast(msg) { const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg }); document.body.append(t); setTimeout(() => t.remove(), 2600); }
const star = (s, n) => `<button class="star ${inWl(s) ? 'on' : ''}" data-star="${esc(s)}" data-n="${esc(n || '')}" title="Watchlist" aria-label="Toggle ${esc(s)} in watchlist">★</button>`;
const symCell = r => `<td class="l">${star(r.s, r.n)}<a class="sym" href="#stock/${encodeURIComponent(r.s)}">${esc(r.s)}</a></td>`;
const panel = (title, body, extra = '', cls = '') => `<section class="panel ${cls}"><div class="ph"><h2>${title}</h2>${extra}</div>${body}</section>`;
const md = text => window.DOMPurify && window.marked ? DOMPurify.sanitize(marked.parse(text || '')) : `<pre>${esc(text)}</pre>`;

// ---------------------------------------------------------------- links per stock
function links(r) {
  const s = r.s, code = s.split('.')[0], L = [];
  const add = (t, u, note = '') => L.push(`<li><a href="${esc(safe(u))}" target="_blank" rel="noopener">${esc(t)}</a> <small>${esc(note)}</small></li>`);
  add('Yahoo Finance', `https://finance.yahoo.com/quote/${encodeURIComponent(s)}`, 'quote, financials, holders');
  add('TradingView', `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym(s))}`, 'live chart');
  add('moomoo', `https://www.moomoo.com/stock/${encodeURIComponent(mooCode(s))}`, 'your US broker');
  add('Google News', `https://news.google.com/search?q=${encodeURIComponent(`"${r.n}"`)}&hl=en-SG&gl=SG&ceid=SG:en`, 'latest coverage');
  if (s.endsWith('.KL')) {
    add('Bursa announcements', `https://www.bursamalaysia.com/market_information/announcements/company_announcement?company=${code}`, 'results, filings');
    add('KLSE Screener', `https://www.klsescreener.com/v2/stocks/view/${code}`, 'financials, Shariah flag');
    add('i3investor', `https://klse.i3investor.com/web/stock/overview/${code}`, 'forum, results, research');
    add('MalaysiaStock.Biz', `https://www.malaysiastock.biz/Corporate-Infomation.aspx?securityCode=${code}`, 'corporate info');
    add('HalalScreener', `https://halalscreener.app/en/stock/${s}`, 'Shariah check');
    add('SC Shariah list', 'https://www.sc.com.my/development/icm/icm-publications/list-of-shariah-compliant-securities', 'official list');
    add('Malacca Securities (M+ Online)', 'https://www.mplusonline.com/', 'your Bursa broker');
  } else if (s.endsWith('.SI')) {
    add('SGX stock page', `https://www.sgx.com/securities/equities/${code}`, 'official');
    add('SGX announcements', `https://www.sgx.com/securities/company-announcements?value=${code}&type=securitycode`, 'filings');
    add('The Edge Singapore', `https://www.theedgesingapore.com/search?keys=${encodeURIComponent(r.n)}`, 'news');
    add('Musaffa', `https://musaffa.com/stock/${code}.SI`, 'Shariah check');
    add('UOB Kay Hian (UTRADE)', 'https://www.utrade.com.sg/', 'your SGX broker');
  } else if (!s.includes('.') && !s.startsWith('^') && !s.includes('=')) {
    add('Musaffa', `https://musaffa.com/stock/${s}`, 'Shariah check');
    add('Zoya', `https://zoya.finance/stocks/${s}`, 'Shariah check');
    add('SEC filings (EDGAR)', `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s}&type=10-&dateb=&owner=include&count=40`, '10-K, 10-Q');
    add('StockAnalysis', `https://stockanalysis.com/stocks/${s.toLowerCase()}/`, 'financials, forecasts');
    add('Finviz', `https://finviz.com/quote.ashx?t=${s}`, 'snapshot, news');
    add('Earnings call transcripts', `https://www.google.com/search?q=${encodeURIComponent(s + ' earnings call transcript')}`, 'search');
  } else if (s.includes('.')) {
    add('Musaffa', `https://musaffa.com/stock/${s}`, 'Shariah check');
  }
  if (r.web) add('Company website', r.web, 'investor relations');
  add('Annual report (search)', `https://www.google.com/search?q=${encodeURIComponent(r.n + ' annual report pdf')}`, 'read the business');
  add('YouTube analysis', `https://www.youtube.com/results?search_query=${encodeURIComponent(r.n + ' stock analysis')}`, 'videos');
  return `<ul class="links">${L.join('')}</ul>`;
}
const TV_MACRO = { '^GSPC': 'SP:SPX', '^IXIC': 'NASDAQ:IXIC', '^DJI': 'DJ:DJI', '^RUT': 'TVC:RUT', '^KLSE': 'FTSEMYX:FBMKLCI', '^STI': 'TVC:STI',
  '^N225': 'TVC:NI225', '^HSI': 'TVC:HSI', '000001.SS': 'SSE:000001', '^KS11': 'TVC:KOSPI', '^TWII': 'TWSE:TAIEX', '^BSESN': 'BSE:SENSEX',
  '^JKII': 'IDX:JII', '^FTSE': 'TVC:UKX', '^GDAXI': 'XETR:DAX', 'GC=F': 'COMEX:GC1!', 'SI=F': 'COMEX:SI1!', 'PL=F': 'NYMEX:PL1!', 'HG=F': 'COMEX:HG1!',
  'CL=F': 'NYMEX:CL1!', 'BZ=F': 'ICEEUR:BRN1!', 'NG=F': 'NYMEX:NG1!', 'ZW=F': 'CBOT:ZW1!', 'ZC=F': 'CBOT:ZC1!', 'ZS=F': 'CBOT:ZS1!',
  'SGD=X': 'FX_IDC:USDSGD', 'MYR=X': 'FX_IDC:USDMYR', 'SGDMYR=X': 'FX_IDC:SGDMYR', 'DX-Y.NYB': 'TVC:DXY', 'JPY=X': 'FX:USDJPY',
  'CNY=X': 'FX_IDC:USDCNY', '^TNX': 'TVC:US10Y', '^IRX': 'TVC:US03MY', '^VIX': 'TVC:VIX', 'ISWD.L': 'LSE:ISWD', 'ISDU.L': 'LSE:ISDU' };
const TV_EX = { KL: 'MYX', SI: 'SGX', T: 'TSE', HK: 'HKEX', KS: 'KRX', TW: 'TWSE', AX: 'ASX', L: 'LSE', TO: 'TSX', SW: 'SIX', AS: 'EURONEXT', SS: 'SSE', SZ: 'SZSE', JK: 'IDX', HE: 'OMXHEX', MC: 'BME', MI: 'MIL', CO: 'OMXCOP' };
function tvSym(s) {
  if (TV_MACRO[s]) return TV_MACRO[s];
  const [code, ex] = s.split('.');
  if (!ex) return s.replace('-', '.');
  return `${TV_EX[ex] || ex}:${ex === 'HK' ? String(+code) : code}`;
}
function mooCode(s) {
  const [code, ex] = s.split('.');
  return !ex ? `${s.replace('-', '.')}-US` : ex === 'SI' ? `${code}-SG` : ex === 'KL' ? `${code}-MY` : ex === 'HK' ? `${code.padStart(5, '0')}-HK` : `${code}-${ex}`;
}

// ---------------------------------------------------------------- shell
// ---------------------------------------------------------------- shell
const TABS = [['mkt', 'MKT', 'Market'], ['brief', 'BRF', 'Reports'], ['quick', 'SMLL', 'Small account'], ['ideas', 'IDEA', 'Ideas'], ['screen', 'SCRN', 'Screener'],
  ['wl', 'WL', 'Watchlist'], ['paper', 'PAPR', 'Paper'], ['notes', 'NOTE', 'Notes'], ['news', 'NEWS', 'News'],
  ['media', 'TV', 'Watch'], ['learn', 'EDU', 'Learn'], ['glossary', 'GLOS', 'Terms'], ['settings', 'SET', 'Settings']];
const BNAV = ['mkt', 'quick', 'wl', 'paper'];
let cleanup = [], lastDispatch = 0, fastPoll = 0;
function shell() {
  $('#tabs').innerHTML = TABS.map(([id, k, n]) => `<a href="#${id}" data-tab="${id}"><b>${k}</b>${n}</a>`).join('');
  // Phone: every tab in one bottom bar that scrolls sideways (most-used first); the active tab scrolls into view.
  const order = [...BNAV, ...TABS.map(t => t[0]).filter(id => !BNAV.includes(id))];
  const bnEnd = () => { const n = $('#bnav'); n.classList.toggle('end', n.scrollLeft + n.clientWidth >= n.scrollWidth - 4); };
  $('#bnav').addEventListener('scroll', bnEnd, { passive: true }); addEventListener('resize', bnEnd);
  setTimeout(bnEnd, 300);
  $('#bnav').innerHTML = order.map(id => { const t = TABS.find(x => x[0] === id); return `<a href="#${id}" data-tab="${id}"><b>${t[1]}</b>${t[2].split(' ')[0]}</a>`; }).join('');
  const h = () => {
    document.documentElement.style.setProperty('--top-h', $('.top').offsetHeight + 'px');
    document.documentElement.style.setProperty('--tabs-h', $('#tabs').offsetHeight + 'px');
  };
  h(); addEventListener('resize', h);
  setInterval(tick, 15000); tick();
  // Live data every minute (Worker) or as soon as the 10-minute GitHub job publishes; snapshot every 5 minutes.
  setInterval(() => { if (document.visibilityState === 'visible') pollLive(); }, 60000);
  setInterval(() => { if (document.visibilityState === 'visible' && fastPoll > Date.now()) pollLive(); }, 20000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshMeta(); }, 300000);
  $('#cmd').addEventListener('submit', e => { e.preventDefault(); go($('#cmdIn').value); });
  $('#refresh').onclick = refreshNow;
  $('#me').onclick = () => pickProfile();
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-star]');
    if (b) { e.preventDefault(); toggleWl(b.dataset.star, b.dataset.n); $$(`[data-star="${CSS.escape(b.dataset.star)}"]`).forEach(x => x.classList.toggle('on', inWl(b.dataset.star))); return; }
    const tr = e.target.closest('tr[data-go]');
    if (tr && !e.target.closest('a,button,input,select,textarea')) location.hash = tr.dataset.go;
  });
  addEventListener('hashchange', () => route());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshMeta(); pollLive(); } });
}
function tick() {
  const n = new Date(), t = d => new Date(d).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
  $('#clock').innerHTML = `<b>SGT</b> ${t(n)} · ${LIVE ? `live ${t(LIVE.at)}` : `data ${D.summary ? ago(D.summary.at) : '–'}`}`;
  const el = $('#sessions'); if (el) el.innerHTML = sessionsHtml();
}
const typing = () => document.activeElement?.matches?.('input,textarea,select');
let lastTouch = 0;
['pointerdown', 'keydown', 'wheel', 'touchmove'].forEach(t => addEventListener(t, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));
// Background data re-renders only the price-heavy views, and never while someone is tapping or typing:
// swapping the DOM mid-tap eats the tap.
function softRoute() {
  const v = location.hash.slice(1).split('/')[0] || P().home;
  if (!['mkt', 'wl', 'paper', 'ideas', 'screen', 'quick'].includes(v)) return;
  if (typing() || Date.now() - lastTouch < 2500) { clearTimeout(softRoute.t); softRoute.t = setTimeout(softRoute, 2500); return; }
  route(true);
}
async function pollLive() {
  if (await loadLive().catch(() => false)) { processOrders(); softRoute(); }
}
// The ⟳ button: re-read everything now; with a GitHub token also ask the server for fresh quotes (~1–2 min).
async function refreshNow() {
  const b = $('#refresh'); b.classList.add('spin'); b.disabled = true;
  try {
    await refreshMeta(true);
    const changed = await loadLive();
    if (TOKEN && !CFG.worker?.url && Date.now() - lastDispatch > 120000) {
      await gh('dispatches', { method: 'POST', body: JSON.stringify({ event_type: 'refresh' }) });
      lastDispatch = Date.now(); fastPoll = Date.now() + 5 * 60000;
      toast('Fetching fresh prices on the server: about 1–2 minutes. The page updates by itself.');
    } else toast(changed ? 'Updated' : CFG.worker?.url ? 'Live prices are current' : TOKEN ? 'Already refreshing' : 'Up to date. Connect GitHub in Settings for server refresh.');
    processOrders(); route(true);
  } catch (e) { toast(`Refresh failed: ${e.message}`); }
  finally { b.classList.remove('spin'); b.disabled = false; }
}
async function refreshMeta(force = false) {
  try {
    const m = await (await fetch(`${RAW}market/meta.json?_=${Date.now()}`, { cache: 'no-store' })).json();
    if (m.salt !== META.salt) { store.del('k'); store.set('meta', m); toast('The family password was changed. Please unlock again.'); setTimeout(() => location.reload(), 1500); return; }
    if (m.at !== META.at || force) {
      const fresh = m.at !== META.at;
      META = m; store.set('meta', m);
      if (fresh) { files.clear(); D.uni = null; D.bySym.clear(); D.summary = await mk('summary.bin'); await universe(); applyLive(); toast('New market snapshot loaded'); if (!force) softRoute(); }
    }
  } catch {}
}
function fillCmd() {
  const opts = D.uni.map(r => `<option value="${esc(r.s)}">${esc(r.n)}</option>`);
  for (const rows of Object.values(D.summary.macro)) rows.forEach(r => opts.push(`<option value="${esc(r.s)}">${esc(r.n)}</option>`));
  $('#cmdList').innerHTML = opts.join('');
}
async function go(q) {
  q = q.trim(); if (!q) return;
  const tab = TABS.find(t => t[1].toLowerCase() === q.toLowerCase() || t[0] === q.toLowerCase());
  if (tab) { location.hash = tab[0]; $('#cmdIn').value = ''; return; }
  await universe();
  const U = q.toUpperCase();
  const all = [...D.uni, ...Object.values(D.summary.macro).flat()];
  const hit = all.find(r => r.s === U) || all.find(r => r.s.split('.')[0] === U) || all.find(r => r.s === U + '.KL' || r.s === U + '.SI')
    || all.find(r => (r.n || '').toUpperCase().startsWith(U)) || all.find(r => (r.n || '').toUpperCase().includes(U));
  location.hash = `stock/${encodeURIComponent(hit ? hit.s : U)}`;
  $('#cmdIn').value = ''; $('#cmdIn').blur();
}
async function route(keep = false) {
  if (!ME) return;
  cleanup.forEach(f => { try { f(); } catch {} }); cleanup = [];
  const [v, ...rest] = location.hash.slice(1).split('/');
  const view = VIEWS[v] ? v : P().home in VIEWS ? P().home : 'mkt';
  const tab = view === 'stock' ? '' : view === 'reports' ? 'brief' : view;
  $$('#tabs a, #bnav a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  const on = $('#bnav a.on'), bn = $('#bnav');  // scroll the bar only, never the page
  if (on && bn.scrollWidth > bn.clientWidth) bn.scrollTo({ left: on.offsetLeft - bn.clientWidth / 2 + on.offsetWidth / 2, behavior: 'smooth' });
  const main = $('#main'), y = scrollY;
  if (!keep) main.innerHTML = '<p class="muted">Loading…</p>';
  try { await VIEWS[view](decodeURIComponent(rest.join('/')), main); }
  catch (e) { console.error(e); main.innerHTML = `<div class="warn">Couldn't load this view: ${esc(e.message)}. Check your connection and tap ⟳.</div>`; }
  if (keep) scrollTo(0, y); else if (!location.hash.includes('/')) scrollTo(0, 0);
  $('#foot').innerHTML = `${esc(ME.name)} · snapshot ${esc(sgt(D.summary.at))} SGT (${esc(D.summary.mode)})${LIVE ? ` · live prices ${esc(sgt(LIVE.at, { hour: '2-digit', minute: '2-digit' }))} via ${liveFrom === 'worker' ? 'Cloudflare Worker' : 'GitHub (every ~10 min)'}` : ''} · Bursa/SGX quotes delayed ~15 min · statistical outlooks, not certainties · educational, not financial advice`;
}

// ---------------------------------------------------------------- market sessions (SGT)
const SESS = [
  { n: 'Bursa Malaysia', tz: 'Asia/Kuala_Lumpur', s: [[540, 750], [870, 1020]], pre: [510, 540] },
  { n: 'SGX', tz: 'Asia/Singapore', s: [[540, 1020]], pre: [510, 540] },
  { n: 'US (NYSE · Nasdaq)', tz: 'America/New_York', s: [[570, 960]], pre: [240, 570], post: [960, 1200] },
  { n: 'Tokyo', tz: 'Asia/Tokyo', s: [[540, 690], [750, 930]] },
  { n: 'Hong Kong', tz: 'Asia/Hong_Kong', s: [[570, 720], [780, 960]] },
  { n: 'London', tz: 'Europe/London', s: [[480, 990]] },
];
function zoned(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { wd: p.weekday, m: (+p.hour % 24) * 60 + +p.minute };
}
function sessionsHtml() {
  return SESS.map(x => {
    const { wd, m } = zoned(x.tz), wkend = wd === 'Sat' || wd === 'Sun';
    const open = !wkend && x.s.some(([a, b]) => m >= a && m < b);
    const lunch = !wkend && !open && x.s.length > 1 && m >= x.s[0][1] && m < x.s[1][0];
    const pre = !wkend && !open && ((x.pre && m >= x.pre[0] && m < x.pre[1]) || (x.post && m >= x.post[0] && m < x.post[1]));
    const offset = zoned('Asia/Singapore').m - m;  // minutes SGT is ahead of the market (mod day)
    const toSgt = mins => { const t = ((mins + offset) % 1440 + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
    const hours = x.s.map(([a, b]) => `${toSgt(a)}–${toSgt(b)}`).join(', ');
    let next = '';
    if (!open && !wkend) { const n = x.s.find(([a]) => a > m); if (n) { const d = n[0] - m; next = ` · opens in ${Math.floor(d / 60)}h ${d % 60}m`; } }
    const st = open ? 'open' : lunch ? 'lunch' : pre ? 'pre' : '';
    return `<div><b><span class="dot ${st}"></span>${esc(x.n)}</b>${open ? 'OPEN' : lunch ? 'LUNCH BREAK' : pre ? (x.post && m >= x.post[0] ? 'AFTER-HOURS' : 'PRE-MARKET') : 'CLOSED'}${next}<br><span class="dim">${hours} SGT</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- views
const VIEWS = {};

VIEWS.mkt = async (_, main) => {
  const S = D.summary;
  const tbl = rows => `<div class="tw"><table><thead><tr><th>Name</th><th>Last</th><th>1D</th><th>1W</th><th>1M</th><th>YTD</th><th>RSI</th><th class="l">Trend bias</th>
    <th title="Probability of being higher in ~1 week">↑1W</th><th title="~1 month">↑1M</th><th title="~3 months">↑3M</th></tr></thead><tbody>${rows.map(r => `
    <tr class="go" data-go="stock/${encodeURIComponent(r.s)}"><td class="l"><span class="sym">${esc(r.n)}</span></td><td>${px(r.px)}</td><td>${pct(r.r1)}</td><td>${pct(r.r5)}</td>
    <td>${pct(r.r21)}</td><td>${pct(r.ytd)}</td><td>${r.rsi == null ? '–' : r.rsi.toFixed(0)}</td><td class="l">${biasHtml(r.bias)}</td>
    <td>${fcCell(r.fc, 5)}</td><td>${fcCell(r.fc, 21)}</td><td>${fcCell(r.fc, 63)}</td></tr>`).join('')}</tbody></table></div>`;
  const key = ['^GSPC', '^IXIC', '^KLSE', '^STI', 'GC=F', 'CL=F', 'SGD=X', 'MYR=X'].map(macroRow).filter(Boolean);
  const outlook = key.map(r => {
    const f = h => r.fc?.[h] ? `<b class="${r.fc[h].up >= .55 ? 'up' : r.fc[h].up <= .45 ? 'down' : 'flat'}">${pctp(r.fc[h].up)}</b> <span class="dim">${px(r.fc[h].lo)}–${px(r.fc[h].hi)}</span>` : '–';
    return `<tr class="go" data-go="stock/${encodeURIComponent(r.s)}"><td class="l sym">${esc(r.n)}</td><td>${px(r.px)}</td><td class="l">${biasHtml(r.bias)}</td><td>${f(5)}</td><td>${f(21)}</td><td>${f(63)}</td></tr>`;
  }).join('');
  const tr = S.track || {};
  const track = Object.keys(tr).length ? Object.entries(tr).map(([h, t]) => `${h === '5' ? '1-week' : '1-month'} calls: <b class="${t.hit >= .55 ? 'up' : t.hit < .5 ? 'down' : 'flat'}">${pctp(t.hit)}</b> right (${t.n} scored)`).join(' · ')
    : 'No calls have matured yet. The first 1-week calls get scored about 7 days after launch.';
  main.innerHTML = `
    <div class="sessions" id="sessions">${sessionsHtml()}</div>
    <div class="grid wide">
      ${panel('Outlook · next days / weeks / months', `<div class="tw"><table><thead><tr><th>Market</th><th>Last</th><th class="l" title="Current trend state. Probabilities to the right are what historically happened next, which can differ (e.g. oversold bounces).">Trend now</th><th>~1 week: P(up) · range</th><th>~1 month</th><th>~3 months</th></tr></thead><tbody>${outlook}</tbody></table></div>
        <div class="pb note">How this works: each day we score the trend (moving averages, MACD, RSI, momentum) from −100 to +100, then look up how often prices rose after the same score over the last 2 years, and the typical range (68% band). Model track record: ${track}</div>`, '', 'span')}
      ${Object.entries(S.macro).map(([g, rows]) => panel(esc(g), tbl(rows))).join('')}
      <div id="breadth" class="span"></div>
      ${['US', 'MY', 'SG', 'GL'].filter(m => S.movers[`${m}-up`]).map(m => panel(`${MKT[m]} · top compliant movers`, `<div class="grid" style="gap:0">${moverTable(S.movers[`${m}-up`], 'Gainers')}${moverTable(S.movers[`${m}-down`], 'Losers')}</div>`)).join('')}
    </div>`;
  const U = await universe();
  const sec = {};
  for (const r of U) if (r.st === 'C' || r.st === 'P') { const k = `${r.m}|${r.sec || 'Other'}`; (sec[k] ||= []).push(r); }
  const rows = Object.entries(sec).filter(([, v]) => v.length >= 3).map(([k, v]) => {
    const [m, s] = k.split('|'), avg = f => v.reduce((a, r) => a + (r[f] || 0), 0) / v.length;
    return { m, s, n: v.length, r1: avg('r1'), r5: avg('r5'), r21: avg('r21'), up: v.filter(r => (r.r1 || 0) > 0).length / v.length, sc: avg('score') };
  }).sort((a, b) => b.r5 - a.r5);
  $('#breadth').innerHTML = panel('Sector heat · Shariah-compliant names (equal-weighted)', `<div class="tw"><table><thead><tr><th>Market</th><th class="l">Sector</th><th>Names</th><th>1D</th><th>1W</th><th>1M</th><th>% up today</th><th>Avg trend score</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="go" data-go="screen/${r.m}|${encodeURIComponent(r.s)}"><td class="l">${r.m}</td><td class="l">${esc(r.s)}</td><td>${r.n}</td><td>${pct(r.r1)}</td><td>${pct(r.r5)}</td><td>${pct(r.r21)}</td><td>${pctp(r.up)}</td><td class="${cls(r.sc)}">${r.sc.toFixed(0)}</td></tr>`).join('')}</tbody></table></div>`);
};
const moverTable = (rows, t) => `<div class="tw"><table><thead><tr><th>${t}</th><th>Last</th><th>1D</th><th>Rel vol</th><th class="l">Status</th></tr></thead><tbody>${(rows || []).map(r => `
  <tr class="go" data-go="stock/${encodeURIComponent(r.s)}">${symCell(r)}<td>${px(r.px)}</td><td>${pct(r.r1)}</td><td>${r.rv ? r.rv.toFixed(1) + '×' : '–'}</td><td class="l">${badge(r.st)}</td></tr>`).join('')}</tbody></table></div>`;

VIEWS.reports = (id, main) => VIEWS.brief(id, main);
VIEWS.brief = async (id, main) => {
  const list = D.summary.reports || [];
  if (!list.length) { main.innerHTML = '<div class="warn">No reports yet. Daily briefs arrive ~06:30 SGT (Mon–Sat); the full weekly report on Sundays at 17:00 SGT.</div>'; return; }
  const filt = store.get('rf', 'all');
  const shown = list.filter(r => filt === 'all' || r.kind === filt);
  const cur = list.find(r => r.id === id) || shown[0] || list[0];
  main.innerHTML = `<div class="side"><nav class="toc">${['all', 'daily', 'weekly'].map(k => `<a href="#brief" data-rf="${k}" class="${filt === k ? 'on' : ''}">${k.toUpperCase()}</a>`).join('')}
    <hr style="border-color:#222;width:100%">${shown.slice(0, 120).map(r => `<a href="#reports/${r.id}" class="${r.id === cur.id ? 'on' : ''}">${r.kind === 'weekly' ? '★ WEEKLY' : 'DAILY'} · ${esc(sgt(r.at, { weekday: 'short', day: 'numeric', month: 'short' }))}</a>`).join('')}</nav>
    <article class="panel"><div class="ph"><h2>${cur.kind === 'weekly' ? 'Weekly report' : 'Daily brief'} · ${esc(sgt(cur.at))} SGT</h2><span class="note">written by ${esc(cur.by)}</span></div><div class="pb md" id="rep">Loading…</div></article></div>`;
  $$('[data-rf]', main).forEach(a => a.onclick = e => { e.preventDefault(); store.set('rf', a.dataset.rf); route(); });
  const rep = await mk(`reports/${cur.id}.bin`);
  $('#rep').innerHTML = (rep.unverified?.length ? `<div class="warn">Number check: ${rep.unverified.length} figure(s) in the AI text weren't found in the source data (${esc(rep.unverified.slice(0, 8).join(', '))}${rep.unverified.length > 8 ? '…' : ''}). Trust the data appendix at the bottom over the prose.</div>` : '')
    + md(rep.md);
  $$('#rep a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
};

VIEWS.ideas = async (mkt, main) => {
  mkt = MKT[mkt] ? mkt : store.get(`im:${ME.id}`, P().mkt);
  store.set(`im:${ME.id}`, mkt);
  const I = D.summary.ideas;
  const inv = I[`${mkt}-invest`] || [], day = I[`${mkt}-day`] || [];
  const t = (rows, kind) => `<div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Name</th><th class="l">Status</th><th>Score</th><th>Last</th><th>1D</th><th>1M</th><th>3M</th><th>RSI</th>
    ${kind === 'inv' ? '<th>P/E</th><th>ROE</th>' : '<th>ATR%</th><th>Rel vol</th><th>$ traded/day</th>'}<th class="l">Bias</th><th>↑1W</th><th>↑1M</th><th>↑3M</th></tr></thead><tbody>${rows.map(r => `
    <tr class="go" data-go="stock/${encodeURIComponent(r.s)}">${symCell(r)}<td class="nm l">${esc(r.n)}</td><td class="l">${badge(r.st)}</td><td><span class="bar" style="width:${(r[kind] || 0) * .4}px"></span> ${r[kind] ?? '–'}</td>
    <td>${px(r.px)}</td><td>${pct(r.r1)}</td><td>${pct(r.r21)}</td><td>${pct(r.r63)}</td><td>${r.rsi?.toFixed(0) ?? '–'}</td>
    ${kind === 'inv' ? `<td>${r.pe ? r.pe.toFixed(1) : '–'}</td><td>${pct(r.roe, 0)}</td>` : `<td>${r.atr ? (r.atr * 100).toFixed(1) + '%' : '–'}</td><td>${r.rv ? r.rv.toFixed(1) + '×' : '–'}</td><td>${big(r.valusd)}</td>`}
    <td class="l">${biasHtml(r.bias)}</td><td>${fcCell(r.fc, 5)}</td><td>${fcCell(r.fc, 21)}</td><td>${fcCell(r.fc, 63)}</td></tr>`).join('')}</tbody></table></div>`;
  main.innerHTML = `<div class="row" style="margin-bottom:12px"><div class="chips">${Object.entries(MKT).map(([k, n]) => `<a class="chip ${k === mkt ? 'on' : ''}" href="#ideas/${k}">${n}</a>`).join('')}</div></div>
    <div class="grid wide">
    ${panel(`${MKT[mkt]} · invest / swing ideas`, t(inv, 'inv') + `<div class="pb note">Score = 30% trend + 20% momentum (3M and 12M) + 30% quality (ROE + margin) + 20% value (P/E), ranked within the market. Names in an uptrend (trend score &gt; 0) come first; check the Bias column, because in a falling market the list fills with downtrend names. Shariah status C or P only, and more than US$1M traded a day.</div>`, '', 'span')}
    ${panel(`${MKT[mkt]} · day-trade / short-swing watch`, t(day, 'day') + `<div class="pb note">Score = 40% liquidity + 25% daily range in the 2–7% ATR sweet spot + 20% unusual volume + 15% trend. Day trading in a Shariah way: cash account, compliant names only, no short selling, no margin interest. Plan entries and stops before the open (see Learn → Day trading).</div>`, '', 'span')}
    ${panel('Status legend', `<div class="pb">${Object.entries(STATUS).map(([k, v]) => `<p>${badge(k)} ${esc(v)}</p>`).join('')}<p class="note">Malaysia: the SC Shariah Advisory Council list (as at ${esc(D.summary.sc?.asof || '?')}${D.summary.sc?.patched ? ', plus the May 2026 changes reported in the press' : ''}) is the authority. US / global: membership of the S&P 500 Shariah and S&P Shariah world indices (via SP Funds ETF holdings). Singapore and others: our AAOIFI-style screen (debt and cash each under 30% of market cap, no prohibited business). <b>P is not a fatwa:</b> verify on Musaffa / Zoya and check the annual report before buying.</p></div>`)}
    </div>`;
};

VIEWS.screen = async (arg, main) => {
  const U = await universe();
  const [am, as] = (arg || '').split('|');
  const F = Object.assign({ m: 'ALL', st: 'CP', q: '', sec: 'ALL', sort: 'valusd', dir: -1 }, store.get('scr', {}), am ? { m: am, sec: as || 'ALL' } : {});
  const secs = [...new Set(U.map(r => r.sec).filter(Boolean))].sort();
  const cols = [['s', 'Ticker'], ['n', 'Name'], ['m', 'Mkt'], ['st', 'Status'], ['px', 'Last'], ['r1', '1D'], ['r21', '1M'], ['r63', '3M'], ['r252', '1Y'], ['rsi', 'RSI'],
    ['score', 'Trend'], ['fc21', '↑1M'], ['pe', 'P/E'], ['roe', 'ROE'], ['dy', 'Div yld'], ['dm', 'Debt/MC'], ['cm', 'Cash/MC'], ['mc', 'Mkt cap'], ['valusd', '$/day']];
  main.innerHTML = `<div class="row" style="margin-bottom:10px">
    <select class="f" id="fm"><option value="ALL">All markets</option>${Object.entries(MKT).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
    <select class="f" id="fst"><option value="CP">Compliant (C+P)</option><option value="C">Certified only</option><option value="P">Passes screen only</option><option value="R">Needs review</option><option value="F">Non-compliant</option><option value="ALL">Everything</option></select>
    <select class="f" id="fsec"><option value="ALL">All sectors</option>${secs.map(s => `<option>${esc(s)}</option>`).join('')}</select>
    <input class="f sp" id="fq" placeholder="Filter by ticker or name" value="${esc(F.q)}"><span class="note" id="fn"></span></div>
    <div class="panel"><div class="tw" style="max-height:calc(100svh - 230px)"><table id="st"><thead><tr>${cols.map(([k, n]) => `<th class="s ${['s', 'n', 'm', 'st'].includes(k) ? 'l' : ''}" data-k="${k}">${n}${F.sort === k ? (F.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody></tbody></table></div></div>
    <p class="note">Debt/MC and Cash/MC are the AAOIFI-style ratios (both must be under 30%). Malaysian names use the SC list instead. Showing up to 300 rows. Tap a column to sort.</p>`;
  $('#fm').value = F.m; $('#fst').value = F.st; $('#fsec').value = secs.includes(F.sec) ? F.sec : 'ALL';
  const val = (r, k) => k === 'fc21' ? r.fc?.['21']?.up : r[k];
  const draw = () => {
    store.set('scr', { ...F, q: F.q });
    const q = F.q.toLowerCase();
    let rows = U.filter(r => (F.m === 'ALL' || r.m === F.m) && (F.st === 'ALL' || F.st.includes(r.st)) && (F.sec === 'ALL' || r.sec === F.sec)
      && (!q || r.s.toLowerCase().includes(q) || (r.n || '').toLowerCase().includes(q)));
    rows.sort((a, b) => { const x = val(a, F.sort), y = val(b, F.sort); return x == null ? 1 : y == null ? -1 : (x > y ? 1 : x < y ? -1 : 0) * F.dir; });
    $('#fn').textContent = `${rows.length} names`;
    $('#st tbody').innerHTML = rows.slice(0, 300).map(r => `<tr class="go" data-go="stock/${encodeURIComponent(r.s)}">${symCell(r)}<td class="nm l">${esc(r.n)}</td><td class="l">${r.m}</td><td class="l">${badge(r.st)}</td>
      <td>${px(r.px)}</td><td>${pct(r.r1)}</td><td>${pct(r.r21)}</td><td>${pct(r.r63)}</td><td>${pct(r.r252, 0)}</td><td>${r.rsi?.toFixed(0) ?? '–'}</td><td class="${cls(r.score)}">${r.score?.toFixed(0) ?? '–'}</td>
      <td>${fcCell(r.fc, 21)}</td><td>${r.pe ? r.pe.toFixed(1) : '–'}</td><td>${pct(r.roe, 0)}</td><td>${r.dy == null ? '–' : r.dy.toFixed(1) + '%'}</td>
      <td class="${r.dm >= .3 ? 'down' : ''}">${pctp(r.dm)}</td><td class="${r.cm >= .3 ? 'down' : ''}">${pctp(r.cm)}</td><td>${big(r.mc)}</td><td>${big(r.valusd)}</td></tr>`).join('');
    $$('#st th').forEach(th => th.textContent = cols.find(c => c[0] === th.dataset.k)[1] + (F.sort === th.dataset.k ? (F.dir > 0 ? ' ▲' : ' ▼') : ''));
  };
  $('#fm').onchange = e => { F.m = e.target.value; draw(); };
  $('#fst').onchange = e => { F.st = e.target.value; draw(); };
  $('#fsec').onchange = e => { F.sec = e.target.value; draw(); };
  $('#fq').oninput = e => { F.q = e.target.value; draw(); };
  $$('#st th').forEach(th => th.onclick = () => { F.dir = F.sort === th.dataset.k ? -F.dir : ['s', 'n', 'm', 'st'].includes(th.dataset.k) ? 1 : -1; F.sort = th.dataset.k; draw(); });
  draw();
};

const kv = pairs => pairs.map(([k, v]) => `<div><small>${esc(k)}</small><span>${v}</span></div>`).join('');
function techRead(r) {
  const t = [];
  if (r.sma200) t.push(r.px > r.sma200 ? 'Above its 200-day average (long-term uptrend).' : 'Below its 200-day average (long-term downtrend).');
  if (r.sma50 && r.sma200) t.push(r.sma50 > r.sma200 ? '50-day is above the 200-day (golden-cross regime).' : '50-day is below the 200-day (death-cross regime).');
  if (r.rsi != null) t.push(r.rsi >= 70 ? `RSI ${r.rsi.toFixed(0)}: overbought, pullback risk.` : r.rsi <= 30 ? `RSI ${r.rsi.toFixed(0)}: oversold, bounce possible but trend is weak.` : `RSI ${r.rsi.toFixed(0)}: neutral zone.`);
  if (r.macd != null) t.push(r.macd > 0 ? 'MACD histogram positive (momentum improving).' : 'MACD histogram negative (momentum fading).');
  if (r.hi52 && r.px >= r.hi52 * .97) t.push('Trading near its 52-week high.');
  return t.join(' ');
}
let chartApi = null, chartCleanup = null;
function drawChart(b, r, weekly = false) {
  const LW = window.LightweightCharts, el = $('#ch');
  const chart = LW.createChart(el, {
    autoSize: true, layout: { background: { color: '#000' }, textColor: '#8c8c8c', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 },
    grid: { vertLines: { color: '#121212' }, horzLines: { color: '#121212' } }, crosshair: { mode: 0 },
    // Weekly full-history view on a log scale: equal % moves look equal, and decades of small prices aren't a flat line.
    rightPriceScale: { borderColor: '#2a2a2a', scaleMargins: { top: .05, bottom: .32 }, mode: weekly ? 1 : 0 }, timeScale: { borderColor: '#2a2a2a', rightOffset: 4 },
    localization: { priceFormatter: px },
  });
  chartCleanup = () => { chart.remove(); chartApi = null; };
  cleanup.push(chartCleanup);
  const n = b.t.length, data = [];
  for (let i = 0; i < n; i++) if (b.c[i] != null && b.o[i] != null) data.push({ time: b.t[i], open: b.o[i], high: b.h[i] ?? b.c[i], low: b.l[i] ?? b.c[i], close: b.c[i] });
  const cs = chart.addCandlestickSeries({ upColor: '#2bd96b', downColor: '#ff4d4d', borderVisible: false, wickUpColor: '#2bd96b', wickDownColor: '#ff4d4d' });
  cs.setData(data);
  const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: .7, bottom: .16 } });
  vol.setData(data.map((d, i) => ({ time: d.time, value: b.v[b.t.indexOf(d.time)] || 0, color: d.close >= d.open ? '#2bd96b44' : '#ff4d4d44' })));
  const closes = data.map(d => d.close);
  const sma = (p, color) => {
    const out = []; let sum = 0;
    closes.forEach((c, i) => { sum += c; if (i >= p) sum -= closes[i - p]; if (i >= p - 1) out.push({ time: data[i].time, value: sum / p }); });
    chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(out);
  };
  if (weekly) { sma(10, '#5fb4ff'); sma(40, '#c38cff'); } else { sma(20, '#ffe14d'); sma(50, '#5fb4ff'); sma(200, '#c38cff'); }
  // RSI(14), Wilder smoothing, on its own scale at the bottom.
  const rsi = []; let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    if (i >= 14) rsi.push({ time: data[i].time, value: al === 0 ? 100 : 100 - 100 / (1 + ag / al) });
  }
  const rs = chart.addLineSeries({ color: '#3fd0d0', lineWidth: 1, priceScaleId: 'rsi', priceLineVisible: false, lastValueVisible: true });
  chart.priceScale('rsi').applyOptions({ scaleMargins: { top: .86, bottom: .01 } });
  rs.setData(rsi);
  rs.createPriceLine({ price: 70, color: '#ff4d4d55', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  rs.createPriceLine({ price: 30, color: '#2bd96b55', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
  // Forecast cone: trading days ahead, skipping weekends.
  const last = data[data.length - 1];
  const ahead = k => { let t = last.time; for (let i = 0; i < k;) { t += 86400; const wd = new Date(t * 1000).getUTCDay(); if (wd && wd !== 6) i++; } return t; };
  const pts = weekly ? [] : [[5], [21], [63]].map(([h]) => [h, r.fc?.[h] || r.fc?.[String(h)]]).filter(x => x[1]);
  // Empty bars for each future trading day, so the cone gets real width instead of three squeezed slots.
  if (pts.length) chart.addLineSeries({ lastValueVisible: false, priceLineVisible: false }).setData(Array.from({ length: pts[pts.length - 1][0] }, (_, i) => ({ time: ahead(i + 1) })));
  if (pts.length) for (const [k, c] of [['lo', '#ffa02899'], ['mid', '#ffa028'], ['hi', '#ffa02899']]) {
    chart.addLineSeries({ color: c, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      .setData([{ time: last.time, value: last.close }, ...pts.map(([h, f]) => ({ time: ahead(h), value: f[k] }))]);
  }
  const lg = $('#lg');
  chart.subscribeCrosshairMove(p => {
    const d = p.time && p.seriesData.get(cs);
    lg.innerHTML = d ? `${new Date(p.time * 1000).toISOString().slice(0, 10)} O ${px(d.open)} H ${px(d.high)} L ${px(d.low)} C <b style="color:${d.close >= d.open ? '#2bd96b' : '#ff4d4d'}">${px(d.close)}</b>` : '';
  });
  chartApi = {
    remove: chartCleanup,
    range: k => {
      if (k === 'MAX') return chart.timeScale().fitContent();
      const days = { '3M': 92, '6M': 183, '1Y': 366, '2Y': 740, '5Y': 1830 }[k];
      chart.timeScale().setVisibleRange({ from: Math.max(data[0].time, last.time - days * 86400), to: pts.length ? ahead(pts[pts.length - 1][0]) : last.time });
    },
  };
}

VIEWS.news = async (_, main) => {
  const S = D.summary, groups = [...new Set(S.news.map(n => n.g))];
  const g = store.get('ng', 'All');
  const items = S.news.filter(n => g === 'All' || n.g === g);
  const byDay = {};
  for (const e of S.calendar || []) (byDay[sgt(e.at, { weekday: 'short', day: 'numeric', month: 'short' })] ||= []).push(e);
  const brk = myNews(LIVE?.news).filter(n => n.src);
  main.innerHTML = `<div class="grid wide">
    ${panel(`Breaking · your ${P().news.sources.length} outlets${LIVE ? ` · updated ${esc(sgt(LIVE.at, { hour: '2-digit', minute: '2-digit' }))}` : ''}`, `<ul class="list">${brk.slice(0, 40).map(n => `<li><span class="tag">${esc(n.s)}</span> <a href="${esc(safe(n.u))}" target="_blank" rel="noopener">${esc(n.t)}</a><br><small>${n.at ? esc(ago(n.at)) : ''}</small></li>`).join('') || '<li class="muted">No fresh headlines from your outlets yet. Choose outlets in Settings → Breaking news.</li>'}</ul>`, '<a class="note" href="#settings">choose outlets</a>')}
    ${panel('Headlines', `<div class="pb chips">${['All', ...groups].map(x => `<button class="chip ${x === g ? 'on' : ''}" data-g="${esc(x)}">${esc(x)}</button>`).join('')}</div>
      <ul class="list">${items.map(n => `<li><span class="tag">${esc(n.g)}${n.sym ? ' · ' + esc(n.sym) : ''}</span> <a href="${esc(safe(n.u))}" target="_blank" rel="noopener">${esc(n.t)}</a><br><small>${esc(n.s || '')} · ${n.at ? esc(ago(n.at)) : ''}</small></li>`).join('')}</ul>`)}
    ${panel('Economic calendar this week (SGT)', `<div class="tw"><table><thead><tr><th>Time</th><th class="l">Ccy</th><th class="l">Event</th><th class="l">Impact</th><th>Forecast</th><th>Previous</th></tr></thead><tbody>
      ${Object.entries(byDay).map(([d, es]) => `<tr><td colspan="6" class="l amber">${esc(d)}</td></tr>` + es.map(e => `<tr><td>${esc(sgt(e.at, { hour: '2-digit', minute: '2-digit', hour12: false }))}</td><td class="l">${esc(e.c)}</td><td class="l">${esc(e.t)}</td>
      <td class="l"><span class="tag ${e.i === 'High' ? 'bear' : 'neu'}">${esc(e.i)}</span></td><td>${esc(e.f || '–')}</td><td>${esc(e.p || '–')}</td></tr>`).join('')).join('')}</tbody></table></div>
      <p class="pb note">Major-currency events from Forex Factory. Malaysia/Singapore releases (BNM OPR decisions, MAS policy statements, SG CPI, MY trade data) are on the links below.</p>`)}
    ${panel('Upcoming earnings', `<ul class="list">${(S.earnings || []).map(e => `<li><a href="#stock/${encodeURIComponent(e.s)}">${esc(e.s)}</a> ${esc(e.n)} <small>${esc(sgt(e.at))} SGT</small></li>`).join('') || '<li class="muted">None soon.</li>'}</ul>`)}
    ${panel('Where to read more', `<div class="pb">${RESOURCES.news.map(([t, u, d]) => `<p><a href="${esc(safe(u))}" target="_blank" rel="noopener">${esc(t)}</a> <span class="note">${esc(d)}</span></p>`).join('')}</div>`)}
  </div>`;
  $$('[data-g]', main).forEach(b => b.onclick = () => { store.set('ng', b.dataset.g); route(); });
};

VIEWS.learn = async (id, main) => {
  const cur = LEARN.find(x => x.id === id) || LEARN[0];
  main.innerHTML = `<div class="side"><nav class="toc">${LEARN.map(x => `<a href="#learn/${x.id}" class="${x.id === cur.id ? 'on' : ''}">${esc(x.t)}</a>`).join('')}</nav>
    <article class="panel"><div class="ph"><h2>${esc(cur.t)}</h2><span class="note">${esc(cur.lvl || '')}</span></div><div class="pb md">${cur.html}${cur.id === 'candles' ? patternsHtml() : ''}</div></article></div>`;
};
function patternsHtml() {
  return `<h2>Pattern library</h2><p class="note">Green = bullish candle, red = bearish. Grey candles show the trend before the pattern; patterns only matter at the right place (after a trend, at support/resistance) and with confirmation.</p>
    <div class="candles">${PATTERNS.map(p => `<div class="candle"><h4>${esc(p.n)} <span class="tag ${p.k}">${p.k === 'bull' ? 'bullish' : p.k === 'bear' ? 'bearish' : 'neutral'}</span> <span class="tag">${esc(p.r)}</span></h4>${candleSvg(p.c, p.ctx)}<p>${p.d}</p><p class="note">${p.t}</p></div>`).join('')}</div>`;
}

VIEWS.glossary = async (_, main) => {
  const q = store.get('gq', ''), lvl = store.get('gl', 'ALL');
  main.innerHTML = `<div class="row" style="margin-bottom:10px"><input class="f sp" id="gq" placeholder="Search ${GLOSSARY.length} terms" value="${esc(q)}">
    <div class="chips">${[['ALL', 'All'], ['B', 'Basic'], ['I', 'Intermediate'], ['A', 'Advanced'], ['S', 'Shariah']].map(([k, n]) => `<button class="chip ${k === lvl ? 'on' : ''}" data-l="${k}">${n}</button>`).join('')}</div></div>
    <section class="panel"><dl class="gl" id="gll"></dl></section>`;
  const draw = () => {
    const qq = $('#gq').value.toLowerCase(), l = store.get('gl', 'ALL');
    store.set('gq', $('#gq').value);
    $('#gll').innerHTML = GLOSSARY.filter(g => (l === 'ALL' || g.l === l) && (!qq || g.t.toLowerCase().includes(qq) || g.d.toLowerCase().includes(qq)))
      .sort((a, b) => a.t.localeCompare(b.t)).map(g => `<dt>${esc(g.t)} <span class="tag">${{ B: 'basic', I: 'inter', A: 'adv', S: 'shariah' }[g.l]}</span></dt><dd>${g.d}</dd>`).join('') || '<dd class="muted">No match.</dd>';
  };
  $('#gq').oninput = draw;
  $$('[data-l]', main).forEach(b => b.onclick = () => { store.set('gl', b.dataset.l); $$('[data-l]', main).forEach(x => x.classList.toggle('on', x === b)); draw(); });
  draw();
};

VIEWS.wl = async (_, main) => {
  const U = await universe();
  const moo = await readData('moomoo.bin').catch(() => null);
  const rows = wlItems().map(w => ({ w, r: D.bySym.get(w.s) || macroRow(w.s) }));
  main.innerHTML = `<div class="grid wide">${panel(`${esc(ME.name)}'s watchlist`, `
    <form class="row pb" id="wlAdd"><input class="f sp" id="wlIn" list="cmdList" placeholder="Add ticker: AAPL, 5347.KL, D05.SI, 7203.T" autocapitalize="characters"><button class="btn">ADD</button></form>
    <div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Name</th><th class="l">Status</th><th>Last</th><th>1D</th><th>1W</th><th>1M</th><th>RSI</th><th class="l">Bias</th><th>↑1W</th><th>↑1M</th>
      <th title="Push alert when price goes above">Alert ≥</th><th title="Push alert when price goes below">Alert ≤</th><th class="l">Notes</th><th></th></tr></thead><tbody>
    ${rows.map(({ w, r }) => `<tr data-s="${esc(w.s)}"><td class="l"><a class="sym" href="#stock/${encodeURIComponent(w.s)}">${esc(w.s)}</a></td><td class="nm l">${esc(r?.n || w.n)}</td>
      <td class="l">${r ? badge(r.st) : '<span class="note">next update</span>'}</td><td>${px(r?.px)}${r?.live ? ' <span class="up" title="live">•</span>' : ''}</td><td>${pct(r?.r1)}</td><td>${pct(r?.r5)}</td><td>${pct(r?.r21)}</td><td>${r?.rsi?.toFixed(0) ?? '–'}</td>
      <td class="l">${biasHtml(r?.bias)}</td><td>${fcCell(r?.fc, 5)}</td><td>${fcCell(r?.fc, 21)}</td>
      <td><input class="f" style="width:84px" inputmode="decimal" data-f="above" value="${w.above ?? ''}"></td><td><input class="f" style="width:84px" inputmode="decimal" data-f="below" value="${w.below ?? ''}"></td>
      <td class="l"><input class="f" style="width:220px" data-f="note" value="${esc(w.note || '')}" placeholder="Why am I watching this?"></td>
      <td><button class="btn sm ghost" data-rm aria-label="Remove">✕</button></td></tr>`).join('') || '<tr><td colspan="15" class="l muted">Empty. Add tickers above, or tap ★ anywhere.</td></tr>'}
    </tbody></table></div>
    <p class="pb note">${esc(syncMsg || (TOKEN ? 'Synced across your devices.' : 'Saved on this device. Connect GitHub in Settings → Family to sync and get alerts.'))} Alerts (price ≥/≤, moves of ±${P().move}% or more) are checked about every 10 minutes by the live job, or every minute with the Cloudflare Worker.</p>`, '', 'span')}
    ${moo ? panel(`moomoo · snapshot ${esc(sgt(moo.at))} SGT`, mooHtml(moo), '', 'span') : ''}
    ${panel('Upcoming earnings (watchlists + big certified names)', `<ul class="list">${(D.summary.earnings || []).map(e => `<li><a href="#stock/${encodeURIComponent(e.s)}">${esc(e.s)}</a> ${esc(e.n)} <small>${esc(sgt(e.at))} SGT</small></li>`).join('') || '<li class="muted">None in the next 3 weeks.</li>'}</ul>`)}
    </div>`;
  $('#wlAdd').onsubmit = e => {
    e.preventDefault();
    const raw = $('#wlIn').value.trim().toUpperCase(); if (!raw) return;
    const s = U.find(r => r.s === raw)?.s || U.find(r => r.s.split('.')[0] === raw)?.s || raw;
    if (!inWl(s)) toggleWl(s, U.find(r => r.s === s)?.n);
    route(true);
  };
  $$('tr[data-s]', main).forEach(tr => {
    const w = ST.wl.find(x => x.s === tr.dataset.s);
    $$('input[data-f]', tr).forEach(inp => inp.onchange = () => {
      const f = inp.dataset.f, v = inp.value.trim();
      if (f !== 'note' && v !== '' && !(isFinite(+v) && +v > 0)) { toast('Enter a positive number'); return; }
      w[f] = f === 'note' ? v : v === '' ? null : +v; w.u = now();
      saveState(); toast('Saved');
    });
    $('[data-rm]', tr).onclick = () => { toggleWl(w.s); route(true); };
  });
  $$('[data-import]', main).forEach(b => b.onclick = () => { JSON.parse(b.dataset.import).forEach(s => { if (!inWl(s)) toggleWl(s, s); }); route(true); });
};
function mooHtml(m) {
  const q = (m.quotes || []).map(x => `<tr><td class="l"><a class="sym" href="#stock/${encodeURIComponent(x.s)}">${esc(x.s)}</a></td><td class="nm l">${esc(x.n)}</td><td>${px(x.px)}</td><td>${pct(x.chg)}</td><td>${big(x.vol)}</td><td>${big(x.turnover)}</td></tr>`).join('');
  const groups = Object.entries(m.groups || {}).map(([g, list]) => `<p><b>${esc(g)}</b> ${list.map(s => `<a href="#stock/${encodeURIComponent(s)}">${esc(s)}</a>`).join(', ')} <button class="btn sm ghost" data-import='${esc(JSON.stringify(list))}'>Add all to my watchlist</button></p>`).join('');
  const pos = (m.positions || []).map(p => `<tr><td class="l">${esc(p.s)}</td><td>${p.qty}</td><td>${px(p.cost)}</td><td>${px(p.px)}</td><td>${pct(p.pl)}</td></tr>`).join('');
  return `<div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Name</th><th>Last</th><th>Chg</th><th>Volume</th><th>Turnover</th></tr></thead><tbody>${q}</tbody></table></div>
    <div class="pb">${groups}${pos ? `<h3 class="amber">Positions</h3><div class="tw"><table><thead><tr><th>Ticker</th><th>Qty</th><th>Cost</th><th>Last</th><th>P/L</th></tr></thead><tbody>${pos}</tbody></table></div>` : ''}</div>`;
}

const zoyaUrl = r => !r.s.includes('.') && !/[\^=]/.test(r.s) ? `https://zoya.finance/stocks/${r.s}` : `https://www.google.com/search?q=${encodeURIComponent(`site:zoya.finance ${r.n}`)}`;
VIEWS.stock = async (s, main) => {
  await universe();
  const r = D.bySym.get(s) || macroRow(s);
  if (!r) {
    main.innerHTML = `<div class="warn">${esc(s)} isn't in the tracked universe yet. Add it to your watchlist and the next update will fetch it, screen it and add a chart.</div>
      <p>${star(s, s)} Add ${esc(s)} to watchlist · <a href="https://finance.yahoo.com/quote/${encodeURIComponent(s)}" target="_blank" rel="noopener">Yahoo Finance</a> · <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym(s))}" target="_blank" rel="noopener">TradingView</a></p>`;
    return;
  }
  const isEq = !!r.m;
  const about = isEq ? (await mk('about.bin').catch(() => ({})))[s] || {} : {};
  const fc = h => r.fc?.[h] || r.fc?.[String(h)];
  const news = (D.summary.news || []).filter(n => n.sym === s);
  const note = ST.notes[s]?.t || '';
  const pr = P(), lot = PT.LOT(s);
  main.innerHTML = `
    <div class="qhead">${star(s, r.n)}<h1 style="margin:0">${esc(s)}</h1><span class="nm">${esc(r.n)}${isEq ? ` · ${MKT[r.m]} · ${esc(r.sec || '')}` : ''}</span>${badge(r.st)}
      <span class="px mono">${px(r.px)}</span><span>${pct(r.r1)} today</span><span class="note">${esc(r.cur || '')} · ${r.live ? 'live' : 'close'} ${esc(r.d || '')}</span>
      ${isEq ? `<a class="btn sm" href="#paper/${encodeURIComponent(s)}">PAPER TRADE</a>` : ''}</div>
    <div class="grid wide">
      <section class="panel span"><div class="ph"><h2>Chart</h2><div class="chips" id="rng">${['3M', '6M', '1Y', '2Y', '5Y', 'MAX'].map(k => `<button class="chip ${k === '6M' ? 'on' : ''}" data-r="${k}">${k}</button>`).join('')}
        <button class="chip" id="tvBtn" title="Live intraday chart from TradingView">LIVE (TradingView)</button></div></div>
        <div class="chart" id="ch"><div class="legend" id="lg"></div></div><div class="tv" id="tv" hidden></div>
        <div class="pb note">3M–2Y: daily candles · <span style="color:#ffe14d">SMA20</span> · <span style="color:#5fb4ff">SMA50</span> · <span style="color:#c38cff">SMA200</span> · dashed amber = statistical 68% range for ~1W/1M/3M ahead. 5Y/MAX: weekly candles over the full listed history · <span style="color:#5fb4ff">10-week</span> · <span style="color:#c38cff">40-week</span> averages. Volume and RSI(14) at the bottom. For intraday timeframes use LIVE (TradingView).</div></section>
      ${panel(`My notes on ${esc(s)}`, `<div class="pb"><textarea class="f" id="note" rows="4" placeholder="Thesis, entry plan, what would make me sell, things to check in the next results…">${esc(note)}</textarea>
        <p class="note" id="noteMsg">${ST.notes[s]?.u ? `Saved ${esc(sgt(ST.notes[s].u))}` : 'Saves as you type. All your notes are in the NOTE tab.'}</p></div>`)}
      ${isEq ? panel('Position size (risk-based)', `<div class="pb"><div class="form" id="ps">
        <label>Account size<input class="f" data-k="acct" inputmode="decimal" value="${pr.acct}"></label><label>Risk per trade %<input class="f" data-k="risk" inputmode="decimal" value="${pr.risk}"></label>
        <label>Entry<input class="f" data-k="entry" inputmode="decimal" value="${+(r.px || 0).toFixed(4)}"></label><label>Stop (default 1.5× ATR)<input class="f" data-k="stop" inputmode="decimal" value="${+((r.px || 0) * (1 - 1.5 * (r.atr || .02))).toFixed(4)}"></label></div>
        <p id="psOut" class="mono"></p><p class="note">Shares = (account × risk%) ÷ (entry − stop), rounded down to board lots of ${lot}. Account and risk defaults are in Settings.</p></div>`) : ''}
      ${panel('Outlook (statistical)', `<div class="tw"><table><thead><tr><th>Horizon</th><th>P(higher)</th><th>Likely range (68%)</th><th>Median path</th></tr></thead><tbody>
        ${[[5, '~1 week'], [21, '~1 month'], [63, '~3 months']].map(([h, n]) => fc(h) ? `<tr><td class="l">${n}</td><td>${fcCell(r.fc, h)}</td><td>${px(fc(h).lo)} – ${px(fc(h).hi)}</td><td>${px(fc(h).mid)}</td></tr>` : '').join('')}</tbody></table></div>
        <div class="pb"><p>Trend bias: ${biasHtml(r.bias)} (score ${r.score?.toFixed(0) ?? '–'} of ±100). ${techRead(r)}</p><p class="note">Based on how ${isEq ? MKT[r.m] : 'macro'} instruments with a similar trend score behaved over the past 2 years, scaled to this one's volatility. Markets can and do break these ranges; use a stop.</p></div>`)}
      ${panel('Key stats', `<div class="kv">${kv([['Last', px(r.px)], ['1 week', pct(r.r5)], ['1 month', pct(r.r21)], ['3 months', pct(r.r63)], ['1 year', pct(r.r252)], ['YTD', pct(r.ytd)],
        ['52w high', px(r.hi52)], ['52w low', px(r.lo52)], ['SMA 20', px(r.sma20)], ['SMA 50', px(r.sma50)], ['SMA 200', px(r.sma200)], ['RSI 14', r.rsi?.toFixed(1) ?? '–'],
        ['ATR % (daily range)', r.atr ? (r.atr * 100).toFixed(2) + '%' : '–'], ['Rel. volume', r.rv ? r.rv.toFixed(2) + '×' : '–'], ['Avg traded/day (US$)', big(r.valusd)],
        ...(isEq ? [['Market cap', big(r.mc)], ['P/E', r.pe?.toFixed(1) ?? '–'], ['Fwd P/E', r.fpe?.toFixed(1) ?? '–'], ['P/B', r.pb?.toFixed(2) ?? '–'], ['ROE', pct(r.roe, 1)],
          ['Profit margin', pct(r.pm, 1)], ['Revenue growth', pct(r.rg, 1)], ['Dividend yield', r.dy == null ? '–' : r.dy.toFixed(2) + '%'], ['Beta', r.beta?.toFixed(2) ?? '–'],
          ['Analyst target', px(r.tgt)], ['Analyst view', `${esc(r.rec || '–')} (${r.ana ?? 0})`], ['Next earnings', r.earn ? sgt(new Date(r.earn * 1000).toISOString(), { day: 'numeric', month: 'short', year: 'numeric' }) : '–']] : [])])}</div>`)}
      ${isEq ? panel('Shariah compliance', `<div class="pb"><p>${badge(r.st)} <b>${esc(STATUS[r.st])}</b></p><ul>${(about.why || r.why || []).map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        <p><a class="btn sm" href="${esc(zoyaUrl(r))}" target="_blank" rel="noopener">CHECK ON ZOYA ↗</a> <a class="btn sm ghost" href="https://musaffa.com/stock/${encodeURIComponent(r.s.split('.')[0])}" target="_blank" rel="noopener">MUSAFFA ↗</a>${r.m === 'MY' ? ' <a class="btn sm ghost" href="https://www.sc.com.my/development/icm/icm-publications/list-of-shariah-compliant-securities" target="_blank" rel="noopener">SC LIST ↗</a>' : ''}</p>
        <p class="note">Zoya (AAOIFI methodology) shows the business screen, the debt/cash/interest-income ratios and a per-share purification amount for dividends. ${r.m === 'MY' ? 'For Bursa stocks the SC Malaysia list is the official word; Zoya is a second opinion.' : ''} Our ratios: debt/market cap ${pctp(r.dm)} · cash/market cap ${pctp(r.cm)}. See Learn → Shariah investing and Zoya.</p></div>`) : ''}
      ${about.about ? panel('What the company does', `<div class="pb">${esc(about.about)}${about.about.length >= 690 ? '…' : ''}</div>`) : ''}
      ${panel('Research links', `<div class="pb">${links(r)}</div>`)}
      ${panel('Latest news', `<ul class="list">${news.map(n => `<li><a href="${esc(safe(n.u))}" target="_blank" rel="noopener">${esc(n.t)}</a><br><small>${esc(n.s || '')} · ${esc(n.at ? ago(n.at) : '')}</small></li>`).join('')
        || `<li>No saved headlines (only watchlist names get them). <a href="https://news.google.com/search?q=${encodeURIComponent(`"${r.n}"`)}&hl=en-SG&gl=SG&ceid=SG:en" target="_blank" rel="noopener">Search Google News</a></li>`}</ul>`)}
    </div>`;
  let nt;
  $('#note').oninput = e => {
    clearTimeout(nt);
    nt = setTimeout(() => { const t = e.target.value; ST.notes[s] = { t, u: now(), n: r.n }; saveState(); $('#noteMsg').textContent = t ? 'Saved' : 'Cleared'; }, 600);
  };
  const ps = () => {
    const v = k => +($(`#ps [data-k=${k}]`)?.value || 0);
    const per = v('entry') - v('stop'), riskAmt = v('acct') * v('risk') / 100;
    if (!$('#psOut')) return;
    if (!(per > 0)) { $('#psOut').textContent = 'Stop must be below entry for a long position.'; return; }
    const sh = Math.floor(riskAmt / per / lot) * lot;
    $('#psOut').innerHTML = `Buy <b>${sh.toLocaleString()}</b> shares${lot > 1 ? ` (${sh / lot} lots)` : ''} · position ${money(sh * v('entry'))} ${esc(r.cur || '')} · max loss ≈ ${money(sh * per)} (${v('risk')}% of account) · reward at 2R: ${px(v('entry') + 2 * per)}`;
  };
  $$('#ps input').forEach(i => i.oninput = ps); ps();
  const file = s.replace(/[^A-Za-z0-9.-]/g, '_');
  const bars = await mk(`ohlc/${file}.bin`).catch(() => null);
  if (!bars || !window.LightweightCharts) { $('#ch').innerHTML = '<div class="legend" id="lg"></div><p class="pb muted">Chart data unavailable.</p>'; return; }
  // Daily bars cover ~2 years; 5Y and MAX switch to weekly bars over the full listed history.
  let mode = 'd';
  const show = async k => {
    const want = ['5Y', 'MAX'].includes(k) ? 'w' : 'd';
    if (want !== mode || !chartApi) {
      let data = bars;
      if (want === 'w') data = await mk(`ohlcw/${file}.bin`).catch(() => null);
      if (!data) { toast('Long history not available yet (it is built on the Sunday run).'); return; }
      chartApi?.remove(); cleanup = cleanup.filter(f => f !== chartCleanup);
      $('#ch').innerHTML = '<div class="legend" id="lg"></div>';
      drawChart(data, r, want === 'w'); mode = want;
    }
    chartApi.range(k);
    $$('#rng [data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === k));
  };
  $$('#rng [data-r]').forEach(bt => bt.onclick = () => show(bt.dataset.r));
  await show('6M');
  $('#tvBtn').onclick = () => {
    const tv = $('#tv'), on = tv.hidden;
    tv.hidden = !on; $('#ch').hidden = on; $('#tvBtn').classList.toggle('on', on);
    if (on && !tv.firstChild) tv.innerHTML = `<iframe title="TradingView chart" style="width:100%;height:100%;border:0" src="https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSym(s))}&interval=D&theme=dark&style=1&timezone=Asia%2FSingapore&withdateranges=1&hide_side_toolbar=0&allow_symbol_change=1&studies=%5B%5D&locale=en"></iframe>`;
  };
};

// ---------------------------------------------------------------- small account: strategies, fee-aware sizing, quick list
// Fee presets (per side, in the market's currency): max(minimum, % of value) + exchange/clearing/stamp extras.
// Sources (Oct 2026, third-party summaries; check your broker's current page): moomoo SG US$0.99/order platform fee and
// no commission; M+ Online 0.08% min RM8 + clearing 0.03% + stamp duty ~0.1%; UOB Kay Hian cash account 0.275% min S$25.
const FEE_PRESETS = {
  US: { label: 'moomoo (US)', cur: 'USD', min: 0.99, pct: 0, add: 0.003 },
  ETF: { label: 'moomoo (US ETFs)', cur: 'USD', min: 0.99, pct: 0, add: 0.003 },
  MY: { label: 'M+ Online (Bursa)', cur: 'MYR', min: 8, pct: 0.08, add: 0.13 },
  SG: { label: 'moomoo SG (SGX)', cur: 'SGD', min: 0.99, pct: 0.03, add: 0.04 },
  SGU: { label: 'UOB Kay Hian cash (SGX)', cur: 'SGD', min: 25, pct: 0.275, add: 0.04 },
  GL: { label: 'moomoo (other markets, estimate)', cur: 'USD', min: 3, pct: 0.03, add: 0.05 },
};
const SMALL_DEF = { cap: 1500, maxPos: 2, risk: 1.5, sgBroker: 'SG', fees: {} };
const SMALL = () => ({ ...SMALL_DEF, ...(ST.prefs?.small || {}) });
const feeOf = (m, sm = SMALL()) => ({ ...FEE_PRESETS[m === 'SG' ? sm.sgBroker : m], ...(sm.fees[m] || {}) });
const STRAT_NAMES = { rsi2: 'RSI(2) dip', brk: '20-day breakout', pull: 'EMA20 pullback' };
function sideFee(f, value) { return Math.max(f.min, f.pct / 100 * value) + f.add / 100 * value; }
// Shares to buy for one setup: risk-based, capped by the per-position budget, rounded to board lots (US allows fractions).
function sizeSetup(x, sm = SMALL()) {
  const f = feeOf(x.m, sm), fx = D.fx || {};
  const budget = PT.convert(sm.cap / sm.maxPos, 'SGD', x.cur, fx), risk = PT.convert(sm.cap * sm.risk / 100, 'SGD', x.cur, fx);
  const per = x.px - x.stop;
  if (!(budget > 0) || !(per > 0)) return null;
  const lot = PT.LOT(x.s), frac = ['US', 'ETF'].includes(x.m);
  const raw = Math.min(risk / per, budget / x.px);
  const qty = frac ? Math.floor(raw * 100) / 100 : Math.floor(raw / lot) * lot;
  // Fees are set in the broker's currency (e.g. US$0.99), which can differ from the stock's (JPY, HKD, USD on SGX…).
  const value = qty * x.px, valueF = PT.convert(value, x.cur, f.cur, fx);
  const rtF = qty > 0 && valueF != null ? 2 * sideFee(f, valueF) : 0, rt = PT.convert(rtF, f.cur, x.cur, fx) ?? 0;
  return { qty, value, rt, feePct: valueF ? rtF / valueF : null, lossAtStop: qty * per + rt, valueSgd: PT.convert(value, x.cur, 'SGD', fx), lot, frac, ok: qty > 0 && valueF != null };
}
function netStats(st, m, sm = SMALL()) {
  const f = feeOf(m, sm), cur = FEE_PRESETS[m === 'SG' ? sm.sgBroker : m].cur;
  const pos = PT.convert(sm.cap / sm.maxPos, 'SGD', cur, D.fx || {});
  const fp = pos ? 2 * sideFee(f, pos) / pos : 0;
  const r = (st.r || []).map(x => x - fp), g = r.filter(x => x > 0).reduce((a, x) => a + x, 0), l = -r.filter(x => x < 0).reduce((a, x) => a + x, 0);
  return { fp, n: r.length, win: r.filter(x => x > 0).length / (r.length || 1), avg: r.reduce((a, x) => a + x, 0) / (r.length || 1), pf: l ? g / l : null };
}
VIEWS.quick = async (_, main) => {
  await universe();
  const Q = D.summary.quick, sm = SMALL();
  if (!Q) { main.innerHTML = '<div class="warn">Strategy data arrives with the next full update (after the market close).</div>'; return; }
  const mkts = ['US', 'ETF', 'MY', 'SG', 'GL'], MK = { ...MKT, ETF: 'Shariah ETFs' };
  const edge = {};
  for (const k of Object.keys(Q.strats)) for (const m of mkts) if (Q.stats[k]?.[m]) edge[`${k}|${m}`] = netStats(Q.stats[k][m], m, sm);
  const sigs = Q.signals.map(x => ({ ...x, z: sizeSetup(x, sm), e: edge[`${x.k}|${x.m}`] }))
    .sort((a, b) => (b.z?.ok - a.z?.ok) || ((b.e?.avg ?? -1) - (a.e?.avg ?? -1)));
  const list = (ST.quick || []).filter(x => !x.del).sort((a, b) => (b.u || '').localeCompare(a.u || ''));
  const verdict = e => !e ? '<span class="dim">–</span>' : e.avg > 0.004 && (e.pf ?? 0) > 1.2 ? '<span class="up">edge after fees</span>' : e.avg > 0 ? '<span class="flat">thin</span>' : '<span class="down">fees eat it</span>';
  main.innerHTML = `<div class="grid wide">
    ${panel('Small-account plan', `<form class="pb" id="smF"><div class="form">
      <label>Trading capital (SGD)<input class="f" name="cap" inputmode="decimal" value="${sm.cap}"></label>
      <label>Max open positions<input class="f" name="maxPos" inputmode="numeric" value="${sm.maxPos}"></label>
      <label>Risk per trade % of capital<input class="f" name="risk" inputmode="decimal" value="${sm.risk}"></label>
      <label>SGX broker<select class="f" name="sgBroker"><option value="SG" ${sm.sgBroker === 'SG' ? 'selected' : ''}>moomoo SG</option><option value="SGU" ${sm.sgBroker === 'SGU' ? 'selected' : ''}>UOB Kay Hian (cash)</option></select></label></div>
      <p class="mono">Per position ≈ S$${money(sm.cap / sm.maxPos)} · max loss per trade ≈ S$${money(sm.cap * sm.risk / 100)} · round-trip fees on S$${money(sm.cap / sm.maxPos)}: ${mkts.map(m => { const f = feeOf(m, sm), c = FEE_PRESETS[m === 'SG' ? sm.sgBroker : m].cur, v = PT.convert(sm.cap / sm.maxPos, 'SGD', c, D.fx || {}); return v ? `${MK[m]} <b class="${2 * sideFee(f, v) / v > 0.01 ? 'down' : 'up'}">${(200 * sideFee(f, v) / v).toFixed(2)}%</b>` : ''; }).join(' · ')}</p>
      <button class="btn">SAVE PLAN</button> <span class="note">Fee presets are third-party figures from Oct 2026; check your broker's fee page.</span></form>`, '', 'span')}
    ${panel('Backtest: which setups survive your fees? (last ~2 years, compliant stocks, one trade at a time per stock)', `<div class="tw"><table><thead><tr><th class="l">Strategy</th><th class="l">Market</th><th>Trades</th><th>Win % (gross)</th><th>Avg/trade (gross)</th><th>Fees round trip</th><th>Win % (net)</th><th>Avg/trade (net)</th><th>Profit factor (net)</th><th class="l">Verdict</th></tr></thead><tbody>
      ${Object.keys(Q.strats).flatMap(k => mkts.filter(m => Q.stats[k]?.[m]).map(m => { const g = Q.stats[k][m], e = edge[`${k}|${m}`]; return `<tr><td class="l">${STRAT_NAMES[k]}</td><td class="l">${MK[m]}</td><td>${g.n}</td><td>${pctp(g.win)}</td><td>${pct(g.avg)}</td><td>${pct(-e.fp)}</td><td>${pctp(e.win)}</td><td>${pct(e.avg)}</td><td>${e.pf ? e.pf.toFixed(2) : '–'}</td><td class="l">${verdict(e)}</td></tr>`; })).join('')}</tbody></table></div>
      <div class="pb note">${Object.entries(Q.strats).map(([k, d]) => `<p><b>${STRAT_NAMES[k]}</b>: ${esc(d)}</p>`).join('')}<p>Honest limits: the universe is today's compliant list (survivorship bias), fills assume the next open with no slippage, and two years is one market regime. Treat "edge after fees" as "worth paper-trading first", not as a promise.</p></div>`, '', 'span')}
    ${panel(`Today's setups (${esc(sgt(Q.at))} SGT)`, `<div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Setup</th><th class="l">Status</th><th>Last</th><th>Stop</th><th>Target</th><th>Qty</th><th>Cost (S$)</th><th>Fees r/t</th><th>Loss at stop</th><th class="l">Backtest (net)</th><th></th></tr></thead><tbody>
      ${sigs.map(x => { const z = x.z; return `<tr class="go" data-go="stock/${encodeURIComponent(x.s)}">${symCell(x)}<td class="l">${STRAT_NAMES[x.k]} <span class="dim">${esc(MK[x.m])}</span></td><td class="l">${badge(x.st)}</td>
        <td>${px(x.px)}</td><td>${px(x.stop)}</td><td>${x.tgt ? px(x.tgt) : '<span class="dim">rule exit</span>'}</td>
        <td>${z?.ok ? (z.frac ? z.qty.toFixed(2) : z.qty.toLocaleString()) : `<span class="down" title="One board lot costs more than your per-position budget">too pricey</span>`}</td><td>${z?.ok ? money(z.valueSgd) : '–'}</td><td class="${z?.feePct > 0.01 ? 'down' : ''}">${z?.ok ? pct(z.feePct) : '–'}</td><td>${z?.ok ? money(z.lossAtStop) + ' ' + esc(x.cur) : '–'}</td>
        <td class="l">${x.e ? `${pct(x.e.avg)} avg · ${verdict(x.e)}` : '–'}</td><td>${z?.ok ? `<button class="btn sm ghost" data-q="${esc(JSON.stringify({ s: x.s, k: x.k, m: x.m, entry: x.px, stop: x.stop, tgt: x.tgt, qty: z.qty, cur: x.cur }))}">＋ LIST</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="12" class="l muted">No setups today. That is normal: these rules wait for specific conditions.</td></tr>'}</tbody></table></div>
      <p class="pb note">Signals are from the latest daily close; enter at the next open only if the setup still holds. "Qty" risks ${sm.risk}% of capital to the stop and never uses more than 1/${sm.maxPos} of capital. Shariah: status C or P only, cash account, no shorting, no margin.</p>`, '', 'span')}
    ${panel(`${esc(ME.name)}'s quick-trade list`, `<div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Setup</th><th>Entry</th><th>Stop</th><th>Target</th><th>Qty</th><th>Last</th><th>vs entry</th><th class="l">Status</th><th class="l">Note</th><th></th></tr></thead><tbody>
      ${list.map(x => { const q = quoteOf(x.s); return `<tr data-qid="${esc(x.id)}"><td class="l"><a class="sym" href="#stock/${encodeURIComponent(x.s)}">${esc(x.s)}</a></td><td class="l">${STRAT_NAMES[x.k] || esc(x.k)}</td><td>${px(x.entry)}</td><td>${px(x.stop)}</td><td>${x.tgt ? px(x.tgt) : '–'}</td><td>${x.qty}</td>
        <td>${px(q?.px)}</td><td>${q ? pct(q.px / x.entry - 1) : '–'}</td>
        <td class="l"><select class="f" data-f="status">${['planned', 'open', 'closed', 'skipped'].map(st => `<option ${x.status === st ? 'selected' : ''}>${st}</option>`).join('')}</select></td>
        <td class="l"><input class="f" style="width:180px" data-f="note" value="${esc(x.note || '')}" placeholder="Why / result"></td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm ghost" data-alert title="Add to watchlist with alerts at the stop and target">ALERTS</button><a class="btn sm ghost" href="#paper/${encodeURIComponent(x.s)}/${x.qty}">PAPER</a><button class="btn sm ghost" data-rmq aria-label="Remove">✕</button></td></tr>`; }).join('') || '<tr><td colspan="11" class="l muted">Tap “＋ LIST” on a setup above to plan it here.</td></tr>'}</tbody></table></div>`, '', 'span')}
    ${panel('Small-account playbook', `<div class="pb md">${LEARN.find(x => x.id === 'small').html}</div>`, '', 'span')}
  </div>`;
  $('#smF').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target), num = (k, lo, hi, d) => Math.min(hi, Math.max(lo, +f.get(k) || d));
    ST.prefs = { ...P(), small: { ...sm, cap: num('cap', 100, 1e8, 1500), maxPos: Math.round(num('maxPos', 1, 10, 2)), risk: num('risk', 0.25, 5, 1.5), sgBroker: f.get('sgBroker') } };
    saveState(); toast('Plan saved'); route(true);
  };
  $$('[data-q]', main).forEach(b => b.onclick = () => {
    const x = JSON.parse(b.dataset.q);
    ST.quick = [...(ST.quick || []), { id: PT.rid(), ...x, status: 'planned', at: now(), u: now() }];
    saveState(); toast(`${x.s} added to your quick-trade list`); route(true);
  });
  $$('tr[data-qid]', main).forEach(tr => {
    const x = ST.quick.find(q => q.id === tr.dataset.qid);
    $$('[data-f]', tr).forEach(i => i.onchange = () => { x[i.dataset.f] = i.value; x.u = now(); saveState(); toast('Saved'); });
    $('[data-rmq]', tr).onclick = () => { Object.assign(x, { del: true, u: now() }); saveState(); route(true); };
    $('[data-alert]', tr).onclick = () => {
      let w = ST.wl.find(y => y.s === x.s);
      if (!w || w.del) { if (!inWl(x.s)) toggleWl(x.s); w = ST.wl.find(y => y.s === x.s); }
      Object.assign(w, { below: +(+x.stop).toPrecision(5), above: x.tgt ? +(+x.tgt).toPrecision(5) : w.above, u: now() });
      saveState(); toast(`Alerts set for ${x.s}: below ${px(x.stop)}${x.tgt ? `, above ${px(x.tgt)}` : ''}`);
    };
  });
};

// ---------------------------------------------------------------- paper trading
// Market orders fill at the latest price; limit/stop orders rest and fill when a later quote crosses them
// (checked whenever new prices arrive, and the live job sends a push when one triggers).
function processOrders() {
  if (!ME || !D.uni) return;
  let n = 0;
  for (const o of ST.paper.orders) {
    const q = quoteOf(o.s), fill = PT.trigger(o, q);
    if (fill == null) continue;
    const t = PT.makeTrade(ST.paper, { ...o, id: 't' + o.id }, fill, q.cur, D.fx);
    if (!t) continue;  // no exchange rate yet: try again on the next quote
    if (o.side === 'sell' && (PT.holdings(ST.paper).pos[o.s]?.q || 0) < o.q) { Object.assign(o, { status: 'cancelled', why: 'not enough shares', u: now() }); continue; }
    ST.paper.trades.push(t); Object.assign(o, { status: 'filled', fill, u: now() }); n++;
    toast(`Paper ${o.side} ${o.q} ${o.s} filled at ${px(fill)}`);
  }
  if (n) saveState();
}
VIEWS.paper = async (arg, main) => {
  const [sym, preQty] = (arg || '').split('/');
  await universe();
  processOrders();
  const pa = ST.paper, fx = D.fx || D.summary.fx || {};
  const val = PT.value(pa, s => quoteOf(s), fx);
  const today = now().slice(0, 10);
  if (!pa.eq.some(e => e.d === today) || Math.abs((pa.eq.find(e => e.d === today)?.v || 0) - val.equity) > 0.005) {
    pa.eq = [...pa.eq.filter(e => e.d !== today), { d: today, v: +val.equity.toFixed(2), u: now() }]; store.set(`st:${ME.id}`, ST);
  }
  const B = pa.base, m = v => `${money(v)} ${B}`;
  const open = pa.orders.filter(o => o.status === 'open' && o.at >= pa.resetAt);
  const trades = pa.trades.filter(t => t.at >= pa.resetAt).sort((a, b) => b.at.localeCompare(a.at));
  const pos = Object.values(val.pos);
  const eq = pa.eq.filter(e => e.d >= pa.resetAt.slice(0, 10)).sort((a, b) => a.d.localeCompare(b.d));
  main.innerHTML = `<div class="grid wide">
    ${panel(`${esc(ME.name)}'s paper account · ${esc(B)}`, `<div class="kv">${kv([['Equity', m(val.equity)], ['Return', pct(val.ret)], ['Cash', m(val.cash)], ['Invested', m(val.invested)],
      ['Unrealised P/L', `<span class="${cls(val.unrealised)}">${m(val.unrealised)}</span>`], ['Realised P/L', `<span class="${cls(val.realised)}">${m(val.realised)}</span>`], ['Fees paid', m(val.fees)], ['Started with', m(pa.start)],
      ['Zakat estimate (2.5% of holdings + cash)', m(0.025 * Math.max(0, val.equity))]])}</div>
      ${eq.length > 1 ? spark(eq.map(e => e.v)) : ''}
      <p class="pb note">Virtual money for practice. Prices: live quotes when available, otherwise the latest close; Bursa/SGX quotes lag ~15 min. Fees ${pa.fee}% per trade. ${P().shariahOnly ? 'Shariah-only mode: buying non-compliant (F) stocks is blocked; no short selling or margin.' : 'Shariah-only mode is off (Settings).'} Zakat shown as the simple trading-shares method; ask your scholar for your case.</p>`, '', 'span')}
    ${panel('Order ticket', `<form class="pb ticket" id="tk">
      <div class="form"><label>Stock<input class="f" id="tkS" list="cmdList" value="${esc(sym || '')}" placeholder="AAPL, 5347.KL…" autocapitalize="characters" required></label>
      <label>Side<span class="seg"><button type="button" data-side="buy" class="on buy">BUY</button><button type="button" data-side="sell">SELL</button></span></label>
      <label>Type<span class="seg">${['market', 'limit', 'stop'].map((t, i) => `<button type="button" data-type="${t}" class="${i ? '' : 'on t'}">${t.toUpperCase()}</button>`).join('')}</span></label>
      <label>Quantity (shares)<input class="f" id="tkQ" inputmode="decimal" placeholder="e.g. 100 (US: fractions OK)" value="${+preQty > 0 ? +preQty : ''}"></label>
      <label id="tkPxL" hidden>Price<input class="f" id="tkPx" inputmode="decimal"></label></div>
      <p id="tkInfo" class="mono"></p><p id="tkErr" class="err"></p><button class="btn" id="tkGo">PLACE ORDER</button></form>`)}
    ${panel('Positions', `<div class="tw"><table><thead><tr><th>Ticker</th><th>Qty</th><th>Avg cost</th><th>Last</th><th>Value (${esc(B)})</th><th>P/L</th><th>P/L %</th><th class="l">Status</th><th></th></tr></thead><tbody>
      ${pos.map(x => { const q = quoteOf(x.s); return `<tr class="go" data-go="stock/${encodeURIComponent(x.s)}"><td class="l"><span class="sym">${esc(x.s)}</span></td><td>${x.q.toLocaleString()}</td><td>${px(x.avg)}</td><td>${px(x.px)}</td><td>${money(x.value)}</td>
        <td class="${cls(x.pl)}">${money(x.pl)}</td><td>${pct(x.plPct)}</td><td class="l">${badge(q?.st)}</td><td><button class="btn sm ghost" data-close="${esc(x.s)}" data-q="${x.q}">SELL ALL</button></td></tr>`; }).join('') || '<tr><td colspan="9" class="l muted">No positions yet. Place a market order to start.</td></tr>'}
      </tbody></table></div>`, '', 'span')}
    ${panel('Open orders', `<div class="tw"><table><thead><tr><th>Placed</th><th class="l">Order</th><th>Price</th><th>Last</th><th></th></tr></thead><tbody>
      ${open.map(o => `<tr><td>${esc(sgt(o.at))}</td><td class="l">${o.side.toUpperCase()} ${o.q} ${esc(o.s)} ${o.type}</td><td>${px(o.px)}</td><td>${px(quoteOf(o.s)?.px)}</td><td><button class="btn sm ghost" data-cancel="${esc(o.id)}">CANCEL</button></td></tr>`).join('') || '<tr><td colspan="5" class="l muted">None.</td></tr>'}</tbody></table></div>`)}
    ${panel('Trade history', `<div class="tw" style="max-height:360px"><table><thead><tr><th>Time</th><th class="l">Trade</th><th>Price</th><th>Value (${esc(B)})</th><th>Fee</th></tr></thead><tbody>
      ${trades.map(t => `<tr><td>${esc(sgt(t.at))}</td><td class="l"><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side.toUpperCase()}</span> ${t.q} ${esc(t.s)}</td><td>${px(t.px)} ${esc(t.cur)}</td><td>${money(t.q * t.px * t.rate)}</td><td>${money(t.fee)}</td></tr>`).join('') || '<tr><td colspan="5" class="l muted">No trades yet.</td></tr>'}</tbody></table></div>`)}
    <div id="board" class="span"></div>
  </div>`;
  // ticket
  const T = { side: 'buy', type: 'market' };
  const info = () => {
    const s = $('#tkS').value.trim().toUpperCase(), q = quoteOf(s), qty = +$('#tkQ').value || 0;
    const p = T.type === 'market' ? q?.px : +$('#tkPx').value;
    const cost = q && p ? PT.convert(qty * p, q.cur, B, fx) : null;
    $('#tkInfo').innerHTML = q ? `${esc(q.n)} ${badge(q.st)} · last ${px(q.px)} ${esc(q.cur)} · board lot ${PT.LOT(s)} · est. ${cost == null ? '–' : m(cost)} + fee` : (s ? 'Unknown ticker: pick one from the list.' : '');
    $('#tkErr').textContent = '';
  };
  $$('#tk [data-side]').forEach(b => b.onclick = () => { T.side = b.dataset.side; $$('#tk [data-side]').forEach(x => x.className = x === b ? `on ${T.side}` : ''); info(); });
  $$('#tk [data-type]').forEach(b => b.onclick = () => { T.type = b.dataset.type; $$('#tk [data-type]').forEach(x => x.className = x === b ? 'on t' : ''); $('#tkPxL').hidden = T.type === 'market'; info(); });
  ['tkS', 'tkQ', 'tkPx'].forEach(id => $(`#${id}`).oninput = info); info();
  $('#tk').onsubmit = e => {
    e.preventDefault();
    const s = $('#tkS').value.trim().toUpperCase(), q = quoteOf(s);
    const o = { id: PT.rid(), s, side: T.side, type: T.type, q: +$('#tkQ').value, px: T.type === 'market' ? null : +$('#tkPx').value, at: now(), u: now(), status: 'open', d0: q?.d };
    const err = !q ? 'Unknown ticker or no price yet.' : PT.check(pa, o, q, fx, { shariahOnly: P().shariahOnly, status: q.st });
    if (err) { $('#tkErr').textContent = err; return; }
    if (o.type === 'market') {
      const t = PT.makeTrade(pa, o, q.px, q.cur, fx);
      if (!t) { $('#tkErr').textContent = 'No exchange rate for this currency yet. Try again after the next update.'; return; }
      pa.trades.push(t); o.status = 'filled'; o.fill = q.px;
      toast(`Paper ${o.side} ${o.q} ${s} at ${px(q.px)}`);
    } else { o.reserve = o.side === 'buy' ? PT.convert(o.q * o.px, q.cur, B, fx) * (1 + pa.fee / 100) : 0; toast('Order placed'); }
    pa.orders.push(o); saveState(); route(true);
  };
  $$('[data-cancel]', main).forEach(b => b.onclick = () => { Object.assign(pa.orders.find(o => o.id === b.dataset.cancel), { status: 'cancelled', u: now() }); saveState(); route(true); });
  $$('[data-close]', main).forEach(b => b.onclick = () => { location.hash = `paper/${encodeURIComponent(b.dataset.close)}`; setTimeout(() => { $('#tk [data-side=sell]')?.click(); $('#tkQ').value = b.dataset.q; info(); }, 50); });
  // family leaderboard: everyone's paper return, read-only
  const rows = [];
  for (const p of people()) {
    const st = p.id === ME.id ? ST : await boardState(p.id);
    if (!st?.paper) continue;
    const v = PT.value(st.paper, s => quoteOf(s), fx);
    rows.push({ p, ret: v.ret, eq: v.equity, base: st.paper.base, n: st.paper.trades.filter(t => t.at >= st.paper.resetAt).length });
  }
  if ($('#board')) $('#board').innerHTML = panel('Family leaderboard (paper)', `<div class="tw"><table><thead><tr><th>Who</th><th>Return</th><th>Equity</th><th>Trades</th></tr></thead><tbody>
    ${rows.sort((a, b) => b.ret - a.ret).map(x => `<tr><td class="l"><span class="avatar" style="display:inline-grid;place-items:center;width:22px;height:22px;font-size:11px;background:${esc(x.p.color)}">${esc(x.p.name[0])}</span> ${esc(x.p.name)}</td><td>${pct(x.ret)}</td><td>${money(x.eq)} ${esc(x.base)}</td><td>${x.n}</td></tr>`).join('')}</tbody></table></div>`);
};
const boards = new Map();
async function boardState(id) {
  const c = boards.get(id);
  if (c && Date.now() - c.t < 300000) return c.st;
  const st = mergeState(await readData(`p/${id}.bin`).catch(() => null), store.get(`st:${id}`, null));
  boards.set(id, { t: Date.now(), st });
  return st;
}
function spark(v) {
  const W = 600, H = 90, lo = Math.min(...v), hi = Math.max(...v), y = x => H - 6 - (x - lo) / ((hi - lo) || 1) * (H - 12);
  const pts = v.map((x, i) => `${(i / (v.length - 1) * W).toFixed(1)},${y(x).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="equity curve"><polyline points="${pts}" fill="none" stroke="${v[v.length - 1] >= v[0] ? '#2bd96b' : '#ff4d4d'}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------- notes & journal
VIEWS.notes = async (_, main) => {
  const q = store.get('nq', '');
  const notes = Object.entries(ST.notes).filter(([, v]) => v.t).sort((a, b) => (b[1].u || '').localeCompare(a[1].u || ''));
  const jr = ST.journal.filter(j => !j.del).sort((a, b) => (b.d + b.at).localeCompare(a.d + a.at));
  main.innerHTML = `<div class="row" style="margin-bottom:10px"><input class="f sp" id="nq" placeholder="Search notes and journal" value="${esc(q)}"></div>
    <div class="grid wide">
    ${panel('Trading journal', `<form class="pb" id="jf" style="display:grid;gap:8px"><div class="form"><label>Date<input class="f" type="date" id="jd" value="${now().slice(0, 10)}"></label><label>Ticker (optional)<input class="f" id="js" list="cmdList" autocapitalize="characters"></label></div>
      <textarea class="f" id="jt" rows="3" placeholder="What I did, why, how I felt, what I learned…" required></textarea><button class="btn">ADD ENTRY</button></form>
      <ul class="list" id="jl">${jr.map(j => `<li data-q="${esc((j.t + ' ' + (j.s || '')).toLowerCase())}"><small>${esc(j.d)}${j.s ? ` · <a href="#stock/${encodeURIComponent(j.s)}">${esc(j.s)}</a>` : ''}</small> <button class="btn sm ghost" style="float:right" data-del="${esc(j.id)}">✕</button><br>${esc(j.t).replace(/\n/g, '<br>')}</li>`).join('') || '<li class="muted">No entries yet. Reviewing a journal every Sunday with the weekly report is the fastest way to improve.</li>'}</ul>`)}
    ${panel('Stock notes', `<ul class="list" id="nl">${notes.map(([s, v]) => `<li data-q="${esc((s + ' ' + (v.n || '') + ' ' + v.t).toLowerCase())}"><a class="sym" href="#stock/${encodeURIComponent(s)}">${esc(s)}</a> <span class="note">${esc(v.n || '')} · ${esc(v.u ? sgt(v.u) : '')}</span><br>${esc(v.t).replace(/\n/g, '<br>')}</li>`).join('') || '<li class="muted">Write notes on any stock page; they appear here.</li>'}</ul>`)}
    </div>`;
  const filt = () => { const v = $('#nq').value.toLowerCase(); store.set('nq', $('#nq').value); $$('#jl li[data-q], #nl li[data-q]').forEach(li => li.hidden = v && !li.dataset.q.includes(v)); };
  $('#nq').oninput = filt; filt();
  $('#jf').onsubmit = e => {
    e.preventDefault();
    ST.journal.push({ id: PT.rid(), d: $('#jd').value, s: $('#js').value.trim().toUpperCase() || null, t: $('#jt').value.trim(), at: now(), u: now() });
    saveState(); route(true);
  };
  $$('[data-del]', main).forEach(b => b.onclick = () => { Object.assign(ST.journal.find(j => j.id === b.dataset.del), { del: true, u: now() }); saveState(); route(true); });
};

// ---------------------------------------------------------------- media + watch later
VIEWS.media = async (_, main) => {
  const M = D.summary.media || { vids: [], pods: [] };
  const vids = [...M.vids].sort((a, b) => new Date(b.at) - new Date(a.at));
  const later = ST.later.filter(x => !x.del);
  const has = id => later.some(x => x.id === id);
  const laterBtn = (id, t, src, url) => `<button class="btn sm ${has(id) ? '' : 'ghost'}" data-later="${esc(id)}" data-t="${esc(t)}" data-src="${esc(src)}" data-url="${esc(url)}">${has(id) ? '✓ SAVED' : '＋ WATCH LATER'}</button>`;
  main.innerHTML = `<div class="grid wide">
    ${panel(`${esc(ME.name)}'s watch later (${later.filter(x => !x.done).length} to go)`, `<ul class="list">${later.sort((a, b) => (a.done - b.done) || b.at.localeCompare(a.at)).map(x => `<li class="later">
      <input type="checkbox" data-done="${esc(x.id)}" ${x.done ? 'checked' : ''} aria-label="Watched"><span><a href="${esc(safe(x.url))}" target="_blank" rel="noopener" ${x.done ? 'class="dim"' : ''}>${esc(x.t)}</a><br><small>${esc(x.src)} · saved ${esc(ago(x.at))}</small></span>
      <button class="btn sm ghost" data-unlater="${esc(x.id)}" aria-label="Remove">✕</button></li>`).join('') || '<li class="muted">Tap “＋ Watch later” on any video or episode below.</li>'}</ul>`, '', 'span')}
    ${panel('Start here · the video you shared', `<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/${FEATURED}" title="StockedUp: The Stock Market Is Being Manipulated…" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>
      <p class="pb note">StockedUp · "The Stock Market Is Being Manipulated…". Watch critically: what evidence is shown, and what would prove it wrong? ${laterBtn('yt:' + FEATURED, 'The Stock Market Is Being Manipulated…', 'StockedUp', `https://www.youtube.com/watch?v=${FEATURED}`)}</p>`)}
    ${panel('Study plan · what to watch next', `<div class="pb">${RESOURCES.study.map(([t, q, why]) => `<p><a href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}" target="_blank" rel="noopener">▶ ${esc(t)}</a><br><span class="note">${esc(why)}</span></p>`).join('')}</div>`)}
    ${panel('Latest from market channels', `<div class="pb vids">${vids.slice(0, 36).map(v => `<div class="vid-wrap"><a class="vid" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><div>${esc(v.t)}<small>${esc(v.src)} · ${v.at ? esc(ago(v.at)) : ''}</small></div></a>${laterBtn('yt:' + v.id, v.t, v.src, `https://www.youtube.com/watch?v=${v.id}`)}</div>`).join('') || '<p class="muted">Video feeds were unavailable at the last update.</p>'}</div>`, '', 'span')}
    ${panel('Latest podcast episodes', `<ul class="list">${M.pods.map(p => `<li><b class="amber">${esc(p.src)}</b><br><a href="${esc(safe(p.u))}" target="_blank" rel="noopener">${esc(p.t)}</a> <small>${p.at ? esc(ago(p.at)) : ''}</small> ${laterBtn('pod:' + (p.u || p.t), p.t, p.src, p.u || '#')}</li>`).join('')}</ul>`)}
    ${panel('Channels & shows to follow', `<div class="pb">${RESOURCES.channels.map(([t, u, d]) => `<p><a href="${esc(safe(u))}" target="_blank" rel="noopener">${esc(t)}</a> <span class="note">${esc(d)}</span></p>`).join('')}</div>`)}
  </div>`;
  $$('[data-later]', main).forEach(b => b.onclick = () => {
    const x = ST.later.find(l => l.id === b.dataset.later);
    if (x && !x.del) Object.assign(x, { del: true, u: now() });
    else if (x) Object.assign(x, { del: false, done: false, at: now(), u: now() });
    else ST.later.push({ id: b.dataset.later, t: b.dataset.t, src: b.dataset.src, url: b.dataset.url, at: now(), u: now(), done: false });
    saveState(); route(true);
  });
  $$('[data-done]', main).forEach(c => c.onchange = () => { Object.assign(ST.later.find(l => l.id === c.dataset.done), { done: c.checked, u: now() }); saveState(); route(true); });
  $$('[data-unlater]', main).forEach(b => b.onclick = () => { Object.assign(ST.later.find(l => l.id === b.dataset.unlater), { del: true, u: now() }); saveState(); route(true); });
};

// ---------------------------------------------------------------- settings
VIEWS.settings = async (_, main) => {
  const sub = await currentSub(), pr = P();
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('AMA Stock Screener sync')}&description=${encodeURIComponent('Lets the family site save profiles, watchlists, paper trades and notifications')}&target_name=${encodeURIComponent(REPO.split('/')[0])}&contents=write&actions=write`;
  const ios = /iPhone|iPad/.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const N = [['daily', 'Daily brief ready (~06:30 SGT)'], ['weekly', 'Weekly report ready (Sun 17:00 SGT)'], ['alerts', 'Watchlist price alerts'], ['moves', 'Big moves in my watchlist'], ['orders', 'Paper orders triggered'], ['breaking', 'Breaking market headlines (busy!)']];
  main.innerHTML = `<div class="grid">
    ${panel(`Profile · ${esc(ME.name)}`, `<form class="pb" id="pf" style="display:grid;gap:10px"><div class="form"><label>Name<input class="f" id="pfN" maxlength="20" value="${esc(ME.name)}"></label>
      <label>New PIN (blank = keep, “none” = remove)<input class="f" id="pfPin" inputmode="numeric" maxlength="8" autocomplete="off"></label></div>
      <div class="swatches">${COLORS.map((c, i) => `<input type="radio" name="pfc" id="pfc${i}" value="${c}" ${c === ME.color ? 'checked' : ''}><label for="pfc${i}" style="background:${c}"></label>`).join('')}</div>
      <div class="row"><button class="btn">SAVE PROFILE</button><button type="button" class="btn ghost" id="pfSwitch">SWITCH PROFILE</button><button type="button" class="btn ghost" id="pfDel">DELETE PROFILE…</button></div><p class="err" id="pfMsg"></p></form>`)}
    ${panel('My preferences', `<form class="pb" id="prf"><div class="form">
      <label>Home tab<select class="f" name="home">${TABS.map(([id, , n]) => `<option value="${id}" ${pr.home === id ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Default ideas market<select class="f" name="mkt">${Object.entries(MKT).map(([k, n]) => `<option value="${k}" ${pr.mkt === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Account size for position sizing<input class="f" name="acct" inputmode="decimal" value="${pr.acct}"></label>
      <label>Risk per trade %<input class="f" name="risk" inputmode="decimal" value="${pr.risk}"></label>
      <label>Big-move alert threshold %<input class="f" name="move" inputmode="decimal" value="${pr.move}"></label></div>
      <label class="toggle"><input type="checkbox" name="ticker" ${pr.ticker ? 'checked' : ''}> Show the breaking-news ticker</label>
      <label class="toggle"><input type="checkbox" name="shariahOnly" ${pr.shariahOnly ? 'checked' : ''}> Shariah-only paper trading (block status F buys)</label>
      <button class="btn">SAVE PREFERENCES</button></form>`)}
    ${panel('Paper account', `<form class="pb" id="paf"><div class="form"><label>Starting cash<input class="f" name="start" inputmode="decimal" value="${ST.paper.start}"></label>
      <label>Base currency<select class="f" name="base">${['SGD', 'USD', 'MYR'].map(c => `<option ${ST.paper.base === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>Fee per trade %<input class="f" name="fee" inputmode="decimal" value="${ST.paper.fee}"></label></div>
      <p class="note">Changing these starts a fresh account (old trades stay in history but no longer count).</p><button class="btn ghost" id="paReset">RESET PAPER ACCOUNT…</button></form>`)}
    ${panel('Notifications on this device', `<div class="pb">${!pushOk() ? `<p>${ios && !standalone ? 'On iPhone: tap Share → <b>Add to Home Screen</b>, open the app from the home screen, then come back here.' : 'This browser does not support push notifications.'}</p>`
      : `<div class="row"><button class="btn" id="pushOn" ${sub ? 'hidden' : ''}>ENABLE FOR ${esc(ME.name.toUpperCase())}</button><button class="btn ghost" id="pushTest" ${sub ? '' : 'hidden'}>SEND TEST</button><button class="btn ghost" id="pushOff" ${sub ? '' : 'hidden'}>TURN OFF</button></div>
      <p class="note" id="pmsg">${sub ? (ST.subs.some(s => s.endpoint === sub.endpoint && !s.del) ? `On for ${esc(ME.name)} on this device.` : 'This device is subscribed for another profile. Tap Enable to move it here.') : ''}${TOKEN ? '' : ' Needs GitHub sync (Family below) first.'}</p>`}
      <form id="nf">${N.map(([k, n]) => `<label class="toggle"><input type="checkbox" name="${k}" ${pr.notify[k] ? 'checked' : ''}> ${n}</label>`).join('')}</form>
      <p class="note">Install as an app: iPhone Safari → Share → Add to Home Screen · Android Chrome → ⋮ → Install app · Desktop Chrome → install icon in the address bar.</p></div>`)}
    ${panel('Breaking news', `<form class="pb" id="bnF"><label class="toggle"><input type="checkbox" name="popup" ${pr.news.popup ? 'checked' : ''}> Pop-up cards for new headlines while the app is open</label>
      <label class="toggle"><input type="checkbox" name="push" ${pr.notify.breaking ? 'checked' : ''}> Also send them as phone notifications (busy!)</label>
      <p class="note">Outlets (market-related headlines only; sports filtered out):</p>
      <div class="form">${NEWS_SOURCES.map(([id, n]) => `<label class="toggle"><input type="checkbox" name="src" value="${id}" ${pr.news.sources.includes(id) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div>
      <div class="row"><button class="btn">SAVE</button><button type="button" class="btn ghost" id="bnTest">SHOW A SAMPLE POP-UP</button></div></form>`)}
    ${panel('Family · GitHub sync & live data', `<div class="pb">${TOKEN ? `<p class="up">GitHub sync connected for the whole family (${esc(REPO)}).</p>` : `<p>One-time setup for the whole family: create a fine-grained GitHub token for <b>${esc(REPO)}</b> only, with <b>Contents</b> and <b>Actions</b> set to Read and write. It's stored encrypted with the family password, so every family device picks it up automatically.</p>
      <p><a class="btn ghost" href="${esc(tokenUrl)}" target="_blank" rel="noopener">CREATE TOKEN ON GITHUB ↗</a></p>`}
      <form class="row" id="tokF"><input class="f sp" id="tok" type="password" placeholder="${TOKEN ? 'Replace token: github_pat_…' : 'github_pat_…'}" autocomplete="off"><button class="btn">${TOKEN ? 'REPLACE' : 'SAVE'}</button></form><p class="err" id="tokMsg"></p>
      <h3 class="amber">Live prices: optional Cloudflare Worker</h3><p class="note">Without it, prices refresh about every 10 minutes from GitHub. With the free Worker (see Learn → Hosting), quotes and headlines refresh every minute.</p>
      <form class="form" id="wkF"><label>Worker URL<input class="f" id="wkU" placeholder="https://ama-live.<you>.workers.dev" value="${esc(CFG.worker?.url || '')}"></label><label>Worker key<input class="f" id="wkK" type="password" autocomplete="off" value="${esc(CFG.worker?.key || '')}"></label><button class="btn ghost">SAVE WORKER</button></form><p class="note" id="wkMsg"></p></div>`)}
    ${panel('Data & backup', `<div class="pb"><p>Snapshot <b>${esc(sgt(D.summary.at))} SGT</b> (${esc(D.summary.mode)}) · live ${LIVE ? esc(sgt(LIVE.at)) + ' via ' + (liveFrom === 'worker' ? 'Worker' : 'GitHub') : 'not yet'}. Universe: ${Object.entries(D.summary.counts || {}).map(([m, c]) => `${m} ${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ')}`).join(' · ')}.</p>
      <ul><li>Every ~10 min: live quotes, FX, breaking news, alerts</li><li>Mon–Sat 06:30 SGT: US close + daily AI brief</li><li>Mon–Fri 18:15 SGT: Asia close refresh</li><li>Sun 17:00 SGT: universe + Shariah re-screen + full weekly report</li></ul>
      <div class="row"><button class="btn ghost" id="exp">EXPORT MY DATA</button><label class="btn ghost" style="cursor:pointer">IMPORT…<input type="file" id="imp" accept="application/json" hidden></label><button class="btn ghost" id="logout">LOCK THIS DEVICE</button></div>
      <p class="note">Sources: Yahoo Finance (delayed), SC Malaysia SAC list (${esc(D.summary.sc?.asof || '?')}), SP Funds S&P Shariah ETF holdings, own AAOIFI-style screen, Zoya/Musaffa links, Google News, Forex Factory, YouTube/podcast RSS. Everything published is AES-256-GCM encrypted with the family password.</p></div>`)}
    ${panel('moomoo OpenAPI', `<div class="pb md">${LEARN.find(x => x.id === 'moomoo').html}</div>`)}
  </div>`;
  const msg = (id, t) => { const el = $(`#${id}`); if (el) el.textContent = t; };
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const p = FAMILY.list.find(x => x.id === ME.id), pin = $('#pfPin').value.trim();
    if (pin && pin !== 'none' && !/^\d{4,8}$/.test(pin)) return msg('pfMsg', 'PIN must be 4–8 digits, or “none”.');
    p.name = $('#pfN').value.trim() || p.name; p.color = $('input[name=pfc]:checked').value; p.u = now();
    if (pin === 'none') p.pin = null; else if (pin) { const salt = PT.rid(); p.pin = { salt, h: await sha(salt + pin) }; }
    ME = p; paintMe();
    try { await saveFamily(); toast('Profile saved'); } catch (x) { toast(`Saved here only: ${x.message}`); }
    route(true);
  };
  $('#pfSwitch').onclick = () => pickProfile();
  let delArm = false;
  $('#pfDel').onclick = async () => {
    if (people().length < 2) return msg('pfMsg', 'This is the only profile.');
    if (!delArm) { delArm = true; $('#pfDel').textContent = 'TAP AGAIN TO DELETE'; return; }
    Object.assign(FAMILY.list.find(x => x.id === ME.id), { del: true, u: now() });
    await saveFamily().catch(() => {}); store.del('me'); ME = null; pickProfile('Profile deleted.');
  };
  $('#prf').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target), num = (k, lo, hi) => Math.min(hi, Math.max(lo, +f.get(k) || DEF_PREFS[k]));
    ST.prefs = { ...pr, home: f.get('home'), mkt: f.get('mkt'), acct: num('acct', 1, 1e9), risk: num('risk', 0.1, 10), move: num('move', 1, 50), ticker: !!f.get('ticker'), shariahOnly: !!f.get('shariahOnly') };
    saveState(); paintTicker(); toast('Preferences saved');
  };
  $('#bnF').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target), sources = f.getAll('src');
    ST.prefs = { ...P(), news: { popup: !!f.get('popup'), sources }, notify: { ...P().notify, breaking: !!f.get('push') } };
    saveState(); paintTicker(); toast(`Breaking news: ${sources.length} outlets${f.get('popup') ? ', pop-ups on' : ''}`); route(true);
  };
  $('#bnTest').onclick = () => { const n = myNews(LIVE?.news).find(x => x.src); showPop(n || { s: 'CNA', t: 'Sample: this is how a breaking headline appears', at: now(), u: '#' }); };
  $('#nf').onchange = () => { const f = new FormData($('#nf')); ST.prefs = { ...P(), notify: Object.fromEntries(N.map(([k]) => [k, !!f.get(k)])) }; saveState(); toast('Notification settings saved'); };
  let resetArm = false;
  $('#paf').onsubmit = e => {
    e.preventDefault();
    if (!resetArm) { resetArm = true; $('#paReset').textContent = 'TAP AGAIN: START A NEW ACCOUNT'; return; }
    const f = new FormData(e.target);
    Object.assign(ST.paper, { start: Math.max(100, +f.get('start') || 1500), base: f.get('base'), fee: Math.max(0, Math.min(2, +f.get('fee') || 0)), resetAt: now(), eq: [] });
    ST.paper.orders.filter(o => o.status === 'open').forEach(o => Object.assign(o, { status: 'cancelled', u: now() }));
    saveState(); toast('New paper account started'); location.hash = 'paper';
  };
  $('#tokF').onsubmit = async e => {
    e.preventDefault();
    const t = $('#tok').value.trim(); if (!t) return;
    msg('tokMsg', 'Checking…');
    const prev = TOKEN; TOKEN = t;
    try {
      const repo = await (await gh('')).json();
      if (!repo.permissions?.push) throw new Error('That token can read but not write this repository.');
      await saveVault({ ...CFG, token: t, at: Date.now() });
      await saveFamily(); saveState(); toast('GitHub sync connected for the family'); route(true);
    } catch (x) { TOKEN = prev; msg('tokMsg', x.status === 401 ? 'GitHub rejected that token.' : x.status === 404 ? 'Token cannot see this repository; check repository access.' : x.message); }
  };
  $('#wkF').onsubmit = async e => {
    e.preventDefault();
    if (!TOKEN) return msg('wkMsg', 'Connect GitHub sync first.');
    const url = $('#wkU').value.trim(), key = $('#wkK').value.trim();
    if (url && !/^https:\/\//.test(url)) return msg('wkMsg', 'The Worker URL must start with https://');
    try {
      if (url) { const r = await fetch(`${url.replace(/\/$/, '')}/q?k=${encodeURIComponent(key)}&s=AAPL`); if (!r.ok) throw new Error(`Worker answered ${r.status}`); }
      await saveVault({ ...CFG, worker: url ? { url, key } : null }); msg('wkMsg', url ? 'Worker saved: prices now refresh every minute.' : 'Worker removed.'); pollLive();
    } catch (x) { msg('wkMsg', x.message); }
  };
  $('#exp').onclick = () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify({ profile: ME, state: ST }, null, 1)], { type: 'application/json' })), download: `ama-${ME.id}-${now().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#imp').onchange = async e => {
    try { const j = JSON.parse(await e.target.files[0].text()); ST = mergeState(ST, { ...j.state, at: Date.now() }); saveState(); toast('Imported and merged'); route(true); }
    catch (x) { toast(`Import failed: ${x.message}`); }
  };
  $('#logout').onclick = () => { store.del('k'); store.del('me'); location.reload(); };
  $('#pushOn')?.addEventListener('click', enablePush);
  $('#pushOff')?.addEventListener('click', disablePush);
  $('#pushTest')?.addEventListener('click', async () => {
    try { await gh('dispatches', { method: 'POST', body: JSON.stringify({ event_type: 'test-push', client_payload: { profile: ME.id } }) }); msg('pmsg', 'Test sent. It arrives in 1–2 minutes.'); }
    catch (x) { msg('pmsg', `Couldn't send (${x.message}).`); }
  });
};

// ---------------------------------------------------------------- push
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentSub() { try { return await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription(); } catch { return null; } }
async function enablePush() {
  const msg = t => { const el = $('#pmsg'); if (el) el.textContent = t; };
  if (!TOKEN) return msg('Connect GitHub sync first (Family section) so the server knows where to send.');
  try {
    if (await Notification.requestPermission() !== 'granted') return msg('Permission denied. Allow notifications for this site in your browser or phone settings.');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(VAPID.replace(/-/g, '+').replace(/_/g, '/')) });
    const j = sub.toJSON();
    // One device notifies one profile: drop this endpoint from whichever profile had it before.
    const prev = store.get('pushProfile');
    if (prev && prev !== ME.id) {
      const st = await readData(`p/${prev}.bin`).catch(() => null);
      if (st) { (st.subs || []).forEach(s => { if (s.endpoint === j.endpoint) Object.assign(s, { del: true, u: now() }); }); st.at = Date.now(); await putData(`p/${prev}.bin`, await seal(st), `profile ${prev}: move device`).catch(() => {}); }
    }
    store.set('pushProfile', ME.id);
    ST.subs = [...ST.subs.filter(s => s.endpoint !== j.endpoint), { ...j, dev: navigator.userAgent.slice(0, 80), at: now(), u: now() }];
    saveState(); toast('Notifications on'); setTimeout(() => route(true), 1200);
  } catch (e) { msg(`Couldn't enable: ${e.message}`); }
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) { ST.subs.forEach(s => { if (s.endpoint === sub.endpoint) Object.assign(s, { del: true, u: now() }); }); await sub.unsubscribe().catch(() => {}); store.del('pushProfile'); saveState(); }
  toast('Notifications off'); setTimeout(() => route(true), 900);
}

// ---------------------------------------------------------------- boot
function showLogin(note = '') {
  $('#login').hidden = false; $('#app').hidden = true;
  $('#loginMsg').textContent = note;
  $('#pw').focus();
  $('#login form').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#login button'); btn.disabled = true; $('#loginMsg').textContent = 'Unlocking…';
    try {
      if (!META) throw new Error('No market data has been published yet.');
      KEY = await derive($('#pw').value, META);
      D.summary = await mk('summary.bin').catch(() => { throw new Error('Wrong password.'); });
      if ($('#remember').checked) store.set('k', { salt: META.salt, raw: b64(new Uint8Array(await crypto.subtle.exportKey('raw', KEY))) });
      start();
    } catch (x) { $('#loginMsg').textContent = x.message; KEY = null; } finally { btn.disabled = false; }
  };
}
async function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  D.fx = D.summary.fx || {};
  shell();
  await loadVault();
  await loadFamily();
  const me = store.get('me');
  if (me && people().some(p => p.id === me)) await loadMe(me); else pickProfile();
  universe().then(() => { applyLive(); processOrders(); }).catch(() => {});
  loadLive().then(() => { processOrders(); if (ME) softRoute(); }).catch(() => {});
  if (ME) route();
  if (pushOk() && (await currentSub())) navigator.serviceWorker.register('sw.js');  // keep the worker fresh
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') location.hash = e.data.hash; });
}
(async function boot() {
  try { META = await (await fetch(`${RAW}market/meta.json?_=${Date.now()}`, { cache: 'no-store' })).json(); store.set('meta', META); }
  catch { META = store.get('meta'); }
  if (!META) return showLogin('No market data published yet. It appears after the first scheduled update.');
  const saved = store.get('k');
  if (saved?.salt === META.salt) {
    try {
      KEY = await crypto.subtle.importKey('raw', unb64(saved.raw), 'AES-GCM', true, ['encrypt', 'decrypt']);
      D.summary = await mk('summary.bin');
      return start();
    } catch { KEY = null; }
  }
  showLogin();
})();
