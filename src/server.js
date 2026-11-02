const http = require('http');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const { createSignalling } = require('./signalling');
const adminRoutes = require('./routes/admin');

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/** Builds the HTTP + WebSocket server. Does not listen or connect to MongoDB. */
function createServer({ env = process.env, waitMs, tickMs } = {}) {
  const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);

  const app = express();
  app.use(express.json());
  app.use(cors({ origin: allowedOrigins }));

  const server = http.createServer(app);
  const signalling = createSignalling({ server, allowedOrigins, waitMs, tickMs, env });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', mongo: MONGO_STATES[mongoose.connection.readyState] || 'unknown' });
  });
  if (env.ADMIN_TOKEN) app.use('/api/admin', adminRoutes(env.ADMIN_TOKEN, signalling.kick));

  return { app, server, wss: signalling.wss };
}

module.exports = { createServer };
