const crypto = require('node:crypto');
const WebSocket = require('ws');

const { createMatcher } = require('./matchmaking');
const { iceServers } = require('./ice');
const SessionModel = require('./models/connections');
const Connection = require('./models/matches');
const Report = require('./models/report');
const Block = require('./models/block');
const Ban = require('./models/ban');
const User = require('./models/user');
const { filterText } = require('./filter');
const { verifyToken } = require('./routes/auth');
const { recordStreak, STREAK_CALL_MS } = require('./streak');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUALITIES = ['High', 'Medium', 'Low', 'Unknown'];
const REASONS = ['nudity', 'harassment', 'underage', 'spam', 'other'];
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const RATE_LIMIT = 50; // messages per second per socket
const MAX_NAME_LENGTH = 30;
const MAX_CHAT_LENGTH = 500;
const CHAT_PER_SECOND = 2;
const CHAT_LOG_LINES = 20; // kept per call in memory, saved only with a report
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

function parseName(name) {
  const clean = typeof name === 'string' ? filterText(name.trim().slice(0, MAX_NAME_LENGTH)).trim() : '';
  return clean || 'Guest';
}

const isSdp = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string' && typeof v.sdp === 'string';
const FORWARD = {
  offer: (data) => isSdp(data.offer) && { offer: data.offer },
  answer: (data) => isSdp(data.answer) && { answer: data.answer },
  candidate: (data) => (data.candidate === null || typeof data.candidate === 'object') && { candidate: data.candidate },
  networkQualityUpdate: (data) => QUALITIES.includes(data.quality) && { quality: data.quality },
};

/** Shared by random chat and rooms: a client has ws, deviceId, partner, chatTimes and chatLog. */
function forward(client, data) {
  const fields = FORWARD[data.type](data);
  if (!fields) return send(client.ws, { type: 'error', message: `invalid ${data.type}` });
  if (client.partner) send(client.partner.ws, { type: data.type, ...fields });
}

function chat(client, data) {
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || text.length > MAX_CHAT_LENGTH) return send(client.ws, { type: 'error', message: 'invalid chat' });
  const t = Date.now();
  client.chatTimes = client.chatTimes.filter((at) => t - at < 1000);
  if (client.chatTimes.length >= CHAT_PER_SECOND) return send(client.ws, { type: 'error', message: 'chat rate limit' });
  client.chatTimes.push(t);
  if (!client.partner) return send(client.ws, { type: 'error', message: 'not in a call' });

  const clean = filterText(text);
  client.chatLog.push({ from: client.deviceId, text: clean, at: new Date(t) });
  if (client.chatLog.length > CHAT_LOG_LINES) client.chatLog.shift();
  send(client.partner.ws, { type: 'chat', text: clean });
  send(client.ws, { type: 'chatSent', text: clean });
}

/** The call's chat lines as report evidence. */
const evidence = (client) =>
  client.chatLog.map((line) => ({
    sender: line.from === client.deviceId ? 'reporter' : 'reported',
    text: line.text,
    at: line.at,
  }));

/**
 * Bans a device or user for a day once enough people reported it, plus the signed-in userId of a reported device.
 * Returns the end of the ban, if any.
 */
async function autoBan(deviceId, userId) {
  try {
    const since = new Date(Date.now() - DAY_MS);
    const reporters = await Report.distinct('reporterDevice', { reportedDevice: deviceId, createdAt: { $gte: since } });
    if (reporters.length < REPORTS_TO_BAN) return null;
    const until = new Date(Date.now() + DAY_MS);
    await Ban.updateOne({ deviceId }, { until, reason: 'auto: reports' }, { upsert: true });
    if (userId) await Ban.updateOne({ deviceId: userId }, { until, reason: 'auto: reports' }, { upsert: true });
    return until;
  } catch (err) {
    logDbError(err);
    return null;
  }
}

function createSignalling({
  server,
  rooms,
  allowedOrigins = [],
  waitMs = 10000,
  tickMs = 1000,
  env = process.env,
  jwtSecret,
  streakMs = STREAK_CALL_MS,
}) {
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
      a.chatLog = b.chatLog = [];
      send(a.ws, { type: 'matched', partnerId: b.callId, role: 'caller', sharedTags, partnerName: b.name });
      send(b.ws, { type: 'matched', partnerId: a.callId, role: 'callee', sharedTags, partnerName: a.name });
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
    client.chatLog = partner.chatLog = null;
    client.lastPartner = partner.deviceId;
    partner.lastPartner = client.deviceId;
    const callDuration = Date.now() - client.callStart;
    new Connection({ userId: client.callId, partnerId: partner.callId, callDuration }).save().catch(logDbError);
    if (callDuration >= streakMs) {
      for (const c of [client, partner]) {
        if (c.userId) recordStreak(c.userId, env).then((s) => s && send(c.ws, { type: 'streak', ...s }));
      }
    }
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

  /** Kicks every client with this device id or signed-in user id. */
  function kick(id, until) {
    for (const client of [...clients.values()]) {
      if (client.deviceId !== id && client.userId !== id) continue;
      detach(client);
      send(client.ws, { type: 'banned', until: until.toISOString() });
      client.ws.close();
    }
  }

  async function checkAutoBan(deviceId, userId) {
    const until = await autoBan(deviceId, userId);
    if (!until) return;
    kick(deviceId, until);
    if (userId) kick(userId, until);
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
    // Random chat stays login-free: a missing or invalid token is ignored.
    let userId = data.token === undefined ? null : verifyToken(data.token, jwtSecret);
    ws.joining = true;

    let ban = null;
    let blocks = [];
    try {
      let user;
      [ban, blocks, user] = await Promise.all([
        Ban.findOne({ deviceId: { $in: userId ? [deviceId, userId] : [deviceId] }, until: { $gt: new Date() } }).lean(),
        Block.find({ deviceId }).lean(),
        userId && User.exists({ _id: userId }),
      ]);
      if (!user) userId = null;
    } catch (err) {
      logDbError(err);
      userId = null;
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
      userId,
      tags,
      name: parseName(data.name),
      chatTimes: [],
      chatLog: null,
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
    if (data.type === 'roomJoin' || ws.member) {
      if (ws.client) return send(ws, { type: 'error', message: 'already joined' });
      return rooms.handle(ws, data);
    }
    const client = ws.client;
    if (data.type === 'join') {
      if (client || ws.joining) return send(ws, { type: 'error', message: 'already joined' });
      return join(ws, data);
    }
    if (!client) return send(ws, { type: 'error', message: 'join first' });

    if (FORWARD[data.type]) return forward(client, data);

    switch (data.type) {
      case 'chat':
        return chat(client, data);
      case 'report':
        if (!REASONS.includes(data.reason)) return send(ws, { type: 'error', message: 'invalid reason' });
        if (client.partner) {
          const { deviceId: reportedDevice, userId: reportedUser } = client.partner;
          new Report({ reporterDevice: client.deviceId, reportedDevice, reason: data.reason, evidence: evidence(client) })
            .save()
            .then(() => checkAutoBan(reportedDevice, reportedUser), logDbError);
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
      if (ws.member) rooms.leave(ws.member);
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

module.exports = { createSignalling, autoBan, UUID, REASONS, FORWARD, send, forward, chat, evidence, logDbError };
