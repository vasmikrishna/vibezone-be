const crypto = require('node:crypto');
const express = require('express');

const Report = require('../models/report');
const Ban = require('../models/ban');
const { UUID } = require('../signalling');

const digest = (value) => crypto.createHash('sha256').update(value).digest();

/** Admin API guarded by the x-admin-token header. onBan(deviceId, until) kicks live sockets. */
function adminRoutes(adminToken, onBan) {
  const router = express.Router();
  const expected = digest(adminToken);

  router.use((req, res, next) => {
    const token = req.get('x-admin-token') || '';
    if (!crypto.timingSafeEqual(digest(token), expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  router.get('/reports', async (req, res) => {
    try {
      res.json(await Report.find().sort({ createdAt: -1 }).limit(200).lean());
    } catch (err) {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/bans', async (req, res) => {
    const { deviceId, hours } = req.body || {};
    if (typeof deviceId !== 'string' || !UUID.test(deviceId) || typeof hours !== 'number' || !(hours > 0)) {
      return res.status(400).json({ error: 'deviceId (uuid) and hours (> 0) are required' });
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
    try {
      const { deletedCount } = await Ban.deleteOne({ deviceId: req.params.deviceId.toLowerCase() });
      res.json({ deleted: deletedCount });
    } catch (err) {
      res.status(500).json({ error: 'database error' });
    }
  });

  return router;
}

module.exports = adminRoutes;
