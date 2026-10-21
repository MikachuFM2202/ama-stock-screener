// node paper.test.mjs: smallest checks that fail if the paper-trading maths breaks.
import assert from 'node:assert/strict';
import { newAccount, holdings, value, check, makeTrade, trigger, convert, mergeList } from './paper.js';

const fx = { USD: 1, SGD: 1.3, MYR: 4.0 };
assert.equal(convert(100, 'USD', 'SGD', fx), 130);
assert.equal(Math.round(convert(400, 'MYR', 'SGD', fx)), 130);
assert.equal(convert(1, 'XXX', 'SGD', fx), null);

const p = newAccount(10000, 'SGD', 0.1);
const t1 = makeTrade(p, { s: 'AAPL', side: 'buy', q: 10, type: 'market' }, 100, 'USD', fx, '2026-10-21T01:00:00Z');
p.trades.push(t1);
let h = holdings(p);
assert.equal(h.pos.AAPL.q, 10);
assert.ok(Math.abs(h.cash - (10000 - 1300 - 1.3)) < 1e-9);          // cost + 0.1% fee, in SGD
p.trades.push(makeTrade(p, { s: 'AAPL', side: 'sell', q: 5, type: 'market' }, 120, 'USD', fx, '2026-10-22T01:00:00Z'));
h = holdings(p);
assert.equal(h.pos.AAPL.q, 5);
assert.ok(Math.abs(h.realised - (5 * 120 * 1.3 - 0.78 - (1301.3 / 2))) < 1e-9);
const v = value(p, s => ({ px: 110, cur: 'USD' }), fx);
assert.ok(Math.abs(v.equity - (h.cash + 5 * 110 * 1.3)) < 1e-9);

// order checks: board lots, no short selling, cash, Shariah-only
assert.match(check(p, { s: '5347.KL', side: 'buy', q: 50, type: 'market' }, { px: 13, cur: 'MYR' }, fx), /board lots/);
assert.match(check(p, { s: 'AAPL', side: 'sell', q: 6, type: 'market' }, null, fx), /at most 5/);
assert.match(check(p, { s: 'MSFT', side: 'buy', q: 1000, type: 'market' }, { px: 400, cur: 'USD' }, fx), /Not enough cash/);
assert.match(check(p, { s: 'D05.SI', side: 'buy', q: 100, type: 'market' }, { px: 40, cur: 'SGD' }, fx, { shariahOnly: true, status: 'F' }), /Shariah/);
assert.equal(check(p, { s: 'D05.SI', side: 'buy', q: 100, type: 'market' }, { px: 40, cur: 'SGD' }, fx), '');

// resting orders
const o = { status: 'open', side: 'buy', type: 'limit', px: 100, at: '2026-10-21T02:00:00Z' };
assert.equal(trigger(o, { px: 105, h: 106, l: 101, d: '2026-10-21' }), null);
assert.equal(trigger(o, { px: 99, h: 106, l: 98, d: '2026-10-21' }), 99);
assert.equal(trigger(o, { px: 99, h: 106, l: 98, d: '2026-10-20' }), null);     // stale quote
assert.equal(trigger({ ...o, side: 'sell', type: 'stop', px: 95 }, { px: 94, h: 100, l: 93, d: '2026-10-21' }), 94);

// reset hides old trades
p.resetAt = '2026-10-23T00:00:00Z';
assert.equal(holdings(p).cash, 10000);

// merge keeps the newer copy and the union
const m = mergeList([{ id: 'a', u: '1', x: 1 }, { id: 'b', u: '1' }], [{ id: 'a', u: '2', x: 2 }, { id: 'c', u: '1' }]);
assert.deepEqual(m.map(x => x.id).sort(), ['a', 'b', 'c']);
assert.equal(m.find(x => x.id === 'a').x, 2);
console.log('ok');
