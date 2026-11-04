const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const { createServer } = require('../src/server');
const User = require('../src/models/user');
const Room = require('../src/models/room');
const Report = require('../src/models/report');
const Ban = require('../src/models/ban');

const JWT_SECRET = 'test-jwt-secret';
const ADMIN_TOKEN = 'test-admin-token';
let server;
let wss;
let base;
let admin;
let member;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sign = (id) => jwt.sign({ sub: String(id) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

function api(method, route, { token, adminToken, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (adminToken) headers['x-admin-token'] = adminToken;
  return fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test.before(async () => {
  await mongoose.connect('mongodb://127.0.0.1:27017/vibezone_admin_test');
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Room.init(), Report.init(), Ban.init()]);
  ({ server, wss } = createServer({ env: { JWT_SECRET, ADMIN_TOKEN, ADMIN_EMAILS: ' boss@vibezone.in , other@x.io' } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const a = await User.create({ email: 'Boss@VibeZone.in', name: 'Boss', googleId: 'g-boss' });
  const m = await User.create({ email: 'member@x.io', name: 'Mira Member', phone: '+919800000001', dob: new Date('1990-01-01') });
  admin = { user: a, token: sign(a._id) };
  member = { user: m, token: sign(m._id) };
});

test.after(async () => {
  wss.clients.forEach((ws) => ws.terminate());
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await sleep(50);
  await mongoose.disconnect();
});

test('admin by email: /me flag, bearer admin allowed, non-admin 403, no auth 401, admin token works', async () => {
  assert.strictEqual((await (await api('GET', '/api/me', { token: admin.token })).json()).admin, true);
  assert.ok(!('admin' in (await (await api('GET', '/api/me', { token: member.token })).json())));

  assert.strictEqual((await api('GET', '/api/admin/stats', { token: admin.token })).status, 200);
  assert.strictEqual((await api('GET', '/api/admin/stats', { token: member.token })).status, 403);
  assert.strictEqual((await api('GET', '/api/admin/stats')).status, 401);
  assert.strictEqual((await api('GET', '/api/admin/stats', { token: 'garbage' })).status, 401);
  assert.strictEqual((await api('GET', '/api/admin/stats', { adminToken: 'wrong' })).status, 401);
  assert.strictEqual((await api('GET', '/api/admin/stats', { adminToken: ADMIN_TOKEN })).status, 200);
});

test('stats shape and counts', async () => {
  await Report.deleteMany({});
  await Report.create({ reporterDevice: crypto.randomUUID(), reportedDevice: String(member.user._id), reason: 'spam' });
  const stats = await (await api('GET', '/api/admin/stats', { token: admin.token })).json();
  assert.deepStrictEqual(Object.keys(stats), ['users', 'online', 'calls', 'reports', 'bans', 'rooms', 'series']);
  assert.deepStrictEqual(stats.reports, { open: 1, last24h: 1, last7d: 1 });
  assert.deepStrictEqual(stats.online, { randomChat: 0, inCall: 0, roomsLive: 0, inRooms: 0 });
  assert.strictEqual(stats.users.google, 1);
  assert.strictEqual(stats.users.adults, 1);
  assert.strictEqual(stats.series.length, 14);
  const today = stats.series[13];
  assert.match(today.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(stats.series[0].date < today.date);
  assert.strictEqual(today.reports, 1);
  assert.strictEqual(today.signups, 2);
});

test('reports: list with reported user, PATCH status, filter by status, validation', async () => {
  await Report.deleteMany({});
  const r = await Report.create({ reporterDevice: crypto.randomUUID(), reportedDevice: String(member.user._id), reason: 'harassment' });
  await Report.create({ reporterDevice: crypto.randomUUID(), reportedDevice: crypto.randomUUID(), reason: 'spam' });

  const list = await (await api('GET', '/api/admin/reports?status=open', { token: admin.token })).json();
  assert.strictEqual(list.total, 2);
  assert.strictEqual(list.page, 1);
  const item = list.items.find((x) => x._id === String(r._id));
  assert.deepStrictEqual(item.reported, { id: String(member.user._id), name: 'Mira Member', email: 'member@x.io' });
  assert.strictEqual(item.reporter, null);

  const patched = await api('PATCH', `/api/admin/reports/${r._id}`, { token: admin.token, body: { status: 'resolved' } });
  const body = await patched.json();
  assert.strictEqual(body.status, 'resolved');
  assert.strictEqual(body.resolvedBy, String(admin.user._id));
  assert.ok(body.resolvedAt);

  assert.strictEqual((await (await api('GET', '/api/admin/reports?status=open', { token: admin.token })).json()).total, 1);
  assert.strictEqual((await (await api('GET', '/api/admin/reports?status=resolved', { adminToken: ADMIN_TOKEN })).json()).total, 1);

  assert.strictEqual((await api('PATCH', `/api/admin/reports/${r._id}`, { token: admin.token, body: { status: 'nope' } })).status, 400);
  assert.strictEqual((await api('PATCH', '/api/admin/reports/xyz', { token: admin.token, body: { status: 'open' } })).status, 400);
  const missing = new mongoose.Types.ObjectId();
  assert.strictEqual((await api('PATCH', `/api/admin/reports/${missing}`, { token: admin.token, body: { status: 'open' } })).status, 404);
  assert.strictEqual((await api('GET', '/api/admin/reports?status=bogus', { token: admin.token })).status, 400);
  assert.strictEqual((await api('GET', '/api/admin/reports?page=0', { token: admin.token })).status, 400);
});

test('users: search by q, escaped regex, detail with reports and hosted rooms', async () => {
  const byName = await (await api('GET', '/api/admin/users?q=mira', { token: admin.token })).json();
  assert.strictEqual(byName.total, 1);
  const row = byName.items[0];
  assert.strictEqual(row.id, String(member.user._id));
  assert.strictEqual(row.adult, true);
  assert.strictEqual(row.admin, false);
  assert.strictEqual(row.bannedUntil, null);
  assert.deepStrictEqual(row.streak, { count: 0, best: 0 });

  assert.strictEqual((await (await api('GET', '/api/admin/users?q=VIBEZONE.IN', { token: admin.token })).json()).items[0].admin, true);
  assert.strictEqual((await (await api('GET', '/api/admin/users?q=%2B9198', { token: admin.token })).json()).total, 1);
  assert.strictEqual((await (await api('GET', '/api/admin/users?q=.*', { token: admin.token })).json()).total, 0);
  assert.strictEqual((await (await api('GET', '/api/admin/users', { token: admin.token })).json()).total, 2);
  assert.strictEqual((await api('GET', `/api/admin/users?q=${'x'.repeat(101)}`, { token: admin.token })).status, 400);

  const detail = await (await api('GET', `/api/admin/users/${member.user._id}`, { token: admin.token })).json();
  assert.ok(detail.reportsAgainst >= 1);
  assert.ok(detail.recentReports.length >= 1);
  assert.strictEqual(detail.rooms, 0);
  assert.strictEqual((await api('GET', '/api/admin/users/xyz', { token: admin.token })).status, 400);
  assert.strictEqual((await api('GET', `/api/admin/users/${new mongoose.Types.ObjectId()}`, { token: admin.token })).status, 404);
});

test('bans: list active with user, delete validates the id', async () => {
  const until = new Date(Date.now() + 3600 * 1000);
  await Ban.create({ deviceId: String(member.user._id), until, reason: 'admin' });
  await Ban.create({ deviceId: crypto.randomUUID(), until: new Date(Date.now() - 1000), reason: 'old' });
  const bans = await (await api('GET', '/api/admin/bans', { token: admin.token })).json();
  assert.strictEqual(bans.length, 1);
  assert.strictEqual(bans[0].user.name, 'Mira Member');
  const users = await (await api('GET', '/api/admin/users?q=mira', { token: admin.token })).json();
  assert.strictEqual(new Date(users.items[0].bannedUntil).getTime(), until.getTime());
  assert.strictEqual((await api('DELETE', '/api/admin/bans/nope', { token: admin.token })).status, 400);
  assert.deepStrictEqual(await (await api('DELETE', `/api/admin/bans/${member.user._id}`, { token: admin.token })).json(), { deleted: 1 });
});

test('rooms: list by status and cancel closes a live room', async () => {
  const startsAt = new Date(Date.now() - 1000);
  const r = await Room.create({
    host: member.user._id,
    hostName: 'Mira',
    name: 'Live room',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60000),
    durationMin: 15,
    interactionMin: 5,
    tickets: 10,
  });
  const ws = new WebSocket(base.replace('http', 'ws'));
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(m)));
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'roomJoin', token: member.token, roomId: String(r._id) }));
  for (let i = 0; i < 100 && !inbox.some((m) => m.type === 'roomState'); i++) await sleep(10);

  const stats = await (await api('GET', '/api/admin/stats', { token: admin.token })).json();
  assert.deepStrictEqual([stats.online.roomsLive, stats.online.inRooms, stats.rooms.live], [1, 1, 1]);
  const list = await (await api('GET', '/api/admin/rooms?status=scheduled', { token: admin.token })).json();
  assert.strictEqual(list.total, 1);
  assert.deepStrictEqual(
    (({ name, hostName, seats, sold, status, live }) => ({ name, hostName, seats, sold, status, live }))(list.items[0]),
    { name: 'Live room', hostName: 'Mira', seats: 10, sold: 0, status: 'scheduled', live: true }
  );

  const cancel = await api('POST', `/api/admin/rooms/${r._id}/cancel`, { token: admin.token });
  assert.strictEqual(cancel.status, 200);
  assert.deepStrictEqual((({ status, live }) => ({ status, live }))(await cancel.json()), { status: 'cancelled', live: false });
  for (let i = 0; i < 100 && !inbox.some((m) => m.type === 'roomClosed'); i++) await sleep(10);
  assert.ok(inbox.some((m) => m.type === 'roomClosed'));
  assert.strictEqual((await Room.findById(r._id)).status, 'cancelled');
  assert.strictEqual((await api('POST', `/api/admin/rooms/${r._id}/cancel`, { token: admin.token })).status, 404);
  assert.strictEqual((await api('POST', '/api/admin/rooms/xyz/cancel', { token: admin.token })).status, 400);
  assert.strictEqual((await (await api('GET', '/api/admin/rooms?status=cancelled', { token: admin.token })).json()).total, 1);
  assert.strictEqual((await api('GET', '/api/admin/rooms?status=live', { token: admin.token })).status, 400);
  ws.close();
});
