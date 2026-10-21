#!/usr/bin/env python3
"""Publishes a read-only moomoo snapshot to the site: your moomoo watchlist groups, snapshot quotes for them and
for your site watchlist, and (with --positions) your holdings. The site shows it on the WL tab.

Needs OpenD running on this Mac and logged in with your moomoo ID (https://openapi.moomoo.com -> Download OpenD).
Never unlocks trading and never places orders.

  SITE_PASSWORD=... python local/moomoo_bridge.py --once
  SITE_PASSWORD=... python local/moomoo_bridge.py --every 60 --positions

GitHub write access comes from GH_TOKEN, or `gh auth token` if the GitHub CLI is logged in.
"""
import argparse, base64, gzip, json, os, subprocess, sys, time, datetime as dt

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

REPO = os.environ.get('REPO', 'MikachuFM2202/stocks-tracker')
API = f'https://api.github.com/repos/{REPO}/contents'
SGT = dt.timezone(dt.timedelta(hours=8))
SUFFIX = {'SG': '.SI', 'MY': '.KL', 'HK': '.HK', 'JP': '.T', 'SH': '.SS', 'SZ': '.SZ', 'AU': '.AX', 'CA': '.TO'}


def yahoo(code):
    """'US.AAPL' -> 'AAPL', 'SG.D05' -> 'D05.SI', 'HK.00700' -> '0700.HK'."""
    mkt, sym = code.split('.', 1)
    if mkt == 'US': return sym.replace('.', '-')
    if mkt == 'HK': sym = sym.lstrip('0').zfill(4)
    return sym + SUFFIX.get(mkt, '.' + mkt)


def moo(sym):
    """Inverse of yahoo(); None for symbols moomoo can't quote (indices, futures, FX)."""
    if any(c in sym for c in '^=') or sym.endswith('.L'): return None
    if '.' not in sym: return 'US.' + sym.replace('-', '.')
    code, suf = sym.rsplit('.', 1)
    mkt = {v[1:]: k for k, v in SUFFIX.items()}.get(suf)
    return mkt and f'{mkt}.{code.zfill(5) if mkt == "HK" else code}'


class Vault:
    def __init__(self, token):
        self.h = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
        meta = requests.get(f'https://raw.githubusercontent.com/{REPO}/market/meta.json', timeout=20).json()
        key = PBKDF2HMAC(hashes.SHA256(), 32, base64.b64decode(meta['salt']), meta['iter']).derive(os.environ['SITE_PASSWORD'].encode())
        self.aes = AESGCM(key)

    def read(self, name):
        r = requests.get(f'{API}/{name}?ref=data', headers={**self.h, 'Accept': 'application/vnd.github.raw+json'}, timeout=20)
        if r.status_code == 404: return None
        r.raise_for_status()
        return json.loads(gzip.decompress(self.aes.decrypt(r.content[:12], r.content[12:], None)))

    def write(self, name, obj):
        iv = os.urandom(12)
        blob = iv + self.aes.encrypt(iv, gzip.compress(json.dumps(obj).encode()), None)
        for i in range(4):
            cur = requests.get(f'{API}/{name}?ref=data', headers=self.h, timeout=20)
            body = {'message': f'moomoo: snapshot', 'branch': 'data', 'content': base64.b64encode(blob).decode()}
            if cur.ok: body['sha'] = cur.json()['sha']
            r = requests.put(f'{API}/{name}', headers=self.h, json=body, timeout=30)
            if r.ok: return
            if r.status_code not in (409, 422): r.raise_for_status()
            time.sleep(1 + i)
        r.raise_for_status()


def snapshot(args, vault):
    import moomoo as mm
    q = mm.OpenQuoteContext(host=args.host, port=args.port)
    try:
        groups = {}
        ret, g = q.get_user_security_group(group_type='CUSTOM')
        if ret == mm.RET_OK:
            for name in g['group_name']:
                ret, d = q.get_user_security(name)
                if ret == mm.RET_OK and len(d): groups[name] = [yahoo(c) for c in d['code']]
        state = vault.read('state.bin') or {}
        wanted = {moo(w['s']) for w in state.get('wl', [])} | {moo(s) for v in groups.values() for s in v}
        codes = sorted(c for c in wanted if c)
        quotes = []
        for i in range(0, len(codes), 200):
            ret, d = q.get_market_snapshot(codes[i:i + 200])
            if ret != mm.RET_OK:  # usually missing quote rights for one market: retry one by one, skip the rest
                for c in codes[i:i + 200]:
                    r1, d1 = q.get_market_snapshot([c])
                    if r1 == mm.RET_OK: quotes += d1.to_dict('records')
                continue
            quotes += d.to_dict('records')
    finally:
        q.close()
    out = {'at': dt.datetime.now(SGT).isoformat(), 'groups': groups, 'quotes': [
        {'s': yahoo(x['code']), 'n': x.get('name'), 'px': x.get('last_price'), 'vol': x.get('volume'), 'turnover': x.get('turnover'),
         'chg': (x['last_price'] / x['prev_close_price'] - 1) if x.get('prev_close_price') else None} for x in quotes]}
    if args.positions:
        out['positions'] = positions(args, mm)
    vault.write('moomoo.bin', out)
    print(f'{out["at"]}: {len(out["quotes"])} quotes, {len(groups)} groups, {len(out.get("positions", []))} positions')


def positions(args, mm):
    rows = []
    for mkt in ('US', 'SG', 'HK', 'MY'):
        t = mm.OpenSecTradeContext(filter_trdmarket=getattr(mm.TrdMarket, mkt), host=args.host, port=args.port,
                                   security_firm=getattr(mm.SecurityFirm, args.firm))
        try:
            ret, d = t.position_list_query()  # read-only: no unlock_trade() call anywhere
            if ret == mm.RET_OK:
                rows += [{'s': yahoo(x['code']), 'qty': x['qty'], 'cost': x.get('cost_price'), 'px': x.get('nominal_price'),
                          'pl': (x.get('pl_ratio') or 0) / 100} for x in d.to_dict('records') if x.get('qty')]
        finally:
            t.close()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--every', type=int, default=0, help='seconds between snapshots')
    ap.add_argument('--positions', action='store_true')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=11111)
    ap.add_argument('--firm', default='FUTUSG', help='FUTUSG (moomoo SG), FUTUMY, FUTUINC (US)...')
    args = ap.parse_args()
    if 'SITE_PASSWORD' not in os.environ: sys.exit('Set SITE_PASSWORD first.')
    token = os.environ.get('GH_TOKEN') or subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True).stdout.strip()
    if not token: sys.exit('No GitHub token: set GH_TOKEN or log in with `gh auth login`.')
    vault = Vault(token)
    while True:
        try: snapshot(args, vault)
        except Exception as e: print('snapshot failed:', e)
        if args.once or not args.every: break
        time.sleep(max(30, args.every))


if __name__ == '__main__':
    main()
