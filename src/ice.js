const crypto = require('node:crypto');

/** ICE servers for the `ready` message: Google STUN plus TURN when configured. */
function iceServers(env = process.env, now = Date.now()) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = (env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
  if (!urls.length) return servers;

  if (env.TURN_SECRET) {
    // coturn REST API (use-auth-secret): username is the unix expiry time
    const username = String(Math.floor(now / 1000) + 3600);
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls, username, credential });
  } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  return servers;
}

module.exports = { iceServers };
