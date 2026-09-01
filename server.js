const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { kellyFraction, expectedValue } = require('./kelly');
const { placeOrderOnBetfair, getAuthToken, DRY_RUN } = require('./bookmakers/betfair_adapter');

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
    createdAt: new Date().toISOString()
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
      if (!liveEnabled) {
        // If live is not enabled, use existing DRY_RUN behavior from adapter
        placeResult = await placeOrderOnBetfair(marketId || rec.eventId, rec.selectionId, rec.stake, rec.decimalOdds);
      } else {
        // liveEnabled==true and BETFAIR_DRY_RUN should be false per /enable_live checks
        placeResult = await placeOrderOnBetfair(marketId || rec.eventId, rec.selectionId, rec.stake, rec.decimalOdds);
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
