# Realtime Betting Assistant MVP — Live Mode Guide

This repo contains a realtime betting assistant prototype. By default the app runs in demo/dry-run mode (safe). The following explains how to change the app from demo to live (real-account) operation. Read everything carefully — placing real bets has legal, financial, and compliance implications.

IMPORTANT SAFETY SUMMARY
- Do NOT enable live mode until you have completed: sandbox testing, secure credential storage, KYC, legal review, rate-limit handling, and monitoring.
- This guide assumes you will use Betfair for execution. BetPawa/Betway adapters can provide odds but placement goes through Betfair (or other exchange API you implement).

What the code enforces
- The server requires an explicit LIVE_MODE_TOKEN environment variable and that you call /enable_live with that token from the UI to enable live mode.
- The server also rejects enabling live mode unless BETFAIR_DRY_RUN is set to "false" (i.e., you explicitly opt-out of dry-run) and required env vars (like BETFAIR_APP_KEY) are present.
- Confirming a recommendation calls the placement adapter; the adapter itself should be configured with sandbox credentials first.

Steps to enable real account (recommended flow)
1. Obtain Betfair sandbox credentials
   - Register at https://developer.betfair.com
   - Create an app to obtain APP_KEY and OAuth client credentials
   - Get test/sandbox account credentials and verify you can call the sandbox placeOrders endpoint

2. Add secrets to your hosting environment (Replit / Heroku / VPS)
   - LIVE_MODE_TOKEN: a long random string you choose (not shared in chat)
   - BETFAIR_APP_KEY
   - BETFAIR_OAUTH_CLIENT_ID
   - BETFAIR_OAUTH_CLIENT_SECRET
   - BETFAIR_ENVIRONMENT=sandbox (or production when ready)
   - BETFAIR_DRY_RUN=false
   - (Optional) BETPAWA_API_URL / BETPAWA_API_KEY / BETWAY_API_URL / BETWAY_API_KEY

   Use the hosting provider's secrets manager (Replit Secrets, Heroku Config Vars) — do NOT commit these to git.

3. Update BetPawa/Betway adapters
   - If you have licensed feed endpoints, set BETPAWA_API_URL and BETWAY_API_URL and API keys so the adapters run in API mode instead of scraping.
   - If you only have website access, consider a licensed provider or a headless browser approach — scraping is fragile and may violate TOS.

4. Deploy and test in sandbox
   - Start the server and run the fetchers. Use the UI to view recommendations.
   - Keep BETFAIR_DRY_RUN=true while testing placement flows; confirm that confirm_bet returns simulated placement.
   - Test error handling, token expiry, rate limits, and reconnection logic.

5. Enable live mode (careful)
   - Set BETFAIR_DRY_RUN=false in your environment and ensure all Betfair credentials are present.
   - In the UI, enter the LIVE_MODE_TOKEN (the same string you set in the environment) and click "Enable Live Mode".
   - The server will validate the token, ensure DRY_RUN is disabled, and toggle live mode on. The UI will show a clear banner when live mode is active.

6. Final checks before placing real bets
   - Confirm KYC and legal approvals, deposit limits, and responsible gambling controls are in place.
   - Add audit logging: persist all recommendations, confirmations, and placement results to a database (Postgres recommended).
   - Monitor placements and set alerts for failed orders or unexpected balances.

If you want me to implement these next steps for you (I can push code changes to this repo):
- Implement Betfair OAuth complete flow (token caching and refresh). I will add code that uses OAUTH secrets from environment variables and refreshes tokens automatically.
- Add persistent audit logging (Postgres + Sequelize or a lightweight JSON log file) to ensure every confirmation and placement is recorded.
- Implement ID mapping: match BetPawa/Betway selection IDs to Betfair marketId/selectionId so user confirmations place on the correct market.
- Add more safety checks: per-user exposure limits, global exposure caps, and a kill-switch that can be invoked remotely to stop live placements.

Tell me which of the above you'd like me to implement next, and I will proceed and commit the changes to the repository.