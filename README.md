# Halal Terminal (stocks-tracker)

A private, Bloomberg-terminal-style market site for a Singapore-based Muslim investor. It covers Malaysia, Singapore, the US, global markets and commodities, and screens every stock for Shariah compliance.

Live: https://mikachufm2202.github.io/stocks-tracker/ (password protected; the data is AES-256-GCM encrypted with the password).

## How it works

```
GitHub Actions (scripts/build.py, 3 schedules)
  ├─ Yahoo Finance prices (2y daily) for ~1,300 stocks + indices/commodities/FX/rates
  ├─ Shariah status: SC Malaysia SAC list (PDF), SP Funds S&P Shariah ETF holdings, own AAOIFI-style screen
  ├─ indicators, trend score, statistical forecasts (historical base rates per score bucket), ideas, movers
  ├─ news (Google News RSS), calendar (Forex Factory), videos (YouTube RSS), podcasts (RSS)
  ├─ AI daily brief / weekly report via any OpenAI-compatible API (default: Gemini free tier), plus a number check
  ├─ encrypt everything with the site password → force-push to the orphan `market` branch
  └─ Web Push notifications (scripts/push.mjs)
Static site (index.html, app.js, learn.js) on GitHub Pages from main
  └─ derives the key from the password, reads raw.githubusercontent.com/<repo>/market/*
Personal state (watchlist, alerts, push subscriptions) → encrypted files on the `data` branch
```

| When (SGT) | Run | What |
|---|---|---|
| Mon–Sat 06:30 | `daily` | after the US close: data, daily brief, notifications |
| Mon–Fri 18:15 | `evening` | after the Asia close: data only |
| Sun 17:00 | `weekly` | universe and Shariah re-screen, full weekly report |

Branches: `main` holds the code (Pages). `market` is rebuilt and force-pushed every run, so encrypted blobs don't pile up. `data` holds user state. **Never reset `data`**: it has the watchlist and the sealed sync token.

## Setup (one time)

Repository secrets:
- `SITE_PASSWORD`: the site password.
- `LLM_API_KEY`: a free Gemini API key from https://aistudio.google.com/apikey (without it, reports are numbers-only). To use another provider (OpenRouter, Groq…), set the repository variables `LLM_BASE_URL` and `LLM_MODEL`.
- `VAPID_PRIVATE_KEY`: the Web Push private key. The public key is in `app.js` and `scripts/push.mjs`; regenerate both together if it's lost (`npx web-push generate-vapid-keys`).

On the site: **Settings → Sync** takes a fine-grained GitHub token (this repo only, Contents + Actions read/write). It's stored encrypted in `data/vault.bin`, so every device unlocks it with the password.

## Local commands

The Python virtualenv lives on the external SSD (`/Volumes/ExtSSD_MainStorage/EXT_Project_Pipeline/EXT_011_stocks-tracker/venv`).

```sh
PY=/Volumes/ExtSSD_MainStorage/EXT_Project_Pipeline/EXT_011_stocks-tracker/venv/bin/python
$PY scripts/test_build.py                                      # self-checks
SITE_PASSWORD=... OUT=/tmp/out LIMIT=15 $PY scripts/build.py daily   # quick local build
SITE_PASSWORD=... $PY local/moomoo_bridge.py --once            # moomoo snapshot (needs OpenD logged in)
```

To preview locally, serve a folder that has the site files plus `market/` (a build output) and open `http://localhost:8765/?data=http://localhost:8765/`.

### Local LLM (optional)

`OLLAMA_MODEL=<model> scripts/build.py daily` writes reports with a local Ollama model instead of the cloud API. Tested on 2026-10-21 with qwen2.5vl:7b: it invented index levels (S&P 500 "4,112" vs the real 7,713), so the cloud model is the default. The number check flags such figures either way. Any model downloads belong on the SSD under `EXT_011_stocks-tracker/`.

## Caveats

- Prices are delayed or end-of-day. For live intraday prices, use the TradingView button, moomoo, or the broker apps.
- A **P** status is a screen result, not a fatwa. The data feed can't see the non-halal income share.
- SC Malaysia's May 2026 list wasn't online as a PDF at build time. The Nov 2025 list is patched with the 6 changes reported by The Edge; the weekly run picks up the newest PDF automatically.
- GitHub disables scheduled workflows after 60 days without commits on a public repo. Any commit or a manual run keeps them alive.
