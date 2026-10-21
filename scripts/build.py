#!/usr/bin/env python3
"""Builds the encrypted market snapshot that the site reads from the `market` branch.

Usage: build.py daily|evening|weekly|live|testpush   (weekly also refreshes the universe and fundamentals;
       live only refreshes quotes + breaking news into LIVE_OUT, every ~10 minutes)
Env:   SITE_PASSWORD (required), OUT (market branch dir, default ./out), DATA (data branch checkout with
       profiles.bin and p/<id>.bin, optional), LIVE_OUT (live branch dir), LLM_API_KEY (+ optional LLM_BASE_URL,
       LLM_MODEL) for the AI reports, LIMIT (cap tickers per market, for quick local tests).

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
    """Caches are encrypted like everything else: fund/alerts data includes family watchlist symbols."""
    stem = name.rsplit('.', 1)[0]
    v = get(f'cache/{stem}.bin')
    if v is not None: return v
    try: v = json.loads((OUT / 'cache' / name).read_text())  # plaintext cache from before 2026-10-21: encrypt it now
    except Exception: return default
    cache_put(name, v)
    return v


def cache_put(name, obj):
    stem = name.rsplit('.', 1)[0]
    put(f'cache/{stem}.bin', obj)
    (OUT / 'cache' / name).unlink(missing_ok=True)


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

# Optional third item: fields copied onto the row (st = Shariah status for paper trading, cur = trading currency).
C, F, R = {'st': 'C'}, {'st': 'F'}, {'st': 'R'}
MACRO = {
    'Indices': [('^GSPC', 'S&P 500'), ('^IXIC', 'Nasdaq Composite'), ('^DJI', 'Dow Jones'), ('^RUT', 'Russell 2000'),
                ('^KLSE', 'FBM KLCI'), ('^STI', 'Straits Times Index'), ('^N225', 'Nikkei 225'), ('^HSI', 'Hang Seng'),
                ('000001.SS', 'Shanghai Composite'), ('^KS11', 'KOSPI'), ('^TWII', 'Taiwan Weighted'), ('^BSESN', 'BSE Sensex'),
                ('^JKII', 'Jakarta Islamic Index'), ('^FTSE', 'FTSE 100'), ('^GDAXI', 'DAX'), ('^NDX', 'Nasdaq 100'),
                ('^SOX', 'Philadelphia Semiconductor'), ('^HSCE', 'Hang Seng China Enterprises'), ('399001.SZ', 'Shenzhen Component'),
                ('^AXJO', 'S&P/ASX 200'), ('^GSPTSE', 'S&P/TSX Composite'), ('^STOXX50E', 'Euro Stoxx 50'), ('^FCHI', 'CAC 40'), ('^JKSE', 'Jakarta Composite')],
    'Shariah ETFs': [('SPUS', 'SP Funds S&P 500 Shariah', C), ('HLAL', 'Wahed FTSE USA Shariah', C), ('UMMA', 'Wahed Dow Jones Islamic World', C),
                     ('SPWO', 'SP Funds S&P World ex-US Shariah', C), ('SPTE', 'SP Funds S&P Global Technology Shariah', C), ('SPRE', 'SP Funds Global REIT Shariah', C),
                     ('SPSK', 'SP Funds Dow Jones Global Sukuk', C), ('ISDU.L', 'iShares MSCI USA Islamic (LSE)', {**C, 'cur': 'USD'}),
                     ('ISWD.L', 'iShares MSCI World Islamic (LSE)', {**C, 'cur': 'USD'}), ('IGDA.L', 'Invesco Dow Jones Islamic Global Developed (LSE)', {**C, 'cur': 'USD'}),
                     ('0821EA.KL', 'Eq8 DJ Islamic Malaysia Titans 25', C), ('0824EA.KL', 'Eq8 MSCI Malaysia Islamic Dividend', C),
                     ('0825EA.KL', 'Eq8 MSCI SEA Islamic Dividend', C), ('0827EA.KL', 'Eq8 DJ Islamic US Titans 50', C),
                     ('0838EA.KL', 'VP-DJ Shariah China A-Shares 100', C), ('0828EA.KL', 'TradePlus Shariah Gold', C)],
    'Commodities': [('GC=F', 'Gold'), ('SI=F', 'Silver'), ('PL=F', 'Platinum'), ('PA=F', 'Palladium'), ('HG=F', 'Copper'), ('ALI=F', 'Aluminium'),
                    ('CL=F', 'WTI crude oil'), ('BZ=F', 'Brent crude oil'), ('NG=F', 'Natural gas'), ('RB=F', 'Gasoline'), ('HO=F', 'Heating oil'),
                    ('ZW=F', 'Wheat'), ('ZC=F', 'Corn'), ('ZS=F', 'Soybeans'), ('KC=F', 'Coffee'), ('SB=F', 'Sugar'), ('CC=F', 'Cocoa'), ('CT=F', 'Cotton')],
    'Crypto': [('BTC-USD', 'Bitcoin', R), ('ETH-USD', 'Ethereum', R), ('SOL-USD', 'Solana', R), ('XRP-USD', 'XRP', R), ('BNB-USD', 'BNB', R),
               ('ADA-USD', 'Cardano', R), ('AVAX-USD', 'Avalanche', R), ('LINK-USD', 'Chainlink', R), ('DOT-USD', 'Polkadot', R),
               ('DOGE-USD', 'Dogecoin (meme coin)', F), ('IBIT', 'iShares Bitcoin Trust ETF', R), ('ETHA', 'iShares Ethereum Trust ETF', R)],
    'Futures': [('ES=F', 'S&P 500 E-mini'), ('NQ=F', 'Nasdaq 100 E-mini'), ('YM=F', 'Dow E-mini'), ('RTY=F', 'Russell 2000 E-mini'),
                ('NIY=F', 'Nikkei 225 (yen)'), ('6E=F', 'Euro FX'), ('6J=F', 'Japanese yen'), ('ZT=F', 'US 2-year Treasury note'),
                ('ZN=F', 'US 10-year Treasury note'), ('ZB=F', 'US 30-year Treasury bond')],
    'Bonds': [('^IRX', 'US 13-week T-bill yield'), ('^FVX', 'US 5-year yield'), ('^TNX', 'US 10-year yield'), ('^TYX', 'US 30-year yield'),
              ('SPSK', 'SP Funds Dow Jones Global Sukuk (Shariah)', C), ('SHY', 'iShares 1-3 Year Treasury', F), ('IEF', 'iShares 7-10 Year Treasury', F),
              ('TLT', 'iShares 20+ Year Treasury', F), ('AGG', 'iShares Core US Aggregate Bond', F), ('HYG', 'iShares High Yield Corporate Bond', F)],
    'FX & VIX': [('SGD=X', 'USD/SGD'), ('MYR=X', 'USD/MYR'), ('SGDMYR=X', 'SGD/MYR'), ('DX-Y.NYB', 'US Dollar Index'),
                 ('JPY=X', 'USD/JPY'), ('CNY=X', 'USD/CNY'), ('^VIX', 'VIX (fear gauge)')],
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
                code = parts[0].replace('/', '-')
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


def fix_suffixes(uni):
    """SP Funds lists Taipei OTC (TPEx) and KOSDAQ names with the main-board suffix; Yahoo has them as .TWO / .KQ."""
    alt = lambda s: s + 'O' if s.endswith('.TW') else s[:-3] + '.KQ'
    cand = [s for s in uni if s.endswith(('.TW', '.KS'))]
    if len(cand) < 2: return uni
    try: d = yf.download(cand + [alt(s) for s in cand], period='1mo', progress=False, auto_adjust=True, group_by='column')['Close']
    except Exception as e: print('suffix check', e); return uni
    ok = lambda s: s in d and d[s].notna().any()
    for s in cand:
        if not ok(s) and ok(alt(s)): uni[alt(s)] = uni.pop(s)
    return uni


def build_universe():
    sc = sc_list()
    spf = sp_funds()
    uni = {}
    for q in screen('KLS', 1e6, 1500):  # every Bursa stock Yahoo lists (~1,050)
        code = q['symbol'].split('.')[0]
        uni[q['symbol']] = {'m': 'MY', 'n': q.get('longName') or q.get('shortName'), 'sn': q.get('shortName'), 'sc': code in sc['codes']}  # sn = Bursa short name (SEALINK)
    for q in screen('SES', 1e6, 1000):  # every SGX stock Yahoo lists (~520)
        uni[q['symbol']] = {'m': 'SG', 'n': q.get('longName') or q.get('shortName'), 'sn': q.get('shortName')}  # SGX short name (DBS)
    for ex in ('NMS', 'NYQ'):
        for q in screen(ex, 2e9, 1500):  # US mid and large caps > US$2b (~2,000)
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
             'earningsTimestamp', 'recommendationKey', 'targetMeanPrice', 'numberOfAnalystOpinions', 'longName', 'quoteType',
             'heldPercentInstitutions', 'heldPercentInsiders']


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


# Pattern finder (dashboard): chart and candlestick setups on the latest daily bar.
PATTERN_NAMES = {'hi52': 'New 52-week high', 'lo52': 'New 52-week low', 'golden': 'Golden cross (50-day over 200-day)', 'death': 'Death cross (50-day under 200-day)',
                 'brk20': '20-day breakout on volume', 'volspike': 'Volume spike (3x average)', 'oversold': 'RSI oversold (under 30)', 'overbought': 'RSI overbought (over 70)',
                 'engulf': 'Bullish engulfing', 'bearengulf': 'Bearish engulfing', 'hammer': 'Hammer after a drop', 'gapup': 'Gap up (over 2%)',
                 'gapdown': 'Gap down (over 2%)', 'inside': 'Inside day (range squeeze)'}


def patterns(P, I):
    out = {}
    for s in I['raw'].columns:
        c = I['raw'][s].dropna()
        if len(c) < 60: continue
        idx = c.index
        o, h, l, v = (P[k][s].reindex(idx) for k in ('Open', 'High', 'Low', 'Volume'))
        O1, H1, L1, C1, O0, H0, L0, C0 = o.iloc[-1], h.iloc[-1], l.iloc[-1], c.iloc[-1], o.iloc[-2], h.iloc[-2], l.iloc[-2], c.iloc[-2]
        if any(pd.isna(x) or x <= 0 for x in (O1, H1, L1, O0, H0, L0)): continue
        f, prior = [], c.iloc[-253:-1]
        if len(prior) >= 120 and C1 > prior.max(): f.append('hi52')
        if len(prior) >= 120 and C1 < prior.min(): f.append('lo52')
        s50, s200 = I['sma'][50][s].reindex(idx), I['sma'][200][s].reindex(idx)
        if s50.iloc[-1] > s200.iloc[-1] and (s50.iloc[-4:-1] <= s200.iloc[-4:-1]).any(): f.append('golden')
        if s50.iloc[-1] < s200.iloc[-1] and (s50.iloc[-4:-1] >= s200.iloc[-4:-1]).any(): f.append('death')
        va = v.iloc[-21:-1].mean()
        if va > 0 and C1 > c.iloc[-21:-1].max() and v.iloc[-1] > 1.5 * va: f.append('brk20')
        if va > 0 and v.iloc[-1] > 3 * va: f.append('volspike')
        r = I['rsi'][s].reindex(idx).iloc[-1]
        if r < 30: f.append('oversold')
        if r > 70: f.append('overbought')
        if C0 < O0 and C1 > O1 and O1 <= C0 and C1 >= O0: f.append('engulf')
        if C0 > O0 and C1 < O1 and O1 >= C0 and C1 <= O0: f.append('bearengulf')
        body = abs(C1 - O1)
        if body > 0 and min(O1, C1) - L1 >= 2 * body and H1 - max(O1, C1) <= body and C0 < c.iloc[-6]: f.append('hammer')
        if L1 > H0 * 1.02: f.append('gapup')
        if H1 < L0 * .98: f.append('gapdown')
        if H1 < H0 and L1 > L0: f.append('inside')
        if f: out[s] = f
    return out


def intraday(syms):
    """5-minute closes for today's (or the last) session: the dashboards' 1-day index charts."""
    try: d = yf.download(syms, period='1d', interval='5m', auto_adjust=False, progress=False, threads=True, group_by='column')['Close']
    except Exception as e: print('intraday', e); return {}
    if isinstance(d, pd.Series): d = d.to_frame(syms[0])
    out = {}
    for s in d.columns:
        c = d[s].dropna()
        if len(c) > 2: out[s] = {'t0': int(c.index[0].timestamp()), 'c': [round(float(x), 4) for x in c]}
    return out


# ---------------------------------------------------------------- news, calendar, media

NEWS_Q = [('Global', 'stock market today'), ('US', 'Wall Street stocks Fed'), ('Malaysia', 'Bursa Malaysia KLCI'),
          ('Singapore', 'SGX Straits Times Index stocks'), ('Commodities', 'gold oil prices'), ('Macro', 'central bank interest rates inflation'),
          ('Islamic finance', 'shariah compliant stocks OR islamic finance'), ('Asia', 'Asian markets stocks')]


# Headlines/videos must be about markets or something that moves them; JUNK drops sport, showbiz, crime and lifestyle.
RELEVANT = re.compile(
    r'\b(stocks?|shares?|equit\w*|markets?|econom\w*|inflation|deflation|interest|rates?|central bank|fed|fomc|powell|ecb|boj|mas|bank negara|bnm|opr|'
    r'earnings|profits?|revenue|results|quarter\w*|guidance|ipos?|listing|bonds?|yields?|treasur\w*|sukuk|dollar|ringgit|sgd|yen|yuan|currenc\w*|forex|fx|'
    r'oil|crude|opec|gold|silver|copper|commodit\w*|palm oil|gdp|recession|tariffs?|trade|trading|trader|exports?|imports?|sanctions?|bursa|sgx|sti|klci|'
    r'wall street|nasdaq|s&p|dow|investors?|invest\w*|funds?|etfs?|dividends?|mergers?|acquisitions?|takeover|deal|bankrupt\w*|default|debt|budget|tax\w*|'
    r'jobs|payrolls?|unemployment|cpi|pmi|retail sales|housing|property|reits?|crypto\w*|bitcoin|ethereum|ai|chips?|semiconductor\w*|nvidia|apple|tesla|'
    r'microsoft|amazon|alphabet|google|meta|banks?|prices?|sales|valuation|billion|million|ceo|compan\w*|firms?|layoffs?|shutdown|election|war|ceasefire|'
    r'portfolio|wealth|money|financ\w*|halal|zakat|riba|shariah|islamic|candlestick|chart|technical analysis|price action|risk|volatility|vix|'
    r'bull\w*|bear\w*|rally|selloff|sell-off|crash|correction|options|futures|hedge|capital|growth|startups?|industr\w*|manufactur\w*|supply|demand)\b', re.I)
JUNK = re.compile(
    r'\b(medal|olympic|league|tournament|championship|world cup|fifa|match|goal|striker|badminton|football|soccer|cricket|tennis|golf|f1|formula 1|nba|nfl|'
    r'celebrity|actor|actress|singer|concert|movie|film|drama series|k-?pop|album|recipe|horoscope|zodiac|wedding|dating|fashion|beauty|makeup|skincare|'
    r'murder\w*|stabb\w*|rape|molest\w*|kidnap\w*|missing child|lottery|toto|giveaway|prank|reacts?|reaction|tiktoks?|marry|marriage|divorce|vlog|unboxing|mukbang|food review|travel guide|'
    r'event highlights?|behind the scenes)\b|#shorts', re.I)


def relevant(t, need_market=True):
    return bool(t) and not JUNK.search(t) and (not need_market or bool(RELEVANT.search(t)))


def gnews(q, n=8, days=1, when=None):
    r = http(f'https://news.google.com/rss/search?q={requests.utils.quote(q)}+when:{when or f"{days}d"}&hl=en-SG&gl=SG&ceid=SG:en')
    f = feedparser.parse(r.content if r else b'')
    out = []
    for e in f.entries[:n]:
        t = e.get('title', '')
        src = e.get('source', {}).get('title') if isinstance(e.get('source'), dict) else ''
        if src and t.endswith(' - ' + src): t = t[: -len(src) - 3]
        out.append({'t': t, 'u': e.get('link'), 's': src, 'at': e.get('published')})
    return out


def yt_search(q, must=None, n=1):
    """Direct videos for a topic (YouTube's search page, videos only), checked via oEmbed so every link is a real, public video.
    `must`: a regex the title or channel has to match (keeps searches on topic and drops clickbait that only shares a word)."""
    r = http('https://www.youtube.com/results', tries=2, params={'search_query': q, 'sp': 'EgIQAQ=='}, cookies={'CONSENT': 'YES+1'})
    out = []
    for vid in list(dict.fromkeys(re.findall(r'"videoId":"([\w-]{11})"', r.text if r else '')))[:6]:
        o = http('https://www.youtube.com/oembed', tries=1, params={'url': f'https://www.youtube.com/watch?v={vid}', 'format': 'json'})
        if not o: continue
        j = o.json()
        t, ch = j.get('title', ''), j.get('author_name', '')
        if not relevant(t, need_market=False) or (must and not re.search(must, t + ' ' + ch, re.I)): continue
        out.append({'id': vid, 't': t, 'src': ch})
        if len(out) >= n: break
    return out


def news(watch):
    out = []
    for tag, q in NEWS_Q:
        try: out += [dict(x, g=tag) for x in gnews(q, 12) if relevant(x['t'])]
        except Exception as e: print('news', tag, e)
    for w in watch[:25]:
        try: out += [dict(x, g='Watchlist', sym=w['s']) for x in gnews(f'"{w["n"]}"', 6, 3) if relevant(x['t'], need_market=False)][:3]
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


# Study plan (Watch tab): each topic resolves to one direct video, refreshed weekly.
STUDY = [  # (topic, YouTube query, why, regex the chosen video's title/channel must match)
    ('Candlestick basics (Rayner Teo)', 'Rayner Teo candlestick patterns trading guide', 'A Singapore-based trader with clear price-action lessons. Start here for the EDU candles chapter.', r'candlestick'),
    ('Support and resistance properly', 'Rayner Teo support and resistance', 'The single most useful chart skill.', r'support and resistance'),
    ('Position sizing and risk', 'position sizing explained trading risk management 1 percent rule', 'Stops and sizing matter more than entries.', r'position siz'),
    ('How to read an annual report', 'how to read a company annual report for stock investors', 'Fundamental basics.', r'annual report|10-k'),
    ('Valuation (Damodaran)', 'Aswath Damodaran valuation class intrinsic value', 'The best free valuation teaching anywhere.', r'damodaran'),
    ('Shariah stock screening explained', 'Islamic Finance Guru shariah stock screening', 'How screens work and their limits.', r'(halal|shariah|islamic).*(screen|check|criteria|compliant)|(screen|check|criteria|compliant).*(halal|shariah|islamic)'),
    ('Purifying dividends', 'how to purify dividends halal investing', 'The practical step most people skip.', r'purif'),
    ('Is day trading halal?', 'is day trading halal scholars', 'Hear the scholarly views directly.', r'day trading'),
    ('Reading the economic calendar', 'how CPI and FOMC affect stock market explained', 'Why stocks jump on data days.', r'cpi|fomc|economic calendar'),
    ('Bursa Malaysia for beginners', 'how to invest in Bursa Malaysia beginners', 'Local market mechanics.', r'bursa'),
    ('US estate tax for Singapore investors', 'US estate tax Singapore investors Ireland domiciled ETF', 'An overlooked risk for Asia-based investors.', r'estate tax|ireland'),
    ('VWAP and opening range (intraday)', 'VWAP opening range breakout strategy explained', 'If you do day trade, learn these first.', r'vwap|opening range'),
]


def media(old, watch=()):
    old = old or {}
    pods, vids = [], []
    for name, url in PODCASTS:
        r = http(url)
        if not r: continue
        f = feedparser.parse(r.content)
        for e in [e for e in f.entries[:8] if relevant(e.get('title'))][:3]:
            pods.append({'src': name, 't': e.get('title'), 'u': e.get('link') or (e.get('enclosures') or [{}])[0].get('href'), 'at': e.get('published')})
    for name, cid in CHANNELS:
        r = http(f'https://www.youtube.com/feeds/videos.xml?channel_id={cid}', tries=2)
        if not r:  # YouTube's feed 404s intermittently; keep yesterday's entries for this channel
            vids += [v for v in old.get('vids', []) if v.get('src') == name and relevant(v.get('t'))]
            continue
        fresh = lambda e: (e.get('published') or '')[:10] >= (NOW - dt.timedelta(days=180)).date().isoformat()  # dormant channels: skip old uploads
        for e in [e for e in feedparser.parse(r.content).entries[:10] if e.get('yt_videoid') and fresh(e) and relevant(e.get('title'))][:4]:
            vids.append({'src': name, 't': e.get('title'), 'id': e.get('yt_videoid'), 'at': e.get('published')})
    study = old.get('study') or []
    if MODE == 'weekly' or len(study) < len(STUDY) // 2 or not old.get('study_v'):  # study_v: re-pick once with the topic filters
        got = []
        for t, q, why, must in STUDY:
            v = yt_search(q, must=must)
            if v: got.append({**v[0], 'topic': t, 'why': why})
        if len(got) >= len(STUDY) // 2: study = got
    # Watchlist names: one or two recent videos that actually mention the company (no search pages on the site).
    wl = {}
    for w in watch[:25]:
        first = re.sub(r'[^\w ]', '', w['n']).split(' ')[0] if w.get('n') and w['n'] != w['s'] else w['s'].split('.')[0]
        try: wl[w['s']] = yt_search(f'{w["n"]} stock', must=re.escape(first), n=2)
        except Exception as e: print('yt', w['s'], e)
    return {'pods': pods, 'vids': vids, 'study': study, 'study_v': 2, 'wl': {k: v for k, v in wl.items() if v}}


# ---------------------------------------------------------------- small-account strategies (scan + backtest)
# Three well-documented long-only swing setups that suit a small cash account (no margin, no shorting): entries at
# the next day's open, exits by rule. The backtest replays each rule over the last ~2 years for every compliant
# stock, one trade at a time per stock. Returns are gross; the site subtracts each person's broker fees.
STRATS = {
    'rsi2': 'RSI(2) dip in an uptrend (Connors): close > 200-day average and 2-day RSI < 10. Exit on the first close above the 5-day average, or after 7 days; stop 2.5 ATR.',
    'brk': '20-day breakout on volume: close above the prior 20-day high on 1.5x average volume, 50-day > 200-day. Exit on a close below the 10-day average or after 10 days; stop 1.5 ATR.',
    'pull': 'Pullback to the rising 20-day EMA: uptrend (50 > 200-day), the day dips to the EMA and closes green above it. Stop under the 3-day low, target 2R, max 10 days.',
}


def _wilder(x, n):
    return x.ewm(alpha=1 / n, min_periods=n).mean()


def strategy_scan(P, meta):
    """meta: {sym: {m, st, cur, n, val}}. Returns (signals today, {strategy: {market: [returns...]}})."""
    rets = {k: {} for k in STRATS}
    sig_today = []
    for s, mt in meta.items():
        try:
            df = pd.DataFrame({k: P[k][s] for k in ('Open', 'High', 'Low', 'Close', 'Volume')}).dropna(subset=['Open', 'High', 'Low', 'Close'])
        except KeyError:
            continue
        df = df[(df['Volume'].fillna(0) > 0) | (df.index == df.index[-1])] if mt['m'] != 'ETF' else df
        if len(df) < 220: continue
        cs = df['Close']
        o, h, l, c, v = (df[k].to_numpy(float) for k in ('Open', 'High', 'Low', 'Close', 'Volume'))
        sma5, sma10, sma50, sma200 = (cs.rolling(n).mean().to_numpy() for n in (5, 10, 50, 200))
        ema20 = cs.ewm(span=20, adjust=False).mean().to_numpy()
        d = cs.diff()
        rsi2 = (100 - 100 / (1 + _wilder(d.clip(lower=0), 2) / _wilder(-d.clip(upper=0), 2).replace(0, np.nan))).fillna(100).to_numpy()
        tr = pd.concat([df['High'] - df['Low'], (df['High'] - cs.shift()).abs(), (df['Low'] - cs.shift()).abs()], axis=1).max(axis=1)
        atr = _wilder(tr, 14).to_numpy()
        hi20 = df['High'].shift(1).rolling(20).max().to_numpy()
        av20 = df['Volume'].shift(1).rolling(20).mean().to_numpy()
        with np.errstate(invalid='ignore'):
            sigs = {
                'rsi2': (c > sma200) & (rsi2 < 10),
                'brk': (c > hi20) & (v > 1.5 * av20) & (c > sma50) & (sma50 > sma200),
                'pull': (sma50 > sma200) & (c > sma50) & (l <= ema20 * 1.005) & (c > ema20) & (c > o) & (c < ema20 * 1.03),
            }
        last = len(c) - 1
        for k, m in sigs.items():
            busy = -1
            for i in np.flatnonzero(m):
                if not np.isfinite(atr[i]) or atr[i] <= 0: continue
                if i == last:
                    stop = c[i] - (2.5 if k == 'rsi2' else 1.5) * atr[i] if k != 'pull' else min(l[max(0, i - 2):i + 1]) - 0.2 * atr[i]
                    sig_today.append({'s': s, 'k': k, 'm': mt['m'], 'st': mt['st'], 'n': mt['n'], 'cur': mt['cur'], 'px': c[i], 'stop': stop,
                                      'tgt': c[i] + 2 * (c[i] - stop) if k == 'pull' else None, 'atr': atr[i] / c[i], 'rsi2': rsi2[i], 'val': mt['val'],
                                      'd': df.index[i].date().isoformat()})
                    continue
                if i <= busy: continue  # one trade at a time per stock
                e = o[i + 1]
                if not e > 0: continue
                stop = e - 2.5 * atr[i] if k == 'rsi2' else e - 1.5 * atr[i] if k == 'brk' else min(l[max(0, i - 2):i + 1]) - 0.2 * atr[i]
                if stop >= e: continue
                tgt = e + 2 * (e - stop) if k == 'pull' else None
                hold = 7 if k == 'rsi2' else 10
                x, j = None, i + 1
                for j in range(i + 1, min(i + 1 + hold, last + 1)):
                    if l[j] <= stop: x = min(o[j], stop) if j > i + 1 else stop; break  # stop first: the conservative assumption
                    if tgt and h[j] >= tgt: x = max(o[j], tgt) if j > i + 1 else tgt; break
                    if k == 'rsi2' and c[j] > sma5[j]: x = c[j]; break
                    if k == 'brk' and c[j] < sma10[j]: x = c[j]; break
                if x is None:
                    if j >= last and j - i < hold: continue  # still open at the end of the data: not a finished trade
                    x = c[j]
                busy = j
                rets[k].setdefault(mt['m'], []).append(round(x / e - 1, 4))
    return sig_today, rets


def strategy_stats(rets):
    out = {}
    for k, by in rets.items():
        out[k] = {}
        for m, r in by.items():
            a = np.array(r)
            if len(a) < 10: continue
            g, ls = a[a > 0].sum(), -a[a < 0].sum()
            out[k][m] = {'n': len(a), 'win': float((a > 0).mean()), 'avg': float(a.mean()), 'med': float(np.median(a)),
                         'pf': float(g / ls) if ls else None, 'r': [float(x) for x in a[-3000:]]}
    return out


def weekly_max(syms):
    """Weekly bars over each symbol's full history, for the chart's 5Y/MAX views. Refreshed on the weekly run."""
    n = 0
    for i in range(0, len(syms), 100):
        chunk = syms[i:i + 100]
        try: d = yf.download(chunk, period='max', interval='1wk', auto_adjust=True, progress=False, threads=True, group_by='column')
        except Exception as e: print('weekly max', e); continue
        if not isinstance(d.columns, pd.MultiIndex): d.columns = pd.MultiIndex.from_product([d.columns, chunk])
        d.index = pd.to_datetime(d.index).tz_localize(None)
        for s in chunk:
            try: f = pd.DataFrame({k: d[k][s] for k in ('Open', 'High', 'Low', 'Close', 'Volume')}).dropna(subset=['Close'])
            except KeyError: continue
            if len(f) < 60: continue
            sig = lambda col: [float(f'{x:.5g}') if np.isfinite(x) else None for x in f[col].to_numpy(float)]
            put(f'ohlcw/{fname(s)}.bin', {'t': [int(t.timestamp()) for t in f.index], 'o': sig('Open'), 'h': sig('High'), 'l': sig('Low'), 'c': sig('Close'),
                                          'v': [int(x) if np.isfinite(x) else 0 for x in f['Volume'].to_numpy(float)]})
            n += 1
    print('weekly max files', n)


# ---------------------------------------------------------------- AI reports

def llm(system, user, max_tokens=2500):
    if os.environ.get('OLLAMA_MODEL'):
        r = requests.post('http://localhost:11434/api/chat', timeout=900, json={'model': os.environ['OLLAMA_MODEL'], 'stream': False,
                          'options': {'num_ctx': 32768, 'temperature': 0.3},  # Ollama's default 2-4k context silently truncates the data
                          'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]})
        return r.json()['message']['content']
    # GitHub Models was retired on 2026-07-30. Any OpenAI-compatible endpoint works; the default is Gemini's free tier.
    key = os.environ.get('LLM_API_KEY')
    if not key: return None
    base = os.environ.get('LLM_BASE_URL') or 'https://generativelanguage.googleapis.com/v1beta/openai'
    models = [os.environ.get('LLM_MODEL') or 'gemini-2.5-flash', os.environ.get('LLM_FALLBACK_MODEL') or 'gemini-2.5-flash-lite']
    try:  # model ids get retired; also try the newest "flash" models the key can see
        ids = [x['id'].split('/')[-1] for x in requests.get(f'{base.rstrip("/")}/models', headers={'Authorization': f'Bearer {key}'}, timeout=30).json()['data']]
        models += sorted([i for i in ids if 'flash' in i and not re.search(r'image|tts|audio|live|embed|preview|exp', i)], key=lambda i: ('lite' in i, [-int(n) for n in re.findall(r'\d+', i)]))[:2]
    except Exception as e: print('llm model list', e)
    for m in dict.fromkeys(models):
        try:
            r = requests.post(f'{base.rstrip("/")}/chat/completions', timeout=300,
                              headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                              json={'model': m, 'max_tokens': max_tokens, 'temperature': 0.4,
                                    'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]})
            if r.ok:
                llm.used = m
                return r.json()['choices'][0]['message']['content']
            print('llm', m, r.status_code, r.text[:300])
        except (requests.RequestException, ValueError, KeyError) as e: print('llm', m, e)
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


def report_ctx(summary, uni_rows, wl, cap=int(os.environ.get('LLM_CTX_CHARS', '60000'))):
    """Shrinks the context until it fits the provider's input limit (Gemini's free tier takes far more than this)."""
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
        tokens = 8000
    else:
        ask = ('Write the DAILY brief for today. Sections: 1) Overnight & yesterday recap (US close, Asia close) 2) What to watch today '
               '(events with SGT times, earnings, headlines that matter) 3) Outlook: today/next few days and the 1-week and 1-month bias '
               'for S&P 500, KLCI, STI, gold and oil, with probabilities/ranges 4) Shariah day-trade watch (liquid, volatile, compliant) '
               'and swing ideas, with levels 5) Watchlist notes 6) Three headlines worth reading in full. About 600-900 words.')
        tokens = 3500
    md = llm(SYSTEM, ask + '\n\nDATA (JSON):\n' + ctx, tokens)
    model = getattr(llm, 'used', None) or os.environ.get('LLM_MODEL') or 'gemini-2.5-flash'
    print('llm reply', len(md or ''), 'chars, context', len(ctx), flush=True)
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


# ---------------------------------------------------------------- family profiles (data branch)

DATA = Path(os.environ.get('DATA', 'datadir'))
NOTIFY_DEFAULTS = {'daily': True, 'weekly': True, 'alerts': True, 'moves': True, 'orders': True, 'breaking': False}


def alive(items): return [x for x in items or [] if not x.get('del')]


def load_profiles():
    """[(profile index entry, profile state)] for every family member. Unreadable files are skipped, not fatal."""
    try: idx = unseal((DATA / 'profiles.bin').read_bytes()).get('list', [])
    except Exception: return []
    out = []
    for p in idx:
        if not re.fullmatch(r'[a-z0-9]{1,24}', str(p.get('id', ''))) or p.get('del'): continue
        try: st = unseal((DATA / 'p' / f'{p["id"]}.bin').read_bytes())
        except Exception: st = {}
        out.append((p, st))
    return out


def prefs(st):
    pr = st.get('prefs') or {}
    return {'move': float(pr.get('move') or 5) / 100, 'notify': {**NOTIFY_DEFAULTS, **(pr.get('notify') or {})}}


def positions(st):
    """Net paper-trading quantity per symbol (trades are the source of truth; see paper.js)."""
    q = {}
    pa = st.get('paper') or {}
    for t in pa.get('trades', []):
        if t.get('at', '') >= pa.get('resetAt', ''):
            q[t['s']] = q.get(t['s'], 0) + (t['q'] if t['side'] == 'buy' else -t['q'])
    return {s: v for s, v in q.items() if v > 0}


def open_orders(st):
    pa = st.get('paper') or {}
    return [o for o in pa.get('orders', []) if o.get('status') == 'open' and o.get('at', '') >= pa.get('resetAt', '')]


def family_symbols(profs):
    syms = {}
    for _, st in profs:
        for w in alive(st.get('wl')): syms.setdefault(w['s'], w.get('n') or w['s'])
        for s in positions(st): syms.setdefault(s, s)
        for o in open_orders(st): syms.setdefault(o['s'], o['s'])
        for x in alive(st.get('quick')):
            if x.get('status') in ('planned', 'open'): syms.setdefault(x['s'], x['s'])
    return syms


def write_push(jobs):
    jobs = [dict(j, subs=alive(j['subs'])) for j in jobs]  # devices turned off or moved to another profile are tombstoned
    jobs = [j for j in jobs if j['subs'] and j['msgs']]
    if jobs: Path(os.environ.get('PUSH_OUT', 'push.json')).write_text(json.dumps({'jobs': jobs}))


# ---------------------------------------------------------------- main

def main():
    global META, AES
    META, AES = _key()
    (OUT / 'cache').mkdir(parents=True, exist_ok=True)
    profs = load_profiles()
    if MODE == 'testpush':
        who = os.environ.get('PROFILE', '')
        write_push([{'subs': st.get('subs', []), 'msgs': [{'title': 'AMA Stock Screener test', 'body': f'Notifications work for {p["name"]} · {NOW:%H:%M} SGT', 'url': '#settings', 'tag': 'test'}]}
                    for p, st in profs if not who or p['id'] == who])
        return
    if MODE == 'live':
        return live_main(profs)
    fam = family_symbols(profs)
    wl = [{'s': s, 'n': n} for s, n in fam.items()]

    uni = cache_get('universe-v2.json')  # v2 (2026-10-21): whole Bursa/SGX + US > $2b; the new name forces one rebuild
    sc = cache_get('sc.json', {})
    if MODE == 'weekly' or not uni or not any(u.get('sn') for u in uni.values()):  # sn added 2026-10-22
        uni, sc = build_universe()
        cache_put('universe-v2.json', uni)
    if any(s.endswith(('.TW', '.KS')) for s in uni):
        uni = fix_suffixes(uni); cache_put('universe-v2.json', uni)
    print('universe', len(uni))

    fund = cache_get('fund.json', {})
    stale = [s for s in uni if s not in fund or 'heldPercentInstitutions' not in (fund[s] or {}) or MODE == 'weekly' and (fund[s] or {}).get('at', '') < (NOW - dt.timedelta(days=6)).date().isoformat()]
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

    macro_syms = list(dict.fromkeys(s for g in MACRO.values() for s, *_ in g))
    curr = ({((fund.get(s) or {}).get('currency') or '').upper() for s in uni} | {'SGD', 'MYR'}) - {'', 'USD'}  # GBp (pence) -> GBP, x100 below
    fx_syms = [f'{c}=X' for c in curr if c.isalpha() and len(c) == 3]
    P = download(list(uni) + macro_syms + fx_syms)
    I = indicators(P)
    have = [s for s in I['C'].columns if I['C'][s].notna().sum() > 30]
    fx = {c: float(I['C'][f'{c}=X'].dropna().iloc[-1]) for c in curr | {'SGD', 'MYR'} if f'{c}=X' in have}
    lost = [c for c in curr if c.isalpha() and len(c) == 3 and c not in fx]  # the bulk download drops some FX pairs under load
    if lost: fx.update({s[:-2]: v['p'] for s, v in quotes([f'{c}=X' for c in lost]).items()})
    fx['USD'] = 1.0
    if 'GBP' in fx: fx['GBp'] = fx['GBP'] * 100

    groups = {'MY': [], 'SG': [], 'US': [], 'GL': [], 'MACRO': [s for s in macro_syms if s in have]}
    for s, u in uni.items():
        if s in have: groups[u['m']].append(s)
    cal = {g: calibrate(I, cols) for g, cols in groups.items() if cols}

    pats = patterns(P, I)
    rows = []
    for s, u in uni.items():
        if s not in have: continue
        f = fund.get(s) or {}
        x = snap(I, s)
        if not x: continue
        st, why = classify(u, f)
        cur = f.get('currency') or ('MYR' if u['m'] == 'MY' else 'SGD' if u['m'] == 'SG' else 'USD')
        rate = 1 if cur == 'USD' else fx.get(cur)
        rows.append({'s': s, 'n': f.get('longName') or u.get('n') or s, 'sn': u.get('sn'), 'm': u['m'], 'st': st, 'why': why, 'sec': f.get('sector'), 'ind': f.get('industry'),
                     'cur': cur, 'mc': f.get('marketCap'), 'pe': f.get('trailingPE'), 'fpe': f.get('forwardPE'), 'pb': f.get('priceToBook'),
                     'roe': f.get('returnOnEquity'), 'pm': f.get('profitMargins'), 'rg': f.get('revenueGrowth'), 'dy': f.get('dividendYield'),
                     'beta': f.get('beta'), 'dm': (f.get('totalDebt') or 0) / f['marketCap'] if f.get('marketCap') and f.get('totalDebt') is not None else None,
                     'cm': (f.get('totalCash') or 0) / f['marketCap'] if f.get('marketCap') and f.get('totalCash') is not None else None,
                     'tgt': f.get('targetMeanPrice'), 'rec': f.get('recommendationKey'), 'ana': f.get('numberOfAnalystOpinions'),
                     'earn': f.get('earningsTimestamp'), 'web': f.get('website'), 'about': f.get('longBusinessSummary'),
                     'inst': f.get('heldPercentInstitutions'), 'insd': f.get('heldPercentInsiders'), 'pat': pats.get(s),
                     'valusd': x['val'] / rate if x.get('val') and rate else None, **x,
                     'bias': label(x['score'] or 0), 'fc': forecast(x['px'], x['score'] or 0, x['vol'], cal.get(u['m'], {}))})
    by = {r['s']: r for r in rows}
    print('rows', len(rows))

    macro = {}
    for g, items in MACRO.items():
        macro[g] = []
        for s, n, *o in items:
            x = snap(I, s) if s in have else None
            if x: macro[g].append({'s': s, 'n': n, **(o[0] if o else {}), **x, 'bias': label(x['score'] or 0), 'fc': forecast(x['px'], x['score'] or 0, x['vol'], cal.get('MACRO', {}))})

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
        # Uptrends first; in a falling market the list still fills, with the downtrend names flagged by their bias.
        ideas[f'{mk}-invest'] = sorted(pool, key=lambda r: ((r['score'] or 0) > 0, r['inv']), reverse=True)[:15]
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
               'cal': {g: {str(h): t for h, t in c.items()} for g, c in cal.items()}, 'patnames': PATTERN_NAMES,
               'sc': {k: sc.get(k) for k in ('asof', 'url', 'patched')}, 'counts': count(rows),
               'calendar': calendar(), 'earnings': earnings, 'news': news([by[w['s']] for w in wl if w['s'] in by] + [{'s': w['s'], 'n': w['s']} for w in wl if w['s'] not in by]),
               'media': media(old.get('media'), [{'s': w['s'], 'n': by[w['s']]['n'] if w['s'] in by else w['s']} for w in wl]), 'reports': old.get('reports', []), 'fx': fx}

    # Small-account strategies: compliant, liquid stocks plus the US-listed Shariah ETFs.
    meta = {r['s']: {'m': r['m'], 'st': r['st'], 'cur': r['cur'], 'n': r['n'], 'val': r.get('valusd')} for r in rows
            if r['st'] in ('C', 'P') and (r.get('valusd') or 0) > (3e5 if r['m'] in ('MY', 'SG') else 2e6)}
    meta.update({s: {'m': 'ETF', 'st': 'C', 'cur': 'USD', 'n': n, 'val': None} for s, n, *_ in MACRO['Shariah ETFs'] if '.' not in s and s in have})
    sigs, rets = strategy_scan(P, meta)
    summary['quick'] = {'at': NOW.isoformat(), 'strats': STRATS, 'signals': sigs, 'stats': strategy_stats(rets)}
    print('strategies', len(sigs), 'signals today', {k: sum(len(v) for v in r.values()) for k, r in rets.items()}, 'backtest trades')
    if MODE == 'weekly' or not (OUT / 'ohlcw').exists():
        weekly_max([s for s in have if not (s.endswith('=X') and s not in macro_syms)])

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
    notify(profs, summary, by)
    print('done', MODE)


def slim(r):
    return {k: r.get(k) for k in ('s', 'n', 'm', 'st', 'sec', 'px', 'r1', 'r5', 'r21', 'r63', 'rsi', 'atr', 'rv', 'valusd', 'score', 'bias', 'fc', 'pe', 'roe', 'inv', 'day', 'sma50', 'sma200', 'cur')}


def count(rows):
    c = {}
    for r in rows: c.setdefault(r['m'], {}).setdefault(r['st'], 0); c[r['m']][r['st']] += 1
    return c


def notify(profs, summary, by):
    """Queues push messages per family member, following each profile's notification settings."""
    sent = cache_get('alerts.json', {})
    today = NOW.date().isoformat()
    jobs = []
    for p, st in profs:
        pr, msgs = prefs(st), []
        if MODE in pr['notify'] and pr['notify'][MODE] and summary['reports']:
            r = summary['reports'][0]
            msgs.append({'title': 'Weekly report is ready' if MODE == 'weekly' else 'Daily brief is ready', 'body': f'{NOW:%a %d %b} · tap to read', 'url': f'#reports/{r["id"]}', 'tag': MODE})
        msgs += alerts(p, st, {s: {'p': r['px'], 'c': r['r1'], 'n': r['n'], 'cur': r.get('cur', '')} for s, r in by.items()}, sent, today)
        jobs.append({'subs': st.get('subs', []), 'msgs': msgs[:8]})
    cache_put('alerts.json', {k: v for k, v in sent.items() if v >= (NOW - dt.timedelta(days=7)).date().isoformat()})
    write_push(jobs)


def alerts(p, st, q, sent, today):
    """Price alerts, big moves and paper orders that have triggered. Each fires at most once a day per profile."""
    pr, msgs = prefs(st), []
    def once(key):
        k = f'{p["id"]}:{key}'
        if sent.get(k) == today: return False
        sent[k] = today
        return True
    for w in alive(st.get('wl')):
        x = q.get(w['s'])
        if not x or x.get('p') is None: continue
        if pr['notify']['alerts']:
            for kind, lvl in (('above', w.get('above')), ('below', w.get('below'))):
                if lvl and ((kind == 'above' and x['p'] >= lvl) or (kind == 'below' and x['p'] <= lvl)) and once(f'{w["s"]}:{kind}'):
                    msgs.append({'title': f'{w["s"]} {kind} {lvl}', 'body': f'{x.get("n") or w["s"]} last {x["p"]:.4g} ({(x.get("c") or 0) * 100:+.1f}% today)', 'url': f'#stock/{w["s"]}', 'tag': f'{w["s"]}:{kind}'})
        if pr['notify']['moves'] and abs(x.get('c') or 0) >= pr['move'] and once(f'{w["s"]}:move'):
            msgs.append({'title': f'{w["s"]} moved {x["c"] * 100:+.1f}%', 'body': f'{x.get("n") or w["s"]} · last {x["p"]:.4g}', 'url': f'#stock/{w["s"]}', 'tag': f'{w["s"]}:move'})
    if pr['notify']['orders']:
        for o in open_orders(st):
            x = q.get(o['s'])
            if not x or not o.get('px'): continue
            later = x.get('d') and x['d'] > (o.get('d0') or o.get('at', '')[:10])  # same day: only the current price counts
            hi, lo = (x.get('h') or x['p'], x.get('l') or x['p']) if later else (x['p'], x['p'])
            hit = (o['side'] == 'buy' and (lo <= o['px'] if o['type'] == 'limit' else hi >= o['px'])) or \
                  (o['side'] == 'sell' and (hi >= o['px'] if o['type'] == 'limit' else lo <= o['px']))
            if hit and once(f'order:{o["id"]}'):
                msgs.append({'title': f'Paper {o["type"]} {o["side"]} {o["s"]} @ {o["px"]} triggered', 'body': 'Open the app to fill it.', 'url': '#paper', 'tag': f'order:{o["id"]}'})
    return msgs


# ---------------------------------------------------------------- live mode: quotes + breaking news every ~10 minutes

LIVE_OUT = Path(os.environ.get('LIVE_OUT', 'liveout'))
# Breaking-news sources the family picked (2026-10-21). Pulled through Google News' per-site search, which works for
# every outlet (most no longer publish RSS). General outlets get a market-keyword filter; business outlets don't need it.
NEWS_SOURCES = {  # id: (name, domain, business-only outlet?)
    'reuters': ('Reuters', 'reuters.com', False), 'bloomberg': ('Bloomberg', 'bloomberg.com', True), 'cnbc': ('CNBC', 'cnbc.com', True),
    'bbc': ('BBC News', 'bbc.com', False), 'aljazeera': ('Al Jazeera', 'aljazeera.com', False), 'ft': ('Financial Times', 'ft.com', True),
    'wsj': ('Wall Street Journal', 'wsj.com', True), 'yahoo': ('Yahoo Finance', 'finance.yahoo.com', True), 'cna': ('CNA', 'channelnewsasia.com', False),
    'bernama': ('Bernama', 'bernama.com', False), 'edge': ('The Edge Malaysia', 'theedgemalaysia.com', True), 'star': ('The Star', 'thestar.com.my', False),
    'st': ('The Straits Times', 'straitstimes.com', False), 'bt': ('The Business Times', 'businesstimes.com.sg', True),
}
MARKET_WORDS = ('(stocks OR shares OR market OR markets OR economy OR inflation OR "interest rate" OR "central bank" OR earnings OR profit '
                'OR IPO OR bonds OR yields OR dollar OR ringgit OR oil OR "gold price" OR "gold prices" OR GDP OR tariff OR Fed OR Bursa OR SGX OR STI OR "Wall Street" OR investors)')


def quotes(syms):
    """Latest price, change vs previous close and today's high/low. Yahoo's 15-min delay applies to Bursa/SGX."""
    out = {}
    syms = list(dict.fromkeys(syms))
    for i in range(0, len(syms), 200):
        chunk = syms[i:i + 200]
        try: d = yf.download(chunk, period='5d', interval='1d', auto_adjust=False, progress=False, threads=True, group_by='column')
        except Exception as e: print('quotes', e); continue
        if not isinstance(d.columns, pd.MultiIndex): d.columns = pd.MultiIndex.from_product([d.columns, chunk])
        for s in chunk:
            try:
                f = pd.DataFrame({k: d[k][s] for k in ('Close', 'High', 'Low', 'Volume')}).dropna(subset=['Close'])
            except KeyError: continue
            if len(f) >= 2 and (f['Volume'].iloc[-1] or 0) == 0 and (f['Volume'].iloc[-2] or 0) > 0: f = f.iloc[:-1]  # pre-open stub
            if len(f) < 2: continue
            last, prev = f.iloc[-1], f.iloc[-2]
            out[s] = {'p': float(last['Close']), 'c': float(last['Close'] / prev['Close'] - 1), 'h': float(last['High']), 'l': float(last['Low']),
                      'v': float(last['Volume'] or 0), 'd': f.index[-1].date().isoformat()}
    return out


def breaking():
    """Newest market headlines from each chosen outlet, tagged with the source id so each profile can filter."""
    items = []
    for sid, (name, dom, biz) in NEWS_SOURCES.items():
        q = f'site:{dom} {MARKET_WORDS}'
        try: got = gnews(q, 8, when='3h') or gnews(q, 4, when='1d')
        except Exception as e: print('breaking', sid, e); continue
        items += [dict(x, src=sid, s=name) for x in got]
    seen, out = set(), []
    for x in sorted(items, key=lambda x: _ts(x.get('at')), reverse=True):
        if sum(ord(c) > 0x24F for c in x['t']) > len(x['t']) * .3: continue  # English feed, but Google mixes in other scripts
        if not relevant(x['t']): continue
        k = x['t'].lower()[:70]
        if k not in seen: seen.add(k); out.append(x)
    return out  # at most 8 per outlet, so a busy outlet can't crowd out a slow one




def _ts(s):
    try: return dt.datetime.strptime(s, '%a, %d %b %Y %H:%M:%S %Z').timestamp()
    except (TypeError, ValueError): return 0


def live_main(profs):
    summary = get('summary.bin', {}) or {}
    syms = [x['s'] for g in (summary.get('macro') or {}).values() for x in g]
    syms += list(family_symbols(profs))
    syms += [r['s'] for r in get('universe.bin', []) or []]  # the whole universe, so the region dashboards' movers are live
    for k in ('ideas', 'movers'):
        syms += [r['s'] for v in (summary.get(k) or {}).values() for r in v]
    q = quotes(syms)
    fxq = quotes([f'{c}=X' for c in (summary.get('fx') or {'SGD': 1, 'MYR': 1}) if c not in ('USD', 'GBp')])
    fx = {s[:-2]: v['p'] for s, v in fxq.items()}
    fxc = {s[:-2]: v['c'] for s, v in fxq.items()}  # 1-day change of each pair (units per USD)
    # Second FX source to double-check Yahoo: Coinbase's public exchange-rate API (mid-market, no key).
    try: cb = requests.get('https://api.coinbase.com/v2/exchange-rates?currency=USD', headers=UA, timeout=20).json()['data']['rates']
    except Exception as e: print('coinbase fx', e); cb = {}
    fx2 = {c: float(cb[c]) for c in list(fx) + ['MYR'] if c in cb} | ({'USD': 1.0} if cb else {})
    if fx: fx['USD'] = 1.0
    if 'GBP' in fx: fx['GBp'] = fx['GBP'] * 100
    news = breaking()
    LIVE_OUT.mkdir(parents=True, exist_ok=True)
    intra = intraday([s for g in ('Indices', 'Futures') for s, *_ in MACRO[g]])
    (LIVE_OUT / 'live.bin').write_bytes(seal({'at': NOW.isoformat(), 'q': q, 'fx': fx, 'fx2': fx2, 'fxc': fxc, 'news': news, 'intra': intra}))
    try: sent = unseal((LIVE_OUT / 'alerts.bin').read_bytes())
    except Exception: sent = {}
    today, jobs = NOW.date().isoformat(), []
    names = {r['s']: r['n'] for v in (summary.get('ideas') or {}).values() for r in v}
    for p, st in profs:
        msgs = alerts(p, st, {s: {**v, 'n': names.get(s)} for s, v in q.items()}, sent, today)
        if prefs(st)['notify']['breaking']:
            mine = set(((st.get('prefs') or {}).get('news') or {}).get('sources') or NEWS_SOURCES)
            for n in [n for n in news if n.get('src') in mine][:3]:
                if _ts(n.get('at')) > NOW.timestamp() - 1800 and sent.get(f'{p["id"]}:news:{n["t"][:60]}') is None:
                    sent[f'{p["id"]}:news:{n["t"][:60]}'] = today
                    msgs.append({'title': 'Breaking', 'body': n['t'][:180], 'url': '#news', 'tag': 'breaking'})
        jobs.append({'subs': st.get('subs', []), 'msgs': msgs[:6]})
    (LIVE_OUT / 'alerts.bin').write_bytes(seal({k: v for k, v in sent.items() if v >= (NOW - dt.timedelta(days=3)).date().isoformat()}))
    write_push(jobs)
    print('live', len(q), 'quotes', len(news), 'headlines', len(profs), 'profiles')


if __name__ == '__main__':
    main()
