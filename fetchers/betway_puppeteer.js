// fetchers/betway_puppeteer.js (updated: include sourceMarketId)
const puppeteer = require('puppeteer');
const axios = require('axios');

const SERVER = process.env.SERVER || 'http://localhost:3000';
const SCRAPE_URL = process.env.BETWAY_SCRAPE_URL || 'https://sports.betway.com/en/sports';
const POLL_MS = parseInt(process.env.POLL_MS || '7000', 10);
const VIEWPORT = { width: 1200, height: 900 };

function removeVig(probabilities) {
  const sum = probabilities.reduce((s, p) => s + p, 0);
  return probabilities.map(p => p / sum);
}

async function scrapeOnce(browser) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  try {
    await page.goto(SCRAPE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Try to extract odds from visible DOM; Betway may render via JS so selectors may vary.
    const events = await page.$$eval('.event, .fixture, .match, .matches__item', cards => {
      return cards.map(c => {
        const el = c;
        const home = (el.querySelector('.team-home, .home, .team-left') || {}).innerText || '';
        const away = (el.querySelector('.team-away, .away, .team-right') || {}).innerText || '';
        const oddsEls = el.querySelectorAll('.odds, .price, .outcome, .selection-price');
        const odds = Array.from(oddsEls).map(o => {
          const txt = (o.innerText||'').trim();
          const m = txt.match(/\d+(?:\.\d+)?/);
          return m ? parseFloat(m[0]) : null;
        }).filter(x => x);
        return { home, away, odds: odds.slice(0,2) };
      }).filter(e => e.home && e.away && e.odds && e.odds.length>=2);
    });

    for (const ev of events) {
      const implied = ev.odds.map(o => 1 / o);
      const fair = removeVig(implied);
      for (let i = 0; i < 2; ++i) {
        const selId = `${ev.home.replace(/\s+/g,'_')}_${ev.away.replace(/\s+/g,'_')}_sel${i}`;
        const market = {
          selectionId: selId,
          selectionName: i===0?ev.home:ev.away,
          decimalOdds: parseFloat(ev.odds[i].toFixed(3)),
          modelProbability: parseFloat(fair[i].toFixed(4)),
          source: 'betway',
          sourceMarketId: selId
        };
        try {
          await axios.post(`${SERVER}/odds`, { eventId: `${ev.home.replace(/\s+/g,'_')}_vs_${ev.away.replace(/\s+/g,'_')}`, name: `${ev.home} vs ${ev.away}`, market }, { timeout: 5000 });
        } catch (err) {
          console.error('POST /odds failed', err.message);
        }
      }
    }

    await page.close();
  } catch (err) {
    console.error('Betway scrape error', err.message);
    try { await page.close(); } catch(e){}
  }
}

(async () => {
  console.log('Starting Betway Puppeteer fetcher. SCRAPE_URL=', SCRAPE_URL);
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  while (true) {
    try {
      await scrapeOnce(browser);
    } catch (err) {
      console.error('Loop error', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
