const crypto = require('node:crypto');

let cloudflare = null; // { servers: [...], fetchedAt }

const hasCloudflare = (env) => Boolean(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN);
const notPort53 = (u) => !/:53(\?|$)/.test(u); // browsers block port 53

/** Fetches short-lived Cloudflare TURN credentials into the cache; a failure keeps the previous ones. */
async function refreshCloudflareTurn(env = process.env, fetchFn = fetch) {
  if (!hasCloudflare(env)) {
    cloudflare = null;
    return null;
  }
  try {
    const res = await fetchFn(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { urls, username, credential } = (await res.json()).iceServers;
    const usable = urls.filter(notPort53);
    cloudflare = {
      servers: [
        { urls: usable.filter((u) => u.startsWith('stun:')) },
        { urls: usable.filter((u) => /^turns?:/.test(u)), username, credential },
      ],
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.warn('[turn] Cloudflare credentials failed: ' + err.message);
  }
  return cloudflare;
}

/** Refreshes Cloudflare TURN now and every `intervalMs` (credentials last 24 h). Returns the timer or null. */
function startCloudflareTurn(env = process.env, { intervalMs = 6 * 60 * 60 * 1000, fetchFn } = {}) {
  if (!hasCloudflare(env)) return null;
  refreshCloudflareTurn(env, fetchFn);
  return setInterval(() => refreshCloudflareTurn(env, fetchFn), intervalMs).unref();
}

/** ICE servers for the `ready` message: Cloudflare (or Google STUN) plus coturn when configured. */
function iceServers(env = process.env, now = Date.now()) {
  const servers = cloudflare ? [...cloudflare.servers] : [{ urls: 'stun:stun.l.google.com:19302' }];
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

module.exports = { iceServers, refreshCloudflareTurn, startCloudflareTurn };
