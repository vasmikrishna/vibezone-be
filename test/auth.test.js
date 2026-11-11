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

const google = (credential, at = base, extra = {}) =>
  fetch(`${at}/api/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential, ...extra }),
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
  assert.strictEqual(user.referrals, 0);
  assert.strictEqual(user.badges.length, 9);
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
  assert.deepStrictEqual(earned({ referrals: 5 }, { count: 0, best: 0 }), ['invite-1', 'invite-5']);
  assert.deepStrictEqual(earned({ referrals: 25 }, { count: 0, best: 0 }), ['invite-1', 'invite-5', 'invite-25']);
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
  await User.updateOne({ _id: user.id }, { $set: { inviteCode: '1234567890', invitedBy: user.id, referrals: 2 } });
  const del = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(del.status, 204);
  const left = await User.findById(user.id).lean();
  const { _id, __v, createdAt, ...rest } = left;
  assert.deepStrictEqual(rest, { googleId: 'g-young', underage: true });
  const again = await (await google(JSON.stringify({ sub: 'g-young', email: 'y@example.com', email_verified: true }))).json();
  assert.strictEqual(again.user.id, user.id);
  assert.strictEqual(again.user.adult, false);
});

const patchMe = (token, body) =>
  fetch(`${base}/api/me`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const getMe = async (token) => (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json();

test('PATCH /me saves a filtered, trimmed bio and an empty bio clears it', async () => {
  const { token, user } = await (await google(JSON.stringify({ sub: 'g-bio', email_verified: true }))).json();
  assert.strictEqual(user.bio, '');
  const res = await patchMe(token, { bio: '  love this shit  ' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).bio, 'love this ****');
  assert.strictEqual((await getMe(token)).bio, 'love this ****');
  assert.strictEqual((await patchMe(token, { bio: 'x'.repeat(161) })).status, 400);
  assert.strictEqual((await patchMe(token, { bio: 5 })).status, 400);
  assert.strictEqual((await patchMe(token, { bio: '' })).status, 200);
  assert.strictEqual((await getMe(token)).bio, '');
});

test('PATCH /me sets and removes a small JPEG photo, rejects anything else', async () => {
  const { token } = await (await google(JSON.stringify({ sub: 'g-photo', email_verified: true }))).json();
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  assert.strictEqual((await patchMe(token, { photo, bio: 'hi' })).status, 200);
  assert.strictEqual((await getMe(token)).photo, photo);

  const bad = [
    'data:image/png;base64,iVBORw0KGgo=',
    `data:image/jpeg;base64,${'A'.repeat(64 * 1024)}`,
    5,
  ];
  for (const p of bad) {
    const res = await patchMe(token, { photo: p });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: 'photo must be a small JPEG' });
  }

  assert.strictEqual((await patchMe(token, { name: 'Ana' })).status, 200);
  const me = await getMe(token);
  assert.strictEqual(me.name, 'Ana');
  assert.strictEqual(me.photo, photo);
  assert.strictEqual(me.bio, 'hi');

  assert.strictEqual((await patchMe(token, { photo: null })).status, 200);
  assert.ok(!('photo' in (await getMe(token))));
  assert.strictEqual((await User.findOne({ googleId: 'g-photo' }).lean()).photo, undefined);
});

const invite = (token) => fetch(`${base}/api/me/invite`, { headers: { authorization: `Bearer ${token}` } });
const publicInvite = async (code, at = base) => {
  const res = await fetch(`${at}/api/invite/${code}`);
  return { status: res.status, body: await res.json() };
};
const friendIds = async (token) =>
  (await (await fetch(`${base}/api/friends`, { headers: { authorization: `Bearer ${token}` } })).json()).friends.map((f) => f.id);

test('GET /me/invite makes one stable 10 hex code, also for parallel first calls; 401 without a token', async () => {
  assert.strictEqual((await fetch(`${base}/api/me/invite`)).status, 401);
  const token = sign((await User.create({ googleId: 'g-invite' }))._id);
  const parallel = await Promise.all([invite(token), invite(token)]);
  const codes = [...(await Promise.all(parallel.map((r) => r.json()))), await (await invite(token)).json()].map((b) => b.code);
  assert.match(codes[0], /^[0-9a-f]{10}$/);
  assert.deepStrictEqual(codes, [codes[0], codes[0], codes[0]]);
});

test('GET /invite/:code shows only the first name and photo; 400 bad format, 404 unknown or underage, 429 over 60 an hour', async () => {
  const photo = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  await User.create([
    { googleId: 'g-pub-1', email: 'p@example.com', phone: '+919800000101', name: 'Priya Devi', bio: 'hi', photo, calls: 3, inviteCode: '0123456789' },
    { googleId: 'g-pub-2', inviteCode: '0123456788' },
    { googleId: 'g-pub-3', name: 'Kid', inviteCode: '0123456787', underage: true },
  ]);
  assert.deepStrictEqual(await publicInvite('0123456789'), { status: 200, body: { name: 'Priya', photo } });
  assert.deepStrictEqual(await publicInvite('0123456788'), { status: 200, body: { name: '' } });
  for (const code of ['0123456787', 'ffffffffff']) {
    assert.deepStrictEqual(await publicInvite(code), { status: 404, body: { error: 'invite not found' } });
  }
  for (const code of ['012345678', '01234567890', 'ABCDEF0123', '%7B%7D']) assert.strictEqual((await publicInvite(code)).status, 400);

  const fresh = await start({ JWT_SECRET });
  for (let i = 0; i < 60; i++) assert.strictEqual((await publicInvite('ffffffffff', fresh)).status, 404);
  assert.strictEqual((await publicInvite('ffffffffff', fresh)).status, 429);
});

test('google sign-in with ref: a new account is invited and befriended; an existing account and bad refs change nothing', async () => {
  const [inviter, other] = await User.create([
    { googleId: 'g-ref-1', inviteCode: 'aaaaaaaaaa' },
    { googleId: 'g-ref-2', inviteCode: 'bbbbbbbbbb' },
    { googleId: 'g-ref-3', inviteCode: 'dddddddddd', underage: true },
  ]);
  const cred = (sub) => JSON.stringify({ sub, email_verified: true });
  const res = await google(cred('g-ref-new'), base, { ref: 'aaaaaaaaaa' });
  assert.strictEqual(res.status, 200);
  const { token, user } = await res.json();
  assert.strictEqual(String((await User.findById(user.id).lean()).invitedBy), String(inviter._id));
  assert.deepStrictEqual(await friendIds(token), [String(inviter._id)]);
  assert.deepStrictEqual(await friendIds(sign(inviter._id)), [user.id]);

  // An existing account signing in with another code is unchanged.
  assert.strictEqual((await google(cred('g-ref-new'), base, { ref: 'bbbbbbbbbb' })).status, 200);
  assert.strictEqual(String((await User.findById(user.id).lean()).invitedBy), String(inviter._id));
  assert.deepStrictEqual(await friendIds(sign(other._id)), []);

  // Unknown, underage, malformed or non-string refs are ignored and sign-in still works.
  const bad = ['cccccccccc', 'dddddddddd', 'AAAAAAAAAA', { $ne: null }, ['aaaaaaaaaa'], 5];
  for (const [i, ref] of bad.entries()) {
    const r = await google(cred(`g-ref-bad-${i}`), base, { ref });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await User.findById((await r.json()).user.id).lean()).invitedBy, undefined);
  }
  assert.deepStrictEqual(await friendIds(sign(inviter._id)), [user.id]);
});

test('recordStreak: an invited adult\'s first call counts once for the inviter; underage or uninvited users count nothing', async () => {
  const env = { STREAK_TZ: 'Asia/Kolkata' };
  const now = new Date('2026-03-01T06:00:00Z');
  const inviter = await User.create({ googleId: 'g-count-1' });
  const [invited, young, plain] = await User.create([
    { googleId: 'g-count-2', invitedBy: inviter._id },
    { googleId: 'g-count-3', invitedBy: inviter._id, underage: true },
    { googleId: 'g-count-4' },
  ]);
  assert.deepStrictEqual(await recordStreak(invited._id, env, now), { count: 1, best: 1 });
  let me = await getMe(sign(inviter._id));
  assert.strictEqual(me.referrals, 1);
  assert.deepStrictEqual(me.badges.filter((b) => b.earned).map((b) => b.id), ['invite-1']);

  await recordStreak(invited._id, env, now);
  await recordStreak(young._id, env, now);
  await recordStreak(plain._id, env, now);
  me = await getMe(sign(inviter._id));
  assert.strictEqual(me.referrals, 1);
  assert.strictEqual(me.calls, 0);
  assert.strictEqual((await User.findById(invited._id).lean()).calls, 2);
  const after = await User.findById(plain._id).lean();
  assert.strictEqual(after.calls, 1);
  assert.strictEqual(after.referrals, undefined);
});

test('deleting an inviter unsets invitedBy on the users it invited', async () => {
  const inviter = await User.create({ googleId: 'g-del-1' });
  const invited = await User.create({ googleId: 'g-del-2', invitedBy: inviter._id });
  const del = await fetch(`${base}/api/me`, { method: 'DELETE', headers: { authorization: `Bearer ${sign(inviter._id)}` } });
  assert.strictEqual(del.status, 204);
  assert.strictEqual((await User.findById(invited._id).lean()).invitedBy, undefined);
});
