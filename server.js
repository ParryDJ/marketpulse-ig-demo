
'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const { LightstreamerClient, Subscription } =
  require('lightstreamer-client-node');

if (process.env.IG_ACCOUNT_TYPE !== 'DEMO') {
  throw new Error('IG_ACCOUNT_TYPE must be DEMO');
}

const app = express();
app.use(express.json({ limit: '12kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const IG_URL = 'https://demo-api.ig.com/gateway/deal';
const CANDLE_MS = 300000;
const MAX_MARKETS = Math.min(
  40,
  Math.max(1, Number(process.env.MAX_STREAM_MARKETS) || 20)
);

const epics = String(
  process.env.IG_EPICS ||
  'CS.D.EURUSD.CFD.IP,CS.D.GBPUSD.CFD.IP,CS.D.USDJPY.CFD.IP'
).split(',').map(x => x.trim()).filter(Boolean);

const markets = new Map();
const quotes = new Map();
const candles = new Map();
const current = new Map();
const activity = [];

let auth = null;
let client = null;
let subscription = null;
let streamStatus = 'disconnected';
let streamError = '';
let account = null;
let positions = [];
let starting = false;
let retryAt = 0;

function log(message) {
  const entry = {
    time: new Date().toISOString(),
    message: String(message).slice(0, 300)
  };
  activity.unshift(entry);
  if (activity.length > 100) activity.pop();
  console.log('[MarketPulse]', entry.message);
}

function number(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const result = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(result) ? result : null;
}

async function request(url, method = 'GET', body = null, version = '1') {
  const headers = {
    'X-IG-API-KEY': process.env.IG_API_KEY || '',
    'VERSION': version,
    'Accept': 'application/json'
  };

  if (auth) {
    headers.CST = auth.cst;
    headers['X-SECURITY-TOKEN'] = auth.xst;
  }

  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(IG_URL + url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw: raw.slice(0, 120) };
  }

  if (!response.ok || data.errorCode) {
    throw new Error(
      `${response.status}: ${data.errorCode || data.raw || 'IG error'}`
    );
  }

  return { data, headers: response.headers };
}

async function login() {
  if (
    !process.env.IG_API_KEY ||
    !process.env.IG_USERNAME ||
    !process.env.IG_PASSWORD
  ) {
    throw new Error('Missing IG DEMO credentials');
  }

  auth = null;

  const result = await request(
    '/session',
    'POST',
    {
      identifier: process.env.IG_USERNAME,
      password: process.env.IG_PASSWORD
    },
    '2'
  );

  const cst = result.headers.get('cst');
  const xst = result.headers.get('x-security-token');

  if (!cst || !xst) {
    throw new Error('IG session tokens missing');
  }

  auth = {
    cst,
    xst,
    accountId: result.data.currentAccountId,
    streamUrl: result.data.lightstreamerEndpoint
  };

  return result.data;
}

async function api(url, version = '1') {
  if (!auth) await login();

  try {
    return (await request(url, 'GET', null, version)).data;
  } catch (error) {
    if (/401|token-invalid/i.test(error.message)) {
      await login();
      return (await request(url, 'GET', null, version)).data;
    }
    throw error;
  }
}

async function discoverMarkets() {
  markets.clear();

  for (const epic of epics) {
    markets.set(epic, { epic, name: epic });
  }

  if (process.env.AUTO_DISCOVER_FOREX === 'false') return;

  try {
    const root = await api('/marketnavigation');
    const queue = (root.nodes || []).filter(node =>
      /forex|currenc|fx/i.test(node.name || '')
    );

    let visited = 0;
    const nodeLimit = 45;
    const marketLimit = 150;

    while (
      queue.length &&
      visited < nodeLimit &&
      markets.size < marketLimit
    ) {
      const node = queue.shift();
      visited++;

      const result = await api(
        '/marketnavigation/' + encodeURIComponent(node.id)
      );

      for (const market of result.markets || []) {
        const epic = String(market.epic || '');

        if (
          /^[A-Z0-9.]{6,55}$/.test(epic) &&
          /([A-Z]{6}|FOREX|FX)/i.test(
            epic + ' ' + (market.instrumentName || '')
          )
        ) {
          markets.set(epic, {
            epic,
            name: market.instrumentName || epic
          });
        }

        if (markets.size >= marketLimit) break;
      }

      for (const child of result.nodes || []) {
        queue.push(child);
      }
    }

    log(`Discovered ${markets.size} forex candidates`);
  } catch (error) {
    log('Market discovery: ' + error.message);
  }
}

function updateCandle(epic, mid, timestamp) {
  const bucket =
    Math.floor(timestamp / CANDLE_MS) * CANDLE_MS;

  let candle = current.get(epic);

  if (candle && bucket < candle.bucket) return;

  if (candle && bucket > candle.bucket) {
    if (candle.ticks >= 2) {
      const history = candles.get(epic) || [];

      history.push({
        time: new Date(candle.bucket).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      });

      candles.set(epic, history.slice(-150));
    }

    current.delete(epic);
    candle = null;
  }

  if (!candle) {
    candle = {
      bucket,
      open: mid,
      high: mid,
      low: mid,
      close: mid,
      ticks: 0
    };
    current.set(epic, candle);
  }

  candle.high = Math.max(candle.high, mid);
  candle.low = Math.min(candle.low, mid);
  candle.close = mid;
  candle.ticks++;
}

function ema(values, period) {
  let result = values[0];
  const multiplier = 2 / (period + 1);

  for (const value of values.slice(1)) {
    result += (value - result) * multiplier;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }

  if (losses === 0) return 100;

  return 100 - 100 / (1 + gains / losses);
}

function analyse(epic) {
  const bars = candles.get(epic) || [];
  const quote = quotes.get(epic);

  if (!quote || Date.now() - quote.at > 20000) {
    return {
      direction: 'STALE',
      score: 0,
      bars: bars.length
    };
  }

  if (bars.length < 30) {
    return {
      direction: 'WARMING',
      score: 0,
      bars: bars.length
    };
  }

  const closes = bars.map(bar => bar.close);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const strength = rsi(closes);

  let direction = 'WAIT';

  if (fast > slow && strength >= 52 && strength <= 68) {
    direction = 'LONG';
  }

  if (fast < slow && strength >= 32 && strength <= 48) {
    direction = 'SHORT';
  }

  return {
    direction,
    score: direction === 'WAIT' ? 0 : 60,
    bars: bars.length,
    ema9: fast,
    ema21: slow,
    rsi: strength
  };
}

function closeStream() {
  if (!client) return;

  try {
    if (subscription) client.unsubscribe(subscription);
    client.disconnect();
  } catch (error) {
    log('Disconnect: ' + error.message);
  }

  client = null;
  subscription = null;
}

function startStream() {
  if (!auth?.streamUrl || !auth.accountId) {
    throw new Error('IG streaming credentials unavailable');
  }

  closeStream();

  streamStatus = 'connecting';
  streamError = '';

  const ls = new LightstreamerClient(
    auth.streamUrl,
    'DEFAULT'
  );

  ls.connectionDetails.setUser(auth.accountId);
  ls.connectionDetails.setPassword(
    `CST-${auth.cst}|XST-${auth.xst}`
  );

  const selected = [...markets.keys()].slice(0, MAX_MARKETS);

  if (!selected.length) {
    throw new Error('No forex markets configured');
  }

  const sub = new Subscription(
    'MERGE',
    selected.map(epic => 'MARKET:' + epic),
    ['BID', 'OFFER', 'UPDATE_TIME', 'MARKET_STATE']
  );

  sub.setRequestedSnapshot('yes');

  sub.addListener({
    onSubscription() {
      log(`Subscribed to ${selected.length} markets`);
    },

    onSubscriptionError(code, message) {
      streamError = `${code}: ${message}`;
      log('Subscription error: ' + streamError);
    },

    onItemUpdate(update) {
      const epic = String(
        update.getItemName() || ''
      ).replace(/^MARKET:/, '');

      if (!markets.has(epic)) return;

      const previous = quotes.get(epic) || {};

      const bid =
        number(update.getValue('BID')) ?? previous.bid;

      const ask =
        number(update.getValue('OFFER')) ?? previous.ask;

      if (
        bid == null ||
        ask == null ||
        bid <= 0 ||
        ask <= bid
      ) return;

      const marketState =
        update.getValue('MARKET_STATE') ||
        previous.marketState ||
        'UNKNOWN';

      const now = Date.now();

      quotes.set(epic, {
        bid,
        ask,
        spread: ask - bid,
        marketState,
        at: now
      });

      if (marketState === 'TRADEABLE') {
        updateCandle(epic, (bid + ask) / 2, now);
      }
    }
  });

  ls.addListener({
    onStatusChange(status) {
      streamStatus = status;
    },

    onServerError(code, message) {
      streamError = `${code}: ${message}`;
      log('Stream error: ' + streamError);
    }
  });

  client = ls;
  subscription = sub;

  ls.connect();
  ls.subscribe(sub);

  log('Starting live IG streaming');
}

async function refreshAccount() {
  const result = await api('/accounts');

  const selected =
    (result.accounts || []).find(
      a => a.accountId === auth.accountId
    ) ||
    (result.accounts || []).find(
      a => a.accountType === 'CFD'
    );

  if (selected) {
    account = {
      accountId: selected.accountId,
      currency: selected.currency,
      balance: selected.balance?.balance
    };
  }

  const open = await api('/positions', '2');

  positions = (open.positions || []).map(item => ({
    epic: item.market?.epic,
    direction: item.position?.direction,
    size: item.position?.size
  }));
}

async function initialise() {
  if (starting) return;

  starting = true;

  try {
    await login();
    await discoverMarkets();
    await refreshAccount();
    startStream();
  } catch (error) {
    streamStatus = 'error';
    streamError = error.message;
    log('Startup error: ' + error.message);
  } finally {
    starting = false;
  }
}

function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;

  if (!token) {
    return res.status(503).json({
      error: 'ADMIN_TOKEN not configured'
    });
  }

  if (req.get('X-Admin-Token') !== token) {
    return res.status(403).json({
      error: 'Invalid admin token'
    });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '3.3.0',
    mode: 'DEMO_MONITOR_ONLY',
    streamStatus,
    marketCount: markets.size
  });
});

app.get('/api/state', (req, res) => {
  const now = Date.now();

  const list = [...markets.values()].map(market => {
    const quote = quotes.get(market.epic);
    const signal = analyse(market.epic);

    return {
      ...market,
      ...signal,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spread: quote?.spread ?? null,
      marketState: quote?.marketState || 'UNKNOWN',
      lastTick: quote
        ? new Date(quote.at).toISOString()
        : null,
      ageSeconds: quote
        ? Math.round((now - quote.at) / 1000)
        : null
    };
  });

  res.json({
    version: '3.3.0',
    mode: 'DEMO_MONITOR_ONLY',
    auto: false,
    orderExecutionEnabled: false,
    streamStatus,
    streamError,
    account,
    positions,
    marketCount: markets.size,
    streamCap: MAX_MARKETS,
    markets: list,
    activity: activity.slice(0, 30)
  });
});

app.get('/api/ig/test', async (req, res) => {
  try {
    await login();
    const result = await api('/accounts');

    res.json({
      ok: true,
      accountsReturned: result.accounts?.length || 0,
      note: 'Demo connection tested. No orders placed.'
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post(
  '/api/admin/reconnect',
  requireAdmin,
  async (req, res) => {
    await initialise();

    res.json({
      ok: true,
      streamStatus,
      streamError
    });
  }
);

app.get('*', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  log('MarketPulse V3.3 started — demo monitoring only');
  initialise();
});

setInterval(() => {
  if (auth) {
    refreshAccount().catch(error => {
      log('Account refresh: ' + error.message);
    });
  }
}, 120000);

setInterval(() => {
  const disconnected =
    !client ||
    streamStatus === 'error' ||
    streamStatus === 'disconnected' ||
    String(streamStatus).startsWith('DISCONNECTED');

  if (
    !starting &&
    disconnected &&
    Date.now() > retryAt
  ) {
    retryAt = Date.now() + 60000;
    initialise();
  }
}, 30000);
