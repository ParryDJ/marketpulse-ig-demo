
import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const KEY = process.env.IG_API_KEY || '';
const USER = process.env.IG_USERNAME || '';
const PASS = process.env.IG_PASSWORD || '';

const TYPE = (process.env.IG_ACCOUNT_TYPE || 'DEMO').toUpperCase();

if (TYPE !== 'DEMO') {
  throw new Error('MarketPulse V2 is DEMO ONLY. Set IG_ACCOUNT_TYPE=DEMO.');
}

const BASE = 'https://demo-api.ig.com/gateway/deal';
const POLL = Math.max(60, Number(process.env.POLL_SECONDS || 60));

const EPICS = (process.env.IG_EPICS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const dir = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(dir, 'public')));
app.use(express.json({ limit: '20kb' }));

let session = null;
let lastError = null;
let scanning = false;
let lastScanAt = null;

const latest = new Map();
const events = [];
const lastEvent = new Map();

const configured = () => Boolean(KEY && USER && PASS);

// ------------------------------------------
// IG DEMO AUTHENTICATION
// ------------------------------------------

async function login() {
  if (!configured()) {
    throw new Error(
      'Add IG_API_KEY, IG_USERNAME and IG_PASSWORD in Render.'
    );
  }

  const response = await fetch(`${BASE}/session`, {
    method: 'POST',
    headers: {
      'X-IG-API-KEY': KEY,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      Version: '2'
    },
    body: JSON.stringify({
      identifier: USER,
      password: PASS
    }),
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();
  let data = {};

  try {
    data = body ? JSON.parse(body) : {};
  } catch {}

  if (!response.ok) {
    throw new Error(
      data.errorCode || `IG login failed (${response.status})`
    );
  }

  const cst = response.headers.get('CST');
  const sec = response.headers.get('X-SECURITY-TOKEN');

  if (!cst || !sec) {
    throw new Error('IG session tokens missing.');
  }

  session = {
    cst,
    sec,
    expires: Date.now() + 4 * 60 * 60 * 1000
  };

  return data;
}

// ------------------------------------------
// IG API REQUEST
// ------------------------------------------

async function request(endpoint, version = '1') {
  if (!session || Date.now() > session.expires - 60000) {
    await login();
  }

  const response = await fetch(`${BASE}${endpoint}`, {
    headers: {
      'X-IG-API-KEY': KEY,
      CST: session.cst,
      'X-SECURITY-TOKEN': session.sec,
      Version: version,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();
  let data = {};

  try {
    data = body ? JSON.parse(body) : {};
  } catch {}

  if (!response.ok) {
    throw new Error(
      data.errorCode || `IG API HTTP ${response.status}`
    );
  }

  return data;
}

// ------------------------------------------
// EMA INDICATOR
// ------------------------------------------

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (const value of values.slice(period)) {
    result =
      value * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

// ------------------------------------------
// RSI INDICATOR
// ------------------------------------------

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  if (losses === 0) return 100;

  const relativeStrength =
    (gains / period) / (losses / period);

  return 100 - 100 / (1 + relativeStrength);
}

// ------------------------------------------
// MARKET ANALYSIS
// ------------------------------------------

function analyse(epic, data) {
  const rows = (data.prices || [])
    .map(price => {
      const bid = Number(price.closePrice?.bid);
      const ask = Number(price.closePrice?.ask);

      const close =
        Number.isFinite(bid) && Number.isFinite(ask)
          ? (bid + ask) / 2
          : Number.isFinite(bid)
            ? bid
            : ask;

      return {
        time: price.snapshotTimeUTC || price.snapshotTime || '',
        bid,
        ask,
        close,
        high: Number(price.highPrice?.bid ?? price.highPrice?.ask),
        low: Number(price.lowPrice?.bid ?? price.lowPrice?.ask)
      };
    })
    .filter(price => Number.isFinite(price.close));

  const closes = rows.map(row => row.close);
  const last = rows.at(-1);

  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const strength = rsi(closes, 14);

  const name =
    data.instrument?.name ||
    data.instrument?.epic ||
    epic;

  if (!last || fast === null || slow === null || strength === null) {
    return {
      epic,
      name,
      direction: 'WAIT',
      confidence: 0,
      reason: 'Waiting for sufficient historical candles',
      candlesReceived: rows.length,
      updatedAt: new Date().toISOString()
    };
  }

  let direction = 'WAIT';
  let reason = 'No qualifying setup';

  if (fast > slow && strength >= 52 && strength <= 68) {
    direction = 'LONG';
    reason = 'EMA bullish and RSI in momentum band';
  } else if (fast < slow && strength <= 48 && strength >= 32) {
    direction = 'SHORT';
    reason = 'EMA bearish and RSI in momentum band';
  }

  // Experimental setup-strength score.
  // This is NOT a probability of making money.

  const trendScore = Math.min(
    40,
    Math.abs(fast - slow) / last.close * 100000
  );

  const rsiScore =
    direction === 'LONG'
      ? Math.max(0, 30 - Math.abs(strength - 60) * 2)
      : direction === 'SHORT'
        ? Math.max(0, 30 - Math.abs(strength - 40) * 2)
        : 0;

  const candleScore = rows.length >= 80
    ? 20
    : Math.round(rows.length / 4);

  const confidence = direction === 'WAIT'
    ? 0
    : Math.max(
        0,
        Math.min(100, Math.round(
          trendScore + rsiScore + candleScore
        ))
      );

  const confidenceLabel =
    confidence >= 75
      ? 'Stronger setup'
      : confidence >= 55
        ? 'Moderate setup'
        : 'Early setup';

  // Stop and target based on recent price range.

  const recent = rows.slice(-15);

  const highs = recent
    .map(row => row.high)
    .filter(Number.isFinite);

  const lows = recent
    .map(row => row.low)
    .filter(Number.isFinite);

  const range =
    highs.length && lows.length
      ? Math.max(...highs) - Math.min(...lows)
      : 0;

  const distance = Math.max(
    range * 0.5,
    last.close * 0.0005
  );

  const entry =
    direction === 'LONG'
      ? last.ask
      : direction === 'SHORT'
        ? last.bid
        : null;

  const stop =
    direction === 'LONG' && Number.isFinite(entry)
      ? entry - distance
      : direction === 'SHORT' && Number.isFinite(entry)
        ? entry + distance
        : null;

  const target =
    direction === 'LONG' && Number.isFinite(entry)
      ? entry + distance * 1.5
      : direction === 'SHORT' && Number.isFinite(entry)
        ? entry - distance * 1.5
        : null;

  return {
    epic,
    name,
    direction,
    reason,
    confidence,
    confidenceLabel,
    bid: last.bid,
    ask: last.ask,
    price: last.close,
    spread:
      Number.isFinite(last.ask) && Number.isFinite(last.bid)
        ? last.ask - last.bid
        : null,
    rsi: strength,
    ema9: fast,
    ema21: slow,
    candleTime: last.time,
    candlesReceived: rows.length,
    entry,
    stop,
    target,
    riskDistance:
      entry !== null && stop !== null
        ? Math.abs(entry - stop)
        : null,
    rewardDistance:
      entry !== null && target !== null
        ? Math.abs(target - entry)
        : null,
    updatedAt: new Date().toISOString()
  };
}

// ------------------------------------------
// MULTI-MARKET SCANNER
// ------------------------------------------

async function scan() {
  if (scanning || !configured() || !EPICS.length) return;

  scanning = true;

  try {
    for (const epic of EPICS) {
      try {
        const data = await request(
          `/prices/${encodeURIComponent(epic)}/MINUTE_5/100`,
          '2'
        );

        const signal = analyse(epic, data);

        signal.status = 'ok';
        latest.set(epic, signal);

        // Prevent duplicate alerts for the same candle.

        if (signal.direction !== 'WAIT' && signal.candleTime) {
          const eventKey =
            `${signal.direction}:${signal.candleTime}`;

          if (lastEvent.get(epic) !== eventKey) {
            lastEvent.set(epic, eventKey);

            events.unshift({
              ...signal,
              id: `${epic}:${eventKey}`,
              recordedAt: new Date().toISOString()
            });

            if (events.length > 100) {
              events.pop();
            }
          }
        }

      } catch (error) {
        latest.set(epic, {
          epic,
          direction: 'UNAVAILABLE',
          status: 'error',
          reason: error.message,
          updatedAt: new Date().toISOString()
        });

        lastError = error.message;
      }
    }

    lastScanAt = new Date().toISOString();

    if (![...latest.values()].some(s => s.status === 'error')) {
      lastError = null;
    }

  } finally {
    scanning = false;
  }
}

// ------------------------------------------
// HEALTH CHECK
// ------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: configured(),
    accountType: 'DEMO',
    paperMode: true,
    liveOrdersEnabled: false,
    epics: EPICS.length,
    pollSeconds: POLL,
    scanning,
    lastScanAt,
    lastError
  });
});

// ------------------------------------------
// DASHBOARD DATA
// ------------------------------------------

app.get('/api/state', (_req, res) => {
  res.json({
    configured: configured(),
    accountType: 'DEMO',
    paperMode: true,
    liveOrdersEnabled: false,
    epics: EPICS,

    signals: EPICS.map(epic =>
      latest.get(epic) || {
        epic,
        direction: 'LOADING',
        reason: 'Waiting for first scan'
      }
    ),

    events: events.slice(0, 50),
    lastError,
    lastScanAt,
    scanning
  });
});

// ------------------------------------------
// IG CONNECTION TEST
// ------------------------------------------

app.get('/api/ig/test', async (_req, res) => {
  try {
    await login();

    const accounts = await request('/accounts', '1');

    res.json({
      ok: true,
      authenticated: true,
      accountsReturned: (accounts.accounts || []).length,
      note: 'Demo connection only. No orders placed.'
    });

  } catch (error) {
    lastError = error.message;

    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// ------------------------------------------
// MARKET SEARCH
// ------------------------------------------

app.get('/api/ig/search', async (req, res) => {
  try {
    const term = String(
      req.query.term || 'EUR/USD'
    ).slice(0, 60);

    const data = await request(
      `/markets?searchTerm=${encodeURIComponent(term)}`,
      '1'
    );

    res.json({
      ok: true,

      markets: (data.markets || []).slice(0, 30).map(market => ({
        epic: market.epic,
        name: market.instrumentName,
        type: market.instrumentType,
        expiry: market.expiry,
        status: market.marketStatus
      }))
    });

  } catch (error) {
    lastError = error.message;

    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

// ------------------------------------------
// MANUAL SCAN
// ------------------------------------------

app.post('/api/scan', async (_req, res) => {
  if (scanning) {
    return res.status(202).json({
      ok: true,
      note: 'A scan is already running.'
    });
  }

  await scan();

  res.json({
    ok: true,
    note: 'Demo scan completed/requested. No orders placed.'
  });
});

// ------------------------------------------
// DASHBOARD
// ------------------------------------------

app.get('*', (_req, res) => {
  res.sendFile(
    path.join(dir, 'public', 'index.html')
  );
});

// ------------------------------------------
// START SERVER
// ------------------------------------------

app.listen(PORT, async () => {
  console.log(
    `MarketPulse AI V2 DEMO started on port ${PORT}.`
  );

  console.log('No order execution is implemented.');

  await scan();

  setInterval(scan, POLL * 1000);
});
