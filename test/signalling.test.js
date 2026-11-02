const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const Block = require('../src/models/block');
const Ban = require('../src/models/ban');
const Report = require('../src/models/report');

const WAIT_MS = 150;
const ADMIN_TOKEN = 'test-admin-token';
let server;
let wss;
let url;
let base;

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([Block.init(), Ban.init(), Report.init()]);
  ({ server, wss } = createServer({
    env: { ALLOWED_ORIGINS: 'https://vibezone.in', ADMIN_TOKEN, TURN_URLS: 'turn:turn.test:3478', TURN_SECRET: 's' },
    waitMs: WAIT_MS,
    tickMs: 20,
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  url = `ws://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await sleep(50);
  await mongoose.disconnect();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a socket and records every message it receives. */
function connect(options) {
  const ws = new WebSocket(url, options);
  ws.inbox = [];
  ws.on('message', (msg) => ws.inbox.push(JSON.parse(msg)));
  ws.waitFor = async (type, timeout = 2000) => {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(10)) {
      const i = ws.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return ws.inbox.splice(i, 1)[0];
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  ws.json = (message) => ws.send(JSON.stringify(message));
  ws.closed = new Promise((resolve) => ws.on('close', resolve));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function joined(deviceId = crypto.randomUUID(), tags = []) {
  const ws = await connect();
  ws.deviceId = deviceId;
  ws.json({ type: 'join', deviceId, tags });
  await ws.waitFor('ready');
  return ws;
}

async function pair() {
  const a = await joined();
  const b = await joined();
  return [a, b, await a.waitFor('matched'), await b.waitFor('matched')];
}

const closeAll = (...sockets) => sockets.forEach((ws) => ws.close());

test('join replies ready with STUN and TURN servers', async () => {
  const ws = await joined();
  const ws2 = await connect();
  ws2.json({ type: 'join', deviceId: crypto.randomUUID() });
  const { iceServers } = await ws2.waitFor('ready');
  assert.strictEqual(iceServers[0].urls, 'stun:stun.l.google.com:19302');
  assert.deepStrictEqual(iceServers[1].urls, ['turn:turn.test:3478']);
  assert.ok(Number(iceServers[1].username) > Date.now() / 1000);
  closeAll(ws, ws2);
});

test('rejects invalid join, messages before join and foreign origins', async () => {
  const ws = await connect();
  ws.json({ type: 'offer', offer: { type: 'offer', sdp: 'x' } });
  assert.strictEqual((await ws.waitFor('error')).message, 'join first');
  ws.json({ type: 'join', deviceId: 'not-a-uuid' });
  await ws.waitFor('error');
  await ws.closed;

  await assert.rejects(connect({ origin: 'https://evil.example' }));
  closeAll(await connect({ origin: 'https://vibezone.in' }));
});

test('matches two users without exposing device ids', async () => {
  const [a, b, ma, mb] = await pair();
  assert.strictEqual(ma.role, 'caller');
  assert.strictEqual(mb.role, 'callee');
  assert.notStrictEqual(ma.partnerId, b.deviceId);
  assert.notStrictEqual(mb.partnerId, a.deviceId);
  closeAll(a, b);
});

test('forwards only to the partner, ignoring a spoofed to', async () => {
  const [a, b] = await pair();
  const c = await joined();
  a.json({ type: 'offer', offer: { type: 'offer', sdp: 'sdp-a' }, to: c.deviceId });
  const offer = await b.waitFor('offer');
  assert.deepStrictEqual(offer, { type: 'offer', offer: { type: 'offer', sdp: 'sdp-a' } });
  b.json({ type: 'networkQualityUpdate', quality: 'High' });
  assert.strictEqual((await a.waitFor('networkQualityUpdate')).quality, 'High');
  b.json({ type: 'networkQualityUpdate', quality: 'Bogus' });
  await b.waitFor('error');
  await sleep(50);
  assert.ok(!c.inbox.some((m) => m.type === 'offer'));
  closeAll(a, b, c);
});

test('skip tells the partner and rematches them after the wait', async () => {
  const [a, b] = await pair();
  const start = Date.now();
  a.json({ type: 'skip' });
  await b.waitFor('partnerLeft');
  await a.waitFor('matched');
  await b.waitFor('matched');
  assert.ok(Date.now() - start >= WAIT_MS - 20);
  closeAll(a, b);
});

test('block prevents a rematch, even after reconnecting', async () => {
  const [a, b] = await pair();
  a.json({ type: 'block' });
  await b.waitFor('partnerLeft');
  await sleep(WAIT_MS * 3);
  assert.ok(!a.inbox.some((m) => m.type === 'matched'));
  assert.ok(!b.inbox.some((m) => m.type === 'matched'));
  assert.ok(await Block.exists({ deviceId: a.deviceId, blockedDevice: b.deviceId }));

  b.close();
  const b2 = await joined(b.deviceId);
  await sleep(WAIT_MS * 3);
  assert.ok(!b2.inbox.some((m) => m.type === 'matched'));
  closeAll(a, b2);
});

test('a new join closes the older socket for the same device', async () => {
  const deviceId = crypto.randomUUID();
  const first = await joined(deviceId);
  const second = await joined(deviceId);
  assert.strictEqual(await first.closed, 4000);
  closeAll(second);
});

test('three distinct reporters ban a device for 24h', async () => {
  const target = await joined();
  for (let i = 0; i < 3; i++) {
    const reporter = await joined();
    await reporter.waitFor('matched');
    await target.waitFor('matched');
    reporter.json({ type: 'report', reason: 'spam' });
    if (i < 2) await target.waitFor('partnerLeft');
    reporter.close();
  }
  const banned = await target.waitFor('banned');
  assert.ok(new Date(banned.until) > new Date(Date.now() + 23 * 3600 * 1000));
  assert.strictEqual(await Report.countDocuments({ reportedDevice: target.deviceId }), 3);

  const again = await connect();
  again.json({ type: 'join', deviceId: target.deviceId });
  await again.waitFor('banned');
});

test('closes sockets that exceed the rate limit', async () => {
  const ws = await joined();
  for (let i = 0; i < 60; i++) ws.json({ type: 'leave' });
  assert.strictEqual(await ws.closed, 1008);
});

test('health and admin endpoints', async () => {
  const health = await fetch(`${base}/health`);
  assert.deepStrictEqual(await health.json(), { status: 'ok', mongo: 'connected' });

  assert.strictEqual((await fetch(`${base}/api/admin/reports`)).status, 401);
  const headers = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };
  const reports = await fetch(`${base}/api/admin/reports`, { headers });
  assert.ok(Array.isArray(await reports.json()));

  const deviceId = crypto.randomUUID();
  const ban = await fetch(`${base}/api/admin/bans`, { method: 'POST', headers, body: JSON.stringify({ deviceId, hours: 1 }) });
  assert.strictEqual(ban.status, 200);
  const ws = await connect();
  ws.json({ type: 'join', deviceId });
  await ws.waitFor('banned');

  const unban = await fetch(`${base}/api/admin/bans/${deviceId}`, { method: 'DELETE', headers });
  assert.deepStrictEqual(await unban.json(), { deleted: 1 });
  closeAll(await joined(deviceId));
});

test('admin API is 404 without ADMIN_TOKEN', async () => {
  const { server: plain, wss: plainWss } = createServer({ env: {} });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  const res = await fetch(`http://127.0.0.1:${plain.address().port}/api/admin/reports`);
  assert.strictEqual(res.status, 404);
  plainWss.close();
  await new Promise((resolve) => plain.close(resolve));
});
