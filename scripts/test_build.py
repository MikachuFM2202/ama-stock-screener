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
print('ok')
