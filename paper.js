// paper.js: paper-trading maths. Pure functions, no DOM, so `node paper.test.mjs` can check them.
// The trade list is the source of truth: cash and positions are always recomputed from it, which also makes
// merging edits from two devices safe (union of trades by id).

export const LOT = s => /\.(KL|SI)$/.test(s) ? 100 : 1;  // Bursa and SGX trade in board lots of 100

// Units of `cur` per 1 USD (from the data's fx map) -> amount in `base`.
export function convert(amount, cur, base, fx) {
  if (cur === base) return amount;
  const f = c => c === 'USD' ? 1 : fx?.[c];
  const a = f(cur), b = f(base);
  if (!a || !b) return null;
  return amount / a * b;
}

export function newAccount(start = 1500, base = 'SGD', fee = 0.1) {
  return { start, base, fee, trades: [], orders: [], eq: [], resetAt: new Date(0).toISOString() };
}

const live = p => t => (t.at || '') >= (p.resetAt || '');

// Replays trades into cash, positions and realised P/L, all in the account's base currency.
export function holdings(p) {
  let cash = +p.start, realised = 0, fees = 0;
  const pos = {};
  for (const t of (p.trades || []).filter(live(p)).sort((a, b) => a.at.localeCompare(b.at))) {
    const gross = t.q * t.px * t.rate, fee = t.fee || 0;
    if (!(t.rate > 0)) continue;  // a trade without an exchange rate can't be valued; never let it poison the cash
    const x = pos[t.s] ||= { s: t.s, q: 0, cost: 0, costBase: 0, cur: t.cur };
    if (t.side === 'sell' && x.q <= 0) { delete pos[t.s]; continue; }  // a sell with nothing held (bad merge) is ignored
    fees += fee;
    if (t.side === 'buy') { cash -= gross + fee; x.q += t.q; x.cost += t.q * t.px; x.costBase += gross + fee; }
    else {
      const frac = t.q / x.q;
      const proceeds = gross - fee;
      realised += proceeds - x.costBase * frac;
      cash += proceeds; x.cost -= x.cost * frac; x.costBase -= x.costBase * frac; x.q -= t.q;
    }
    if (x.q <= 1e-9) delete pos[t.s];
  }
  for (const x of Object.values(pos)) x.avg = x.cost / x.q;
  return { cash, pos, realised, fees };
}

// Account value now. price(s) -> { px, cur } in the instrument's own currency.
export function value(p, price, fx) {
  const h = holdings(p);
  let invested = 0, missing = 0;
  for (const x of Object.values(h.pos)) {
    const q = price(x.s);
    const v = q ? convert(x.q * q.px, q.cur || x.cur, p.base, fx) : null;
    x.px = q?.px ?? x.avg;
    x.value = v ?? convert(x.cost, x.cur, p.base, fx) ?? x.costBase;
    x.pl = x.value - x.costBase;
    x.plPct = x.costBase ? x.pl / x.costBase : 0;
    if (v == null) missing++;
    invested += x.value;
  }
  const equity = h.cash + invested;
  return { ...h, invested, equity, ret: equity / p.start - 1, unrealised: invested - Object.values(h.pos).reduce((a, x) => a + x.costBase, 0), missing };
}

// Checks an order before it is placed. Returns an error message, or '' when fine.
export function check(p, o, quote, fx, opts = {}) {
  if (!o.s) return 'Pick a stock.';
  if (/[\^=]/.test(o.s)) return `${o.s} is an index, future or currency: not tradable here. Try a stock or a Shariah ETF.`;
  if (!(o.q > 0) || !Number.isInteger(o.q)) return 'Quantity must be a whole number of shares.';
  if (o.q % LOT(o.s)) return `${o.s} trades in board lots of ${LOT(o.s)} shares.`;
  if (opts.shariahOnly && o.side === 'buy' && opts.status === 'F') return 'Shariah-only mode: this stock is not Shariah-compliant (status F).';
  if (o.type !== 'market' && !(o.px > 0)) return 'Enter a price for limit/stop orders.';
  const h = holdings(p);
  if (o.side === 'sell') {
    const held = h.pos[o.s]?.q || 0;
    const reserved = (p.orders || []).filter(x => x.status === 'open' && x.side === 'sell' && x.s === o.s).reduce((a, x) => a + x.q, 0);
    if (o.q > held - reserved) return `You can sell at most ${held - reserved} (no short selling in a Shariah account).`;
    if (convert(1, quote?.cur || h.pos[o.s]?.cur || 'USD', p.base, fx) == null) return 'No exchange rate for this currency yet.';
    return '';
  }
  const px = o.type === 'market' ? quote?.px : o.px;
  if (!px) return 'No price available for this stock yet.';
  const cost = convert(o.q * px, quote?.cur || 'USD', p.base, fx);
  if (cost == null) return 'No exchange rate for this currency yet.';
  const reserved = (p.orders || []).filter(x => x.status === 'open' && x.side === 'buy').reduce((a, x) => a + (x.reserve || 0), 0);
  const need = cost * (1 + p.fee / 100);
  if (need > h.cash - reserved + 1e-6) return `Not enough cash: need ${need.toFixed(2)} ${p.base}, have ${(h.cash - reserved).toFixed(2)} (open orders reserve cash).`;
  return '';
}

// Returns null when there is no exchange rate yet (callers keep the order open / show an error).
export function makeTrade(p, o, px, cur, fx, at = new Date().toISOString()) {
  const rate = convert(1, cur, p.base, fx);
  if (!(rate > 0) || !(px > 0)) return null;
  return { id: o.id || rid(), s: o.s, side: o.side, q: o.q, px, cur, rate, fee: o.q * px * rate * p.fee / 100, at, type: o.type };
}

// Should a resting order fill, given the latest quote { px, h, l, d }? Returns the fill price or null.
// On the day the order was placed (o.d0 = the quote's trading date then) only the current price counts: that day's
// high/low may have happened before the order existed. On later days the day's high/low count too.
export function trigger(o, q) {
  if (o.status !== 'open' || !q || !(q.px > 0)) return null;
  const d0 = o.d0 || o.at.slice(0, 10);
  if (q.d && q.d < d0) return null;
  const later = q.d && q.d > d0;
  const hi = later ? q.h ?? q.px : q.px, lo = later ? q.l ?? q.px : q.px;
  if (o.side === 'buy' && o.type === 'limit' && lo <= o.px) return Math.min(o.px, q.px <= o.px ? q.px : o.px);
  if (o.side === 'buy' && o.type === 'stop' && hi >= o.px) return Math.max(o.px, q.px);
  if (o.side === 'sell' && o.type === 'limit' && hi >= o.px) return Math.max(o.px, q.px >= o.px ? q.px : o.px);
  if (o.side === 'sell' && o.type === 'stop' && lo <= o.px) return Math.min(o.px, q.px);
  return null;
}

// Union of two lists by id; the copy with the newer `u` (or `at`) wins. Used to merge devices' edits.
export function mergeList(a = [], b = [], key = 'id') {
  const m = new Map();
  for (const x of [...a, ...b]) {
    const k = x[key], cur = m.get(k);
    if (!cur || (x.u || x.at || '') >= (cur.u || cur.at || '')) m.set(k, x);
  }
  return [...m.values()];
}

export const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
