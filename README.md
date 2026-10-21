# AMA Stock Screener

A private, Bloomberg-terminal-style market site for a Singapore-based Muslim family. It covers Malaysia, Singapore, the US, global markets and commodities, and screens every stock for Shariah compliance. It also has family profiles, paper trading, notes, a watch-later list, and push notifications.

Live: https://mikachufm2202.github.io/ama-stock-screener/ (family password; all data is AES-256-GCM encrypted with it).

## How it works

```
GitHub Actions
  market.yml (3 schedules) → scripts/build.py daily|evening|weekly
    ├─ Yahoo prices (2y daily) for ~1,650 stocks + indices/commodities/FX/rates
    ├─ Shariah status: SC Malaysia SAC list (PDF), SP Funds S&P Shariah ETF holdings, own AAOIFI-style screen
    ├─ indicators, trend score, statistical forecasts, ideas, movers, FX table
    ├─ news, economic calendar, videos, podcasts
    ├─ AI daily brief / weekly report (Gemini free tier via LLM_API_KEY) + number check + data appendix
    └─ encrypt → force-push orphan `market` branch; per-profile push notifications
  live.yml (every ~10 min) → scripts/build.py live
    └─ quotes for macro + ideas + every family watchlist/paper position, FX, breaking news → orphan `live` branch;
       price alerts, big moves, triggered paper orders, optional breaking-news pushes
Static site on GitHub Pages (index.html, app.js, paper.js, learn.js)
  └─ derives the key from the password, reads market/ live/ data/ branches; optional Cloudflare Worker for 1-min quotes
Family data on the `data` branch (encrypted): profiles.bin, p/<id>.bin (watchlist, notes, journal, paper trades,
watch-later, prefs, push subscriptions), vault.bin (GitHub token + Worker settings), moomoo.bin
```

| When (SGT) | Job | What |
|---|---|---|
| every ~10 min | `live` | quotes, FX, breaking news, alerts |
| Mon–Sat 06:30 | `market daily` | after the US close: full data, daily brief, notifications |
| Mon–Fri 18:15 | `market evening` | after the Asia close: full data |
| Sun 17:00 | `market weekly` | universe and Shariah re-screen, full weekly report |

**Never reset the `data` branch**: it holds the family's profiles, paper trades and the sealed sync token. `market` and `live` are rebuilt and force-pushed every run.

## Setup

Repository secrets:
- `SITE_PASSWORD`: the family password. To change it, use `local/rotate_password.py` (it re-encrypts everything).
- `VAPID_PRIVATE_KEY`: the Web Push private key. The public key is in `app.js` and `scripts/push.mjs`.
- `LLM_API_KEY`: a free Gemini key (https://aistudio.google.com/apikey). Without it, reports are numbers-only. For another OpenAI-compatible provider, set the repository variables `LLM_BASE_URL` and `LLM_MODEL`.

On the site, **Settings → Family** takes a fine-grained GitHub token (this repo only; Contents and Actions read/write) once for the whole family. It's stored encrypted in `data/vault.bin`.

### Optional: Cloudflare Worker for 1-minute prices

```sh
cd worker
npx wrangler login                 # use the approved Cloudflare account
npx wrangler secret put KEY        # any long random string
npx wrangler deploy
```
Paste the Worker URL and key in **Settings → Family → Live prices**. See Learn → Hosting for the GitHub vs Cloudflare comparison.

## Local commands

The Python virtualenv lives on the external SSD:

```sh
PY=/Volumes/ExtSSD_MainStorage/EXT_Project_Pipeline/EXT_011_ama-stock-screener/venv/bin/python
$PY scripts/test_build.py && node paper.test.mjs                        # self-checks
SITE_PASSWORD=... OUT=/tmp/out LIMIT=15 $PY scripts/build.py daily      # quick local build
SITE_PASSWORD=... $PY local/moomoo_bridge.py --once                     # moomoo snapshot (needs OpenD logged in)
OLD_PASSWORD=... NEW_PASSWORD=... $PY local/rotate_password.py --dry-run # change the family password (drop --dry-run to apply)
```

To preview locally, serve a folder with the site files plus `market/`, `live/` and `data/` directories, then open `http://localhost:8766/?data=http://localhost:8766/`.

`OLLAMA_MODEL=<model>` makes `build.py` write reports with a local Ollama model. On 2026-10-21, qwen2.5vl:7b invented index levels, so the cloud model is the default. Model downloads belong on the SSD under `EXT_011_ama-stock-screener/`.

## Caveats

- Bursa/SGX prices lag about 15 minutes. GitHub's 10-minute schedule can slip by a few minutes; the Worker gives true 1-minute updates.
- A **P** status is a screen result, not a fatwa. Check Zoya/Musaffa for the revenue breakdown.
- Profile PINs stop casual switching; they are not separate encryption. Everyone with the family password can read all profiles.
- The repo is public (free Pages), so the encrypted files can be downloaded and guessed at offline. Use a long family passphrase.
- GitHub disables scheduled workflows after 60 days without repository activity. The live job's pushes don't count; any commit or manual run does.
