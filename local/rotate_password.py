#!/usr/bin/env python3
"""Changes the family password: re-encrypts every file on the market, data and live branches with a new key,
then updates the SITE_PASSWORD secret. Workflows are paused meanwhile so nothing writes with the old key.

  OLD_PASSWORD=... NEW_PASSWORD=... python local/rotate_password.py [--dry-run]

Afterwards every device asks for the new password once (the old remembered key no longer matches).
"""
import base64, gzip, json, os, subprocess, sys, tempfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

REPO = os.environ.get('REPO', 'MikachuFM2202/ama-stock-screener')
GIT = '/Library/Developer/CommandLineTools/usr/bin/git' if Path('/Library/Developer/CommandLineTools/usr/bin/git').exists() else 'git'
DRY = '--dry-run' in sys.argv


def key(pw, salt, it): return AESGCM(PBKDF2HMAC(hashes.SHA256(), 32, salt, it).derive(pw.encode()))


def run(*a, cwd=None): subprocess.run(a, cwd=cwd, check=True)


def main():
    old, new = os.environ.get('OLD_PASSWORD'), os.environ.get('NEW_PASSWORD')
    if not old or not new: sys.exit('Set OLD_PASSWORD and NEW_PASSWORD.')
    if len(new) < 12: sys.exit('Use a passphrase of at least 12 characters (4+ random words is best).')
    tmp = Path(tempfile.mkdtemp())
    url = f'https://github.com/{REPO}.git'
    heads = subprocess.run([GIT, 'ls-remote', '--heads', url], capture_output=True, text=True, check=True).stdout
    branches = [b for b in ('market', 'data', 'live') if f'refs/heads/{b}' in heads]
    for b in branches:
        run(GIT, 'clone', '-q', '--depth', '1', '-b', b, url, str(tmp / b))
    meta = json.loads((tmp / 'market' / 'meta.json').read_text())
    k_old = key(old, base64.b64decode(meta['salt']), meta['iter'])
    salt = os.urandom(16)
    k_new = key(new, salt, meta['iter'])
    n = 0
    for b in branches:
        for f in (tmp / b).rglob('*.bin'):
            raw = f.read_bytes()
            try: plain = k_old.decrypt(raw[:12], raw[12:], None)
            except Exception: sys.exit(f'{b}/{f.relative_to(tmp / b)} does not decrypt with OLD_PASSWORD: nothing was changed.')
            iv = os.urandom(12)
            f.write_bytes(iv + k_new.encrypt(iv, plain, None)); n += 1
            if DRY: json.loads(gzip.decompress(k_new.decrypt(iv, f.read_bytes()[12:], None)))
    meta['salt'] = base64.b64encode(salt).decode()
    (tmp / 'market' / 'meta.json').write_text(json.dumps(meta))
    print(f're-encrypted {n} files')
    if DRY: return print('dry run: nothing pushed, secret unchanged')
    run('gh', 'workflow', 'disable', 'market.yml', '-R', REPO); run('gh', 'workflow', 'disable', 'live.yml', '-R', REPO)
    try:
        for b in branches:
            run(GIT, 'add', '-A', cwd=tmp / b)
            run(GIT, '-c', 'user.name=rotate', '-c', 'user.email=rotate@users.noreply.github.com', 'commit', '-qm', f'{b}: rotate family password', cwd=tmp / b)
            run(GIT, 'push', '-q', *(['-f'] if b != 'data' else []), 'origin', b, cwd=tmp / b)
        subprocess.run(['gh', 'secret', 'set', 'SITE_PASSWORD', '-R', REPO], input=new.encode(), check=True)
    finally:
        run('gh', 'workflow', 'enable', 'market.yml', '-R', REPO); run('gh', 'workflow', 'enable', 'live.yml', '-R', REPO)
    print('done: tell the family the new password')


if __name__ == '__main__':
    main()
