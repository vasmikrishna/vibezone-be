const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/user');
const Otp = require('../models/otp');
const Room = require('../models/room');
const Ticket = require('../models/ticket');
const Block = require('../models/block');
const Friendship = require('../models/friendship');
const { filterText } = require('../filter');
const { sendCode } = require('../sms');
const { streakView } = require('../streak');
const { badgesView } = require('../badges');

const PHONE = /^\+[1-9]\d{7,14}$/; // E.164
const CODE = /^\d{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const OTP_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_NAME_LENGTH = 30;
const MAX_BIO_LENGTH = 160;
// ponytail: photos live on the user doc as data URLs, capped at 64 KB; move to object storage (e.g. Cloudflare R2) with a URL on the user if they need to grow.
const MAX_PHOTO_LENGTH = 64 * 1024;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_CREDENTIAL_LENGTH = 4096;

const adult = (user) => Boolean(user.dob) && !user.underage;
// ponytail: admins are derived from ADMIN_EMAILS on each check, no stored role.
const isAdmin = (user, env) =>
  Boolean(user.email) &&
  (env.ADMIN_EMAILS || '').split(',').some((e) => e.trim() && e.trim().toLowerCase() === user.email.toLowerCase());
const userView = (user, env) => {
  const streak = streakView(user, env);
  return {
    id: String(user._id),
    name: user.name || '',
    bio: user.bio || '',
    ...(user.photo && { photo: user.photo }),
    ...(user.phone && { phone: user.phone }),
    ...(user.email && { email: user.email }),
    adult: adult(user),
    streak,
    calls: user.calls || 0,
    badges: badgesView(user, streak),
    ...(isAdmin(user, env) && { admin: true }),
  };
};

/** Default Google ID token check: resolves the token payload, rejects a bad token. */
function googleVerifier() {
  const client = new OAuth2Client();
  return async (idToken, audience) => (await client.verifyIdToken({ idToken, audience })).getPayload();
}

/** Returns the user id of a valid HS256 token, else null. */
function verifyToken(token, secret) {
  try {
    const { sub } = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return typeof sub === 'string' && OBJECT_ID.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

/** Express middleware: Authorization: Bearer <jwt>, sets req.user. */
function authenticate(secret) {
  return async (req, res, next) => {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    const id = scheme === 'Bearer' && verifyToken(token, secret);
    if (!id) return res.status(401).json({ error: 'unauthorized' });
    try {
      req.user = await User.findById(id);
    } catch {
      return res.status(500).json({ error: 'database error' });
    }
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
}

/** Sliding one-hour window: allow(key) is false once key was allowed max times in the last hour. */
function hourlyLimit(max) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v[v.length - 1] >= HOUR_MS) hits.delete(k);
    const recent = (hits.get(key) || []).filter((at) => t - at < HOUR_MS);
    if (recent.length >= max) return false;
    hits.set(key, [...recent, t]);
    return true;
  };
}

/** YYYY-MM-DD in the past, else null. */
function parseDob(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date.getUTCFullYear() >= 1900 && date <= new Date() ? date : null;
}

const isAdult = (dob) => Date.UTC(dob.getUTCFullYear() + 18, dob.getUTCMonth(), dob.getUTCDate()) <= Date.now();

function authRoutes({ env, jwtSecret, otpSecret, rooms, verifyGoogle = googleVerifier() }) {
  const router = express.Router();
  const auth = authenticate(jwtSecret);
  const perPhone = hourlyLimit(3);
  const perIp = hourlyLimit(10);
  const googlePerIp = hourlyLimit(30);
  const hash = (phone, code) => crypto.createHmac('sha256', otpSecret).update(`${phone}:${code}`).digest();
  const login = (user) => ({
    token: jwt.sign({ sub: String(user._id) }, jwtSecret, { algorithm: 'HS256', expiresIn: '30d' }),
    user: userView(user, env),
  });

  router.post('/auth/otp', async (req, res) => {
    const { phone } = req.body || {};
    if (typeof phone !== 'string' || !PHONE.test(phone)) return res.status(400).json({ error: 'phone must be E.164' });
    if (!perIp(req.ip) || !perPhone(phone)) return res.status(429).json({ error: 'too many codes, try later' });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    try {
      await Otp.updateOne(
        { phone },
        { codeHash: hash(phone, code).toString('hex'), attempts: 0, createdAt: new Date() },
        { upsert: true }
      );
    } catch {
      return res.status(500).json({ error: 'database error' });
    }
    try {
      if (await sendCode(env, phone, code)) return res.json({ sent: true });
    } catch (err) {
      console.error('[sms]', err.message);
    }
    await Otp.deleteOne({ phone }).catch(() => {});
    res.status(503).json({ error: 'sms unavailable' });
  });

  router.post('/auth/verify', async (req, res) => {
    const { phone, code } = req.body || {};
    if (typeof phone !== 'string' || !PHONE.test(phone) || typeof code !== 'string' || !CODE.test(code)) {
      return res.status(400).json({ error: 'phone and 6 digit code are required' });
    }
    try {
      // Every attempt counts, atomically, so parallel guesses cannot exceed MAX_ATTEMPTS.
      const otp = await Otp.findOneAndUpdate(
        { phone, attempts: { $lt: MAX_ATTEMPTS }, createdAt: { $gt: new Date(Date.now() - OTP_MS) } },
        { $inc: { attempts: 1 } }
      );
      const ok = otp && crypto.timingSafeEqual(Buffer.from(otp.codeHash, 'hex'), hash(phone, code));
      if (!ok || (await Otp.deleteOne({ _id: otp._id })).deletedCount !== 1) {
        return res.status(401).json({ error: 'invalid code' });
      }
      const user = await User.findOneAndUpdate({ phone }, { $setOnInsert: { phone } }, { upsert: true, new: true });
      res.json(login(user));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.post('/auth/google', async (req, res) => {
    if (!env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'google sign-in unavailable' });
    const { credential } = req.body || {};
    if (typeof credential !== 'string' || !credential || credential.length > MAX_CREDENTIAL_LENGTH) {
      return res.status(400).json({ error: 'credential is required' });
    }
    if (!googlePerIp(req.ip)) return res.status(429).json({ error: 'too many attempts, try later' });

    let payload = null;
    try {
      payload = await verifyGoogle(credential, env.GOOGLE_CLIENT_ID);
    } catch {
      // invalid, expired or for another client id
    }
    if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.email_verified !== true) {
      return res.status(401).json({ error: 'invalid google token' });
    }
    const { sub: googleId, email } = payload;
    try {
      let user = await User.findOneAndUpdate(
        { googleId },
        { $setOnInsert: { googleId, ...(typeof email === 'string' && { email }) } },
        { upsert: true, new: true }
      );
      const name = typeof payload.given_name === 'string' ? filterText(payload.given_name.trim().slice(0, MAX_NAME_LENGTH)).trim() : '';
      if (!user.name && name) {
        user = (await User.findOneAndUpdate({ _id: user._id, name: { $in: [null, ''] } }, { $set: { name } }, { new: true })) || user;
      }
      res.json(login(user));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.get('/me', auth, (req, res) => res.json(userView(req.user, env)));

  router.patch('/me', auth, async (req, res) => {
    const { name, dob, bio, photo } = req.body || {};
    const update = {};
    if (name !== undefined) {
      const clean = typeof name === 'string' ? filterText(name.trim()) : '';
      if (!clean || clean.length > MAX_NAME_LENGTH) return res.status(400).json({ error: 'name must be 1-30 characters' });
      update.name = clean;
    }
    if (bio !== undefined) {
      const clean = typeof bio === 'string' ? filterText(bio.trim()) : null;
      if (clean === null || clean.length > MAX_BIO_LENGTH) return res.status(400).json({ error: 'bio must be at most 160 characters' });
      update.bio = clean;
    }
    if (photo !== undefined && photo !== null) {
      if (typeof photo !== 'string' || photo.length > MAX_PHOTO_LENGTH || !JPEG_DATA_URL.test(photo)) {
        return res.status(400).json({ error: 'photo must be a small JPEG' });
      }
      update.photo = photo;
    }
    const user = req.user;
    if (dob !== undefined) {
      const date = parseDob(dob);
      if (!date) return res.status(400).json({ error: 'dob must be a past YYYY-MM-DD date' });
      if (user.underage) return res.status(403).json({ error: 'under 18' });
      if (user.dob && user.dob.getTime() !== date.getTime()) return res.status(409).json({ error: 'dob cannot be changed' });
      if (!isAdult(date)) {
        try {
          await User.updateOne({ _id: user._id }, { $set: { underage: true } });
        } catch {
          return res.status(500).json({ error: 'database error' });
        }
        return res.status(403).json({ error: 'under 18' });
      }
      update.dob = date;
    }
    try {
      // dob: null or the same date, so a parallel PATCH cannot change a set dob.
      const filter = update.dob ? { _id: user._id, dob: { $in: [null, update.dob] } } : { _id: user._id };
      const doc = { ...(Object.keys(update).length && { $set: update }), ...(photo === null && { $unset: { photo: 1 } }) };
      const saved = await User.findOneAndUpdate(filter, doc, { new: true });
      if (!saved) return res.status(409).json({ error: 'dob cannot be changed' });
      res.json(userView(saved, env));
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  router.delete('/me', auth, async (req, res) => {
    const { _id: id, phone, googleId, underage } = req.user;
    try {
      const booked = await Ticket.distinct('room', { user: id });
      await Room.updateMany({ _id: { $in: booked } }, { $inc: { sold: -1 } });
      await Ticket.deleteMany({ user: id });
      await Room.updateMany({ host: id, status: 'scheduled' }, { $set: { status: 'cancelled' } });
      await Room.updateMany({ host: id }, { $set: { hostName: '' } });
      await Block.deleteMany({ deviceId: String(id) });
      await Friendship.deleteMany({ users: id });
      // An underage phone or Google account keeps only the flag, so a new account cannot unlock rooms.
      if (underage) await User.replaceOne({ _id: id }, { ...(phone && { phone }), ...(googleId && { googleId }), underage: true });
      else await User.deleteOne({ _id: id });
    } catch {
      return res.status(500).json({ error: 'database error' });
    }
    rooms.kickUser(String(id));
    res.status(204).end();
  });

  return router;
}

module.exports = { authRoutes, authenticate, verifyToken, adult, isAdmin, hourlyLimit, OBJECT_ID };
