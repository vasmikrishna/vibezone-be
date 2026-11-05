const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const User = require('../src/models/user');
const Block = require('../src/models/block');
const Friendship = require('../src/models/friendship');

const JWT_SECRET = 'test-jwt-secret';
let server;
let wss;
let base;
let url;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_friends_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Friendship.init(), Block.init()]);
  ({ server, wss } = createServer({ env: { JWT_SECRET, ADMIN_TOKEN: 'admin' }, waitMs: 150, tickMs: 20 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  url = base.replace('http', 'ws');
});

test.after(async () => {
  wss.clients.forEach((ws) => ws.terminate());
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await sleep(50);
  await mongoose.disconnect();
});

const sign = (id) => jwt.sign({ sub: String(id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' });

const api = async (method, path, token, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers } });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

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
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Two random-chat clients (token or null for a guest) matched with each other; returns [a, b, matchedA, matchedB]. */
async function call(userA, userB) {
  const a = await connect();
  const b = await connect();
  a.json({ type: 'join', deviceId: crypto.randomUUID(), name: userA ? userA.name : 'Guest', ...(userA && { token: sign(userA._id) }) });
  await a.waitFor('ready');
  b.json({ type: 'join', deviceId: crypto.randomUUID(), name: userB ? userB.name : 'Guest', ...(userB && { token: sign(userB._id) }) });
  const [ma, mb] = await Promise.all([a.waitFor('matched'), b.waitFor('matched')]);
  return [a, b, ma, mb];
}

const hangUp = async (...sockets) => {
  sockets.forEach((ws) => ws.close());
  await sleep(50);
};

const users = (...names) => User.create(names.map((name) => ({ phone: `+9198${crypto.randomInt(10000000, 99999999)}`, name })));

test('friend request in a call, accept over REST, and the next match says friends', async () => {
  const [ua, ub] = await users('Asha', 'Ravi');
  const [a, b, ma, mb] = await call(ua, ub);
  assert.strictEqual(ma.canAddFriend, true);
  assert.strictEqual(ma.friendStatus, 'none');
  assert.strictEqual(mb.friendStatus, 'none');

  a.json({ type: 'friendRequest' });
  assert.deepStrictEqual(await a.waitFor('friendStatus'), { type: 'friendStatus', status: 'requested' });
  assert.deepStrictEqual(await b.waitFor('friendRequestReceived'), { type: 'friendRequestReceived', name: 'Asha' });
  // A repeat request stays requested.
  a.json({ type: 'friendRequest' });
  assert.strictEqual((await a.waitFor('friendStatus')).status, 'requested');

  const tb = sign(ub._id);
  const ta = sign(ua._id);
  assert.deepStrictEqual((await api('GET', '/api/friends/count', tb)).body, { incoming: 1 });
  const listB = (await api('GET', '/api/friends', tb)).body;
  assert.strictEqual(listB.incoming.length, 1);
  assert.deepStrictEqual(listB.incoming[0].from, { id: String(ua._id), name: 'Asha' });
  const listA = (await api('GET', '/api/friends', ta)).body;
  assert.deepStrictEqual(listA.outgoing[0].to, { id: String(ub._id), name: 'Ravi' });
  await hangUp(a, b);

  const { requestId } = listB.incoming[0];
  assert.strictEqual((await api('POST', `/api/friends/requests/${requestId}/accept`, ta)).status, 404); // requester cannot accept
  assert.deepStrictEqual((await api('POST', `/api/friends/requests/${requestId}/accept`, tb)).body, { ok: true });
  for (const [token, other] of [[ta, ub], [tb, ua]]) {
    const { friends, incoming, outgoing } = (await api('GET', '/api/friends', token)).body;
    assert.strictEqual(friends.length, 1);
    assert.deepStrictEqual(Object.keys(friends[0]).sort(), ['id', 'name', 'since', 'streak']);
    assert.strictEqual(friends[0].id, String(other._id));
    assert.deepStrictEqual(friends[0].streak, { count: 0, best: 0 });
    assert.deepStrictEqual([incoming, outgoing], [[], []]);
  }

  const [a2, b2, ma2, mb2] = await call(ua, ub);
  assert.strictEqual(ma2.friendStatus, 'friends');
  assert.strictEqual(mb2.friendStatus, 'friends');
  a2.json({ type: 'friendRequest' });
  assert.strictEqual((await a2.waitFor('friendStatus')).status, 'friends');

  const admin = await api('GET', `/api/admin/users/${ua._id}`, null, { 'x-admin-token': 'admin' });
  assert.strictEqual(admin.body.friends, 1);
  await hangUp(a2, b2);
});

test('mutual requests auto-accept; a pending request shows as requested/incoming on match', async () => {
  const [ua, ub] = await users('Mira', 'Dev');
  const [a, b] = await call(ua, ub);
  a.json({ type: 'friendRequest' });
  await a.waitFor('friendStatus');
  await hangUp(a, b);

  const [a2, b2, ma, mb] = await call(ua, ub);
  assert.strictEqual(ma.friendStatus, 'requested');
  assert.strictEqual(mb.friendStatus, 'incoming');
  b2.json({ type: 'friendRequest' });
  assert.strictEqual((await b2.waitFor('friendStatus')).status, 'friends');
  assert.strictEqual((await a2.waitFor('friendStatus')).status, 'friends');
  const doc = await Friendship.findOne({ users: Friendship.pair(ua._id, ub._id) }).lean();
  assert.strictEqual(doc.status, 'accepted');
  assert.ok(doc.acceptedAt);
  await hangUp(a2, b2);
});

test('guests cannot add friends, and nobody can add a guest', async () => {
  const [ua] = await users('Lena');
  const [a, guest, ma, mg] = await call(ua, null);
  assert.strictEqual(ma.canAddFriend, false);
  assert.strictEqual(mg.canAddFriend, false);
  a.json({ type: 'friendRequest' });
  assert.strictEqual((await a.waitFor('error')).message, 'partner is a guest');
  guest.json({ type: 'friendRequest' });
  assert.strictEqual((await guest.waitFor('error')).message, 'sign in to add friends');
  await hangUp(a, guest);
});

test('decline, cancel and remove; 400 for bad ids, 404 for others, 401 without a token', async () => {
  const [ua, ub, uc] = await users('Ana', 'Ben', 'Cy');
  const [ta, tb, tc] = [ua, ub, uc].map((u) => sign(u._id));
  const pending = (from, to) => Friendship.create({ users: Friendship.pair(from._id, to._id), requester: from._id, status: 'pending' });

  assert.strictEqual((await api('GET', '/api/friends')).status, 401);
  assert.strictEqual((await api('POST', '/api/friends/requests/nope/accept', ta)).status, 400);
  assert.strictEqual((await api('POST', '/api/friends/requests/nope/decline', ta)).status, 400);
  assert.strictEqual((await api('DELETE', '/api/friends/requests/nope', ta)).status, 400);
  assert.strictEqual((await api('DELETE', '/api/friends/nope', ta)).status, 400);

  const r1 = await pending(ua, ub);
  assert.strictEqual((await api('POST', `/api/friends/requests/${r1._id}/decline`, tc)).status, 404);
  assert.strictEqual((await api('POST', `/api/friends/requests/${r1._id}/decline`, ta)).status, 404);
  assert.deepStrictEqual((await api('POST', `/api/friends/requests/${r1._id}/decline`, tb)).body, { ok: true });
  assert.strictEqual(await Friendship.exists({ _id: r1._id }), null);

  const r2 = await pending(ua, ub);
  assert.strictEqual((await api('DELETE', `/api/friends/requests/${r2._id}`, tb)).status, 404);
  assert.deepStrictEqual((await api('DELETE', `/api/friends/requests/${r2._id}`, ta)).body, { ok: true });
  assert.strictEqual((await api('DELETE', `/api/friends/requests/${r2._id}`, ta)).status, 404);

  const r3 = await pending(ua, ub);
  assert.strictEqual((await api('DELETE', `/api/friends/${ub._id}`, ta)).status, 404); // pending, not friends
  await api('POST', `/api/friends/requests/${r3._id}/accept`, tb);
  assert.strictEqual((await api('DELETE', `/api/friends/${uc._id}`, ta)).status, 404);
  assert.deepStrictEqual((await api('DELETE', `/api/friends/${ua._id}`, tb)).body, { ok: true });
  assert.strictEqual(await Friendship.exists({ _id: r3._id }), null);
  assert.strictEqual((await api('GET', '/api/friends', tc)).body.friends.length, 0);
});

test('blocking removes the friendship and stops new requests', async () => {
  const [ua, ub] = await users('Oli', 'Pia');
  await Friendship.create({ users: Friendship.pair(ua._id, ub._id), requester: ua._id, status: 'accepted', acceptedAt: new Date() });
  const [a, b] = await call(ua, ub);
  a.json({ type: 'block' });
  for (let i = 0; i < 100 && (await Friendship.exists({ users: Friendship.pair(ua._id, ub._id) })); i++) await sleep(10);
  assert.strictEqual(await Friendship.exists({ users: Friendship.pair(ua._id, ub._id) }), null);
  await hangUp(a, b);

  // A user-id block (as rooms store them) refuses a request in random chat.
  const [uc, ud] = await users('Quinn', 'Rae');
  await Block.create({ deviceId: String(ud._id), blockedDevice: String(uc._id) });
  const [c, d] = await call(uc, ud);
  c.json({ type: 'friendRequest' });
  assert.strictEqual((await c.waitFor('error')).message, 'blocked');
  assert.strictEqual(await Friendship.exists({ users: Friendship.pair(uc._id, ud._id) }), null);
  await hangUp(c, d);
});

test('deleting an account removes its friendships and requests', async () => {
  const [ua, ub, uc] = await users('Sam', 'Tia', 'Uma');
  await Friendship.create([
    { users: Friendship.pair(ua._id, ub._id), requester: ua._id, status: 'accepted', acceptedAt: new Date() },
    { users: Friendship.pair(ua._id, uc._id), requester: uc._id, status: 'pending' },
  ]);
  assert.strictEqual((await api('DELETE', '/api/me', sign(ua._id))).status, 204);
  assert.strictEqual(await Friendship.countDocuments({ users: ua._id }), 0);
  assert.deepStrictEqual((await api('GET', '/api/friends/count', sign(uc._id))).body, { incoming: 0 });
});

test('a friend request still reaches the last partner after the call ended', async () => {
  const [ua, ub] = await users('Kiran', 'Mala');
  const [a, b] = await call(ua, ub);
  a.json({ type: 'skip' });
  await b.waitFor('partnerLeft');

  b.json({ type: 'friendRequest' });
  assert.deepStrictEqual(await b.waitFor('friendStatus'), { type: 'friendStatus', status: 'requested' });
  assert.deepStrictEqual(await a.waitFor('friendRequestReceived'), { type: 'friendRequestReceived', name: 'Mala' });
  assert.strictEqual((await api('GET', '/api/friends/count', sign(ua._id))).body.incoming, 1);
});
