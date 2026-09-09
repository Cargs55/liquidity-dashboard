# Global Liquidity Dashboard

Single source of truth for global liquidity — one dial, the push/pull behind it, and a drill-down for 15 markets.
Live: https://liquidity-dashboard-davids-projects-fccd7766.vercel.app

## How it works
- `index.html` — the page (vanilla HTML/CSS/JS, no build step). Plain-English and Expert views.
- `api/data.js` — Vercel serverless function. Fetches every series live from primary sources (NY Fed, US Treasury FiscalData,
  OFR, ECB Data Portal, BIS, CBOE, RBA; FRED when `FRED_API_KEY` is set), computes z-scores, the weighted composite
  (plumbing 35 / credit 25 / balance sheets 20 / money 10 / vol & dollar 10), regional readings and rule-based commentary.
  Edge-cached 6 hours (`s-maxage=21600`). Nothing is hard-coded; failed feeds are reported and dropped with weights re-normalised.
- `vercel.json` — function timeout (60s) and the cron (`0 */6 * * *` → `/api/data`) that keeps the cache warm.

## Deploy
Push to `main` on a Vercel-linked project, or drag the folder onto https://vercel.com/new. Set `FRED_API_KEY`
(free: https://fredaccount.stlouisfed.org/apikeys) in Project → Settings → Environment Variables to enable reserves/GDP,
ICE BofA credit spreads, Fed/BoJ balance-sheet history and the M2 aggregates.

## Check
`/api/data?fresh=1` bypasses the cache; `dataHealth.series` lists every feed and its status; `composite.liveWeight` is the
share of intended weight that is live.

Built 8 September 2026 for David Cargill. Information tool, not investment advice.
