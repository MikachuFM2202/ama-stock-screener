"""Smallest checks that fail if the screening, forecast or number-check logic breaks: python scripts/test_build.py"""
import os, sys, tempfile
os.environ.setdefault('OUT', tempfile.mkdtemp())
sys.argv = ['x', 'daily']
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'local'))
import build as b
from moomoo_bridge import moo, yahoo

# Shariah classification
assert b.classify({'m': 'MY', 'sc': True}, {})[0] == 'C'
assert b.classify({'m': 'MY', 'sc': False}, {})[0] == 'F'
assert b.classify({'m': 'US', 'spf': ['SPUS']}, {})[0] == 'C'
f = {'industry': 'Banks - Regional', 'marketCap': 1e9, 'totalDebt': 0, 'totalCash': 0}
assert b.classify({'m': 'SG'}, f)[0] == 'F'
f = {'industry': 'Semiconductors', 'marketCap': 1e9, 'totalDebt': 2e8, 'totalCash': 1e8}
assert b.classify({'m': 'SG'}, f)[0] == 'P'
assert b.classify({'m': 'SG'}, dict(f, totalDebt=3e8))[0] == 'F'      # 30% limit is exclusive
assert b.classify({'m': 'SG'}, dict(f, industry='REIT - Retail'))[0] == 'R'
assert b.classify({'m': 'SG'}, {'industry': 'Software'})[0] == 'R'      # missing ratios -> review, never pass

# Forecast uses the right score bucket and scales the range by volatility
cal = {h: [{'n': 99, 'up': k / 10, 'q': [-1, 0, 1]} for k in range(5)] for h in b.H}
fc = b.forecast(100, 60, 0.01, cal)
assert fc[5]['up'] == 0.4 and fc[5]['lo'] < 100 < fc[5]['hi'] and fc[63]['hi'] > fc[5]['hi']
assert b.forecast(100, -60, 0.01, cal)[5]['up'] == 0.0
assert b.forecast(100, 0, float('nan'), cal) is None

# Number check flags invented figures, accepts real ones and ignores dates
ctx = '{"last":"7,712.60","chg":"+0.12%","p":"P(up) 58%"}'
assert b.unverified('S&P at 7,712.60 (+0.12%), P(up) 58% on 21 Oct 2026', ctx) == []
assert b.unverified('S&P at 4,112.63', ctx) == ['4,112.63']

# moomoo <-> Yahoo symbols round-trip
for y, m in [('AAPL', 'US.AAPL'), ('BRK-B', 'US.BRK.B'), ('D05.SI', 'SG.D05'), ('0700.HK', 'HK.00700'), ('5347.KL', 'MY.5347')]:
    assert moo(y) == m and yahoo(m) == y, (y, m, moo(y), yahoo(m))
assert moo('^GSPC') is None and moo('GC=F') is None
# Family profiles: positions from trades (respecting resets), alerts fire once a day, triggered paper orders
st = {'wl': [{'s': 'AAPL', 'above': 300}, {'s': 'MSFT', 'del': True, 'above': 1}],
      'paper': {'resetAt': '2026-10-01', 'trades': [{'s': 'AAPL', 'side': 'buy', 'q': 10, 'at': '2026-10-02'}, {'s': 'AAPL', 'side': 'sell', 'q': 4, 'at': '2026-10-03'},
                                                    {'s': 'OLD', 'side': 'buy', 'q': 5, 'at': '2026-09-01'}],
                'orders': [{'id': 'o1', 's': 'NVDA', 'side': 'buy', 'type': 'limit', 'px': 100, 'status': 'open', 'at': '2026-10-04'}]}}
assert b.positions(st) == {'AAPL': 6}
assert set(b.family_symbols([({'id': 'a'}, st)])) == {'AAPL', 'NVDA'}
sent = {}
q = {'AAPL': {'p': 310, 'c': 0.01}, 'MSFT': {'p': 500, 'c': 0}, 'NVDA': {'p': 101, 'c': 0, 'h': 105, 'l': 99, 'd': '2026-10-21'}}
m = b.alerts({'id': 'a'}, st, q, sent, '2026-10-21')
assert [x['tag'] for x in m] == ['AAPL:above', 'order:o1'], m
assert b.alerts({'id': 'a'}, st, q, sent, '2026-10-21') == []             # once a day
st['prefs'] = {'notify': {'alerts': False, 'orders': False}, 'move': 0.5}
assert [x['tag'] for x in b.alerts({'id': 'b'}, st, q, {}, '2026-10-21')] == ['AAPL:move']   # 1% move >= 0.5% threshold
# same-day orders only fill on the current price, not on a low that happened before the order existed
st2 = {'paper': {'orders': [{'id': 'o2', 's': 'NVDA', 'side': 'buy', 'type': 'limit', 'px': 100, 'status': 'open', 'at': '2026-10-21T01:00:00Z', 'd0': '2026-10-21'}], 'trades': []}}
assert b.alerts({'id': 'c'}, st2, q, {}, '2026-10-21') == []
# deleted push subscriptions are never sent to
import json as _j, tempfile as _t
os.environ['PUSH_OUT'] = _t.mktemp()
b.write_push([{'subs': [{'endpoint': 'a'}, {'endpoint': 'b', 'del': True}], 'msgs': [{'title': 't'}]}])
assert [s['endpoint'] for s in _j.load(open(os.environ['PUSH_OUT']))['jobs'][0]['subs']] == ['a']
# news/video relevance: market stories stay, sport/showbiz/crime/shorts go
assert all(b.relevant(t) for t in ['Fed holds rates, stocks rally', 'Oil jumps as OPEC cuts output', 'How to Trade Breakouts'])
assert not any(b.relevant(t) for t in ['Malaysia wins badminton gold', 'Actress stuns at gala', 'Man stabbed in Woodlands', 'Quit my job #shorts', 'Best hawker food in Penang', 'Who You Marry Is a Financial Decision', 'Analyst Reacts to Finance TikToks'])
print('ok')
