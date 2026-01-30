# Roblox Inventory Checker (Aged Items + Discord)

Uses the same base as the original script: Selenium (Rolimons), Nexus API (Discord lookup), and a Discord webhook. This version is an **inventory checker** that finds users who have **aged Roblox items** (Limited/Limited U with RAP ≥ threshold) and **Discord connected**, then sends matches to your webhook.

## What it does

1. **Gets users** from Rolimons Trade Ads (same source as the base script).
2. **Scrapes Rolimons profile** for value and avatar; skips if value is below `MIN_ROLIMONS_VALUE`.
3. **Fetches Roblox inventory** (collectibles) and keeps only **aged items**: Limited/Limited U with RAP ≥ `AGED_RAP_MIN`. If `ROBLOX_API_KEY` is set, items must also have been **held by the user for `AGED_HELD_YEARS`+ years** (uses Roblox Cloud API v2).
4. If the user has at least one aged item, **looks up Discord** via Nexus API and **sends to webhook** (Discord + Roblox username, Rolimons value, top aged items).

## Setup

```bash
cd roblox-inventory-checker
npm install
```

Optional env (or edit defaults in `index.js`):

- `WEBHOOK_URL` – Discord webhook URL
- `NEXUS_ADMIN_KEY` – Nexus API admin key
- `AGED_RAP_MIN` – Min RAP for an item to count as “aged” (default: 100000)
- `AGED_HELD_YEARS` – Min years the user must have held the item (default: 3). Requires `ROBLOX_API_KEY`.
- `ROBLOX_API_KEY` – Roblox Open Cloud API key (optional). When set, only items held ≥ `AGED_HELD_YEARS` years count as aged.
- `AGED_INVENTORY_PERCENT_MIN` – When using 3yr filter: require at least this % of qualifying inventory (limited, RAP ≥ threshold) to be held 3+ years (default: 50). 0 = any one item ok.
- `MIN_ROLIMONS_VALUE` – Min Rolimons value to consider a user (default: 100000)
- `MIN_TRADE_ADS` / `MAX_TRADE_ADS` – Rolimons trade ads range (default: 0–500)
- `PORT` – Healthcheck server port (default: 3000)

## Run

```bash
npm start
```

Healthcheck: `GET http://localhost:3000/`

## Deploy on Railway

1. Push this folder to a GitHub repo (or connect your repo in Railway).
2. In [Railway](https://railway.app): **New Project** → **Deploy from GitHub repo** (or **Empty Project** then add a **GitHub Repo** / **Dockerfile**).
3. Railway detects the **Dockerfile** and builds an image with Node, Chrome, and ChromeDriver (Chrome for Testing). No extra config needed.
4. Set **variables** in the Railway dashboard: `NEXUS_ADMIN_KEY` (required); `WEBHOOK_URL`, `AGED_RAP_MIN`, `MIN_ROLIMONS_VALUE` (optional).
5. Deploy. The app listens on `PORT`. Use **Settings → Generate Domain** for a public URL; `GET /` is the healthcheck.

The app uses `CHROME_BIN` and `CHROMEDRIVER_PATH` when set so Selenium runs correctly in the container.

## Requirements (local)

- Node.js
- Chrome (for Selenium) or run via Docker
- For Docker/Railway: Chrome and ChromeDriver are installed in the image’s 