const crypto = require('node:crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const { createSignalling } = require('./signalling');
const { createRooms } = require('./rooms');
const adminRoutes = require('./routes/admin');
const { authRoutes } = require('./routes/auth');
const roomRoutes = require('./routes/rooms');

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/**
 * Builds the HTTP + WebSocket server. Does not listen or connect to MongoDB.
 * Outside production, missing JWT/OTP secrets fall back to random per-process ones (app.js refuses that in production).
 */
function createServer({ env = process.env, waitMs, tickMs, minuteMs = 60 * 1000 } = {}) {
  const jwtSecret = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const otpSecret = env.OTP_SECRET || crypto.randomBytes(32).toString('hex');
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: allowedOrigins }));
  app.set('trust proxy', Number(env.TRUST_PROXY) || false); // proxy hops, for per-IP OTP limits

  const server = http.createServer(app);
  const rooms = createRooms({ jwtSecret, minuteMs, env });
  const signalling = createSignalling({ server, rooms, allowedOrigins, waitMs, tickMs, env });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', mongo: MONGO_STATES[mongoose.connection.readyState] || 'unknown' });
  });
  app.use('/api', authRoutes({ env, jwtSecret, otpSecret, rooms }));
  app.use('/api/rooms', roomRoutes({ jwtSecret, rooms, minuteMs }));
  if (env.ADMIN_TOKEN) app.use('/api/admin', adminRoutes(env.ADMIN_TOKEN, (id, until) => {
      signalling.kick(id, until);
      rooms.kickUser(id);
    }));

  return { app, server, wss: signalling.wss };
}

module.exports = { createServer };
