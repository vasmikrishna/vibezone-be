const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const Block = require('../src/models/block');
const Ban = require('../src/models/ban');
const Report = require('../src/models/report');
const { filterText } = require('../src/filter');

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

async function joined(deviceId = crypto.randomUUID(), tags = [], name) {
  const ws = await connect();
  ws.deviceId = deviceId;
  ws.json({ type: 'join', deviceId, tags, name });
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

test('mediaState forwards only video, audio and hold to the partner', async () => {
  const [a, b] = await pair();
  a.json({ type: 'mediaState', video: false, audio: true, hold: false, extra: 'x' });
  assert.deepStrictEqual(await b.waitFor('mediaState'), { type: 'mediaState', video: false, audio: true, hold: false });
  a.json({ type: 'mediaState', video: 'no', audio: true, hold: false });
  assert.strictEqual((await a.waitFor('error')).message, 'invalid mediaState');
  a.json({ type: 'mediaState', video: true, audio: true });
  assert.strictEqual((await a.waitFor('error')).message, 'invalid mediaState');
  closeAll(a, b);
});

test('recording consent messages forward to the partner with no other fields', async () => {
  const [a, b] = await pair();
  for (const type of ['recordRequest', 'recordAccept', 'recordDecline', 'recordStop']) {
    a.json({ type, extra: 'x', data: { big: true } });
    assert.deepStrictEqual(await b.waitFor(type), { type });
    b.json({ type, extra: 'y' });
    assert.deepStrictEqual(await a.waitFor(type), { type });
  }
  closeAll(a, b);
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

test('filter masks blocked words only as whole words', () => {
  assert.strictEqual(filterText('oh SHIT, a Dickens novel'), 'oh ****, a Dickens novel');
  assert.strictEqual(filterText('hello there'), 'hello there');
});

test('matched carries the partner name, filtered, trimmed and defaulting to Guest', async () => {
  const a = await joined(undefined, [], '  Asha  ');
  const b = await joined();
  assert.strictEqual((await b.waitFor('matched')).partnerName, 'Asha');
  assert.strictEqual((await a.waitFor('matched')).partnerName, 'Guest');
  closeAll(a, b);

  const c = await joined(undefined, [], `shit ${'x'.repeat(40)}`);
  const d = await joined(undefined, [], '   ');
  const name = (await d.waitFor('matched')).partnerName;
  assert.strictEqual(name, `**** ${'x'.repeat(25)}`);
  assert.strictEqual((await c.waitFor('matched')).partnerName, 'Guest');
  closeAll(c, d);
});

test('chat is filtered, forwarded only to the partner and echoed to the sender', async () => {
  const [a, b] = await pair();
  const c = await joined();
  a.json({ type: 'chat', text: '  hi you bitch  ', to: c.deviceId });
  assert.deepStrictEqual(await b.waitFor('chat'), { type: 'chat', text: 'hi you *****' });
  assert.deepStrictEqual(await a.waitFor('chatSent'), { type: 'chatSent', text: 'hi you *****' });
  await sleep(50);
  assert.ok(!c.inbox.some((m) => m.type === 'chat'));
  assert.ok(!a.inbox.some((m) => m.type === 'chat'));
  closeAll(a, b, c);
});

test('chat rejects empty, too long and non-string text', async () => {
  const [a, b] = await pair();
  for (const text of ['   ', 'x'.repeat(501), 42]) {
    a.json({ type: 'chat', text });
    assert.strictEqual((await a.waitFor('error')).message, 'invalid chat');
    await sleep(510);
  }
  a.json({ type: 'chat', text: 'x'.repeat(500) });
  assert.strictEqual((await b.waitFor('chat')).text.length, 500);
  assert.ok(!b.inbox.some((m) => m.type === 'chat'));
  closeAll(a, b);
});

test('chat allows 2 messages a second per client', async () => {
  const [a, b] = await pair();
  for (let i = 0; i < 3; i++) a.json({ type: 'chat', text: `m${i}` });
  assert.strictEqual((await a.waitFor('error')).message, 'chat rate limit');
  await sleep(100);
  assert.deepStrictEqual(b.inbox.filter((m) => m.type === 'chat').map((m) => m.text), ['m0', 'm1']);
  await sleep(1000);
  a.json({ type: 'chat', text: 'later' });
  await a.waitFor('chatSent');
  closeAll(a, b);
});

test('report saves the call chat as evidence, then chat is cleared for the next call', async () => {
  const [a, b] = await pair();
  a.json({ type: 'chat', text: 'hello' });
  await b.waitFor('chat');
  b.json({ type: 'chat', text: 'go away' });
  await a.waitFor('chat');
  a.json({ type: 'report', reason: 'harassment' });
  await b.waitFor('partnerLeft');
  let report;
  for (let i = 0; i < 50 && !report; i++, await sleep(20)) report = await Report.findOne({ reporterDevice: a.deviceId }).lean();
  assert.deepStrictEqual(
    report.evidence.map(({ sender, text }) => ({ sender, text })),
    [{ sender: 'reporter', text: 'hello' }, { sender: 'reported', text: 'go away' }]
  );
  assert.ok(report.evidence[0].at instanceof Date);

  a.json({ type: 'chat', text: 'anyone?' });
  assert.strictEqual((await a.waitFor('error')).message, 'not in a call');
  closeAll(a, b);
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
  assert.ok(Array.isArray((await reports.json()).items));

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

test('admin API is 401 without ADMIN_TOKEN and without a bearer token', async () => {
  const { server: plain, wss: plainWss } = createServer({ env: {} });
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${plain.address().port}/api/admin/reports`;
  assert.strictEqual((await fetch(at)).status, 401);
  assert.strictEqual((await fetch(at, { headers: { 'x-admin-token': '' } })).status, 401);
  plainWss.close();
  await new Promise((resolve) => plain.close(resolve));
});
