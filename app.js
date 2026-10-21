// app.js: Halal Terminal. Unlocks the encrypted snapshot on the `market` branch and renders every view.
// Data flow: GitHub Actions (scripts/build.py) -> market branch (AES-GCM, gzip'd JSON) -> this page.
// Personal state (watchlist, push subscriptions) lives encrypted on the `data` branch; writes need a GitHub token,
// which is itself stored encrypted on that branch (vault.bin) so every device unlocks it with the password alone.
import { LEARN, PATTERNS, GLOSSARY, RESOURCES, candleSvg } from './learn.js';

const qs = new URLSearchParams(location.search);
const REPO = qs.get('repo') || (() => {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/), p = location.pathname.split('/')[1];
  return m && p ? `${m[1]}/${p}` : 'MikachuFM2202/stocks-tracker';
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

// Personal state on the data branch.
let ST = store.get('st', { wl: [], subs: [], at: 0 });
let TOKEN = null;
async function gh(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { ...opt, headers: {
    Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opt.headers || {}) } });
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status });
  return r;
}
async function readData(name) {
  if (TOKEN) {  // the API is fresh; raw.githubusercontent caches for ~5 minutes
    try { return await unseal(await (await gh(`contents/${name}?ref=data&_=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw+json' } })).arrayBuffer()); }
    catch (e) { if (e.status === 404) return null; }
  }
  const r = await fetch(`${RAW}data/${name}?_=${Date.now()}`, { cache: 'no-store' });
  return r.ok ? unseal(await r.arrayBuffer()) : null;
}
async function putData(name, bytes, message) {
  for (let i = 0; i < 4; i++) {
    let sha;
    try { sha = (await (await gh(`contents/${name}?ref=data&_=${Date.now()}`)).json()).sha; } catch (e) { if (e.status !== 404) throw e; }
    try { return await gh(`contents/${name}`, { method: 'PUT', body: JSON.stringify({ message, content: b64(bytes), branch: 'data', sha }) }); }
    catch (e) { if (![409, 422].includes(e.status) || i === 3) throw e; await sleep(400 * (i + 1) + Math.random() * 300); }
  }
}
async function loadState() {
  try { const v = await readData('vault.bin'); TOKEN = v?.token || null; } catch {}
  try {
    const remote = await readData('state.bin');
    if (remote && (remote.at || 0) >= (ST.at || 0)) { ST = { wl: [], subs: [], ...remote }; store.set('st', ST); }
  } catch {}
}
let saveT = null, syncMsg = '';
function saveState() {
  ST.at = Date.now(); store.set('st', ST);
  clearTimeout(saveT);
  if (!TOKEN) { syncMsg = 'Saved on this device only (connect GitHub in Settings to sync).'; return; }
  saveT = setTimeout(async () => {
    try {
      const remote = await readData('state.bin').catch(() => null);
      // Subscriptions from other devices must survive this write.
      const subs = new Map([...(remote?.subs || []), ...ST.subs].map(s => [s.endpoint, s]));
      ST.subs = [...subs.values()];
      await putData('state.bin', await seal(ST), 'state: update');
      syncMsg = `Synced ${new Date().toLocaleTimeString()}`;
    } catch (e) { syncMsg = `Sync failed (${e.message}). Kept on this device.`; toast(syncMsg); }
  }, 700);
}
const inWl = s => ST.wl.some(w => w.s === s);
function toggleWl(s, n) {
  if (inWl(s)) ST.wl = ST.wl.filter(w => w.s !== s);
  else ST.wl.unshift({ s, n: n || D.bySym.get(s)?.n || s, add: new Date().toISOString().slice(0, 10) });
  saveState(); toast(inWl(s) ? `Added ${s} to watchlist` : `Removed ${s}`);
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
const pct = (v, d = 2) => v == null || !isFinite(v) ? '<span class="flat">–</span>' : `<span class="${cls(v)}">${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%</span>`;
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
const TABS = [['mkt', 'MKT', 'Market'], ['brief', 'BRF', 'Reports'], ['ideas', 'IDEA', 'Shariah ideas'], ['screen', 'SCRN', 'Screener'],
  ['wl', 'WL', 'Watchlist'], ['news', 'NEWS', 'News & calendar'], ['media', 'TV', 'Watch & listen'], ['learn', 'EDU', 'Learn'],
  ['glossary', 'GLOS', 'Terms'], ['settings', 'SET', 'Settings']];
let cleanup = [];
function shell() {
  $('#tabs').innerHTML = TABS.map(([id, k, n]) => `<a href="#${id}" data-tab="${id}"><b>${k}</b>${n}</a>`).join('');
  const h = () => document.documentElement.style.setProperty('--top-h', $('.top').offsetHeight + 'px');
  h(); addEventListener('resize', h);
  setInterval(tick, 15000); tick();
  $('#cmd').addEventListener('submit', e => { e.preventDefault(); go($('#cmdIn').value); });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-star]');
    if (b) { e.preventDefault(); toggleWl(b.dataset.star, b.dataset.n); $$(`[data-star="${CSS.escape(b.dataset.star)}"]`).forEach(x => x.classList.toggle('on', inWl(b.dataset.star))); return; }
    const tr = e.target.closest('tr[data-go]');
    if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.go;
  });
  addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { await refreshMeta(); } });
}
function tick() {
  const now = new Date();
  $('#clock').innerHTML = `<b>SGT</b> ${now.toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false })} · data ${D.summary ? ago(D.summary.at) : '–'}`;
  const el = $('#sessions'); if (el) el.innerHTML = sessionsHtml();
}
async function refreshMeta() {
  try {
    const m = await (await fetch(`${RAW}market/meta.json?_=${Date.now()}`, { cache: 'no-store' })).json();
    if (m.at !== META.at) { META = m; store.set('meta', m); files.clear(); D.uni = null; D.bySym.clear(); D.summary = await mk('summary.bin'); toast('New market data loaded'); route(); }
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
async function route() {
  cleanup.forEach(f => { try { f(); } catch {} }); cleanup = [];
  const [v, ...rest] = location.hash.slice(1).split('/');
  const view = VIEWS[v] ? v : 'mkt';
  $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (view === 'stock' ? '' : view === 'reports' ? 'brief' : view)));
  const main = $('#main');
  main.innerHTML = '<p class="muted mono">LOADING…</p>';
  try { await VIEWS[view](decodeURIComponent(rest.join('/')), main); }
  catch (e) { console.error(e); main.innerHTML = `<div class="warn">Couldn't load this view: ${esc(e.message)}. Check your connection and try again.</div>`; }
  if (!location.hash.includes('/')) scrollTo(0, 0);
  $('#foot').innerHTML = `Snapshot ${esc(sgt(D.summary.at))} SGT (${esc(D.summary.mode)} run) · prices delayed / end-of-day · statistical outlooks, not certainties · educational, not financial advice`;
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
  mkt = MKT[mkt] ? mkt : store.get('im', 'US');
  store.set('im', mkt);
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

VIEWS.wl = async (_, main) => {
  const U = await universe();
  const moo = await readData('moomoo.bin').catch(() => null);
  const rows = ST.wl.map(w => ({ w, r: D.bySym.get(w.s) || macroRow(w.s) }));
  main.innerHTML = `<div class="grid wide">${panel('Watchlist', `
    <form class="row pb" id="wlAdd"><input class="f sp" id="wlIn" list="cmdList" placeholder="Add ticker: AAPL, 5347.KL, D05.SI, 7203.T" autocapitalize="characters"><button class="btn">ADD</button></form>
    <div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Name</th><th class="l">Status</th><th>Last</th><th>1D</th><th>1W</th><th>1M</th><th>RSI</th><th class="l">Bias</th><th>↑1W</th><th>↑1M</th>
      <th title="Push alert when price goes above">Alert ≥</th><th title="Push alert when price goes below">Alert ≤</th><th class="l">Notes</th><th></th></tr></thead><tbody>
    ${rows.map(({ w, r }) => `<tr data-s="${esc(w.s)}"><td class="l"><a class="sym" href="#stock/${encodeURIComponent(w.s)}">${esc(w.s)}</a></td><td class="nm l">${esc(r?.n || w.n)}</td>
      <td class="l">${r ? badge(r.st) : '<span class="note">next update</span>'}</td><td>${px(r?.px)}</td><td>${pct(r?.r1)}</td><td>${pct(r?.r5)}</td><td>${pct(r?.r21)}</td><td>${r?.rsi?.toFixed(0) ?? '–'}</td>
      <td class="l">${biasHtml(r?.bias)}</td><td>${fcCell(r?.fc, 5)}</td><td>${fcCell(r?.fc, 21)}</td>
      <td><input class="f" style="width:84px" inputmode="decimal" data-f="above" value="${w.above ?? ''}"></td><td><input class="f" style="width:84px" inputmode="decimal" data-f="below" value="${w.below ?? ''}"></td>
      <td class="l"><input class="f" style="width:220px" data-f="note" value="${esc(w.note || '')}" placeholder="Why am I watching this?"></td>
      <td><button class="btn sm ghost" data-rm>✕</button></td></tr>`).join('') || '<tr><td colspan="15" class="l muted">Empty. Add tickers above, or tap ★ anywhere.</td></tr>'}
    </tbody></table></div>
    <p class="pb note">${esc(syncMsg || (TOKEN ? 'Synced across your devices.' : 'Saved on this device. Connect GitHub in Settings to sync and get alerts.'))} Alerts and big-move (±5%) notifications are checked at each data update (≈06:30 and 18:15 SGT on weekdays), not live.</p>`, '', 'span')}
    ${moo ? panel(`moomoo · snapshot ${esc(sgt(moo.at))} SGT`, mooHtml(moo), '', 'span') : ''}
    ${panel('Upcoming earnings (watchlist + big certified names)', `<ul class="list">${(D.summary.earnings || []).map(e => `<li><a href="#stock/${encodeURIComponent(e.s)}">${esc(e.s)}</a> ${esc(e.n)} <small>${esc(sgt(e.at))} SGT</small></li>`).join('') || '<li class="muted">None in the next 3 weeks.</li>'}</ul>`)}
    </div>`;
  $('#wlAdd').onsubmit = e => {
    e.preventDefault();
    const raw = $('#wlIn').value.trim().toUpperCase(); if (!raw) return;
    const s = U.find(r => r.s === raw)?.s || U.find(r => r.s.split('.')[0] === raw)?.s || raw;
    if (!inWl(s)) toggleWl(s, U.find(r => r.s === s)?.n);
    route();
  };
  $$('tr[data-s]', main).forEach(tr => {
    const w = ST.wl.find(x => x.s === tr.dataset.s);
    $$('input[data-f]', tr).forEach(inp => inp.onchange = () => {
      const f = inp.dataset.f, v = inp.value.trim();
      w[f] = f === 'note' ? v : v === '' ? null : +v;
      if (f !== 'note' && v !== '' && !isFinite(+v)) { toast('Enter a number'); return; }
      saveState(); toast('Saved');
    });
    $('[data-rm]', tr).onclick = () => { toggleWl(w.s); route(); };
  });
  $$('[data-import]', main).forEach(b => b.onclick = () => { JSON.parse(b.dataset.import).forEach(s => { if (!inWl(s)) ST.wl.push({ s, n: s, add: new Date().toISOString().slice(0, 10) }); }); saveState(); route(); });
};
function mooHtml(m) {
  const q = (m.quotes || []).map(x => `<tr><td class="l"><a class="sym" href="#stock/${encodeURIComponent(x.s)}">${esc(x.s)}</a></td><td class="nm l">${esc(x.n)}</td><td>${px(x.px)}</td><td>${pct(x.chg)}</td><td>${big(x.vol)}</td><td>${big(x.turnover)}</td></tr>`).join('');
  const groups = Object.entries(m.groups || {}).map(([g, list]) => `<p><b>${esc(g)}</b> ${list.map(s => `<a href="#stock/${encodeURIComponent(s)}">${esc(s)}</a>`).join(', ')} <button class="btn sm ghost" data-import='${esc(JSON.stringify(list))}'>Add all to watchlist</button></p>`).join('');
  const pos = (m.positions || []).map(p => `<tr><td class="l">${esc(p.s)}</td><td>${p.qty}</td><td>${px(p.cost)}</td><td>${px(p.px)}</td><td>${pct(p.pl)}</td></tr>`).join('');
  return `<div class="tw"><table><thead><tr><th>Ticker</th><th class="l">Name</th><th>Last</th><th>Chg</th><th>Volume</th><th>Turnover</th></tr></thead><tbody>${q}</tbody></table></div>
    <div class="pb">${groups}${pos ? `<h3 class="amber mono">Positions</h3><div class="tw"><table><thead><tr><th>Ticker</th><th>Qty</th><th>Cost</th><th>Last</th><th>P/L</th></tr></thead><tbody>${pos}</tbody></table></div>` : ''}</div>`;
}

VIEWS.stock = async (s, main) => {
  await universe();
  let r = D.bySym.get(s) || macroRow(s);
  if (!r) {
    main.innerHTML = `<div class="warn">${esc(s)} isn't in the tracked universe yet. Add it to your watchlist and the next data update (06:30 / 18:15 SGT) will fetch it, screen it and add a chart.</div>
      <p>${star(s, s)} Add ${esc(s)} to watchlist · <a href="https://finance.yahoo.com/quote/${encodeURIComponent(s)}" target="_blank" rel="noopener">Yahoo Finance</a> · <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSym(s))}" target="_blank" rel="noopener">TradingView</a></p>`;
    return;
  }
  const isEq = !!r.m;
  const about = isEq ? (await mk('about.bin').catch(() => ({})))[s] || {} : {};
  const fc = h => r.fc?.[h] || r.fc?.[String(h)];
  const news = (D.summary.news || []).filter(n => n.sym === s);
  main.innerHTML = `
    <div class="qhead">${star(s, r.n)}<h1 style="margin:0">${esc(s)}</h1><span class="nm">${esc(r.n)}${isEq ? ` · ${MKT[r.m]} · ${esc(r.sec || '')}` : ''}</span>${badge(r.st)}
      <span class="px mono">${px(r.px)}</span><span class="mono">${pct(r.r1)} today</span><span class="note">${esc(r.cur || '')} · close ${esc(r.d || '')}</span></div>
    <div class="grid wide">
      <section class="panel span"><div class="ph"><h2>Chart</h2><div class="chips" id="rng">${['3M', '6M', '1Y', '2Y'].map(k => `<button class="chip ${k === '6M' ? 'on' : ''}" data-r="${k}">${k}</button>`).join('')}
        <button class="chip" id="tvBtn" title="Live intraday chart from TradingView">LIVE (TradingView)</button></div></div>
        <div class="chart" id="ch"><div class="legend" id="lg"></div></div><div class="tv" id="tv" hidden></div>
        <div class="pb note">Candles daily · <span style="color:#ffe14d">SMA20</span> · <span style="color:#5fb4ff">SMA50</span> · <span style="color:#c38cff">SMA200</span> · volume · RSI(14) at the bottom · dashed amber = statistical 68% range for ~1W/1M/3M ahead.</div></section>
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
        <p class="note">Debt/market cap ${pctp(r.dm)} · cash/market cap ${pctp(r.cm)}. Dividends: purify the non-halal income share (see Learn → Shariah investing). Status can change at each review; Malaysian names are re-reviewed every May and November.</p></div>`) : ''}
      ${about.about ? panel('What the company does', `<div class="pb">${esc(about.about)}${about.about.length >= 690 ? '…' : ''}</div>`) : ''}
      ${panel('Research links', `<div class="pb">${links(r)}</div>`)}
      ${panel('Latest news', `<ul class="list">${news.map(n => `<li><a href="${esc(safe(n.u))}" target="_blank" rel="noopener">${esc(n.t)}</a><br><small>${esc(n.s || '')} · ${esc(n.at ? ago(n.at) : '')}</small></li>`).join('')
        || `<li>Not on your watchlist, so no saved headlines. <a href="https://news.google.com/search?q=${encodeURIComponent(`"${r.n}"`)}&hl=en-SG&gl=SG&ceid=SG:en" target="_blank" rel="noopener">Search Google News</a></li>`}</ul>`)}
    </div>`;
  const bars = await mk(`ohlc/${s.replace(/[^A-Za-z0-9.-]/g, '_')}.bin`).catch(() => null);
  if (!bars || !window.LightweightCharts) { $('#ch').innerHTML = '<p class="pb muted">Chart data unavailable.</p>'; return; }
  drawChart(bars, r);
  $('#tvBtn').onclick = () => {
    const tv = $('#tv'), on = tv.hidden;
    tv.hidden = !on; $('#ch').hidden = on; $('#tvBtn').classList.toggle('on', on);
    if (on && !tv.firstChild) tv.innerHTML = `<iframe title="TradingView chart" style="width:100%;height:100%;border:0" src="https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSym(s))}&interval=D&theme=dark&style=1&timezone=Asia%2FSingapore&withdateranges=1&hide_side_toolbar=0&allow_symbol_change=1&studies=%5B%5D&locale=en"></iframe>`;
  };
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
function drawChart(b, r) {
  const LW = window.LightweightCharts, el = $('#ch');
  const chart = LW.createChart(el, {
    autoSize: true, layout: { background: { color: '#000' }, textColor: '#8c8c8c', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 },
    grid: { vertLines: { color: '#121212' }, horzLines: { color: '#121212' } }, crosshair: { mode: 0 },
    rightPriceScale: { borderColor: '#2a2a2a', scaleMargins: { top: .05, bottom: .32 } }, timeScale: { borderColor: '#2a2a2a', rightOffset: 4 },
    localization: { priceFormatter: px },
  });
  cleanup.push(() => chart.remove());
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
  sma(20, '#ffe14d'); sma(50, '#5fb4ff'); sma(200, '#c38cff');
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
  const pts = [[5], [21], [63]].map(([h]) => [h, r.fc?.[h] || r.fc?.[String(h)]]).filter(x => x[1]);
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
  const setRange = k => {
    const days = { '3M': 92, '6M': 183, '1Y': 366, '2Y': 740 }[k];
    chart.timeScale().setVisibleRange({ from: last.time - days * 86400, to: pts.length ? ahead(pts[pts.length - 1][0]) : last.time });
    $$('#rng [data-r]').forEach(b => b.classList.toggle('on', b.dataset.r === k));
  };
  $$('#rng [data-r]').forEach(bt => bt.onclick = () => setRange(bt.dataset.r));
  setRange('6M');
}

VIEWS.news = async (_, main) => {
  const S = D.summary, groups = [...new Set(S.news.map(n => n.g))];
  const g = store.get('ng', 'All');
  const items = S.news.filter(n => g === 'All' || n.g === g);
  const byDay = {};
  for (const e of S.calendar || []) (byDay[sgt(e.at, { weekday: 'short', day: 'numeric', month: 'short' })] ||= []).push(e);
  main.innerHTML = `<div class="grid wide">
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

VIEWS.media = async (_, main) => {
  const M = D.summary.media || { vids: [], pods: [] };
  const vids = [...M.vids].sort((a, b) => new Date(b.at) - new Date(a.at));
  main.innerHTML = `<div class="grid wide">
    ${panel('Start here · the video you shared', `<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/${FEATURED}" title="StockedUp: The Stock Market Is Being Manipulated…" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>
      <p class="pb note">StockedUp · "The Stock Market Is Being Manipulated…". Watch critically: ask what evidence is shown, and what would prove it wrong.</p>`)}
    ${panel('Study plan · what to watch next', `<div class="pb">${RESOURCES.study.map(([t, q, why]) => `<p><a href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}" target="_blank" rel="noopener">▶ ${esc(t)}</a><br><span class="note">${esc(why)}</span></p>`).join('')}</div>`)}
    ${panel('Latest from market channels', `<div class="pb vids">${vids.slice(0, 36).map(v => `<a class="vid" href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg"><div>${esc(v.t)}<small>${esc(v.src)} · ${v.at ? esc(ago(v.at)) : ''}</small></div></a>`).join('') || '<p class="muted">Video feeds were unavailable at the last update.</p>'}</div>`, '', 'span')}
    ${panel('Latest podcast episodes', `<ul class="list">${M.pods.map(p => `<li><b class="amber">${esc(p.src)}</b><br><a href="${esc(safe(p.u))}" target="_blank" rel="noopener">${esc(p.t)}</a> <small>${p.at ? esc(ago(p.at)) : ''}</small></li>`).join('')}</ul>`)}
    ${panel('Channels & shows to follow', `<div class="pb">${RESOURCES.channels.map(([t, u, d]) => `<p><a href="${esc(safe(u))}" target="_blank" rel="noopener">${esc(t)}</a> <span class="note">${esc(d)}</span></p>`).join('')}</div>`)}
  </div>`;
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

VIEWS.settings = async (_, main) => {
  const sub = await currentSub();
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('Halal Terminal sync')}&description=${encodeURIComponent('Lets the stocks-tracker site save the watchlist and push subscriptions')}&target_name=${encodeURIComponent(REPO.split('/')[0])}&contents=write&actions=write`;
  const ios = /iPhone|iPad/.test(navigator.userAgent), standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  main.innerHTML = `<div class="grid">
    ${panel('Sync across devices', `<div class="pb">${TOKEN ? `<p class="up">Connected. Watchlist and alerts sync to the encrypted <code>data</code> branch of ${esc(REPO)}.</p>
      <div class="row"><button class="btn ghost" id="refresh">REFRESH DATA NOW</button><button class="btn ghost" id="forget">DISCONNECT THIS TOKEN</button></div><p class="note" id="rmsg"></p>`
      : `<p>One-time setup per account (not per device): create a fine-grained GitHub token for <b>${esc(REPO)}</b> only, with <b>Contents: Read and write</b> and <b>Actions: Read and write</b>. It's stored encrypted with your password, so other devices pick it up automatically.</p>
      <p><a class="btn ghost" href="${esc(tokenUrl)}" target="_blank" rel="noopener">CREATE TOKEN ON GITHUB ↗</a></p>
      <form class="row" id="tokF"><input class="f sp" id="tok" type="password" placeholder="github_pat_…" autocomplete="off"><button class="btn">SAVE</button></form><p class="err" id="tokMsg"></p>`}</div>`)}
    ${panel('Notifications', `<div class="pb">${!pushOk() ? `<p>${ios && !standalone ? 'On iPhone: tap Share → <b>Add to Home Screen</b>, open the app from the home screen, then come back here.' : 'This browser does not support push notifications.'}</p>`
      : `<p>Get the daily brief (~06:30 SGT), the Sunday weekly report (17:00 SGT), and your watchlist price alerts on this device.</p>
      <div class="row"><button class="btn" id="pushOn" ${sub ? 'hidden' : ''}>ENABLE NOTIFICATIONS</button><button class="btn ghost" id="pushTest" ${sub ? '' : 'hidden'}>SEND TEST</button><button class="btn ghost" id="pushOff" ${sub ? '' : 'hidden'}>TURN OFF</button></div>
      <p class="note" id="pmsg">${sub ? 'On for this device.' : ''}${TOKEN ? '' : ' Needs the GitHub sync above first.'}</p>`}
      <p class="note">Install as an app: iPhone Safari → Share → Add to Home Screen. Android Chrome → ⋮ → Install app. Desktop Chrome → install icon in the address bar.</p></div>`)}
    ${panel('moomoo OpenAPI', `<div class="pb md">${LEARN.find(x => x.id === 'moomoo').html}</div>`)}
    ${panel('Data & schedule', `<div class="pb"><p>Snapshot: <b>${esc(sgt(D.summary.at))} SGT</b> (${esc(D.summary.mode)}). Universe: ${Object.entries(D.summary.counts || {}).map(([m, c]) => `${m} ${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ')}`).join(' · ')}.</p>
      <ul><li>Mon–Sat 06:30 SGT: US close + daily AI brief + notifications</li><li>Mon–Fri 18:15 SGT: Asia close refresh</li><li>Sun 17:00 SGT: universe + Shariah re-screen + full weekly report</li></ul>
      <p class="note">Prices: Yahoo Finance (delayed/end-of-day). Shariah: SC Malaysia SAC list (${esc(D.summary.sc?.asof || '?')}), SP Funds S&P Shariah ETF holdings, own AAOIFI-style ratio screen. News: Google News. Calendar: Forex Factory. AI: Gemini free tier (numbers-only reports if no key is set). Everything is encrypted with your password before it's published.</p>
      <div class="row"><button class="btn ghost" id="logout">LOCK &amp; FORGET PASSWORD ON THIS DEVICE</button></div></div>`)}
  </div>`;
  $('#logout').onclick = () => { store.del('k'); location.reload(); };
  $('#tokF')?.addEventListener('submit', async e => {
    e.preventDefault();
    const t = $('#tok').value.trim(), msg = $('#tokMsg');
    msg.textContent = 'Checking…'; TOKEN = t;
    try {
      const repo = await (await gh('')).json();
      if (!repo.permissions?.push) throw new Error('That token can read but not write this repository.');
      await putData('vault.bin', await seal({ token: t, at: Date.now() }), 'vault: store sync token');
      await putData('state.bin', await seal({ ...ST, at: Date.now() }), 'state: first sync');
      toast('Connected'); route();
    } catch (x) { TOKEN = null; msg.textContent = x.status === 401 ? 'GitHub rejected that token.' : x.status === 404 ? 'Token cannot see this repository; check repository access.' : x.message; }
  });
  $('#forget')?.addEventListener('click', async () => { TOKEN = null; toast('Token disconnected on this device (still saved for others).'); route(); });
  $('#refresh')?.addEventListener('click', async () => {
    try { await gh('actions/workflows/market.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode: 'evening' } }) }); $('#rmsg').textContent = 'Started. New data in ~10–15 minutes.'; }
    catch (x) { $('#rmsg').textContent = `Couldn't start it (${x.message}). The token needs Actions: Read and write.`; }
  });
  $('#pushOn')?.addEventListener('click', enablePush);
  $('#pushOff')?.addEventListener('click', disablePush);
  $('#pushTest')?.addEventListener('click', async () => {
    try { await gh('dispatches', { method: 'POST', body: JSON.stringify({ event_type: 'test-push' }) }); $('#pmsg').textContent = 'Test sent. It arrives in about a minute.'; }
    catch (x) { $('#pmsg').textContent = `Couldn't send (${x.message}).`; }
  });
};

// ---------------------------------------------------------------- push
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function currentSub() { try { return await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription(); } catch { return null; } }
async function enablePush() {
  const msg = $('#pmsg');
  if (!TOKEN) { msg.textContent = 'Connect GitHub sync first (above) so the server knows where to send.'; return; }
  try {
    if (await Notification.requestPermission() !== 'granted') { msg.textContent = 'Permission denied. Allow notifications for this site in your browser settings.'; return; }
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(VAPID.replace(/-/g, '+').replace(/_/g, '/')) });
    const j = sub.toJSON();
    ST.subs = [...ST.subs.filter(s => s.endpoint !== j.endpoint), { ...j, dev: navigator.userAgent.slice(0, 80), at: Date.now() }];
    saveState(); toast('Notifications on'); setTimeout(route, 900);
  } catch (e) { msg.textContent = `Couldn't enable: ${e.message}`; }
}
async function disablePush() {
  const sub = await currentSub();
  if (sub) { ST.subs = ST.subs.filter(s => s.endpoint !== sub.endpoint); await sub.unsubscribe().catch(() => {}); saveState(); }
  toast('Notifications off'); setTimeout(route, 900);
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
  shell();
  await loadState();
  route();
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
