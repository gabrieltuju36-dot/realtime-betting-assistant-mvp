# Realtime Betting Assistant MVP

This repository contains a mobile-friendly demo of a realtime betting assistant. It supports mock feed, TheOddsAPI, Betradar, BetPawa and Betway adapters (the latter two include optional scraping fallbacks).

Important: Scraping bookmaker websites is brittle and may violate their Terms of Service. Use official/licensed APIs or feed agreements for production.

Quick start (demo mock mode)
1. Import the repo into Replit (recommended for phone-only users) or run locally.
2. Start the server and mock feed: `node server.js & node mock_feed.js`.
3. Open the provided Replit URL or http://localhost:3000 on your phone (same LAN).

BetPawa / Betway adapters
- `providers/betpawa_fetcher.js` and `providers/betway_fetcher.js` try two modes:
  - API mode: if you set BETPAWA_API_URL / BETWAY_API_URL and API keys, the adapter will call those endpoints and forward normalized markets.
  - Scrape mode: if no API URL is set, the adapter will attempt to scrape public odds pages. This is fragile and not recommended for production.

Environment variables for these adapters (examples):
- SERVER=http://your-server:3000
- BETPAWA_API_URL=https://api.betpawa.example/odds
- BETPAWA_API_KEY=...
- BETPAWA_SCRAPE_URL=https://www.betpawa.com/en/sports
- BETWAY_API_URL=...
- BETWAY_API_KEY=...
- BETWAY_SCRAPE_URL=https://sports.betway.com/en/sports

Legal & safety
- Always use sandbox/test credentials when testing bet placement.
- Do not place real bets until you have implemented secure credential storage, auditing, and legal checks.
- Never commit API keys or certificates to the repository.

If you want, I can:
- Implement Betfair sandbox OAuth flow and map BetPawa/Betway market IDs to Betfair selectionIds (needed to place bets from confirmations).
- Replace HTML scraping with a Puppeteer-based headless browser fetcher for JS-driven bookmaker sites (more reliable but heavier).
- Add database-backed persistence and user accounts.

