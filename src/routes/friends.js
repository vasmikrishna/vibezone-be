const express = require('express');
const mongoose = require('mongoose');

const Friendship = require('../models/friendship');
const User = require('../models/user');
const Ban = require('../models/ban');
const Message = require('../models/message');
const { filterText } = require('../filter');
const { streakView } = require('../streak');
const { authenticate, hourlyLimit, OBJECT_ID } = require('./auth');

const MAX_MESSAGE_LENGTH = 500;
const PAGE = 50;

/**
 * Friends API: list, accept, decline, cancel and remove, plus direct messages between accepted friends.
 * messages pushes to app sockets and knows who is online; inCall(userId) says who has a call partner.
 */
function friendRoutes({ env, jwtSecret, messages, inCall }) {
  // ponytail: hourly cap only; add a per-second burst cap if abuse shows up.
  const allowSend = hourlyLimit(600);
  const router = express.Router();
  router.use(authenticate(jwtSecret));
  for (const name of ['id', 'userId']) {
    router.param(name, (req, res, next, id) => {
      if (!OBJECT_ID.test(id)) return res.status(400).json({ error: 'invalid id' });
      req[name] = new mongoose.Types.ObjectId(id);
      next();
    });
  }
  const db = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  };
  const isFriend = (a, b) => Friendship.exists({ users: Friendship.pair(a, b), status: 'accepted' });
  const notFriends = (res) => res.status(404).json({ error: 'not friends' });
  const done = (res, found) => (found ? res.json({ ok: true }) : res.status(404).json({ error: 'request not found' }));

  router.get('/', db(async (req, res) => {
    const me = req.user._id;
    const rows = await Friendship.find({ users: me }).sort({ createdAt: -1 }).lean();
    const other = (f) => f.users.find((u) => !u.equals(me));
    // ponytail: photos go inline (up to 64 KB each); serve them from a URL if friend lists get long.
    const [users, counts] = await Promise.all([
      User.find({ _id: { $in: rows.map(other) } }, 'name streak photo lastSeen').lean(),
      Message.aggregate([{ $match: { to: me, readAt: null } }, { $group: { _id: '$from', n: { $sum: 1 } } }]),
    ]);
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const unread = new Map(counts.map((c) => [String(c._id), c.n]));
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const f of rows) {
      const u = byId.get(String(other(f)));
      if (!u) continue;
      const who = { id: String(u._id), name: u.name || '' };
      if (f.status === 'accepted') {
        out.friends.push({
          ...who,
          ...(u.photo && { photo: u.photo }),
          streak: streakView(u, env),
          since: f.acceptedAt,
          online: messages.online(who.id),
          inCall: inCall(who.id),
          lastSeen: u.lastSeen ? u.lastSeen.toISOString() : null,
          unread: unread.get(who.id) || 0,
          last: f.last ? { text: f.last.text, mine: f.last.from.equals(me), at: f.last.at } : null,
        });
      }
      else if (f.requester.equals(me)) out.outgoing.push({ requestId: String(f._id), to: who, createdAt: f.createdAt });
      else out.incoming.push({ requestId: String(f._id), from: who, createdAt: f.createdAt });
    }
    const newest = (f) => (f.last ? f.last.at : f.since);
    out.friends.sort((a, b) => newest(b) - newest(a));
    res.json(out);
  }));

  router.get('/count', db(async (req, res) => {
    const [incoming, unread] = await Promise.all([
      Friendship.countDocuments({ users: req.user._id, status: 'pending', requester: { $ne: req.user._id } }),
      Message.countDocuments({ to: req.user._id, readAt: null }),
    ]);
    res.json({ incoming, unread });
  }));

  const incoming = (req) => ({ _id: req.id, users: req.user._id, status: 'pending', requester: { $ne: req.user._id } });

  router.post('/requests/:id/accept', db(async (req, res) => {
    done(res, await Friendship.findOneAndUpdate(incoming(req), { $set: { status: 'accepted', acceptedAt: new Date() } }));
  }));

  router.post('/requests/:id/decline', db(async (req, res) => {
    done(res, (await Friendship.deleteOne(incoming(req))).deletedCount);
  }));

  router.delete('/requests/:id', db(async (req, res) => {
    done(res, (await Friendship.deleteOne({ _id: req.id, status: 'pending', requester: req.user._id })).deletedCount);
  }));

  router.delete('/:userId', db(async (req, res) => {
    const { deletedCount } = await Friendship.deleteOne({ users: Friendship.pair(req.user._id, req.userId), status: 'accepted' });
    if (!deletedCount) return notFriends(res);
    await Message.deleteMany(Message.between(req.user._id, req.userId));
    res.json({ ok: true });
  }));

  /** The newest 50 messages before `before` (default now), oldest first. */
  // ponytail: pages by createdAt, so messages in the same millisecond as `before` can be skipped; page by _id if that ever shows.
  router.get('/:userId/messages', db(async (req, res) => {
    const { before } = req.query;
    const until = before === undefined ? new Date() : new Date(typeof before === 'string' ? before : NaN);
    if (Number.isNaN(until.getTime())) return res.status(400).json({ error: 'invalid before' });
    if (!(await isFriend(req.user._id, req.userId))) return notFriends(res);
    const rows = await Message.find({ ...Message.between(req.user._id, req.userId), createdAt: { $lt: until } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(PAGE + 1)
      .lean();
    res.json({ messages: rows.slice(0, PAGE).reverse().map(Message.view), more: rows.length > PAGE });
  }));

  router.post('/:userId/messages', db(async (req, res) => {
    const me = req.user._id;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'invalid message' });
    if (!(await isFriend(me, req.userId))) return notFriends(res);
    if (await Ban.exists({ deviceId: String(me), until: { $gt: new Date() } })) return res.status(403).json({ error: 'banned' });
    if (!allowSend(String(me))) return res.status(429).json({ error: 'too many messages, try later' });
    const doc = await Message.create({ from: me, to: req.userId, text: filterText(text) });
    await Friendship.updateOne(
      { users: Friendship.pair(me, req.userId), status: 'accepted' },
      { $set: { last: { text: doc.text, from: me, at: doc.createdAt } } }
    );
    const message = Message.view(doc);
    for (const id of [me, req.userId]) messages.push(id, { type: 'message', message });
    res.status(201).json({ message });
  }));

  /** Marks the friend's messages to me as read and tells both users. */
  router.post('/:userId/read', db(async (req, res) => {
    const me = req.user._id;
    if (!(await isFriend(me, req.userId))) return notFriends(res);
    const at = new Date();
    const { modifiedCount } = await Message.updateMany({ from: req.userId, to: me, readAt: null }, { $set: { readAt: at } });
    if (modifiedCount) {
      const event = { type: 'read', reader: String(me), peer: String(req.userId), at: at.toISOString() };
      for (const id of [me, req.userId]) messages.push(id, event);
    }
    res.json({ ok: true });
  }));

  return router;
}

module.exports = friendRoutes;
