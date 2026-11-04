const express = require('express');
const mongoose = require('mongoose');

const Friendship = require('../models/friendship');
const User = require('../models/user');
const { streakView } = require('../streak');
const { authenticate, OBJECT_ID } = require('./auth');

/** Friends API: list, accept, decline, cancel and remove. */
function friendRoutes({ env, jwtSecret }) {
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
  const done = (res, found) => (found ? res.json({ ok: true }) : res.status(404).json({ error: 'request not found' }));

  router.get('/', db(async (req, res) => {
    const me = req.user._id;
    const rows = await Friendship.find({ users: me }).sort({ createdAt: -1 }).lean();
    const other = (f) => f.users.find((u) => !u.equals(me));
    const users = await User.find({ _id: { $in: rows.map(other) } }, 'name streak').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const f of rows) {
      const u = byId.get(String(other(f)));
      if (!u) continue;
      const who = { id: String(u._id), name: u.name || '' };
      if (f.status === 'accepted') out.friends.push({ ...who, streak: streakView(u, env), since: f.acceptedAt });
      else if (f.requester.equals(me)) out.outgoing.push({ requestId: String(f._id), to: who, createdAt: f.createdAt });
      else out.incoming.push({ requestId: String(f._id), from: who, createdAt: f.createdAt });
    }
    out.friends.sort((a, b) => b.since - a.since);
    res.json(out);
  }));

  router.get('/count', db(async (req, res) => {
    const incoming = await Friendship.countDocuments({ users: req.user._id, status: 'pending', requester: { $ne: req.user._id } });
    res.json({ incoming });
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
    if (!deletedCount) return res.status(404).json({ error: 'not friends' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = friendRoutes;
