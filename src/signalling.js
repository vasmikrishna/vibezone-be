const crypto = require('node:crypto');
const WebSocket = require('ws');

const { createMatcher } = require('./matchmaking');
const { iceServers } = require('./ice');
const SessionModel = require('./models/connections');
const Connection = require('./models/matches');
const Report = require('./models/report');
const Block = require('./models/block');
const Ban = require('./models/ban');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUALITIES = ['High', 'Medium', 'Low', 'Unknown'];
const REASONS = ['nudity', 'harassment', 'underage', 'spam', 'other'];
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const RATE_LIMIT = 50; // messages per second per socket
const REPORTS_TO_BAN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Persistence must never crash signalling. */
const logDbError = (err) => console.error('[db]', err.message);

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    console.error('[ws] send failed:', err.message);
  }
}

function parseTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) return null;
  const clean = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') return null;
    const t = tag.trim().toLowerCase();
    if (t.length > MAX_TAG_LENGTH) return null;
    if (t && !clean.includes(t)) clean.push(t);
  }
  return clean;
}

const isSdp = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string' && typeof v.sdp === 'string';
const FORWARD = {
  offer: (data) => isSdp(data.offer) && { offer: data.offer },
  answer: (data) => isSdp(data.answer) && { answer: data.answer },
  candidate: (data) => (data.candidate === null || typeof data.candidate === 'object') && { candidate: data.candidate },
  networkQualityUpdate: (data) => QUALITIES.includes(data.quality) && { quality: data.quality },
};

function createSignalling({ server, allowedOrigins = [], waitMs = 10000, tickMs = 1000, env = process.env }) {
  const wss = new WebSocket.Server({
    server,
    maxPayload: 64 * 1024,
    // Native apps and tests may send no Origin header; browsers always do.
    verifyClient: ({ origin }) => !origin || allowedOrigins.includes(origin),
  });
  const matcher = createMatcher({ waitMs });
  const clients = new Map(); // deviceId -> client

  function tryMatch() {
    for (let pair = matcher.next(); pair; pair = matcher.next()) {
      const { a, b, sharedTags } = pair;
      a.partner = b;
      b.partner = a;
      a.callId = crypto.randomUUID();
      b.callId = crypto.randomUUID();
      a.callStart = b.callStart = Date.now();
      send(a.ws, { type: 'matched', partnerId: b.callId, role: 'caller', sharedTags });
      send(b.ws, { type: 'matched', partnerId: a.callId, role: 'callee', sharedTags });
    }
  }

  function enqueue(client) {
    if (client.partner || clients.get(client.deviceId) !== client) return;
    matcher.add(client);
    tryMatch();
  }

  /** Ends the client's call; the partner is told and requeued. */
  function endCall(client) {
    const partner = client.partner;
    if (!partner) return;
    client.partner = partner.partner = null;
    client.lastPartner = partner.deviceId;
    partner.lastPartner = client.deviceId;
    new Connection({ userId: client.callId, partnerId: partner.callId, callDuration: Date.now() - client.callStart })
      .save()
      .catch(logDbError);
    send(partner.ws, { type: 'partnerLeft' });
    enqueue(partner);
  }

  /** Drops the client from matchmaking without closing its socket. */
  function detach(client) {
    endCall(client);
    if (clients.get(client.deviceId) !== client) return;
    matcher.remove(client.deviceId);
    clients.delete(client.deviceId);
  }

  function kick(deviceId, until) {
    const client = clients.get(deviceId);
    if (!client) return;
    detach(client);
    send(client.ws, { type: 'banned', until: until.toISOString() });
    client.ws.close();
  }

  async function checkAutoBan(deviceId) {
    try {
      const since = new Date(Date.now() - DAY_MS);
      const reporters = await Report.distinct('reporterDevice', { reportedDevice: deviceId, createdAt: { $gte: since } });
      if (reporters.length < REPORTS_TO_BAN) return;
      const until = new Date(Date.now() + DAY_MS);
      await Ban.updateOne({ deviceId }, { until, reason: 'auto: reports' }, { upsert: true });
      kick(deviceId, until);
    } catch (err) {
      logDbError(err);
    }
  }

  function block(client) {
    const partner = client.partner;
    client.blocks.add(partner.deviceId);
    Block.updateOne(
      { deviceId: client.deviceId, blockedDevice: partner.deviceId },
      { $set: { blockedDevice: partner.deviceId } },
      { upsert: true }
    ).catch(logDbError);
  }

  async function join(ws, data) {
    const tags = parseTags(data.tags);
    if (typeof data.deviceId !== 'string' || !UUID.test(data.deviceId) || !tags) {
      send(ws, { type: 'error', message: 'invalid join' });
      return ws.close(1008);
    }
    const deviceId = data.deviceId.toLowerCase();
    ws.joining = true;

    let ban = null;
    let blocks = [];
    try {
      [ban, blocks] = await Promise.all([
        Ban.findOne({ deviceId, until: { $gt: new Date() } }).lean(),
        Block.find({ deviceId }).lean(),
      ]);
    } catch (err) {
      logDbError(err);
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ban) {
      send(ws, { type: 'banned', until: ban.until.toISOString() });
      return ws.close();
    }

    const older = clients.get(deviceId);
    if (older) {
      detach(older);
      older.ws.close(4000, 'replaced');
    }

    const client = {
      ws,
      deviceId,
      tags,
      blocks: new Set(blocks.map((b) => b.blockedDevice)),
      lastPartner: null,
      partner: null,
    };
    ws.client = client;
    clients.set(deviceId, client);
    send(ws, { type: 'ready', iceServers: iceServers(env) });
    send(ws, { type: 'activeUsers', value: clients.size });
    enqueue(client);
  }

  function handle(ws, data) {
    const client = ws.client;
    if (data.type === 'join') {
      if (client || ws.joining) return send(ws, { type: 'error', message: 'already joined' });
      return join(ws, data);
    }
    if (!client) return send(ws, { type: 'error', message: 'join first' });

    if (FORWARD[data.type]) {
      const fields = FORWARD[data.type](data);
      if (!fields) return send(ws, { type: 'error', message: `invalid ${data.type}` });
      if (client.partner) send(client.partner.ws, { type: data.type, ...fields });
      return;
    }

    switch (data.type) {
      case 'report':
        if (!REASONS.includes(data.reason)) return send(ws, { type: 'error', message: 'invalid reason' });
        if (client.partner) {
          const reportedDevice = client.partner.deviceId;
          new Report({ reporterDevice: client.deviceId, reportedDevice, reason: data.reason })
            .save()
            .then(() => checkAutoBan(reportedDevice), logDbError);
        }
      // falls through: a report also blocks
      case 'block':
        if (client.partner) block(client);
      // falls through: a block also skips
      case 'skip':
        endCall(client);
        return enqueue(client);
      case 'leave':
        endCall(client);
        return matcher.remove(client.deviceId);
      default:
        return send(ws, { type: 'error', message: 'unknown type' });
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const sessionId = crypto.randomUUID();
    new SessionModel({ sessionId, startTime: new Date() }).save().catch(logDbError);

    let windowStart = Date.now();
    let count = 0;

    ws.on('message', (msg, isBinary) => {
      const t = Date.now();
      if (t - windowStart >= 1000) {
        windowStart = t;
        count = 0;
      }
      if (++count > RATE_LIMIT) return ws.close(1008, 'rate limit');

      let data;
      try {
        data = isBinary ? null : JSON.parse(msg);
      } catch {
        data = null;
      }
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
        return send(ws, { type: 'error', message: 'invalid message' });
      }
      handle(ws, data);
    });

    ws.on('close', () => {
      if (ws.client) detach(ws.client);
      SessionModel.updateOne({ sessionId }, { $set: { endTime: new Date() } }).catch(logDbError);
    });

    ws.on('error', (err) => console.error('[ws]', err.message));
  });

  const matchTimer = setInterval(tryMatch, tickMs);
  const activeTimer = setInterval(() => {
    for (const client of clients.values()) send(client.ws, { type: 'activeUsers', value: clients.size });
  }, 3000);
  const keepalive = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(matchTimer);
    clearInterval(activeTimer);
    clearInterval(keepalive);
  });

  return { wss, kick };
}

module.exports = { createSignalling, UUID };
