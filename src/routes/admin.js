const crypto = require('node:crypto');
const express = require('express');

const Report = require('../models/report');
const Ban = require('../models/ban');
const User = require('../models/user');
const Room = require('../models/room');
const Connection = require('../models/matches');
const { UUID } = require('../signalling');
const { verifyToken, isAdmin, adult, OBJECT_ID } = require('./auth');
const { streakView, dayKey, previousDay } = require('../streak');

const PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const SERIES_DAYS = 14;
const REPORT_STATUSES = ['open', 'resolved', 'dismissed'];
const ROOM_STATUSES = ['scheduled', 'ended', 'cancelled'];

const digest = (value) => crypto.createHash('sha256').update(value).digest();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Reports from before #11 have no status and count as open.
const statusFilter = (status) => (status === 'open' ? { status: { $nin: ['resolved', 'dismissed'] } } : { status });

/** Page number from the query (default 1), or null when invalid. */
function parsePage(value) {
  if (value === undefined) return 1;
  const page = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : 0;
  return page >= 1 ? page : null;
}

/** { id, name, email } by id for the ids that are existing users. */
async function usersById(ids) {
  const userIds = [...new Set(ids.filter((id) => OBJECT_ID.test(id)))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }, 'name email').lean() : [];
  return new Map(users.map((u) => [String(u._id), { id: String(u._id), name: u.name || '', email: u.email || '' }]));
}

/** Calls, signups and reports per day for the last SERIES_DAYS days in STREAK_TZ, oldest first. */
async function dailySeries(env, now) {
  const days = [dayKey(now, env)];
  while (days.length < SERIES_DAYS) days.unshift(previousDay(days[0]));
  const since = new Date(now.getTime() - (SERIES_DAYS + 1) * DAY_MS);
  const timezone = env.STREAK_TZ || 'Asia/Kolkata';
  const perDay = async (model, field) => {
    const rows = await model.aggregate([
      { $match: { [field]: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone } }, n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.n]));
  };
  const [calls, signups, reports] = await Promise.all([
    perDay(Connection, 'connectedAt'),
    perDay(User, 'createdAt'),
    perDay(Report, 'createdAt'),
  ]);
  return days.map((date) => ({ date, calls: calls.get(date) || 0, signups: signups.get(date) || 0, reports: reports.get(date) || 0 }));
}

const roomView = (r, rooms) => ({
  id: String(r._id),
  name: r.name,
  hostName: r.hostName || '',
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  seats: r.tickets,
  sold: r.sold || 0,
  status: r.status,
  live: rooms.isLive(String(r._id)),
});

/**
 * Admin API: the x-admin-token header (when ADMIN_TOKEN is set) or the bearer token of a user in ADMIN_EMAILS.
 * onBan(deviceId, until) kicks live sockets; signalling and rooms give in-memory stats.
 */
function adminRoutes({ env, jwtSecret, onBan, signalling, rooms }) {
  const router = express.Router();
  const expected = env.ADMIN_TOKEN && digest(env.ADMIN_TOKEN);

  router.use(async (req, res, next) => {
    const token = req.get('x-admin-token');
    if (expected && token !== undefined && crypto.timingSafeEqual(digest(token), expected)) {
      req.admin = 'token';
      return next();
    }
    const [scheme, jwt] = (req.get('authorization') || '').split(' ');
    const id = scheme === 'Bearer' && verifyToken(jwt, jwtSecret);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    let user;
    try {
      user = await User.findById(id, 'email').lean();
    } catch {
      return res.status(500).json({ error: 'database error' });
    }
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!isAdmin(user, env)) return res.status(403).json({ error: 'forbidden' });
    req.admin = id;
    next();
  });

  router.get('/stats', async (req, res) => {
    const now = new Date();
    const ago = (days) => new Date(now.getTime() - days * DAY_MS);
    try {
      const [users, new7d, google, phone, adults, calls7d, avg, open, last24h, last7d, bans, upcoming, liveRooms, ended7d, series] =
        await Promise.all([
          User.countDocuments(),
          User.countDocuments({ createdAt: { $gte: ago(7) } }),
          User.countDocuments({ googleId: { $exists: true } }),
          User.countDocuments({ phone: { $exists: true } }),
          User.countDocuments({ dob: { $exists: true }, underage: { $ne: true } }),
          Connection.countDocuments({ connectedAt: { $gte: ago(7) } }),
          Connection.aggregate([{ $match: { connectedAt: { $gte: ago(7) } } }, { $group: { _id: null, ms: { $avg: '$callDuration' } } }]),
          Report.countDocuments(statusFilter('open')),
          Report.countDocuments({ createdAt: { $gte: ago(1) } }),
          Report.countDocuments({ createdAt: { $gte: ago(7) } }),
          Ban.countDocuments({ until: { $gt: now } }),
          Room.countDocuments({ status: 'scheduled', startsAt: { $gt: now } }),
          Room.countDocuments({ status: 'scheduled', startsAt: { $lte: now }, endsAt: { $gt: now } }),
          Room.countDocuments({ status: 'ended', endsAt: { $gte: ago(7) } }),
          dailySeries(env, now),
        ]);
      res.json({
        users: { total: users, new7d, google, phone, adults },
        online: { ...signalling.stats(), ...rooms.stats() },
        calls: { today: series[series.length - 1].calls, last7d: calls7d, avgSeconds7d: Math.round((avg[0]?.ms || 0) / 1000) },
        reports: { open, last24h, last7d },
        bans: { active: bans },
        rooms: { upcoming, live: liveRooms, ended7d },
        series,
      });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.get('/reports', async (req, res) => {
    const { status } = req.query;
    const page = parsePage(req.query.page);
    if ((status !== undefined && !REPORT_STATUSES.includes(status)) || !page) {
      return res.status(400).json({ error: `status must be one of ${REPORT_STATUSES.join(', ')}; page must be >= 1` });
    }
    const filter = status ? statusFilter(status) : {};
    try {
      const [reports, total] = await Promise.all([
        Report.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
        Report.countDocuments(filter),
      ]);
      const users = await usersById(reports.flatMap((r) => [r.reportedDevice, r.reporterDevice]));
      const items = reports.map((r) => ({
        ...r,
        status: r.status || 'open',
        reported: users.get(r.reportedDevice) || null,
        reporter: users.get(r.reporterDevice) || null,
      }));
      res.json({ items, total, page });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.patch('/reports/:id', async (req, res) => {
    const { status } = req.body || {};
    if (!OBJECT_ID.test(req.params.id) || !REPORT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `a report id and status (${REPORT_STATUSES.join(', ')}) are required` });
    }
    const update =
      status === 'open'
        ? { $set: { status }, $unset: { resolvedAt: 1, resolvedBy: 1 } }
        : { $set: { status, resolvedAt: new Date(), resolvedBy: req.admin } };
    try {
      const report = await Report.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
      if (!report) return res.status(404).json({ error: 'report not found' });
      res.json(report);
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  /** Admin view of users with calls, streak, active ban and reports against them. */
  async function userRows(users) {
    const ids = users.map((u) => String(u._id));
    const [bans, reports] = await Promise.all([
      Ban.find({ deviceId: { $in: ids }, until: { $gt: new Date() } }).lean(),
      Report.aggregate([{ $match: { reportedDevice: { $in: ids } } }, { $group: { _id: '$reportedDevice', n: { $sum: 1 } } }]),
    ]);
    const bannedUntil = new Map(bans.map((b) => [b.deviceId, b.until]));
    const against = new Map(reports.map((r) => [r._id, r.n]));
    return users.map((u) => {
      const id = String(u._id);
      return {
        id,
        name: u.name || '',
        email: u.email || '',
        phone: u.phone || '',
        adult: adult(u),
        underage: Boolean(u.underage),
        admin: isAdmin(u, env),
        createdAt: u.createdAt,
        calls: u.calls || 0,
        streak: streakView(u, env),
        bannedUntil: bannedUntil.get(id) || null,
        reportsAgainst: against.get(id) || 0,
      };
    });
  }

  router.get('/users', async (req, res) => {
    const { q = '' } = req.query;
    const page = parsePage(req.query.page);
    if (typeof q !== 'string' || q.length > MAX_QUERY_LENGTH || !page) {
      return res.status(400).json({ error: `q must be at most ${MAX_QUERY_LENGTH} characters; page must be >= 1` });
    }
    const term = q.trim();
    const regex = { $regex: escapeRegex(term), $options: 'i' };
    const filter = term ? { $or: [{ name: regex }, { email: regex }, { phone: regex }] } : {};
    try {
      const [users, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
        User.countDocuments(filter),
      ]);
      res.json({ items: await userRows(users), total, page });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.get('/users/:id', async (req, res) => {
    const { id } = req.params;
    if (!OBJECT_ID.test(id)) return res.status(400).json({ error: 'invalid user id' });
    try {
      const user = await User.findById(id).lean();
      if (!user) return res.status(404).json({ error: 'user not found' });
      const key = String(user._id);
      const [[row], recentReports, hosted] = await Promise.all([
        userRows([user]),
        Report.find({ reportedDevice: key }).sort({ createdAt: -1 }).limit(10).lean(),
        Room.countDocuments({ host: user._id }),
      ]);
      res.json({ ...row, recentReports, rooms: hosted });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.get('/bans', async (req, res) => {
    try {
      const bans = await Ban.find({ until: { $gt: new Date() } }).sort({ until: -1 }).lean();
      const users = await usersById(bans.map((b) => b.deviceId));
      res.json(bans.map((b) => ({ deviceId: b.deviceId, until: b.until, reason: b.reason || '', user: users.get(b.deviceId) || null })));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/bans', async (req, res) => {
    const { deviceId, hours } = req.body || {};
    if (typeof deviceId !== 'string' || !(UUID.test(deviceId) || OBJECT_ID.test(deviceId)) || typeof hours !== 'number' || !(hours > 0)) {
      return res.status(400).json({ error: 'deviceId (uuid or user id) and hours (> 0) are required' });
    }
    const id = deviceId.toLowerCase();
    const until = new Date(Date.now() + hours * 60 * 60 * 1000);
    try {
      await Ban.updateOne({ deviceId: id }, { until, reason: 'admin' }, { upsert: true });
      onBan(id, until);
      res.json({ deviceId: id, until });
    } catch (err) {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.delete('/bans/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    if (!(UUID.test(deviceId) || OBJECT_ID.test(deviceId))) return res.status(400).json({ error: 'deviceId must be a uuid or user id' });
    try {
      const { deletedCount } = await Ban.deleteOne({ deviceId: deviceId.toLowerCase() });
      res.json({ deleted: deletedCount });
    } catch (err) {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.get('/rooms', async (req, res) => {
    const { status } = req.query;
    const page = parsePage(req.query.page);
    if ((status !== undefined && !ROOM_STATUSES.includes(status)) || !page) {
      return res.status(400).json({ error: `status must be one of ${ROOM_STATUSES.join(', ')}; page must be >= 1` });
    }
    const filter = status ? { status } : {};
    try {
      const [docs, total] = await Promise.all([
        Room.find(filter).sort({ startsAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
        Room.countDocuments(filter),
      ]);
      res.json({ items: docs.map((r) => roomView(r, rooms)), total, page });
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/rooms/:id/cancel', async (req, res) => {
    const { id } = req.params;
    if (!OBJECT_ID.test(id)) return res.status(400).json({ error: 'invalid room id' });
    try {
      const room = await Room.findOneAndUpdate({ _id: id, status: 'scheduled' }, { $set: { status: 'cancelled' } }, { new: true }).lean();
      if (!room) return res.status(404).json({ error: 'no scheduled room with this id' });
      rooms.close(String(room._id));
      res.json(roomView(room, rooms));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  return router;
}

module.exports = adminRoutes;
