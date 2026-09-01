// providers/betpawa_fetcher.js
/**
 * BetPawa adapter: tries to fetch odds from BetPawa.
 *
 * IMPORTANT:
 * - BetPawa does not provide a public REST API for odds in many regions. The safe/legal
 *   approach is to request official data access from BetPawa or use licensed odds providers.
 * - This file implements two modes:
 *    1) API mode: if BETPAWA_API_URL and BETPAWA_API_KEY are provided (licensed feed), it will call that.
 *    2) Scrape mode: if no API is provided, it will attempt to scrape the public website HTML.
 *       Scraping can break at any time and may violate BetPawa terms of service. Use at your own risk.
 *
 * Usage (Replit / local):
 *   SERVER=http://localhost:3000 node providers/betpawa_fetcher.js
 *
 * Environment variables (optional):
 *   BETPAWA_API_URL    - URL to a licensed BetPawa feed (preferred)
 *   BETPAWA_API_KEY    - API key for licensed feed
 *   BETPAWA_SCRAPE_URL - public odds page to scrape (e.g. https://www.betpawa.*/sports)
 *   POLL_MS            - polling interval in ms (default 7000)
 *   SERVER             - your assistant server to forward normalized /odds POSTs
 */

const axios = require('axios');
const cheerio = require('cheerio');

const API_URL = process.env.BETPAWA_API_URL;
const API_KEY = process.env.BETPAWA_API_KEY;
const SCRAPE_URL = process.env.BETPAWA_SCRAPE_URL || 'https://www.betpawa.com/en/sports';
const SERVER = process.env.SERVER || 'http://localhost:3000';
const POLL_MS = parseInt(process.env.POLL_MS || '7000', 10);

function removeVig(probabilities) {
  const sum = probabilities.reduce((s, p) => s + p, 0);
  if (sum <= 0) return probabilities;
  return probabilities.map(p => p / sum);
}

async function fetchApiFeed() {
  try {
    const resp = await axios.get(API_URL, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      timeout: 10000
    });
    return resp.data;
  } catch (err) {
    console.error('BetPawa API fetch error:', err.message || err);
    return null;
  }
}

async function fetchScrapeFeed() {
  try {
    const resp = await axios.get(SCRAPE_URL, { timeout: 10000 });
    return resp.data;
  } catch (err) {
    console.error('BetPawa scrape fetch error:', err.message || err);
    return null;
  }
}

function normalizeApiEvent(raw) {
  // Adapt this to the exact feed you receive from a licensed API
  // Common fields: id, homeTeam, awayTeam, markets: [{type, outcomes: [{name, price}]}]
  if (!raw) return null;
  const eventId = raw.id || `${raw.sport || 'sport'}_${raw.home}_${raw.away}`;
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
  // This is a heuristic parser that tries to find simple moneyline odds on the BetPawa sports page.
  // BetPawa site structure varies by country/region; update selectors for your locale.
  const $ = cheerio.load(html);
  const events = [];

  // Example heuristic: find event list items
  $('.event, .fixture, .match').each((_, el) => {
    const container = $(el);
    const teams = [];
    // try common selectors for team names
    const t1 = container.find('.team-home, .home-name, .team-left').first().text().trim();
    const t2 = container.find('.team-away, .away-name, .team-right').first().text().trim();
    if (t1) teams.push(t1);
    if (t2) teams.push(t2);
    if (teams.length < 2) return;
    const eventId = teams.join('_');
    const name = `${teams[0]} vs ${teams[1]}`;

    // find odds - heuristic
    const odds = [];
    container.find('.odds, .price, .outcome').each((i, oel) => {
      const txt = $(oel).text().trim();
      const m = txt.match(/\d+(?:\.\d+)?/);
      if (m) odds.push(parseFloat(m[0]));
    });
    if (odds.length < 2) return;
    const outcomes = [
      { name: teams[0], price: odds[0] },
      { name: teams[1], price: odds[1] }
    ];
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

async function forwardToServer(eventId, name, market) {
  try {
    await axios.post(`${SERVER}/odds`, { eventId, name, market }, { timeout: 5000 });
  } catch (err) {
    console.error('Forward to server failed:', err.message || err);
  }
}

(async function loop() {
  console.log('Starting BetPawa fetcher. API_URL=', !!API_URL, 'SCRAPE_URL=', SCRAPE_URL);
  while (true) {
    if (API_URL) {
      const data = await fetchApiFeed();
      if (Array.isArray(data)) {
        for (const raw of data) {
          const norm = normalizeApiEvent(raw);
          if (!norm) continue;
          for (const m of norm.markets) await forwardToServer(norm.eventId, norm.name, m);
        }
      }
    } else {
      const html = await fetchScrapeFeed();
      if (html) {
        const events = normalizeScrapedHtml(html);
        for (const ev of events) {
          for (const m of ev.markets) await forwardToServer(ev.eventId, ev.name, m);
        }
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
