const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { kellyFraction, expectedValue } = require('./kelly');
const { placeOrderOnBetfair, getAuthToken, DRY_RUN } = require('./bookmakers/betfair_adapter');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});
app.use(bodyParser.json());
app.use(express.static('public'));

let bankroll = 1000.0; // demo starting bankroll
const minStake = 1.0;
const maxStakePercent = 0.05; // cap stake

const events = {}; // eventId -> {name, markets: {selectionId: market}}
const pendingRecommendations = {}; // recId -> recommendation

// Live mode guard - starts false. Must be enabled with the correct token.
let liveEnabled = false;

// Mappings file (sourceMarketId -> canonical + betfair ids)
const MAPPINGS_FILE = path.join(__dirname, 'mappings.json');
let mappings = [];

function loadMappings() {
  try {
    if (fs.existsSync(MAPPINGS_FILE)) {
      const raw = fs.readFileSync(MAPPINGS_FILE, 'utf8');
      mappings = JSON.parse(raw || '[]');
    } else {
      mappings = [];
    }
  } catch (err) {
    console.error('Failed to load mappings:', err.message);
    mappings = [];
  }
}

function saveMappings() {
  try {
    fs.writeFileSync(MAPPINGS_FILE, JSON.stringify(mappings, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to save mappings:', err.message);
    return false;
  }
}

loadMappings();

function findMappingForSource(source, sourceMarketId) {
  return mappings.find(m => m.source === source && m.sourceMarketId === sourceMarketId) || null;
}

function normalizeText(s) {
  if (!s) return '';
  return s.toString().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const as = new Set(normalizeText(a).split(' ').filter(Boolean));
  const bs = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (as.size === 0 || bs.size === 0) return 0;
  let inter = 0;
  for (const x of as) if (bs.has(x)) inter++;
  const uni = new Set([...as, ...bs]).size;
  return inter / uni;
}

function recommendBet(eventId, market) {
  const b = market.decimalOdds - 1;
  const p = market.modelProbability;
  const f = kellyFraction(p, b);
  const stake = Math.max(minStake, Math.min(bankroll * Math.min(f, maxStakePercent), bankroll));
  const ev = expectedValue(p, market.decimalOdds);
  const recId = `${eventId}_${market.selectionId}_${Date.now()}`;
  const rec = {
    recId,
    eventId,
    selectionId: market.selectionId,
    selectionName: market.selectionName,
    decimalOdds: market.decimalOdds,
    modelProbability: p,
    kellyFraction: f,
    stake: parseFloat(stake.toFixed(2)),
    ev: parseFloat(ev.toFixed(4)),
    status: 'pending',
    createdAt: new Date().toISOString(),
    // include source info for mapping
    source: market.source || 'unknown',
    sourceMarketId: market.sourceMarketId || market.selectionId
  };
  pendingRecommendations[recId] = rec;
  return rec;
}

io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  socket.emit('initial_state', { events, bankroll, pending: Object.values(pendingRecommendations), liveEnabled });

  socket.on('place_bet', (data) => {
    // no-op (legacy)
    console.log('socket place_bet', data);
  });
});

// Accept new odds updates from ingestion adapters
app.post('/odds', (req, res) => {
  const { eventId, name, market } = req.body;
  if (!eventId || !market) return res.status(400).send('missing eventId/market');
  events[eventId] = events[eventId] || { name, markets: {} };
  events[eventId].markets[market.selectionId] = market;

  const rec = recommendBet(eventId, market);
  // Broadcast the odds update + recommendation
  io.emit('odds_update', { eventId, market, recommendation: rec });
  res.json({ status: 'ok', recommendation: rec });
});

// Endpoint for client to list pending recommendations
app.get('/recommendations', (req, res) => {
  res.json({ recommendations: Object.values(pendingRecommendations) });
});

// Suggest mapping endpoint - returns candidate mappings based on fuzzy matching
app.post('/suggest_mapping', (req, res) => {
  const { source, sourceMarketId, selectionName, eventName } = req.body || {};
  if (!selectionName && !eventName) return res.status(400).json({ status: 'error', error: 'selectionName or eventName required' });

  // Score existing mappings against the provided names
  const suggestions = mappings.map(m => {
    const scoreSel = jaccardSimilarity(selectionName, m.canonicalSelectionId || '');
    const scoreEvent = jaccardSimilarity(eventName, m.canonicalEventId || '');
    const score = Math.max(scoreSel, scoreEvent);
    return { mapping: m, score, scoreSel, scoreEvent };
  }).filter(s => s.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 20);

  // Also try to find similar entries from already-mapped pending recommendations
  const mappedFromPending = Object.values(pendingRecommendations)
    .map(rec => ({ rec, map: findMappingForSource(rec.source, rec.sourceMarketId) }))
    .filter(x => x.map)
    .map(x => {
      const m = x.map;
      const scoreSel = jaccardSimilarity(selectionName, m.canonicalSelectionId || '');
      const scoreEvent = jaccardSimilarity(eventName, m.canonicalEventId || '');
      const score = Math.max(scoreSel, scoreEvent);
      return { mapping: m, sourceRec: x.rec, score, scoreSel, scoreEvent };
    }).filter(s => s.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0,20);

  // Merge suggestions, preferring higher score and uniqueness by betfairMarketId + betfairSelectionId
  const seen = new Set();
  const merged = [];
  for (const s of [...suggestions, ...mappedFromPending]) {
    const key = `${s.mapping.betfairMarketId}::${s.mapping.betfairSelectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }

  res.json({ suggestions: merged });
});

// Mappings endpoints
app.get('/mappings', (req, res) => {
  res.json({ mappings });
});

app.post('/mappings', (req, res) => {
  const m = req.body;
  // required fields: source, sourceMarketId, canonicalEventId, canonicalSelectionId, betfairMarketId, betfairSelectionId
  const required = ['source','sourceMarketId','canonicalEventId','canonicalSelectionId','betfairMarketId','betfairSelectionId'];
  const missing = required.filter(k => !m[k]);
  if (missing.length) return res.status(400).json({ status:'error', error: `missing fields: ${missing.join(',')}` });
  // prevent duplicates
  const existing = mappings.find(x => x.source===m.source && x.sourceMarketId===m.sourceMarketId);
  if (existing) return res.status(409).json({ status:'error', error: 'mapping exists', mapping: existing });
  const newMap = {
    source: m.source,
    sourceMarketId: m.sourceMarketId,
    canonicalEventId: m.canonicalEventId,
    canonicalSelectionId: m.canonicalSelectionId,
    betfairMarketId: m.betfairMarketId,
    betfairSelectionId: m.betfairSelectionId,
    mappedAt: new Date().toISOString(),
    metadata: m.metadata || {}
  };
  mappings.push(newMap);
  if (!saveMappings()) return res.status(500).json({ status:'error', error:'failed to persist mapping' });
  io.emit('mapping_added', newMap);
  res.json({ status:'ok', mapping: newMap });
});

// Return unmapped pending recommendations (for admin UI)
app.get('/unmapped', (req, res) => {
  const unmapped = Object.values(pendingRecommendations).filter(rec => {
    const map = findMappingForSource(rec.source, rec.sourceMarketId);
    return !map;
  }).slice(-200);
  res.json({ unmapped });
});

// Endpoint to enable live mode. Requires a token stored in env LIVE_MODE_TOKEN and DRY_RUN=false.
app.post('/enable_live', (req, res) => {
  const { token } = req.body || {};
  const envToken = process.env.LIVE_MODE_TOKEN;

  if (!envToken) return res.status(400).json({ status: 'error', error: 'LIVE_MODE_TOKEN not set on server' });
  if (!token) return res.status(400).json({ status: 'error', error: 'token required' });
  if (token !== envToken) return res.status(403).json({ status: 'error', error: 'invalid token' });

  // Additional safety checks: ensure that Betfair adapter is configured and DRY_RUN is explicitly false
  const betfairDry = (process.env.BETFAIR_DRY_RUN || 'true') === 'true';
  if (betfairDry) return res.status(400).json({ status: 'error', error: 'BETFAIR_DRY_RUN must be set to false to enable live mode' });

  // Basic credential checks (presence only) - real authentication performed during placement
  const required = ['BETFAIR_APP_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) return res.status(400).json({ status: 'error', error: `missing environment vars: ${missing.join(', ')}` });

  liveEnabled = true;
  io.emit('live_mode', { liveEnabled });
  console.log('Live mode enabled');
  res.json({ status: 'ok', liveEnabled });
});

// Client confirms a bet; server places it (dry-run by default). Only proceeds with real placement if liveEnabled is true.
app.post('/confirm_bet', async (req, res) => {
  // body: { recId, userId, bookmaker: 'betfair', marketId: <betfair_market_id?> }
  const { recId, userId, bookmaker, marketId } = req.body;
  if (!recId) return res.status(400).send('recId required');
  const rec = pendingRecommendations[recId];
  if (!rec) return res.status(404).send('recommendation not found');

  // Lock / mark as 'placing'
  rec.status = 'placing';
  io.emit('recommendation_update', rec);

  try {
    let placeResult;
    if (bookmaker === 'betfair') {
      // Try to find a mapping for this source -> betfair ids
      const map = findMappingForSource(rec.source, rec.sourceMarketId);
      let useMarketId = marketId || rec.eventId;
      let useSelectionId = rec.selectionId;
      if (map) {
        useMarketId = map.betfairMarketId;
        useSelectionId = map.betfairSelectionId;
      }

      if (!liveEnabled) {
        // If live is not enabled, use existing DRY_RUN behavior from adapter
        placeResult = await placeOrderOnBetfair(useMarketId, useSelectionId, rec.stake, rec.decimalOdds);
      } else {
        // liveEnabled==true and BETFAIR_DRY_RUN should be false per /enable_live checks
        placeResult = await placeOrderOnBetfair(useMarketId, useSelectionId, rec.stake, rec.decimalOdds);
      }
    } else {
      placeResult = { simulated: true, status: 'UNSUPPORTED_BOOKMAKER' };
    }

    // On successful placement simulation/response, update rec & bankroll
    rec.status = 'placed';
    rec.placedAt = new Date().toISOString();
    rec.placeResult = placeResult;

    // update bankroll for demo (debit stake)
    bankroll = Math.max(0, bankroll - rec.stake);

    // broadcast updates
    io.emit('bankroll_update', { bankroll });
    io.emit('recommendation_update', rec);

    res.json({ status: 'ok', rec, bankroll });
  } catch (err) {
    rec.status = 'error';
    rec.error = err.message || String(err);
    io.emit('recommendation_update', rec);
    res.status(500).json({ status: 'error', error: rec.error });
  }
});

app.get('/bankroll', (req, res) => res.json({ bankroll }));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // bind to all interfaces so phone can reach it
server.listen(PORT, HOST, () => console.log(`Server listening on ${HOST}:${PORT}`));
