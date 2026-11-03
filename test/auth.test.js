const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const User = require('../src/models/user');
const Ban = require('../src/models/ban');
const { badgesView } = require('../src/badges');
const { recordStreak, streakView, dayKey } = require('../src/streak');

const JWT_SECRET = 'test-jwt-secret';
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const STREAK_MS = 50;
const servers = [];
let base;
let url;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake Google verifier: the credential is the JSON payload, "bad" is rejected. */
async function verifyGoogle(credential, audience) {
  assert.strictEqual(audience, CLIENT_ID);
  if (credential === 'bad') throw new Error('Wrong number of segments');
  return JSON.parse(credential);
}

async function start(env) {
  const { server, wss } = createServer({ env, verifyGoogle, streakMs: STREAK_MS, waitMs: 150, tickMs: 20 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, wss });
  return `http://127.0.0.1:${server.address().port}`;
}

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_auth_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Ban.init()]);
  base = await start({ JWT_SECRET, GOOGLE_CLIENT_ID: CLIENT_ID });
  url = base.replace('http', 'ws');
});

test.after(async () => {
  for (const { server, wss } of servers) {
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await sleep(50);
  await mongoose.disconnect();
});

const google = (credential, at = base) =>
  fetch(`${at}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });

const sign = (id) => jwt.sign({ sub: String(id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' });

function connect() {
  const ws = new WebSocket(url);
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

test('google login: 503 without a client id, 400 for a bad body, 401 for a bad or unverified token', async () => {
  const off = await start({ JWT_SECRET });
  const unavailable = await google('x', off);
  assert.strictEqual(unavailable.status, 503);
  assert.deepStrictEqual(await unavailable.json(), { error: 'google sign-in unavailable' });

  assert.strictEqual((await google('')).status, 400);
  assert.strictEqual((await google('x'.repeat(4097))).status, 400);

  const bad = await google('bad');
  assert.strictEqual(bad.status, 401);
  assert.deepStrictEqual(await bad.json(), { error: 'invalid google token' });
  const unverified = JSON.stringify({ sub: 'g-unverified', email: 'u@example.com', email_verified: false });
  assert.strictEqual((await google(unverified)).status, 401);
  assert.strictEqual(await User.exists({ googleId: 'g-unverified' }), null);
});

test('google login creates the user once, names it from given_name and returns a token for /me', async () => {
  const credential = JSON.stringify({ sub: 'g-1', email: 'asha@example.com', email_verified: true, given_name: ' Asha ' });
  const first = await google(credential);
  assert.strictEqual(first.status, 200);
  const { token, user } = await first.json();
  assert.strictEqual(user.name, 'Asha');
  assert.strictEqual(user.email, 'asha@example.com');
  assert.strictEqual(user.phone, undefined);
  assert.strictEqual(user.adult, false);
  assert.deepStrictEqual(user.streak, { count: 0, best: 0 });
  assert.strictEqual(user.calls, 0);
  assert.strictEqual(user.badges.length, 6);
  assert.ok(user.badges.every((b) => b.earned === false));

  const second = await (await google(credential)).json();
  assert.strictEqual(second.user.id, user.id);
  const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual((await me.json()).id, user.id);

  // A second Google user without a phone does not clash on the phone index.
  const other = await google(JSON.stringify({ sub: 'g-2', email: 'b@example.com', email_verified: true }));
  assert.strictEqual(other.status, 200);
  assert.notStrictEqual((await other.json()).user.id, user.id);
});

test('recordStreak: same day unchanged, next day +1, a gap resets; streakView drops a missed streak', async () => {
  const env = { STREAK_TZ: 'Asia/Kolkata' };
  const { _id: id } = await User.create({ googleId: 'g-streak' });
  const day1 = new Date('2026-03-01T06:00:00Z');
  const day2 = new Date('2026-03-02T19:00:00Z'); // 00:30 on 3 March in Kolkata
  const day3 = new Date('2026-03-03T10:00:00Z');
  assert.strictEqual(dayKey(day2, env), '2026-03-03');

  assert.deepStrictEqual(await recordStreak(id, env, day1), { count: 1, best: 1 });
  assert.deepStrictEqual(await recordStreak(id, env, day1), { count: 1, best: 1 });
  // Parallel calls on the next day count once.
  const both = await Promise.all([recordStreak(id, env, new Date('2026-03-02T06:00:00Z')), recordStreak(id, env, new Date('2026-03-02T07:00:00Z'))]);
  assert.deepStrictEqual(both, [{ count: 2, best: 2 }, { count: 2, best: 2 }]);
  assert.deepStrictEqual(await recordStreak(id, env, day3), { count: 3, best: 3 });

  const user = await User.findById(id).lean();
  assert.deepStrictEqual(streakView(user, env, new Date('2026-03-04T10:00:00Z')), { count: 3, best: 3 });
  assert.deepStrictEqual(streakView(user, env, new Date('2026-03-05T10:00:00Z')), { count: 0, best: 3 });
  assert.deepStrictEqual(await recordStreak(id, env, new Date('2026-03-06T10:00:00Z')), { count: 1, best: 3 });
});

test('badgesView: fresh user earns none, calls and streak unlock badges, a broken streak drops hot-streak only', () => {
  const earned = (u, s) => badgesView(u, s).filter((b) => b.earned).map((b) => b.id);
  assert.deepStrictEqual(earned({}, { count: 0, best: 0 }), []);
  assert.deepStrictEqual(earned({ calls: 10 }, { count: 5, best: 7 }), ['first-call', 'regular', 'hot-streak', 'week-warrior']);
  assert.deepStrictEqual(earned({ calls: 10 }, { count: 0, best: 7 }), ['first-call', 'regular', 'week-warrior']);
});

test('recordStreak: a second call on the same day keeps the streak but counts the call', async () => {
  const env = { STREAK_TZ: 'Asia/Kolkata' };
  const { _id: id } = await User.create({ googleId: 'g-calls' });
  const now = new Date('2026-03-01T06:00:00Z');
  await recordStreak(id, env, now);
  await recordStreak(id, env, now);
  const user = await User.findById(id).lean();
  assert.strictEqual(user.streak.count, 1);
  assert.strictEqual(user.calls, 2);
});

test('random chat: two signed-in users who talk past the streak time both get a streak; guests do not', async () => {
  const [u1, u2] = await User.create([{ googleId: 'g-chat-1' }, { phone: '+919800000001' }]);
  const a = await connect();
  const b = await connect();
  const guest = await connect();
  a.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(u1._id) });
  await a.waitFor('ready');
  b.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(u2._id) });
  await b.waitFor('matched');
  await sleep(STREAK_MS + 20);
  a.json({ type: 'leave' });
  assert.deepStrictEqual(await a.waitFor('streak'), { type: 'streak', count: 1, best: 1 });
  assert.deepStrictEqual(await b.waitFor('streak'), { type: 'streak', count: 1, best: 1 });

  // An invalid token is ignored: the guest still joins and gets no streak.
  guest.json({ type: 'join', deviceId: crypto.randomUUID(), token: 'not-a-jwt' });
  await guest.waitFor('ready');
  await guest.waitFor('matched');
  await sleep(STREAK_MS + 20);
  guest.json({ type: 'leave' });
  assert.deepStrictEqual(await b.waitFor('streak'), { type: 'streak', count: 1, best: 1 });
  await sleep(100);
  assert.ok(!guest.inbox.some((m) => m.type === 'streak'));
  [a, b, guest].forEach((ws) => ws.close());
});

test('random chat: a banned user id is refused on a fresh device and kicked by an admin ban', async () => {
  const [banned, later] = await User.create([{ googleId: 'g-banned' }, { googleId: 'g-later' }]);
  const until = new Date(Date.now() + 60 * 60 * 1000);
  await Ban.create({ deviceId: String(banned._id), until, reason: 'admin' });
  const ws = await connect();
  ws.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(banned._id) });
  assert.strictEqual((await ws.waitFor('banned')).until, until.toISOString());
  await ws.closed;

  const adminBase = await start({ JWT_SECRET, ADMIN_TOKEN: 'admin' });
  const live = new WebSocket(adminBase.replace('http', 'ws'));
  const inbox = [];
  live.on('message', (msg) => inbox.push(JSON.parse(msg)));
  await new Promise((resolve) => live.on('open', resolve));
  const closed = new Promise((resolve) => live.on('close', resolve));
  live.send(JSON.stringify({ type: 'join', deviceId: crypto.randomUUID(), token: sign(later._id) }));
  for (let i = 0; i < 100 && !inbox.some((m) => m.type === 'ready'); i++) await sleep(10);
  const res = await fetch(`${adminBase}/api/admin/bans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'admin' },
    body: JSON.stringify({ deviceId: String(later._id), hours: 1 }),
  });
  assert.strictEqual(res.status, 200);
  await closed;
  assert.ok(inbox.some((m) => m.type === 'banned'));
});

test('deleting an underage Google account keeps only its googleId and the flag', async () => {
  const { user, token } = await (await google(JSON.stringify({ sub: 'g-young', email: 'y@example.com', email_verified: true }))).json();
  const patch = await fetch(`${base}/api/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ dob: '2015-01-01' }),
  });
  assert.strictEqual(patch.status, 403);
  const del = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(del.status, 204);
  const left = await User.findById(user.id).lean();
  const { _id, __v, createdAt, ...rest } = left;
  assert.deepStrictEqual(rest, { googleId: 'g-young', underage: true });
  const again = await (await google(JSON.stringify({ sub: 'g-young', email: 'y@example.com', email_verified: true }))).json();
  assert.strictEqual(again.user.id, user.id);
  assert.strictEqual(again.user.adult, false);
});
