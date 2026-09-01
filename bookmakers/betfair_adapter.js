/**
 * Betfair adapter with OAuth token handling (client_credentials fallback) and order placement.
 *
 * Usage:
 *  - Provide either:
 *     a) BETFAIR_OAUTH_CLIENT_ID and BETFAIR_OAUTH_CLIENT_SECRET (client credentials). The adapter will request and cache access tokens.
 *     b) Or pre-populate BETFAIR_AUTH_TOKEN with a valid access token (useful if you obtain it elsewhere).
 *  - Set BETFAIR_APP_KEY (application key from Betfair) in env.
 *  - For testing keep BETFAIR_DRY_RUN=true (default) to avoid placing real bets.
 *
 * Notes:
 *  - Betfair's production and sandbox authentication requirements may differ. If client_credentials grant is not supported for your app,
 *    you will need to perform the Authorization Code flow externally to obtain a long-lived refresh/access token and set BETFAIR_AUTH_TOKEN.
 *  - Never put client secrets or tokens into public code or chat. Use your host's secret manager (Replit Secrets, Heroku Config Vars, etc.).
 */

const axios = require('axios');

const APP_KEY = process.env.BETFAIR_APP_KEY;
const OAUTH_CLIENT_ID = process.env.BETFAIR_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.BETFAIR_OAUTH_CLIENT_SECRET;
const PRESET_TOKEN = process.env.BETFAIR_AUTH_TOKEN; // optional pre-provided token
const ENV = process.env.BETFAIR_ENVIRONMENT || 'sandbox';
const DRY_RUN = (process.env.BETFAIR_DRY_RUN || 'true') === 'true';

// Token cache
let tokenCache = { token: PRESET_TOKEN || null, expiresAt: 0 };

// Betfair token endpoint - sandbox and production use same identity host but check docs
const TOKEN_URL = 'https://identitysso.betfair.com/api/oauth2/token';
const API_BASE = 'https://api.betfair.com/exchange/betting/rest/v1.0';

async function requestClientCredentialsToken() {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw new Error('OAuth client id/secret not set in environment. Set BETFAIR_OAUTH_CLIENT_ID and BETFAIR_OAUTH_CLIENT_SECRET.');
  }

  const auth = Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
  try {
    const resp = await axios.post(TOKEN_URL, 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });
    if (resp.data && resp.data.access_token) {
      const expiresIn = parseInt(resp.data.expires_in || '3600', 10);
      tokenCache.token = resp.data.access_token;
      tokenCache.expiresAt = Date.now() + (expiresIn * 1000);
      return tokenCache.token;
    }
    throw new Error('token response missing access_token');
  } catch (err) {
    const msg = err.response && err.response.data ? JSON.stringify(err.response.data) : (err.message || String(err));
    throw new Error('Failed to obtain token via client_credentials: ' + msg);
  }
}

async function getAuthToken() {
  // Return preset token if available and not expired (we can't check expiry for preset); prefer preset
  if (PRESET_TOKEN) return PRESET_TOKEN;

  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;

  // Try client credentials flow
  try {
    const t = await requestClientCredentialsToken();
    return t;
  } catch (err) {
    throw err; // bubble up - caller should handle
  }
}

async function placeOrderOnBetfair(marketId, selectionId, stake, price) {
  if (DRY_RUN) {
    return {
      simulated: true,
      status: 'SUCCESS (DRY_RUN)',
      marketId,
      selectionId,
      stake,
      price,
      betId: `SIM-${Date.now()}`
    };
  }

  if (!APP_KEY) throw new Error('BETFAIR_APP_KEY not set in environment');

  const token = await getAuthToken();

  const payload = {
    marketId,
    instructions: [
      {
        selectionId: parseInt(selectionId, 10),
        orderType: 'LIMIT',
        side: 'BACK',
        limitOrder: {
          size: parseFloat(stake),
          price: parseFloat(price),
          persistenceType: 'LAPSE'
        }
      }
    ],
    customerRef: `tuju.app-${Date.now()}`
  };

  try {
    const resp = await axios.post(`${API_BASE}/placeOrders/`, payload, {
      headers: {
        'X-Application': APP_KEY,
        'X-Authentication': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return resp.data;
  } catch (err) {
    const details = err.response && err.response.data ? JSON.stringify(err.response.data) : (err.message || String(err));
    throw new Error('placeOrder failed: ' + details);
  }
}

module.exports = { getAuthToken, placeOrderOnBetfair, DRY_RUN };
