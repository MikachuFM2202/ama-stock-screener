#!/usr/bin/env python3
"""Builds the encrypted market snapshot that the site reads from the `market` branch.

Usage: build.py daily|evening|weekly   (weekly also refreshes the universe and fundamentals)
Env:   SITE_PASSWORD (required), OUT (output dir, default ./out), STATE (path to the data branch's
       state.bin, optional), GITHUB_TOKEN (GitHub Models for the AI reports, optional),
       LIMIT (cap tickers per market, for quick local tests).

Every file except meta.json and cache/ is AES-256-GCM encrypted with a key derived from the site
password (PBKDF2-SHA256), gzip'd JSON inside. The site derives the same key at login.
"""
import base64, csv, datetime as dt, gzip, io, json, math, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedparser, numpy as np, pandas as pd, requests, yfinance as yf
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MODE = sys.argv[1] if len(sys.argv) > 1 else 'daily'
OUT = Path(os.environ.get('OUT', 'out'))
LIMIT = int(os.environ.get('LIMIT', '0'))
SGT = dt.timezone(dt.timedelta(hours=8))
NOW = dt.datetime.now(SGT)
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'}
ITER = 310_000
H = (5, 21, 63)  # forecast horizons in trading days: ~1 week, ~1 month, ~3 months
(OUT / 'cache' / 'yf').mkdir(parents=True, exist_ok=True)
yf.set_tz_cache_location(str(OUT / 'cache' / 'yf'))


# ---------------------------------------------------------------- crypto + io

def _key():
    meta = OUT / 'meta.json'
    m = json.loads(meta.read_text()) if meta.exists() else {'v': 1, 'iter': ITER, 'salt': base64.b64encode(os.urandom(16)).decode()}
    k = PBKDF2HMAC(hashes.SHA256(), 32, base64.b64decode(m['salt']), m['iter']).derive(os.environ['SITE_PASSWORD'].encode())
    return m, AESGCM(k)


META, AES = None, None


def seal(obj):
    iv = os.urandom(12)
    return iv + AES.encrypt(iv, gzip.compress(json.dumps(clean(obj), separators=(',', ':')).encode()), None)


def unseal(b):
    return json.loads(gzip.decompress(AES.decrypt(b[:12], b[12:], None)))


def put(name, obj):
    p = OUT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(seal(obj))


def get(name, default=None):
    try: return unseal((OUT / name).read_bytes())
    except Exception: return default


def cache_get(name, default=None):
    try: return json.loads((OUT / 'cache' / name).read_text())
    except Exception: return default


def cache_put(name, obj):
    p = OUT / 'cache' / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(clean(obj), separators=(',', ':')))


def clean(o):
    """NaN/inf -> None, floats trimmed to 5 significant digits so the files stay small."""
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (float, np.floating)):
        o = float(o)
        if not math.isfinite(o): return None
        return float(f'{o:.5g}') if abs(o) < 1e15 else round(o)
    return o


def fname(sym):
    return re.sub(r'[^A-Za-z0-9.-]', '_', sym)


def http(url, tries=3, **kw):
    for i in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=30, **kw)
            if r.ok: return r
        except requests.RequestException: pass
        if i < tries - 1: time.sleep(2 * (i + 1))
    return None


# ---------------------------------------------------------------- reference lists

MACRO = {
    'Indices': [('^GSPC', 'S&P 500'), ('^IXIC', 'Nasdaq Composite'), ('^DJI', 'Dow Jones'), ('^RUT', 'Russell 2000'),
                ('^KLSE', 'FBM KLCI'), ('^STI', 'Straits Times Index'), ('^N225', 'Nikkei 225'), ('^HSI', 'Hang Seng'),
                ('000001.SS', 'Shanghai Composite'), ('^KS11', 'KOSPI'), ('^TWII', 'Taiwan Weighted'), ('^BSESN', 'BSE Sensex'),
                ('^JKII', 'Jakarta Islamic Index'), ('^FTSE', 'FTSE 100'), ('^GDAXI', 'DAX')],
    'Shariah ETFs': [('SPUS', 'SP Funds S&P 500 Shariah'), ('HLAL', 'Wahed FTSE USA Shariah'), ('UMMA', 'Wahed Dow Jones Islamic World'),
                     ('SPWO', 'SP Funds S&P World ex-US Shariah'), ('SPTE', 'SP Funds S&P Global Technology Shariah'), ('SPRE', 'SP Funds Global REIT Shariah'),
                     ('SPSK', 'SP Funds Dow Jones Global Sukuk'), ('ISDU.L', 'iShares MSCI USA Islamic (LSE)'), ('ISWD.L', 'iShares MSCI World Islamic (LSE)')],
    'Commodities': [('GC=F', 'Gold'), ('SI=F', 'Silver'), ('PL=F', 'Platinum'), ('HG=F', 'Copper'), ('CL=F', 'WTI crude oil'),
                    ('BZ=F', 'Brent crude oil'), ('NG=F', 'Natural gas'), ('ZW=F', 'Wheat'), ('ZC=F', 'Corn'), ('ZS=F', 'Soybeans')],
    'FX & rates': [('SGD=X', 'USD/SGD'), ('MYR=X', 'USD/MYR'), ('SGDMYR=X', 'SGD/MYR'), ('DX-Y.NYB', 'US Dollar Index'),
                   ('JPY=X', 'USD/JPY'), ('CNY=X', 'USD/CNY'), ('^TNX', 'US 10-year yield'), ('^IRX', 'US 13-week T-bill'), ('^VIX', 'VIX (fear gauge)')],
}
EXCLUDED_INDUSTRY = re.compile(
    r'bank|insurance|credit services|mortgage|capital markets|financial conglomerates|asset management|'
    r'gambling|casino|resorts & casinos|brewer|winer|distiller|tobacco|adult|leisure.*casino|pawn|consumer lending', re.I)
REVIEW_INDUSTRY = re.compile(r'reit|real estate|lodging|restaurants|entertainment|aerospace & defense|packaged foods|'
                             r'beverages|grocery|food distribution|broadcasting|hotel', re.I)
BBG = {'JP': '.T', 'HK': '.HK', 'KS': '.KS', 'TT': '.TW', 'AU': '.AX', 'LN': '.L', 'CN': '.TO', 'SW': '.SW', 'NA': '.AS',
       'C1': '.SS', 'C2': '.SZ', 'IJ': '.JK', 'FH': '.HE', 'SM': '.MC', 'IM': '.MI', 'DC': '.CO'}
# SC's May 2026 revision isn't on its website as a PDF yet. These six changes were reported by The Edge (node/805314).
SC_PATCH = {'28 November 2025': {'add': ['5357', '0120', '5343'], 'drop': ['0382', '7022', '0388']}}


def sc_list():
    """Malaysia: the Securities Commission's Shariah Advisory Council list (the authority for Bursa stocks)."""
    page = http('https://www.sc.com.my/development/icm/icm-publications/list-of-shariah-compliant-securities')
    cached = cache_get('sc.json')
    m = page and re.search(r'"Page Description":"List of Shariah[^"]*?as at ([^"]+)","Page Thumbnail":"[^"]*","Page Address":"(https://[^"]+)"', page.text)
    if not m: return cached or {'asof': None, 'codes': []}
    asof, url = m.group(1).strip(), m.group(2)
    if cached and cached.get('asof') == asof: return cached
    import pdfplumber
    pdf = pdfplumber.open(io.BytesIO(http(url).content))
    codes, on = set(), False
    for p in pdf.pages:
        t = p.extract_text() or ''
        if 'LIST OF SHARIAH-COMPLIANT SECURITIES' in t: on = True
        if 'ADDITIONAL LIST' in t: break
        if on: codes |= set(re.findall(r'(?:^|\s)\d{1,3}\.?\s+(\d{4}(?:SS)?)\s', t, re.M))
    patch = SC_PATCH.get(asof, {})
    codes = (codes | set(patch.get('add', []))) - set(patch.get('drop', []))
    out = {'asof': asof, 'url': url, 'patched': bool(patch), 'codes': sorted(codes)}
    if len(codes) > 300: cache_put('sc.json', out)  # a parse that finds few codes is broken; don't cache it
    return out


def sp_funds():
    """Holdings of SP Funds' Shariah ETFs (S&P Shariah indices, screened by a Shariah board)."""
    out = {}
    for f in ('SPUS', 'SPWO', 'SPTE', 'SPRE'):
        r = http(f'https://www.sp-funds.com/wp-content/uploads/data/TidalFG_Holdings_{f}.csv')
        if not r: continue
        for row in csv.DictReader(io.StringIO(r.text)):
            t = row.get('StockTicker', '').strip()
            parts = t.split(' ')
            if len(parts) == 1:
                if not re.fullmatch(r'[A-Z]{1,5}([./][A-Z])?', t): continue  # cash and sukuk lines
                y = t.replace('/', '-').replace('.', '-')
            elif parts[1] in BBG:
                code = parts[0]
                if parts[1] == 'HK': code = code.zfill(4)
                y = code + BBG[parts[1]]
            else: continue
            out.setdefault(y, {'n': row.get('SecurityName', ''), 'f': []})['f'].append(f)
    return out


def screen(exchange, mcap, n):
    from yfinance import EquityQuery as Q
    rows, off = [], 0
    while len(rows) < n:
        try:
            r = yf.screen(Q('and', [Q('eq', ['exchange', exchange]), Q('gt', ['intradaymarketcap', mcap])]),
                          size=min(250, n - len(rows)), offset=off, sortField='intradaymarketcap', sortAsc=False)
        except Exception as e:
            print('screen failed', exchange, e); break
        q = [x for x in r.get('quotes', []) if x.get('quoteType') == 'EQUITY']
        rows += q
        off += 250
        if len(r.get('quotes', [])) < 250: break
    return rows


def build_universe():
    sc = sc_list()
    spf = sp_funds()
    uni = {}
    for q in screen('KLS', 3e8, 600):  # Bursa, market cap > RM300m
        code = q['symbol'].split('.')[0]
        uni[q['symbol']] = {'m': 'MY', 'n': q.get('longName') or q.get('shortName'), 'sc': code in sc['codes']}
    for q in screen('SES', 1.5e8, 400):  # SGX, market cap > S$150m
        uni[q['symbol']] = {'m': 'SG', 'n': q.get('longName') or q.get('shortName')}
    for ex in ('NMS', 'NYQ'):
        for q in screen(ex, 1.5e10, 450):  # US large caps > US$15b
            uni[q['symbol'].replace('.', '-')] = {'m': 'US', 'n': q.get('longName') or q.get('shortName')}
    for y, h in spf.items():
        mk = 'US' if '.' not in y else 'GL'
        uni.setdefault(y, {'m': mk, 'n': h['n']})['spf'] = h['f']
    if LIMIT:
        keep = {}
        for mk in ('MY', 'SG', 'US', 'GL'):
            keep.update(dict([kv for kv in uni.items() if kv[1]['m'] == mk][:LIMIT]))
        uni = keep
    return uni, sc


FUND_KEYS = ['sector', 'industry', 'marketCap', 'totalDebt', 'totalCash', 'trailingPE', 'forwardPE', 'priceToBook', 'returnOnEquity',
             'profitMargins', 'revenueGrowth', 'earningsGrowth', 'dividendYield', 'beta', 'currency', 'longBusinessSummary', 'website',
             'earningsTimestamp', 'recommendationKey', 'targetMeanPrice', 'numberOfAnalystOpinions', 'longName', 'quoteType']


def fundamentals(syms, old):
    def one(s):
        for i in range(3):
            try:
                inf = yf.Ticker(s).info or {}
                d = {k: inf.get(k) for k in FUND_KEYS}
                if d.get('longBusinessSummary'): d['longBusinessSummary'] = d['longBusinessSummary'][:700]
                d['at'] = NOW.date().isoformat()
                return s, d
            except Exception as e:
                if '429' in str(e) or 'Too Many' in str(e): time.sleep(20 * (i + 1))
                else: time.sleep(2)
        return s, old.get(s)
    with ThreadPoolExecutor(6) as ex:
        return {s: d for s, d in ex.map(one, syms) if d}


def classify(u, f):
    """Returns (status, reasons). C = certified by a Shariah board/index, P = passes our screen (not certified),
    R = needs manual review, F = fails / officially non-compliant."""
    f = f or {}
    if u['m'] == 'MY':
        return ('C', ['On the SC Malaysia Shariah Advisory Council list']) if u.get('sc') else \
               ('F', ['Not on the SC Malaysia Shariah list (the SAC list is the authority for Bursa stocks)'])
    if u.get('spf'):
        return 'C', [f'Held by Shariah ETF {", ".join(u["spf"])} (S&P Shariah index, screened by a Shariah board)']
    ind = f'{f.get("industry") or ""} {f.get("sector") or ""}'
    mc, debt, cash = f.get('marketCap'), f.get('totalDebt'), f.get('totalCash')
    if EXCLUDED_INDUSTRY.search(ind): return 'F', [f'Business activity not permissible: {f.get("industry")}']
    if not mc or debt is None or cash is None: return 'R', ['Not enough financial data to screen; check Musaffa/Zoya']
    dm, cm = debt / mc, cash / mc
    why = [f'Debt / market cap {dm:.0%} (limit 30%)', f'Cash / market cap {cm:.0%} (limit 30%)']
    if dm >= 0.30 or cm >= 0.30: return 'F', why
    if REVIEW_INDUSTRY.search(ind): return 'R', why + [f'Ratios pass, but {f.get("industry")} needs a revenue check (non-halal income must be < 5%)']
    return 'P', why + ['Industry permissible; impermissible-income share not disclosed by data feed, so not certified']


# ---------------------------------------------------------------- prices + indicators

def download(syms):
    frames = []
    syms = list(dict.fromkeys(syms))
    for i in range(0, len(syms), 150):
        chunk = syms[i:i + 150]
        for a in range(3):
            try:
                d = yf.download(chunk, period='2y', interval='1d', auto_adjust=True, progress=False, threads=True, group_by='column')
                if not isinstance(d.columns, pd.MultiIndex): d.columns = pd.MultiIndex.from_product([d.columns, chunk])
                frames.append(d)
                break
            except Exception as e:
                print('download retry', e); time.sleep(10)
    d = pd.concat(frames, axis=1)
    missing = [s for s in syms if s not in d['Close'] or d['Close'][s].isna().all()]
    if missing and len(missing) < len(syms) / 2:  # yfinance drops some tickers under thread contention; one quiet retry
        try:
            m = yf.download(missing, period='2y', interval='1d', auto_adjust=True, progress=False, threads=False, group_by='column')
            if not isinstance(m.columns, pd.MultiIndex): m.columns = pd.MultiIndex.from_product([m.columns, missing])
            d = pd.concat([d.drop(columns=[c for c in d.columns if c[1] in missing]), m], axis=1)
        except Exception as e: print('retry failed', e)
    d.index = pd.to_datetime(d.index).tz_localize(None).normalize()
    d = d[~d.index.duplicated(keep='last')].sort_index()
    return {k: d[k] for k in ('Open', 'High', 'Low', 'Close', 'Volume')}


def indicators(P):
    C, Hh, L, V = P['Close'], P['High'], P['Low'], P['Volume']
    # Yahoo adds a zero-volume placeholder row for today before a market opens; it isn't a real session.
    stub = (V.fillna(0) == 0) & (V.shift().fillna(0) > 0)
    C = C.mask(stub)
    Cf = C.ffill(limit=5)
    sma = {n: Cf.rolling(n, min_periods=int(n * .8)).mean() for n in (20, 50, 200)}
    d = Cf.diff()
    rs = d.clip(lower=0).ewm(alpha=1 / 14, min_periods=14).mean() / (-d.clip(upper=0)).ewm(alpha=1 / 14, min_periods=14).mean()
    rsi = 100 - 100 / (1 + rs)
    macd = Cf.ewm(span=12).mean() - Cf.ewm(span=26).mean()
    hist = macd - macd.ewm(span=9).mean()
    tr = pd.concat([(Hh - L), (Hh - Cf.shift()).abs(), (L - Cf.shift()).abs()]).groupby(level=0).max().reindex(C.index)
    atr = tr.ewm(alpha=1 / 14, min_periods=14).mean() / Cf
    lr = np.log(Cf).diff()
    vol = lr.rolling(60, min_periods=40).std()
    r21 = Cf / Cf.shift(21) - 1
    parts = [np.sign(Cf - sma[50]), np.sign(Cf - sma[200]), np.sign(sma[50] - sma[200]), np.sign(hist),
             ((rsi - 50) / 20).clip(-1, 1), (r21 / (vol * math.sqrt(21))).clip(-1, 1)]
    score = sum(p.fillna(0) for p in parts) / len(parts) * 100
    return dict(raw=C, C=Cf, sma=sma, rsi=rsi, hist=hist, atr=atr, vol=vol, score=score, V=V,
                relvol=V / V.rolling(20, min_periods=10).mean(), val=(Cf * V).rolling(20, min_periods=10).mean(),
                hi20=Cf.rolling(20).max(), hi252=Cf.rolling(252, min_periods=120).max(), lo252=Cf.rolling(252, min_periods=120).min())


BUCKETS = [-101, -50, -20, 20, 50, 101]


def calibrate(I, cols):
    """For each score bucket and horizon: how often price rose over the next h days in the past 2 years,
    and the quantiles of the vol-normalised forward move. This is the 'model' behind every forecast."""
    out = {}
    C, vol, score = I['C'][cols], I['vol'][cols], I['score'][cols]
    for h in H:
        z = (np.log(C.shift(-h) / C) / (vol * math.sqrt(h))).stack()
        s = score.stack().reindex(z.index)
        b = pd.cut(s, BUCKETS, labels=False)
        tab = []
        for k in range(len(BUCKETS) - 1):
            zz = z[b == k].dropna()
            tab.append(None if len(zz) < 50 else {'n': len(zz), 'up': float((zz > 0).mean()), 'q': [float(zz.quantile(q)) for q in (.16, .5, .84)]})
        out[h] = tab
    return out


def forecast(px, score, vol, cal):
    if px is None or vol is None or not math.isfinite(vol) or not math.isfinite(score): return None
    k = int(np.digitize(score, BUCKETS[1:-1]))
    f = {}
    for h in H:
        t = cal.get(h, [None] * 5)[k]
        if not t: continue
        s = vol * math.sqrt(h)
        f[h] = {'up': t['up'], 'lo': px * math.exp(t['q'][0] * s), 'mid': px * math.exp(t['q'][1] * s), 'hi': px * math.exp(t['q'][2] * s), 'n': t['n']}
    return f


def label(score):
    return 'Strong bullish' if score >= 50 else 'Bullish' if score >= 20 else 'Strong bearish' if score <= -50 else 'Bearish' if score <= -20 else 'Neutral'


def snap(I, s):
    C = I['raw'][s].dropna()
    if len(C) < 2: return None

    def v(x):
        try:
            y = x[s].loc[C.index[-1]]
            return float(y) if pd.notna(y) else None
        except Exception: return None
    px = float(C.iloc[-1])

    def ret(n): return float(px / C.iloc[-1 - n] - 1) if len(C) > n else None
    ytd = C[C.index >= pd.Timestamp(NOW.year, 1, 1)]
    return {'px': px, 'd': C.index[-1].date().isoformat(), 'r1': ret(1), 'r5': ret(5), 'r21': ret(21), 'r63': ret(63), 'r252': ret(252),
            'ytd': float(px / C[C.index < pd.Timestamp(NOW.year, 1, 1)].iloc[-1] - 1) if len(ytd) and len(C) > len(ytd) else None,
            'sma20': v(I['sma'][20]), 'sma50': v(I['sma'][50]), 'sma200': v(I['sma'][200]), 'rsi': v(I['rsi']), 'macd': v(I['hist']),
            'atr': v(I['atr']), 'vol': v(I['vol']), 'score': v(I['score']), 'rv': v(I['relvol']), 'val': v(I['val']),
            'hi52': v(I['hi252']), 'lo52': v(I['lo252']), 'hi20': v(I['hi20'])}


# ---------------------------------------------------------------- news, calendar, media

NEWS_Q = [('Global', 'stock market today'), ('US', 'Wall Street stocks Fed'), ('Malaysia', 'Bursa Malaysia KLCI'),
          ('Singapore', 'SGX Straits Times Index stocks'), ('Commodities', 'gold oil prices'), ('Macro', 'central bank interest rates inflation'),
          ('Islamic finance', 'shariah compliant stocks OR islamic finance'), ('Asia', 'Asian markets stocks')]


def gnews(q, n=8, days=1):
    r = http(f'https://news.google.com/rss/search?q={requests.utils.quote(q)}+when:{days}d&hl=en-SG&gl=SG&ceid=SG:en')
    f = feedparser.parse(r.content if r else b'')
    out = []
    for e in f.entries[:n]:
        t = e.get('title', '')
        src = e.get('source', {}).get('title') if isinstance(e.get('source'), dict) else ''
        if src and t.endswith(' - ' + src): t = t[: -len(src) - 3]
        out.append({'t': t, 'u': e.get('link'), 's': src, 'at': e.get('published')})
    return out


def news(watch):
    out = []
    for tag, q in NEWS_Q:
        try: out += [dict(x, g=tag) for x in gnews(q)]
        except Exception as e: print('news', tag, e)
    for w in watch[:25]:
        try: out += [dict(x, g='Watchlist', sym=w['s']) for x in gnews(f'"{w["n"]}"', 3, 3)]
        except Exception: pass
    seen, uniq = set(), []
    for x in out:
        k = x['t'].lower()[:80]
        if k not in seen: seen.add(k); uniq.append(x)
    return uniq


def calendar():
    r = http('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
    out = []
    try:
        for e in r.json():
            if e.get('impact') not in ('High', 'Medium') or e.get('country') not in ('USD', 'CNY', 'JPY', 'EUR', 'GBP', 'AUD', 'All'): continue
            t = dt.datetime.fromisoformat(e['date']).astimezone(SGT)
            out.append({'at': t.isoformat(), 'c': e['country'], 't': e['title'], 'i': e['impact'], 'f': e.get('forecast'), 'p': e.get('previous')})
    except Exception as e: print('calendar', e)
    return out


PODCASTS = [('Odd Lots (Bloomberg)', 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8a94442e-5a74-4fa2-8b8d-ae27003a8d6b/982f5071-765c-403d-969d-ae27003a8d83/podcast.rss'),
            ('Bloomberg Surveillance', 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/8e704079-ca57-4eac-9741-ae27003e2b7f/9739700c-72c3-4176-ae55-ae27003e2b96/podcast.rss'),
            ('Thoughts on the Market (Morgan Stanley)', 'https://rss.art19.com/thoughts-on-the-market'),
            ('BFM Market Watch (Malaysia)', 'https://www.omnycontent.com/d/playlist/de62ff84-6498-49d0-a266-a9d50120c712/6b814c2f-604a-4ef9-90ed-ab0900403795/e6b2e450-18e4-4826-b7f2-ab0900403795/podcast.rss'),
            ('The Business Times Podcasts (Singapore)', 'https://www.omnycontent.com/d/playlist/d9486183-3dd4-4ad6-aebe-a4c1008455d5/95017a37-a3f6-4071-994b-abdb0017cb9f/914f3504-0bfe-4515-a9d7-abdb0017cba4/podcast.rss'),
            ('IslamicFinanceGuru', 'https://anchor.fm/s/8139018/podcast/rss'),
            ('Animal Spirits', 'https://feeds.megaphone.fm/TCP6464651487'),
            ('The Compound and Friends', 'https://feeds.megaphone.fm/TCP4771071679'),
            ('We Study Billionaires', 'https://feeds.megaphone.fm/PPLLC8974708240')]
CHANNELS = [('Rayner Teo (SG trader, price action)', 'UCES1CX-L4242aZELJyz-6QA'), ('StockedUp', 'UC-m6zNItyoDk5lSykDlhE4Q'),
            ('The Plain Bagel', 'UCFCEuCsyWP0YkP3CZ3Mr01Q'), ('Ben Felix', 'UCDXTQ8nWmx_EhZ2v-kp7QxA'), ('Patrick Boyle', 'UCASM0cgfkJxQ1ICmRilfHLw'),
            ('Aswath Damodaran', 'UCLvnJL8htRR1T9cbSccaoVw'), ('Bloomberg Television', 'UCIALMKvObZNtJ6AmdCLP7Lg'), ('CNBC Television', 'UCrp_UI8XtuYfpiqluWLD7Lw'),
            ('Yahoo Finance', 'UCEAZeUIeJs0IjQiqTCdVSIg'), ('CNA', 'UC83jt4dlz1Gjl58fzQrrKZg'), ('Money FM 89.3', 'UCKQ_ev3_C_V0zPn-9PDrL4g'),
            ('Seedly', 'UCbAwxhtR3Bzh9QZbtpC-ssg'), ('Dr Wealth', 'UC5m_pwvwWIyCOCkP_7GcdsA'), ('Islamic Finance Guru', 'UCibDKXYzRYYtI-Q_HUcNdLg'),
            ('Zoya', 'UCwUNl-kaRvUbFhvJxAOI-dA')]


def media(old):
    pods, vids = [], []
    for name, url in PODCASTS:
        r = http(url)
        if not r: continue
        f = feedparser.parse(r.content)
        for e in f.entries[:3]:
            pods.append({'src': name, 't': e.get('title'), 'u': e.get('link') or (e.get('enclosures') or [{}])[0].get('href'), 'at': e.get('published')})
    for name, cid in CHANNELS:
        r = http(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}', tries=2)
        if not r:  # YouTube's feed 404s intermittently; keep yesterday's entries for this channel
            vids += [v for v in (old or {}).get('vids', []) if v.get('src') == name]
            continue
        for e in feedparser.parse(r.content).entries[:4]:
            vids.append({'src': name, 't': e.get('title'), 'id': e.get('yt_videoid'), 'at': e.get('published')})
    return {'pods': pods, 'vids': vids}


# ---------------------------------------------------------------- AI reports

def llm(system, user, model='openai/gpt-4.1-mini', max_tokens=2500):
    if os.environ.get('OLLAMA_MODEL'):
        r = requests.post('http://localhost:11434/api/chat', timeout=900, json={'model': os.environ['OLLAMA_MODEL'], 'stream': False,
                          'options': {'num_ctx': 32768, 'temperature': 0.3},  # Ollama's default 2-4k context silently truncates the data
                          'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]})
        return r.json()['message']['content']
    tok = os.environ.get('GITHUB_TOKEN')
    if not tok: return None
    for m in (model, 'openai/gpt-4.1-mini'):
        try:
            r = requests.post('https://models.github.ai/inference/chat/completions', timeout=240,
                              headers={'Authorization': f'Bearer {tok}', 'Content-Type': 'application/json', 'Accept': 'application/json'},
                              json={'model': m, 'max_tokens': max_tokens, 'temperature': 0.4,
                                    'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]})
            if r.ok:
                try: return r.json()['choices'][0]['message']['content']
                except ValueError: return r.text
            print('llm', m, r.status_code, r.text[:200])
        except requests.RequestException as e: print('llm', m, e)
    return None


SYSTEM = """You are the market analyst for one private reader: a Muslim retail investor living in Singapore who trades
Malaysian stocks (Malacca Securities, UOB Kay Hian), Singapore stocks (UOB Kay Hian) and US/global stocks (moomoo).
Rules:
- Only suggest Shariah-compliant names: status C (certified) first, P (passes our ratio screen, not certified - say so).
  Never suggest status F names. Never suggest short selling, conventional margin, options, CFDs, futures or leveraged ETFs.
  For commodities, only talk about Shariah-compliant exposure (physical/spot gold accounts, Shariah gold ETFs, compliant producers).
- Use ONLY the numbers in the data given. Never invent prices, levels, earnings or news. If something is unknown, say so.
- Times are Singapore time (SGT, UTC+8). US cash session is 21:30-04:00 SGT (22:30-05:00 when the US is on standard time).
- Forecasts in the data are statistical (historical hit rates for similar trend scores), not certainties. Express them as
  probabilities and ranges, and say what would invalidate the view.
- Write in clear Markdown with short sections and bullet points. Explain any jargon briefly in brackets the first time.
- End with a one-line reminder that this is educational, not financial advice."""


def _p(x): return None if x is None else f'{x * 100:+.2f}%'


def _px(x): return None if x is None else f'{x:,.2f}' if abs(x) >= 1 else f'{x:.4g}'


def _fc(fc):
    """Forecasts as readable strings: models copy strings faithfully but mangle nested numbers."""
    out = {}
    for h, name in ((5, '1 week'), (21, '1 month'), (63, '3 months')):
        f = (fc or {}).get(h) or (fc or {}).get(str(h))
        if f: out[name] = f'P(up) {f["up"] * 100:.0f}%, likely range {_px(f["lo"])} to {_px(f["hi"])}'
    return out


def _row(r, lite=False):
    drop = ('sma50', 'sma200', 'chg_ytd', 'pe', 'sector', 'name') if lite else ()
    return {k: v for k, v in {'symbol': r['s'], 'name': r['n'], 'market': r.get('m'), 'shariah_status': r.get('st'), 'sector': r.get('sec'),
            'last': _px(r.get('px')), 'chg_1d': _p(r.get('r1')), 'chg_1w': _p(r.get('r5')), 'chg_1m': _p(r.get('r21')), 'chg_ytd': _p(r.get('ytd')),
            'rsi14': None if r.get('rsi') is None else round(r['rsi']), 'trend_bias': r.get('bias'), 'sma50': _px(r.get('sma50')),
            'sma200': _px(r.get('sma200')), 'pe': None if not r.get('pe') else round(r['pe'], 1), 'outlook': _fc(r.get('fc'))}.items() if v not in (None, {}, '') and k not in drop}


def report_ctx(summary, uni_rows, wl, cap=24000):
    """GitHub Models' free tier takes ~8k input tokens per request, so the context shrinks until it fits."""
    for n in (6, 4, 3, 2, 1):
        ctx = _ctx(summary, uni_rows, wl, n)
        if len(ctx) <= cap: break
    return ctx


def _ctx(summary, uni_rows, wl, n):
    wls = {w['s'] for w in wl}
    return json.dumps({
        'now_sgt': NOW.strftime('%a %d %b %Y %H:%M'),
        'macro': {g: [dict(_row(x, n <= 3), name=x['n']) for x in rows] for g, rows in summary['macro'].items()},
        'forecast_track_record': {f'{h}d calls': f'{t["hit"] * 100:.0f}% right of {t["n"]}' for h, t in (summary.get('track') or {}).items()},
        'shariah_ideas': {k: [_row(r, n <= 2) for r in v[:n]] for k, v in summary['ideas'].items()},
        'top_movers_compliant': {k: [_row(r) for r in v[:max(1, n - 2)]] for k, v in summary['movers'].items()},
        'watchlist': [_row(r) for r in uni_rows if r['s'] in wls][:n * 5],
        'calendar_this_week_sgt': [f'{e["at"][:16].replace("T", " ")} {e["c"]} {e["t"]} ({e["i"]}, forecast {e.get("f") or "-"}, previous {e.get("p") or "-"})' for e in summary['calendar'][:n * 4]],
        'earnings_upcoming_sgt': [f'{e["at"][:16].replace("T", " ")} {e["s"]} {e["n"]}' for e in summary.get('earnings', [])[:n * 3]],
        'headlines': [f'[{h.get("g")}] {h.get("t")} ({h.get("s")})' for h in summary['news'][:n * 7]],
    }, separators=(',', ':'), ensure_ascii=False)


NUM = re.compile(r'(?<![\w.])[-+]?\d[\d,]*\.?\d*')


def unverified(md, ctx):
    """Numbers in the report that don't appear (within 0.6%) anywhere in the data it was given."""
    known = []
    for m in NUM.finditer(ctx):
        try: known.append(float(m.group().replace(',', '')))
        except ValueError: pass
    known = np.array(sorted(set(known)))
    bad = []
    for m in NUM.finditer(re.sub(r'https?://\S+', '', md)):
        t = m.group().strip('+-').rstrip('.')
        try: v = float(t.replace(',', ''))
        except ValueError: continue
        if v <= 31 and '.' not in t or 1990 <= v <= 2100 and '.' not in t: continue  # dates, counts, years
        if len(known) and np.min(np.abs(known - v) / max(abs(v), 1e-9)) <= 0.006: continue
        bad.append(t)
    return sorted(set(bad))


def write_report(kind, summary, uni_rows, wl):
    ctx = report_ctx(summary, uni_rows, wl)
    if kind == 'weekly':
        ask = ('Write the FULL weekly report for the coming week. Sections: 1) Week in review (each market: US, Malaysia, Singapore, '
               'global, commodities, FX & rates) 2) Big themes and what drove them 3) Outlook: next few days, next week, next 1-3 months, '
               'per market, with probabilities/ranges from the forecasts and what would change the view 4) Week-ahead calendar '
               '(SGT times) and why each event matters 5) Shariah-compliant ideas: long-term and day-trade/swing, each with the reason, '
               'entry idea, invalidation level (use SMA levels/ranges from the data) and its compliance status 6) Watchlist review, '
               'name by name 7) Risks to watch 8) What to study this week (one concept from candlesticks/technical/fundamental analysis '
               'tied to this week\'s market, plus which headlines to read). About 1800-2500 words.')
        model, tokens = 'openai/gpt-4.1', 4000
    else:
        ask = ('Write the DAILY brief for today. Sections: 1) Overnight & yesterday recap (US close, Asia close) 2) What to watch today '
               '(events with SGT times, earnings, headlines that matter) 3) Outlook: today/next few days and the 1-week and 1-month bias '
               'for S&P 500, KLCI, STI, gold and oil, with probabilities/ranges 4) Shariah day-trade watch (liquid, volatile, compliant) '
               'and swing ideas, with levels 5) Watchlist notes 6) Three headlines worth reading in full. About 600-900 words.')
        model, tokens = 'openai/gpt-4.1-mini', 2500
    md = llm(SYSTEM, ask + '\n\nDATA (JSON):\n' + ctx, model, tokens)
    if md and len(md) < 300: md = None  # a stub or refusal, not a report
    by = os.environ.get('OLLAMA_MODEL') or model if md else 'template'
    bad = unverified(md, ctx) if md else []
    if md:  # the AI narrative, then the exact numbers it was given, so nothing hinges on the model copying correctly
        md += '\n\n---\n\n' + template_report(kind, summary, appendix=True)
    return {'id': f'{NOW.date().isoformat()}-{kind}', 'kind': kind, 'at': NOW.isoformat(), 'by': by, 'unverified': bad,
            'md': md or template_report(kind, summary)}


def template_report(kind, s, appendix=False):
    """The exact numbers. Used alone when no LLM is reachable, so a report always exists."""
    def pct(x): return '–' if x is None else f'{x * 100:+.2f}%'
    L = ['## Data appendix (exact figures)', ''] if appendix else \
        [f'# {"Weekly report" if kind == "weekly" else "Daily brief"} · {NOW:%a %d %b %Y}', '', '_AI writer unavailable; numbers-only version._', '']
    for g, rows in s['macro'].items():
        L += [f'{"###" if appendix else "##"} {g}', '| Name | Last | 1D | 1W | 1M | Bias | P(up 1W) |', '|---|---|---|---|---|---|---|']
        for x in rows:
            fc = (x.get('fc') or {}).get(5) or {}
            L.append(f'| {x["n"]} | {x["px"]:,.2f} | {pct(x.get("r1"))} | {pct(x.get("r5"))} | {pct(x.get("r21"))} | {x.get("bias", "")} | {fc.get("up", 0):.0%} |')
        L.append('')
    if appendix: return '\n'.join(L)
    L += ['## Calendar (SGT)'] + [f'- {e["at"][5:16].replace("T", " ")} · {e["c"]} · {e["t"]} ({e["i"]})' for e in s['calendar'][:20]]
    L += ['', '## Headlines'] + [f'- [{n["t"]}]({n["u"]}) — {n.get("s", "")}' for n in s['news'][:15]]
    L += ['', '_Educational only, not financial advice._']
    return '\n'.join(L)


# ---------------------------------------------------------------- main

def main():
    global META, AES
    META, AES = _key()
    (OUT / 'cache').mkdir(parents=True, exist_ok=True)
    state = {}
    if os.environ.get('STATE') and Path(os.environ['STATE']).exists():
        try: state = unseal(Path(os.environ['STATE']).read_bytes())
        except Exception as e: print('state unreadable', e)
    wl = state.get('wl', [])
    if MODE == 'testpush':
        Path(os.environ.get('PUSH_OUT', 'push.json')).write_text(json.dumps({'subs': state.get('subs', []), 'msgs': [
            {'title': 'Halal Terminal test', 'body': f'Notifications work on this device · {NOW:%H:%M} SGT', 'url': '#settings', 'tag': 'test'}]}))
        return

    uni = cache_get('universe.json')
    sc = cache_get('sc.json', {})
    if MODE == 'weekly' or not uni:
        uni, sc = build_universe()
        cache_put('universe.json', uni)
    print('universe', len(uni))

    fund = cache_get('fund.json', {})
    stale = [s for s in uni if s not in fund or MODE == 'weekly' and (fund[s] or {}).get('at', '') < (NOW - dt.timedelta(days=6)).date().isoformat()]
    stale += [w['s'] for w in wl if w['s'] not in fund and w['s'] not in uni]
    if stale:
        print('fundamentals', len(stale))
        fund.update(fundamentals(stale, fund))
        cache_put('fund.json', fund)

    # Watchlist symbols outside the universe are still tracked (status from the screen).
    for w in wl:
        if w['s'] not in uni:
            f = fund.get(w['s']) or {}
            mk = 'MY' if w['s'].endswith('.KL') else 'SG' if w['s'].endswith('.SI') else 'US' if '.' not in w['s'] else 'GL'
            uni[w['s']] = {'m': mk, 'n': f.get('longName') or w['s'], 'sc': mk == 'MY' and w['s'].split('.')[0] in sc.get('codes', []), 'wl': 1}

    macro_syms = [s for g in MACRO.values() for s, _ in g]
    curr = {((fund.get(s) or {}).get('currency') or '').upper() for s in uni} - {'', 'USD'}  # GBp (pence) -> GBP, x100 below
    fx_syms = [f'{c}=X' for c in curr if c.isalpha() and len(c) == 3]
    P = download(list(uni) + macro_syms + fx_syms)
    I = indicators(P)
    have = [s for s in I['C'].columns if I['C'][s].notna().sum() > 30]
    fx = {c: float(I['C'][f'{c}=X'].dropna().iloc[-1]) for c in curr if f'{c}=X' in have}
    if 'GBP' in fx: fx['GBp'] = fx['GBP'] * 100

    groups = {'MY': [], 'SG': [], 'US': [], 'GL': [], 'MACRO': [s for s in macro_syms if s in have]}
    for s, u in uni.items():
        if s in have: groups[u['m']].append(s)
    cal = {g: calibrate(I, cols) for g, cols in groups.items() if cols}

    rows = []
    for s, u in uni.items():
        if s not in have: continue
        f = fund.get(s) or {}
        x = snap(I, s)
        if not x: continue
        st, why = classify(u, f)
        cur = f.get('currency') or ('MYR' if u['m'] == 'MY' else 'SGD' if u['m'] == 'SG' else 'USD')
        rate = 1 if cur == 'USD' else fx.get(cur)
        rows.append({'s': s, 'n': f.get('longName') or u.get('n') or s, 'm': u['m'], 'st': st, 'why': why, 'sec': f.get('sector'), 'ind': f.get('industry'),
                     'cur': cur, 'mc': f.get('marketCap'), 'pe': f.get('trailingPE'), 'fpe': f.get('forwardPE'), 'pb': f.get('priceToBook'),
                     'roe': f.get('returnOnEquity'), 'pm': f.get('profitMargins'), 'rg': f.get('revenueGrowth'), 'dy': f.get('dividendYield'),
                     'beta': f.get('beta'), 'dm': (f.get('totalDebt') or 0) / f['marketCap'] if f.get('marketCap') and f.get('totalDebt') is not None else None,
                     'cm': (f.get('totalCash') or 0) / f['marketCap'] if f.get('marketCap') and f.get('totalCash') is not None else None,
                     'tgt': f.get('targetMeanPrice'), 'rec': f.get('recommendationKey'), 'ana': f.get('numberOfAnalystOpinions'),
                     'earn': f.get('earningsTimestamp'), 'web': f.get('website'), 'about': f.get('longBusinessSummary'),
                     'valusd': x['val'] / rate if x.get('val') and rate else None, **x,
                     'bias': label(x['score'] or 0), 'fc': forecast(x['px'], x['score'] or 0, x['vol'], cal.get(u['m'], {}))})
    by = {r['s']: r for r in rows}
    print('rows', len(rows))

    macro = {}
    for g, items in MACRO.items():
        macro[g] = []
        for s, n in items:
            x = snap(I, s) if s in have else None
            if x: macro[g].append({'s': s, 'n': n, **x, 'bias': label(x['score'] or 0), 'fc': forecast(x['px'], x['score'] or 0, x['vol'], cal.get('MACRO', {}))})

    ideas, movers = {}, {}
    def ok(r): return r['st'] in ('C', 'P') and r.get('valusd') and r['valusd'] > 1e6
    def rank(v): return pd.Series(v).rank(pct=True).fillna(.5).values
    for mk in ('MY', 'SG', 'US', 'GL'):
        pool = [r for r in rows if r['m'] == mk and ok(r)]
        if not pool: continue
        trend = rank([r['score'] for r in pool])
        mom = rank([(r.get('r63') or 0) + (r.get('r252') or 0) / 2 for r in pool])
        qual = rank([(r.get('roe') or 0) + (r.get('pm') or 0) for r in pool])
        val = rank([-(r['pe'] if r.get('pe') and r['pe'] > 0 else 80) for r in pool])
        liq = rank([r['valusd'] for r in pool])
        for i, r in enumerate(pool):
            r['inv'] = round(100 * (.3 * trend[i] + .2 * mom[i] + .3 * qual[i] + .2 * val[i]))
            atr = r.get('atr') or 0
            r['day'] = round(100 * (.4 * liq[i] + .25 * (1 if .02 <= atr <= .07 else .4) + .2 * min((r.get('rv') or 0) / 2, 1) + .15 * trend[i]))
        ideas[f'{mk}-invest'] = sorted([r for r in pool if (r['score'] or 0) > 0], key=lambda r: -r['inv'])[:15]
        ideas[f'{mk}-day'] = sorted(pool, key=lambda r: -r['day'])[:15]
        movers[f'{mk}-up'] = sorted(pool, key=lambda r: -(r['r1'] or 0))[:10]
        movers[f'{mk}-down'] = sorted(pool, key=lambda r: (r['r1'] or 0))[:10]

    # Forecast track record: log today's 1W/1M calls on the macro list + watchlist, score the ones that matured.
    preds = get('preds.bin', [])
    today = NOW.date().isoformat()
    pxnow = {**{r['s']: r['px'] for r in rows}, **{x['s']: x['px'] for g in macro.values() for x in g}}
    for p in preds:
        if p.get('ok') is None and p['due'] <= today and p['s'] in pxnow:
            p['end'] = pxnow[p['s']]; p['ok'] = (p['end'] > p['px']) == (p['up'] > .5)
    tracked = [x for g in macro.values() for x in g] + [by[w['s']] for w in wl if w['s'] in by]
    if not any(p['d'] == today for p in preds):
        for x in tracked:
            for h in (5, 21):
                fc = (x.get('fc') or {}).get(h)
                if fc and abs(fc['up'] - .5) >= .03:  # only log real calls, not coin flips
                    preds.append({'d': today, 'due': (NOW + dt.timedelta(days=round(h * 7 / 5))).date().isoformat(), 's': x['s'], 'h': h, 'px': x['px'], 'up': fc['up'], 'ok': None})
    preds = preds[-6000:]
    done = [p for p in preds if p.get('ok') is not None]
    track = {str(h): {'n': len(d), 'hit': sum(p['ok'] for p in d) / len(d)} for h in (5, 21) if (d := [p for p in done if p['h'] == h])}

    old = get('summary.bin', {}) or {}
    earnings = sorted([{'s': r['s'], 'n': r['n'], 'at': dt.datetime.fromtimestamp(r['earn'], SGT).isoformat()} for r in rows
                       if r.get('earn') and NOW.timestamp() - 86400 < r['earn'] < NOW.timestamp() + 21 * 86400
                       and (r['s'] in {w['s'] for w in wl} or r['st'] == 'C' and (r.get('mc') or 0) > 5e10)], key=lambda e: e['at'])
    summary = {'at': NOW.isoformat(), 'mode': MODE, 'macro': macro, 'ideas': {k: [slim(r) for r in v] for k, v in ideas.items()},
               'movers': {k: [slim(r) for r in v] for k, v in movers.items()}, 'track': track,
               'cal': {g: {str(h): t for h, t in c.items()} for g, c in cal.items()},
               'sc': {k: sc.get(k) for k in ('asof', 'url', 'patched')}, 'counts': count(rows),
               'calendar': calendar(), 'earnings': earnings, 'news': news([by[w['s']] for w in wl if w['s'] in by] + [{'s': w['s'], 'n': w['s']} for w in wl if w['s'] not in by]),
               'media': media(old.get('media')), 'reports': old.get('reports', [])}

    if MODE in ('daily', 'weekly'):
        rep = write_report(MODE, summary, rows, wl)
        put(f'reports/{rep["id"]}.bin', rep)
        summary['reports'] = [{k: rep[k] for k in ('id', 'kind', 'at', 'by')}] + [r for r in summary['reports'] if r['id'] != rep['id']][:400]

    put('summary.bin', summary)
    put('universe.bin', [{k: v for k, v in r.items() if k not in ('about',)} for r in rows])
    put('about.bin', {r['s']: {'about': r.get('about'), 'why': r['why']} for r in rows})
    put('preds.bin', preds)
    for s in have:
        if s.endswith('=X') and s not in macro_syms: continue
        c = I['raw'][s].dropna()
        idx = c.index[-520:]
        put(f'ohlc/{fname(s)}.bin', {'t': [int(t.timestamp()) for t in idx], **{k[0].lower(): P[k][s].reindex(idx).round(6).tolist() for k in ('Open', 'High', 'Low', 'Close', 'Volume')}})
    META['at'] = NOW.isoformat()
    (OUT / 'meta.json').write_text(json.dumps(META))
    notify(state, summary, by, rows)
    print('done', MODE)


def slim(r):
    return {k: r.get(k) for k in ('s', 'n', 'm', 'st', 'sec', 'px', 'r1', 'r5', 'r21', 'r63', 'rsi', 'atr', 'rv', 'valusd', 'score', 'bias', 'fc', 'pe', 'roe', 'inv', 'day', 'sma50', 'sma200', 'cur')}


def count(rows):
    c = {}
    for r in rows: c.setdefault(r['m'], {}).setdefault(r['st'], 0); c[r['m']][r['st']] += 1
    return c


def notify(state, summary, by, rows):
    """Writes push.json for scripts/push.mjs: report-ready pings plus watchlist price alerts (each fired once per day)."""
    subs = state.get('subs', [])
    if not subs: return
    sent = cache_get('alerts.json', {})
    today = NOW.date().isoformat()
    msgs = []
    if MODE in ('daily', 'weekly') and summary['reports']:
        r = summary['reports'][0]
        msgs.append({'title': 'Weekly report is ready' if MODE == 'weekly' else 'Daily brief is ready', 'body': f'{NOW:%a %d %b} · tap to read', 'url': f'#reports/{r["id"]}', 'tag': MODE})
    for w in state.get('wl', []):
        r = by.get(w['s'])
        if not r: continue
        for kind, lvl in (('above', w.get('above')), ('below', w.get('below'))):
            if lvl and ((kind == 'above' and r['px'] >= lvl) or (kind == 'below' and r['px'] <= lvl)) and sent.get(f'{w["s"]}:{kind}') != today:
                sent[f'{w["s"]}:{kind}'] = today
                msgs.append({'title': f'{w["s"]} {kind} {lvl}', 'body': f'{r["n"]} last {r["px"]:.4g} {r["cur"]} ({(r["r1"] or 0) * 100:+.1f}% today)', 'url': f'#stock/{w["s"]}', 'tag': f'{w["s"]}:{kind}'})
        if abs(r.get('r1') or 0) >= .05 and sent.get(f'{w["s"]}:move') != today:
            sent[f'{w["s"]}:move'] = today
            msgs.append({'title': f'{w["s"]} moved {r["r1"] * 100:+.1f}%', 'body': f'{r["n"]} · {r["bias"]}', 'url': f'#stock/{w["s"]}', 'tag': f'{w["s"]}:move'})
    cache_put('alerts.json', {k: v for k, v in sent.items() if v >= (NOW - dt.timedelta(days=7)).date().isoformat()})
    Path(os.environ.get('PUSH_OUT', 'push.json')).write_text(json.dumps({'subs': subs, 'msgs': msgs[:8]}))


if __name__ == '__main__':
    main()
