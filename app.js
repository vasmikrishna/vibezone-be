require('dotenv').config();
const mongoose = require('mongoose');

const { createServer } = require('./src/server');

const PORT = Number(process.env.PORT) || 3001;

if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is required');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.OTP_SECRET)) {
  console.error('JWT_SECRET and OTP_SECRET are required in production');
  process.exit(1);
}

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
  } catch (err) {
    console.error('Error connecting to MongoDB:', err.message);
    process.exit(1);
  }

  const { server, wss } = createServer();
  server.listen(PORT, () => console.log(`[Server] listening on port ${PORT}`));

  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received, shutting down');
    setTimeout(() => process.exit(1), 10000).unref();
    wss.clients.forEach((ws) => ws.close(1001, 'server shutdown'));
    wss.close();
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  });
}

main();
