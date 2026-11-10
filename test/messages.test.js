const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const User = require('../src/models/user');
const Ban = require('../src/models/ban');
const Friendship = require('../src/models/friendship');
const Message = require('../src/models/message');

const JWT_SECRET = 'test-jwt-secret';
let server;
let wss;
let base;
let url;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_messages_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Friendship.init(), Message.init(), Ban.init()]);
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

const api = async (method, path, user, body) => {
  const headers = { authorization: `Bearer ${sign(user._id)}`, ...(body !== undefined && { 'content-type': 'application/json' }) };
  const res = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const say = (from, to, text) => api('POST', `/api/friends/${to._id}/messages`, from, { text });

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

/** An app socket that said hello as this user. */
async function hello(user) {
  const ws = await connect();
  ws.json({ type: 'hello', token: sign(user._id) });
  await ws.waitFor('welcome');
  return ws;
}

const closed = (ws) => new Promise((resolve) => ws.on('close', (code) => resolve(code)));
const hangUp = async (...sockets) => {
  sockets.forEach((ws) => ws.close());
  await sleep(80);
};

const users = (...names) => User.create(names.map((name) => ({ phone: `+9197${crypto.randomInt(10000000, 99999999)}`, name })));
const befriend = (a, b, status = 'accepted') =>
  Friendship.create({ users: Friendship.pair(a._id, b._id), requester: a._id, status, acceptedAt: new Date(Date.now() - 60000) });

test('send and history: order, more, before paging and validation', async () => {
  const [ua, ub] = await users('Asha', 'Ravi');
  await befriend(ua, ub);

  const sent = await say(ua, ub, '  hello there  ');
  assert.strictEqual(sent.status, 201);
  assert.strictEqual(sent.body.message.text, 'hello there');
  assert.strictEqual(sent.body.message.from, String(ua._id));
  assert.strictEqual(sent.body.message.to, String(ub._id));
  assert.strictEqual(sent.body.message.readAt, null);

  // 54 older messages with distinct times, both directions.
  const t0 = Date.now() - 3600000;
  await Message.insertMany(
    Array.from({ length: 54 }, (_, i) => ({ from: i % 2 ? ua._id : ub._id, to: i % 2 ? ub._id : ua._id, text: `m${i}`, createdAt: new Date(t0 + i * 1000) }))
  );
  const page1 = await api('GET', `/api/friends/${ub._id}/messages`, ua);
  assert.strictEqual(page1.status, 200);
  assert.strictEqual(page1.body.messages.length, 50);
  assert.strictEqual(page1.body.more, true);
  assert.strictEqual(page1.body.messages[49].text, 'hello there'); // oldest first, newest last
  assert.strictEqual(page1.body.messages[0].text, 'm5');
  const before = page1.body.messages[0].at;
  const page2 = await api('GET', `/api/friends/${ua._id}/messages?before=${encodeURIComponent(before)}`, ub);
  assert.deepStrictEqual(page2.body.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.strictEqual(page2.body.more, false);

  assert.strictEqual((await api('GET', `/api/friends/${ub._id}/messages?before=nope`, ua)).status, 400);
  assert.strictEqual((await api('GET', `/api/friends/${ub._id}/messages?before=a&before=b`, ua)).body.error, 'invalid before');

  for (const text of ['', '   ', 'x'.repeat(501), 42, null]) {
    const res = await say(ua, ub, text);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'invalid message');
  }
  assert.strictEqual((await say(ua, ub, 'x'.repeat(500))).status, 201);
  assert.strictEqual((await say(ua, ub, 'oh shit no')).body.message.text, 'oh **** no');
});

test('non-friends and pending requests get 404; bad ids 400', async () => {
  const [ua, ub, uc] = await users('Asha', 'Ravi', 'Kiran');
  await befriend(ua, ub, 'pending');
  for (const other of [ub, uc]) {
    assert.deepStrictEqual(await say(ua, other, 'hi'), { status: 404, body: { error: 'not friends' } });
    assert.strictEqual((await say(other, ua, 'hi')).status, 404);
    assert.strictEqual((await api('GET', `/api/friends/${other._id}/messages`, ua)).status, 404);
    assert.strictEqual((await api('POST', `/api/friends/${other._id}/read`, ua)).status, 404);
  }
  assert.strictEqual((await api('GET', '/api/friends/nope/messages', ua)).status, 400);
  assert.strictEqual(await Message.countDocuments({ from: ua._id }), 0);
});

test('live message push, unread counts, read receipts and the last preview', async () => {
  const [ua, ub, uc] = await users('Asha', 'Ravi', 'Kiran');
  await befriend(ua, ub);
  await befriend(ua, uc);
  const a = await hello(ua);
  const b = await hello(ub);
  const b2 = await hello(ub); // a second tab

  const { body } = await say(ua, ub, 'hey');
  for (const ws of [a, b, b2]) assert.deepStrictEqual((await ws.waitFor('message')).message, body.message);
  await say(ua, ub, 'you there?');
  await say(uc, ua, 'yo');

  const listB = await api('GET', '/api/friends', ub);
  const fa = listB.body.friends.find((f) => f.id === String(ua._id));
  assert.strictEqual(fa.unread, 2);
  assert.deepStrictEqual(fa.last, { text: 'you there?', mine: false, at: fa.last.at });
  assert.deepStrictEqual((await api('GET', '/api/friends/count', ub)).body, { incoming: 0, unread: 2 });

  // Newest conversation first: Kiran wrote last.
  const listA = await api('GET', '/api/friends', ua);
  assert.deepStrictEqual(listA.body.friends.map((f) => f.name), ['Kiran', 'Ravi']);
  assert.strictEqual(listA.body.friends[0].last.mine, false);
  assert.strictEqual(listA.body.friends[1].last.mine, true);
  assert.strictEqual(listA.body.friends[1].unread, 0);

  a.inbox.length = b.inbox.length = 0;
  assert.deepStrictEqual((await api('POST', `/api/friends/${ua._id}/read`, ub)).body, { ok: true });
  for (const ws of [a, b, b2]) {
    const read = await ws.waitFor('read');
    assert.strictEqual(read.reader, String(ub._id));
    assert.strictEqual(read.peer, String(ua._id));
  }
  assert.deepStrictEqual((await api('GET', '/api/friends/count', ub)).body, { incoming: 0, unread: 0 });
  const history = await api('GET', `/api/friends/${ua._id}/messages`, ub);
  assert.ok(history.body.messages.every((m) => m.readAt));

  // Nothing new to read: no event.
  await api('POST', `/api/friends/${ua._id}/read`, ub);
  await sleep(100);
  assert.ok(!a.inbox.some((m) => m.type === 'read'));
  await hangUp(a, b, b2);
});

test('presence: friends hear online and offline, non-friends hear nothing; online and lastSeen in GET /', async () => {
  const [ua, ub, uc] = await users('Asha', 'Ravi', 'Kiran');
  await befriend(ua, ub);
  const b = await hello(ub);
  const c = await hello(uc);

  const a = await hello(ua);
  const on = await b.waitFor('presence');
  assert.deepStrictEqual(on, { type: 'presence', userId: String(ua._id), online: true, lastSeen: null });
  let friend = (await api('GET', '/api/friends', ub)).body.friends[0];
  assert.strictEqual(friend.online, true);
  assert.strictEqual(friend.inCall, false);
  assert.strictEqual(friend.lastSeen, null);

  const a2 = await hello(ua); // a second tab: no new event
  await hangUp(a2);
  a.close();
  const off = await b.waitFor('presence');
  assert.strictEqual(off.online, false);
  assert.ok(off.lastSeen);
  assert.strictEqual(b.inbox.filter((m) => m.type === 'presence').length, 0);
  await sleep(50);
  friend = (await api('GET', '/api/friends', ub)).body.friends[0];
  assert.strictEqual(friend.online, false);
  assert.strictEqual(friend.lastSeen, off.lastSeen);

  assert.ok(!c.inbox.some((m) => m.type === 'presence'));
  await hangUp(b, c);
});

test('inCall is true while a friend is in a random-chat call', async () => {
  const [ua, ub] = await users('Asha', 'Ravi');
  await befriend(ua, ub);
  const x = await connect();
  const y = await connect();
  x.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(ua._id) });
  y.json({ type: 'join', deviceId: crypto.randomUUID() });
  await Promise.all([x.waitFor('matched'), y.waitFor('matched')]);
  assert.strictEqual((await api('GET', '/api/friends', ub)).body.friends[0].inCall, true);
  await hangUp(x, y);
  assert.strictEqual((await api('GET', '/api/friends', ub)).body.friends[0].inCall, false);
});

test('typing reaches a friend only, at most once per second', async () => {
  const [ua, ub, uc] = await users('Asha', 'Ravi', 'Kiran');
  await befriend(ua, ub);
  const a = await hello(ua);
  const b = await hello(ub);
  const c = await hello(uc);

  a.json({ type: 'typing', to: String(ub._id) });
  assert.deepStrictEqual(await b.waitFor('typing'), { type: 'typing', from: String(ua._id) });
  a.json({ type: 'typing', to: String(ub._id) }); // within a second: dropped
  await sleep(1050);
  a.json({ type: 'typing', to: String(uc._id) }); // not a friend
  a.json({ type: 'typing', to: 'nope' });
  c.json({ type: 'typing', to: String(ua._id) });
  await sleep(150);
  assert.ok(!b.inbox.some((m) => m.type === 'typing'));
  assert.ok(!c.inbox.some((m) => m.type === 'typing'));
  assert.ok(!a.inbox.some((m) => m.type === 'typing' || m.type === 'error'));
  await hangUp(a, b, c);
});

test('hello: bad tokens are refused, unknown types and one mode per socket', async () => {
  const [ua] = await users('Asha');
  for (const token of [undefined, 'nope', jwt.sign({ sub: String(ua._id) }, 'wrong'), sign(new mongoose.Types.ObjectId())]) {
    const ws = await connect();
    const done = closed(ws);
    ws.json({ type: 'hello', token });
    assert.strictEqual((await ws.waitFor('error')).message, 'unauthorized');
    assert.strictEqual(await done, 1008);
  }

  const a = await hello(ua);
  for (const type of ['hello', 'join', 'roomJoin']) {
    a.json({ type, token: sign(ua._id), deviceId: crypto.randomUUID(), roomId: String(new mongoose.Types.ObjectId()) });
    assert.strictEqual((await a.waitFor('error')).message, 'already joined');
  }
  a.json({ type: 'chat', text: 'hi' });
  assert.strictEqual((await a.waitFor('error')).message, 'unknown type');

  const r = await connect();
  r.json({ type: 'join', deviceId: crypto.randomUUID() });
  await r.waitFor('ready');
  r.json({ type: 'hello', token: sign(ua._id) });
  assert.strictEqual((await r.waitFor('error')).message, 'already joined');
  await hangUp(a, r);
});

test('unfriend and account deletion remove the messages', async () => {
  const [ua, ub, uc] = await users('Asha', 'Ravi', 'Kiran');
  await befriend(ua, ub);
  await befriend(ua, uc);
  await say(ua, ub, 'one');
  await say(ub, ua, 'two');
  await say(uc, ua, 'three');
  assert.strictEqual((await api('DELETE', `/api/friends/${ub._id}`, ua)).status, 200);
  assert.strictEqual(await Message.countDocuments(Message.between(ua._id, ub._id)), 0);
  assert.strictEqual(await Message.countDocuments(Message.between(ua._id, uc._id)), 1);

  // Blocking in a call removes the friendship and the messages too.
  const [ud, ue] = await users('Dev', 'Esha');
  await befriend(ud, ue);
  await say(ud, ue, 'four');
  const x = await connect();
  const y = await connect();
  x.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(ud._id) });
  await x.waitFor('ready');
  y.json({ type: 'join', deviceId: crypto.randomUUID(), token: sign(ue._id) });
  await Promise.all([x.waitFor('matched'), y.waitFor('matched')]);
  x.json({ type: 'block' });
  await y.waitFor('partnerLeft');
  await hangUp(x, y);
  assert.strictEqual(await Message.countDocuments(Message.between(ud._id, ue._id)), 0);

  assert.strictEqual((await api('DELETE', '/api/me', uc)).status, 204);
  assert.strictEqual(await Message.countDocuments({ $or: [{ from: uc._id }, { to: uc._id }] }), 0);
});

test('a banned sender gets 403', async () => {
  const [ua, ub] = await users('Asha', 'Ravi');
  await befriend(ua, ub);
  await Ban.create({ deviceId: String(ua._id), until: new Date(Date.now() + 60000) });
  assert.deepStrictEqual(await say(ua, ub, 'hi'), { status: 403, body: { error: 'banned' } });
  assert.strictEqual((await say(ub, ua, 'hi')).status, 201);
});
