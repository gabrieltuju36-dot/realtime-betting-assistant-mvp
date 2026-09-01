// providers/betway_fetcher.js
/**
 * Betway adapter: API mode (if available) or scraping fallback.
 *
 * WARNING / LEGAL: Scraping bookmaker websites may violate their terms of service and
 * could be legally risky depending on jurisdiction. Prefer official API or licensed data feeds.
 *
 * Usage:
 *   SERVER=http://localhost:3000 node providers/betway_fetcher.js
 *
 * Environment variables (optional):
 *   BETWAY_API_URL   - optional licensed feed URL
 *   BETWAY_API_KEY   - optional API key
 *   BETWAY_SCRAPE_URL- public Betway sports page, default to https://sports.betway.com
 *   POLL_MS          - polling interval (default 7000)
 */

const axios = require('axios');
const cheerio = require('cheerio');

const API_URL = process.env.BETWAY_API_URL;
const API_KEY = process.env.BETWAY_API_KEY;
const SCRAPE_URL = process.env.BETWAY_SCRAPE_URL || 'https://sports.betway.com/en/sports';
const SERVER = process.env.SERVER || 'http://localhost:3000';
const POLL_MS = parseInt(process.env.POLL_MS || '7000', 10);

function removeVig(probabilities) {
  const sum = probabilities.reduce((s, p) => s + p, 0);
  if (sum <= 0) return probabilities;
  return probabilities.map(p => p / sum);
}

async function fetchApi() {
  try {
    const resp = await axios.get(API_URL, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      timeout: 10000
    });
    return resp.data;
  } catch (err) {
    console.error('Betway API fetch error:', err.message || err);
    return null;
  }
}

async function fetchScrape() {
  try {
    const resp = await axios.get(SCRAPE_URL, { timeout: 10000 });
    return resp.data;
  } catch (err) {
    console.error('Betway scrape fetch error:', err.message || err);
    return null;
  }
}

function normalizeApiEvent(raw) {
  if (!raw) return null;
  const eventId = raw.id || `${raw.sport}_${raw.home}_${raw.away}`;
  const name = raw.home && raw.away ? `${raw.home} vs ${raw.away}` : raw.name || eventId;
  const market = (raw.markets || []).find(m => Array.isArray(m.outcomes) && m.outcomes.length >= 2);
  if (!market) return null;
  const outcomes = market.outcomes.map(o => ({ name: o.name, price: parseFloat(o.price || o.decimal) }));
  const implied = outcomes.map(o => 1 / o.price);
  const fair = removeVig(implied);
  const normalized = outcomes.map((o, i) => ({
    selectionId: `${eventId}_${o.name.replace(/\s+/g, '_')}`,
    selectionName: o.name,
    decimalOdds: parseFloat(o.price.toFixed(3)),
    modelProbability: parseFloat(fair[i].toFixed(4))
  }));
  return { eventId, name, markets: normalized };
}

function normalizeScrapedHtml(html) {
  const $ = cheerio.load(html);
  const events = [];

  // Heuristic: Betway uses complex SPA; server-side HTML may be minimal. This will work on pages
  // that render static odds. For JS-driven pages you need a headless browser (Puppeteer) which
  // may be slower and more resource intensive.
  $('.match, .event, .fixture').each((_, el) => {
    const container = $(el);
    const team1 = container.find('.team-home, .home').first().text().trim();
    const team2 = container.find('.team-away, .away').first().text().trim();
    if (!team1 || !team2) return;
    const eventId = `${team1}_${team2}`;
    const name = `${team1} vs ${team2}`;
    const odds = [];
    container.find('.odds, .price, .market-outcome').each((i, oel) => {
      const txt = $(oel).text().trim();
      const m = txt.match(/\d+(?:\.\d+)?/);
      if (m) odds.push(parseFloat(m[0]));
    });
    if (odds.length < 2) return;
    const outcomes = [ {name: team1, price: odds[0]}, {name: team2, price: odds[1]} ];
    const implied = outcomes.map(o => 1 / o.price);
    const fair = removeVig(implied);
    const normalized = outcomes.map((o, i) => ({
      selectionId: `${eventId}_${o.name.replace(/\s+/g, '_')}`,
      selectionName: o.name,
      decimalOdds: parseFloat(o.price.toFixed(3)),
      modelProbability: parseFloat(fair[i].toFixed(4))
    }));
    events.push({ eventId, name, markets: normalized });
  });

  return events;
}

async function forward(eventId, name, market) {
  try {
    await axios.post(`${SERVER}/odds`, { eventId, name, market }, { timeout: 5000 });
  } catch (err) {
    console.error('Failed forwarding to server:', err.message || err);
  }
}

(async function loop() {
  console.log('Starting Betway fetcher. API_MODE=', !!API_URL, 'SCRAPE_URL=', SCRAPE_URL);
  while (true) {
    if (API_URL) {
      const data = await fetchApi();
      if (Array.isArray(data)) {
        for (const raw of data) {
          const norm = normalizeApiEvent(raw);
          if (!norm) continue;
          for (const m of norm.markets) await forward(norm.eventId, norm.name, m);
        }
      }
    } else {
      const html = await fetchScrape();
      if (html) {
        const events = normalizeScrapedHtml(html);
        for (const ev of events) for (const m of ev.markets) await forward(ev.eventId, ev.name, m);
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
