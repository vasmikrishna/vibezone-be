const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const User = require('../src/models/user');
const Otp = require('../src/models/otp');
const Room = require('../src/models/room');
const Ticket = require('../src/models/ticket');
const Block = require('../src/models/block');
const Report = require('../src/models/report');
const Ban = require('../src/models/ban');

const JWT_SECRET = 'test-jwt-secret';
const OTP_SECRET = 'test-otp-secret';
const SMS_KEY = 'test-sms-key';
const ADMIN_TOKEN = 'test-admin-token';
const MINUTE_MS = 200; // a test "minute"
const servers = [];
let sms;
let smsUrl;
let base;
let url;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a server on a random port; returns its base URL. */
async function start(env, options = {}) {
  const { server, wss } = createServer({ env, minuteMs: MINUTE_MS, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, wss });
  return `http://127.0.0.1:${server.address().port}`;
}

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_rooms_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Otp.init(), Room.init(), Ticket.init(), Block.init(), Report.init()]);

  // Fake SMS provider: records every message.
  sms = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      sms.inbox.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      res.end('{}');
    });
  });
  sms.inbox = [];
  await new Promise((resolve) => sms.listen(0, '127.0.0.1', resolve));
  smsUrl = `http://127.0.0.1:${sms.address().port}/send`;

  base = await start({ JWT_SECRET, OTP_SECRET, SMS_API_URL: smsUrl, SMS_API_KEY: SMS_KEY, ADMIN_TOKEN });
  url = base.replace('http', 'ws');
});

test.after(async () => {
  for (const { server, wss } of servers) {
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  sms.closeAllConnections();
  await new Promise((resolve) => sms.close(resolve));
  await sleep(50);
  await mongoose.disconnect();
});

let phoneSeq = 0;
const newPhone = () => `+9198${String(Date.now()).slice(-6)}${String(phoneSeq++).padStart(2, '0')}`;

function api(method, route, { token, body, at = base } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${at}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const sign = (id, options = {}) => jwt.sign({ sub: String(id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d', ...options });

/** Creates an adult user directly in the database. */
async function adult(name = 'Asha') {
  const user = await User.create({ phone: newPhone(), name, dob: new Date('1990-01-01') });
  return { user, id: String(user._id), token: sign(user._id) };
}

/** Inserts a room starting startInMs from now, lasting durationMs. */
function room(host, { startInMs = 0, durationMs = 60000, interactionMin = 30, tickets = 10 } = {}) {
  const startsAt = new Date(Date.now() + startInMs);
  return Room.create({
    host: host.user._id,
    hostName: host.user.name,
    name: 'Test room',
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMs),
    durationMin: 15,
    interactionMin,
    tickets,
  });
}

async function book(roomDoc, ...users) {
  for (const u of users) assert.strictEqual((await api('POST', `/api/rooms/${roomDoc._id}/book`, { token: u.token })).status, 200);
}

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
  /** Latest roomState, dropping older ones. */
  ws.state = async () => {
    let last = await ws.waitFor('roomState');
    await sleep(30);
    for (let i; (i = ws.inbox.findIndex((m) => m.type === 'roomState')) >= 0; ) last = ws.inbox.splice(i, 1)[0];
    return last;
  };
  ws.json = (message) => ws.send(JSON.stringify(message));
  ws.closed = new Promise((resolve) => ws.on('close', resolve));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function roomJoin(u, roomDoc) {
  const ws = await connect();
  ws.json({ type: 'roomJoin', token: u.token, roomId: String(roomDoc._id) });
  return ws;
}

async function joined(u, roomDoc) {
  const ws = await roomJoin(u, roomDoc);
  await ws.waitFor('ready');
  return ws;
}

const closeAll = (...sockets) => sockets.forEach((ws) => ws.close());

async function otpCode(phone) {
  const before = sms.inbox.length;
  const res = await api('POST', '/api/auth/otp', { body: { phone } });
  assert.deepStrictEqual(await res.json(), { sent: true });
  assert.strictEqual(sms.inbox.length, before + 1);
  const message = sms.inbox[before];
  assert.strictEqual(message.to, phone);
  assert.strictEqual(message.auth, `Bearer ${SMS_KEY}`);
  return message.message.match(/\d{6}/)[0];
}

const verify = (phone, code) => api('POST', '/api/auth/verify', { body: { phone, code } });

test('OTP login: code is stored hashed, verifies once and returns a 30 day token', async () => {
  assert.strictEqual((await api('POST', '/api/auth/otp', { body: { phone: '9876543210' } })).status, 400);
  assert.strictEqual((await api('POST', '/api/auth/otp', { body: { phone: { $gt: '' } } })).status, 400);

  const phone = newPhone();
  const code = await otpCode(phone);
  const stored = await Otp.findOne({ phone }).lean();
  assert.match(stored.codeHash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(stored).includes(code));

  assert.strictEqual((await verify(phone, code === '000000' ? '111111' : '000000')).status, 401);
  const res = await verify(phone, code);
  assert.strictEqual(res.status, 200);
  const { token, user } = await res.json();
  assert.deepStrictEqual(user, { id: user.id, name: '', phone, adult: false, streak: { count: 0, best: 0 }, calls: 0, badges: user.badges });
  const { exp, iat } = jwt.decode(token);
  assert.strictEqual(exp - iat, 30 * 24 * 3600);
  assert.strictEqual((await verify(phone, code)).status, 401, 'a code works once');

  const me = await api('GET', '/api/me', { token });
  assert.deepStrictEqual(await me.json(), user);

  // Same response for an existing phone, and the same account.
  const again = await verify(phone, await otpCode(phone));
  assert.strictEqual((await again.json()).user.id, user.id);
});

test('OTP lockout after 5 wrong attempts', async () => {
  const phone = newPhone();
  const code = await otpCode(phone);
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.strictEqual((await verify(phone, wrong)).status, 401);
  assert.strictEqual((await verify(phone, code)).status, 401);
});

test('OTP sends are limited to 3 per phone and 10 per IP an hour', async () => {
  const at = await start({ JWT_SECRET, OTP_SECRET, SMS_API_URL: smsUrl, SMS_API_KEY: SMS_KEY });
  const send = (phone) => api('POST', '/api/auth/otp', { body: { phone }, at });
  const phone = newPhone();
  for (let i = 0; i < 3; i++) assert.strictEqual((await send(phone)).status, 200);
  assert.strictEqual((await send(phone)).status, 429); // still counts towards the IP limit
  for (let i = 0; i < 6; i++) assert.strictEqual((await send(newPhone())).status, 200);
  assert.strictEqual((await send(newPhone())).status, 429);
});

test('without an SMS provider: dev logs only the code, production returns 503 and logs nothing', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const dev = await start({});
  const phone = newPhone();
  assert.strictEqual((await api('POST', '/api/auth/otp', { body: { phone }, at: dev })).status, 200);
  const line = log.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(line, /\d{6}/);
  assert.ok(!line.includes(phone));

  log.mock.resetCalls();
  const prod = await start({ NODE_ENV: 'production', JWT_SECRET, OTP_SECRET });
  assert.strictEqual((await api('POST', '/api/auth/otp', { body: { phone: newPhone() }, at: prod })).status, 503);
  assert.strictEqual(log.mock.callCount(), 0);
});

test('refuses to start in production without JWT_SECRET and OTP_SECRET', () => {
  const app = path.join(__dirname, '..', 'app.js');
  const run = spawnSync(process.execPath, [app], {
    cwd: os.tmpdir(), // no .env here
    env: { PATH: process.env.PATH, NODE_ENV: 'production', MONGO_URI: 'mongodb://127.0.0.1:1/none', JWT_SECRET: 'x' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /JWT_SECRET and OTP_SECRET are required/);
});

test('auth failures: missing, malformed, wrong secret, wrong algorithm, expired and deleted users', async () => {
  const { id, user } = await adult();
  const bad = [
    undefined,
    'not-a-jwt',
    jwt.sign({ sub: id }, 'wrong-secret', { algorithm: 'HS256' }),
    jwt.sign({ sub: id }, JWT_SECRET, { algorithm: 'HS512' }),
    jwt.sign({ sub: id }, JWT_SECRET, { algorithm: 'HS256', expiresIn: -10 }),
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.`,
    sign('000000000000000000000000'),
    sign('{"$gt":""}'),
  ];
  for (const token of bad) {
    assert.strictEqual((await api('GET', '/api/me', { token })).status, 401);
    assert.strictEqual((await api('GET', '/api/rooms', { token })).status, 401);
  }
  const res = await fetch(`${base}/api/me`, { headers: { authorization: `Basic ${sign(id)}` } });
  assert.strictEqual(res.status, 401);
  assert.strictEqual((await api('GET', '/api/me', { token: sign(id) })).status, 200);
  assert.strictEqual(user.name, 'Asha');

  const ws = await connect();
  ws.json({ type: 'roomJoin', token: bad[3], roomId: '000000000000000000000000' });
  assert.strictEqual((await ws.waitFor('error')).message, 'unauthorized');
  closeAll(ws);
});

test('profile: adult dob is fixed once set; under 18 is rejected and blocks rooms for good', async () => {
  const user = await User.create({ phone: newPhone() });
  const token = sign(user._id);
  for (const dob of ['2000-02-30', '01/01/1990', 19900101, '2999-01-01']) {
    assert.strictEqual((await api('PATCH', '/api/me', { token, body: { dob } })).status, 400);
  }
  assert.strictEqual((await api('PATCH', '/api/me', { token, body: { name: '' } })).status, 400);

  const res = await api('PATCH', '/api/me', { token, body: { name: '  Ravi ', dob: '1995-06-15' } });
  const me = await res.json();
  assert.deepStrictEqual(me, { id: String(user._id), name: 'Ravi', phone: user.phone, adult: true, streak: { count: 0, best: 0 }, calls: 0, badges: me.badges });
  assert.strictEqual((await api('PATCH', '/api/me', { token, body: { name: 'Ravi', dob: '1995-06-15' } })).status, 200);
  assert.strictEqual((await api('PATCH', '/api/me', { token, body: { dob: '1990-06-15' } })).status, 409);

  const kid = await User.create({ phone: newPhone() });
  const kidToken = sign(kid._id);
  const now = new Date();
  const tooYoung = `${now.getUTCFullYear() - 17}-01-01`;
  assert.strictEqual((await api('PATCH', '/api/me', { token: kidToken, body: { dob: tooYoung } })).status, 403);
  assert.strictEqual((await api('PATCH', '/api/me', { token: kidToken, body: { dob: '1990-01-01' } })).status, 403);
  assert.strictEqual((await (await api('GET', '/api/me', { token: kidToken })).json()).adult, false);

  const host = await adult();
  const r = await room(host, { startInMs: 60000 });
  assert.strictEqual((await api('POST', `/api/rooms/${r._id}/book`, { token: kidToken })).status, 403);
  const create = { name: 'Kids', startsAt: new Date(Date.now() + 60000).toISOString(), durationMin: 30, interactionMin: 5, tickets: 5 };
  assert.strictEqual((await api('POST', '/api/rooms', { token: kidToken, body: create })).status, 403);

  // Deleting the account keeps the phone blocked.
  assert.strictEqual((await api('DELETE', '/api/me', { token: kidToken })).status, 204);
  const stub = await User.findOne({ phone: kid.phone }).lean();
  assert.strictEqual(stub.underage, true);
  assert.strictEqual(stub.dob, undefined);
});

test('create and list rooms', async () => {
  const host = await adult('Host');
  const startsAt = new Date(Date.now() + 3600000).toISOString();
  const good = { name: '  Book club  ', description: 'Talk', startsAt, durationMin: 60, interactionMin: 5, tickets: 2 };
  const invalid = [
    { ...good, name: 'ab' },
    { ...good, name: 'x'.repeat(61) },
    { ...good, description: 'x'.repeat(1001) },
    { ...good, startsAt: new Date(Date.now() - 1000).toISOString() },
    { ...good, startsAt: 'soon' },
    { ...good, durationMin: 14 },
    { ...good, durationMin: 181 },
    { ...good, interactionMin: 0 },
    { ...good, interactionMin: 31 },
    { ...good, tickets: 51 },
    { ...good, tickets: 1.5 },
    { ...good, tickets: '5' },
  ];
  for (const body of invalid) assert.strictEqual((await api('POST', '/api/rooms', { token: host.token, body })).status, 400);

  const res = await api('POST', '/api/rooms', { token: host.token, body: good });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.deepStrictEqual(created, {
    id: created.id,
    name: 'Book club',
    description: 'Talk',
    hostName: 'Host',
    startsAt,
    durationMin: 60,
    interactionMin: 5,
    tickets: 2,
    ticketsLeft: 2,
    booked: false,
    isHost: true,
    status: 'upcoming',
  });

  const guest = await adult();
  await book({ _id: created.id }, guest);
  const list = await (await api('GET', '/api/rooms', { token: guest.token })).json();
  const mine = list.find((r) => r.id === created.id);
  assert.deepStrictEqual([mine.booked, mine.isHost, mine.ticketsLeft], [true, false, 1]);
  const starts = list.map((r) => r.startsAt);
  assert.deepStrictEqual(starts, [...starts].sort());
});

test('booking: ids are validated, hosts cannot book, one ticket per user, no overbooking under a race', async () => {
  const host = await adult();
  const r = await room(host, { startInMs: 60000, tickets: 3 });
  assert.strictEqual((await api('POST', '/api/rooms/not-an-id/book', { token: host.token })).status, 400);
  assert.strictEqual((await api('POST', '/api/rooms/000000000000000000000000/book', { token: host.token })).status, 404);
  assert.strictEqual((await api('POST', `/api/rooms/${r._id}/book`, { token: host.token })).status, 403);

  const users = await Promise.all(Array.from({ length: 10 }, () => adult()));
  const results = await Promise.all(users.map((u) => api('POST', `/api/rooms/${r._id}/book`, { token: u.token })));
  const statuses = results.map((res) => res.status).sort();
  assert.deepStrictEqual(statuses, [200, 200, 200, 409, 409, 409, 409, 409, 409, 409]);
  assert.strictEqual((await Room.findById(r._id)).sold, 3);
  assert.strictEqual(await Ticket.countDocuments({ room: r._id }), 3);

  const holder = users[results.findIndex((res) => res.status === 200)];
  assert.strictEqual((await api('POST', `/api/rooms/${r._id}/book`, { token: holder.token })).status, 409);
  const unbook = await api('DELETE', `/api/rooms/${r._id}/book`, { token: holder.token });
  assert.deepStrictEqual([(await unbook.json()).ticketsLeft], [1]);
});

test('room join window: 10 minutes before start until end, ticket or host only', async () => {
  const host = await adult();
  const guest = await adult();
  const stranger = await adult();
  const early = await room(host, { startInMs: 11 * MINUTE_MS + 5000 });
  const open = await room(host, { startInMs: 9 * MINUTE_MS });
  const over = await room(host, { startInMs: -2000, durationMs: 1000 });
  await book(early, guest);
  await book(open, guest);
  await Ticket.create({ room: over._id, user: guest.user._id });

  for (const [u, r, message] of [
    [guest, early, 'room not open'],
    [host, early, 'room not open'],
    [guest, over, 'room not open'],
    [stranger, open, 'no ticket'],
  ]) {
    const ws = await roomJoin(u, r);
    assert.strictEqual((await ws.waitFor('error')).message, message);
    closeAll(ws);
  }
  const bad = await connect();
  bad.json({ type: 'roomJoin', token: guest.token, roomId: { $ne: null } });
  assert.strictEqual((await bad.waitFor('error')).message, 'invalid room');

  const h = await joined(host, open);
  const g = await joined(guest, open);
  assert.strictEqual((await g.state()).position, 1);
  h.json({ type: 'roomNext' });
  assert.strictEqual((await h.waitFor('error')).message, 'room not started');
  closeAll(h, g, bad);
});

test('queue in join order; roomNext runs 1-to-1 turns with forwarding and chat', async () => {
  const host = await adult('Host');
  const a = await adult('Anu');
  const b = await adult('Bala');
  const r = await room(host);
  await book(r, a, b);

  const h = await joined(host, r);
  const wa = await joined(a, r);
  const wb = await joined(b, r);
  const hostState = await h.state();
  assert.deepStrictEqual(hostState, {
    type: 'roomState',
    role: 'host',
    queue: [{ userId: a.id, name: 'Anu' }, { userId: b.id, name: 'Bala' }],
    current: null,
    endsAt: null,
  });
  assert.deepStrictEqual(await wb.state(), { type: 'roomState', role: 'attendee', queue: [], position: 2, current: null, endsAt: null });

  wa.json({ type: 'roomNext' });
  assert.strictEqual((await wa.waitFor('error')).message, 'host only');

  h.json({ type: 'roomNext' });
  const mh = await h.waitFor('matched');
  const ma = await wa.waitFor('matched');
  assert.deepStrictEqual([mh.role, mh.partnerId, mh.partnerName, mh.sharedTags], ['caller', a.id, 'Anu', []]);
  assert.deepStrictEqual([ma.role, ma.partnerId, ma.partnerName], ['callee', host.id, 'Host']);
  assert.ok(new Date(ma.endsAt) > new Date());
  const stateA = await wa.state();
  assert.deepStrictEqual([stateA.position, stateA.current, stateA.endsAt], [null, { userId: a.id, name: 'Anu' }, ma.endsAt]);
  assert.strictEqual((await wb.state()).position, 1);

  h.json({ type: 'offer', offer: { type: 'offer', sdp: 'sdp-h' } });
  assert.deepStrictEqual(await wa.waitFor('offer'), { type: 'offer', offer: { type: 'offer', sdp: 'sdp-h' } });
  wa.json({ type: 'chat', text: 'hi shit' });
  assert.strictEqual((await h.waitFor('chat')).text, 'hi ****');
  wb.json({ type: 'chat', text: 'me too' });
  assert.strictEqual((await wb.waitFor('error')).message, 'not in a call');

  h.json({ type: 'roomNext' });
  await wa.waitFor('partnerLeft');
  assert.strictEqual((await wb.waitFor('matched')).partnerId, host.id);
  assert.deepStrictEqual((await h.state()).current, { userId: b.id, name: 'Bala' });
  assert.ok(!wa.inbox.some((m) => m.type === 'matched'));

  // Attendee disconnecting ends the turn.
  wb.close();
  await h.waitFor('partnerLeft');
  assert.deepStrictEqual((await h.state()).current, null);
  closeAll(h, wa);
});

test('sessions end automatically at endsAt; the room closes at its end', async () => {
  const host = await adult();
  const a = await adult();
  const r = await room(host, { interactionMin: 1, durationMs: 1500 });
  await book(r, a);
  const h = await joined(host, r);
  const wa = await joined(a, r);
  h.json({ type: 'roomNext' });
  const { endsAt } = await wa.waitFor('matched');
  await wa.waitFor('partnerLeft');
  await h.waitFor('partnerLeft');
  assert.ok(Date.now() >= new Date(endsAt).getTime() - 20);
  assert.ok(Date.now() - new Date(endsAt).getTime() < 500);
  assert.strictEqual((await h.state()).current, null);

  await h.waitFor('roomClosed');
  await wa.waitFor('roomClosed');
  await sleep(50);
  assert.strictEqual((await Room.findById(r._id)).status, 'ended');
  closeAll(h, wa);
});

test('roomEnd is host only and closes the room for everyone', async () => {
  const host = await adult();
  const a = await adult();
  const r = await room(host);
  await book(r, a);
  const h = await joined(host, r);
  const wa = await joined(a, r);
  wa.json({ type: 'roomEnd' });
  assert.strictEqual((await wa.waitFor('error')).message, 'host only');
  h.json({ type: 'roomEnd' });
  await wa.waitFor('roomClosed');
  await h.waitFor('roomClosed');
  await sleep(50);
  assert.strictEqual((await Room.findById(r._id)).status, 'ended');
  const again = await roomJoin(a, r);
  assert.strictEqual((await again.waitFor('error')).message, 'room not found');
  closeAll(h, wa, again);
});

test('bans apply to rooms: three reporters auto-ban, and an admin ban by user id removes a live attendee', async () => {
  const host = await adult();
  const bad = await adult();
  const r = await room(host);
  await book(r, bad);
  await Report.create(['a', 'b'].map((reporterDevice) => ({ reporterDevice, reportedDevice: bad.id, reason: 'spam' })));
  const h = await joined(host, r);
  const wb = await joined(bad, r);
  h.json({ type: 'roomNext' });
  await wb.waitFor('matched');
  h.json({ type: 'report', reason: 'harassment' });
  await wb.waitFor('roomClosed');
  await sleep(100);
  assert.ok(await Ban.exists({ deviceId: bad.id }));
  const blockedOut = await adult();
  const banned = await roomJoin(bad, r);
  assert.strictEqual((await banned.waitFor('error')).message, 'banned');

  await book(r, blockedOut);
  const wv = await joined(blockedOut, r);
  const res = await fetch(`${base}/api/admin/bans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ deviceId: blockedOut.id, hours: 1 }),
  });
  assert.strictEqual(res.status, 200);
  await wv.waitFor('roomClosed');
  closeAll(h, banned, wv);
});

test('block ends the session; the blocked user cannot join or book that host again', async () => {
  const host = await adult();
  const a = await adult();
  const r = await room(host);
  const later = await room(host, { startInMs: 60000 });
  await book(r, a);
  const h = await joined(host, r);
  const wa = await joined(a, r);
  h.json({ type: 'roomNext' });
  await wa.waitFor('matched');
  h.json({ type: 'block' });
  await wa.waitFor('partnerLeft');
  await wa.waitFor('roomClosed');
  assert.deepStrictEqual((await h.state()).queue, []);
  await sleep(50);
  assert.ok(await Block.exists({ deviceId: host.id, blockedDevice: a.id }));

  const again = await roomJoin(a, r);
  assert.strictEqual((await again.waitFor('error')).message, 'no ticket');
  const res = await api('POST', `/api/rooms/${later._id}/book`, { token: a.token });
  assert.strictEqual(res.status, 403);
  closeAll(h, wa, again);
});

test('reports: in-session report saves chat evidence; HTTP report validates input; admin lists both', async () => {
  const host = await adult();
  const a = await adult();
  const r = await room(host);
  await book(r, a);
  const h = await joined(host, r);
  const wa = await joined(a, r);
  h.json({ type: 'roomNext' });
  await wa.waitFor('matched');
  h.json({ type: 'chat', text: 'hello' });
  await wa.waitFor('chat');
  wa.json({ type: 'report', reason: 'bogus' });
  assert.strictEqual((await wa.waitFor('error')).message, 'invalid reason');
  wa.json({ type: 'report', reason: 'harassment' });
  await h.waitFor('partnerLeft');
  await wa.waitFor('roomClosed');
  let report;
  for (let i = 0; i < 50 && !report; i++, await sleep(20)) report = await Report.findOne({ reporterDevice: a.id }).lean();
  assert.strictEqual(String(report.roomId), String(r._id));
  assert.strictEqual(report.reportedDevice, host.id);
  assert.deepStrictEqual(report.evidence.map(({ sender, text }) => ({ sender, text })), [{ sender: 'reported', text: 'hello' }]);
  closeAll(h, wa);

  const route = `/api/rooms/${r._id}/report`;
  assert.strictEqual((await api('POST', route, { token: a.token, body: { reason: 'nope' } })).status, 400);
  assert.strictEqual((await api('POST', route, { token: a.token, body: { reason: 'spam', userId: { $ne: null } } })).status, 400);
  assert.strictEqual((await api('POST', '/api/rooms/xyz/report', { token: a.token, body: { reason: 'spam' } })).status, 400);
  assert.strictEqual((await api('POST', route, { token: host.token, body: { reason: 'spam', userId: a.id } })).status, 201);

  const reports = await (await fetch(`${base}/api/admin/reports`, { headers: { 'x-admin-token': ADMIN_TOKEN } })).json();
  assert.ok(reports.some((x) => x.reporterDevice === host.id && x.reportedDevice === a.id && x.roomId === String(r._id)));
});

test('host cancels a room; only the host can', async () => {
  const host = await adult();
  const a = await adult();
  const r = await room(host);
  await book(r, a);
  const wa = await joined(a, r);
  assert.strictEqual((await api('DELETE', `/api/rooms/${r._id}`, { token: a.token })).status, 404);
  assert.strictEqual((await api('DELETE', `/api/rooms/${r._id}`, { token: host.token })).status, 204);
  await wa.waitFor('roomClosed');
  assert.strictEqual((await Room.findById(r._id)).status, 'cancelled');
  closeAll(wa);
});

test('account deletion removes tickets, cancels hosted rooms and invalidates the token', async () => {
  const host = await adult();
  const me = await adult();
  const theirs = await room(host);
  await book(theirs, me);
  const mine = await room(me, { startInMs: 60000 });
  const other = await adult();
  await book(mine, other);
  const ws = await joined(me, theirs);
  const h = await joined(host, theirs);

  assert.strictEqual((await api('DELETE', '/api/me', { token: me.token })).status, 204);
  await ws.waitFor('roomClosed');
  assert.deepStrictEqual((await h.state()).queue, []);
  assert.strictEqual(await User.exists({ _id: me.user._id }), null);
  assert.strictEqual(await Ticket.countDocuments({ user: me.user._id }), 0);
  assert.strictEqual((await Room.findById(theirs._id)).sold, 0);
  const cancelled = await Room.findById(mine._id);
  assert.deepStrictEqual([cancelled.status, cancelled.hostName], ['cancelled', '']);
  assert.strictEqual((await api('GET', '/api/me', { token: me.token })).status, 401);
  const list = await (await api('GET', '/api/rooms', { token: other.token })).json();
  assert.ok(!list.some((x) => x.id === String(mine._id)));
  closeAll(ws, h);
});
