const test = require('node:test');
const assert = require('node:assert');
const { iceServers, refreshCloudflareTurn, startCloudflareTurn } = require('../src/ice');

const GOOGLE = { urls: 'stun:stun.l.google.com:19302' };
const URLS = [
  'stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'stun:stun.cloudflare.com:53',
  'turn:turn.cloudflare.com:53?transport=udp',
];
const cfEnv = { CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 't' };
const good = () => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ iceServers: { urls: URLS, username: 'u', credential: 'c' } }) };
  };
  fn.calls = calls;
  return fn;
};
const expected = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
    username: 'u',
    credential: 'c',
  },
];

test('without Cloudflare: Google STUN, plus coturn when configured', async () => {
  await refreshCloudflareTurn({});
  assert.deepStrictEqual(iceServers({}), [GOOGLE]);
  const now = 1_700_000_000_000;
  const servers = iceServers({ TURN_URLS: 'turn:t:3478', TURN_SECRET: 's' }, now);
  assert.strictEqual(servers.length, 2);
  assert.strictEqual(servers[1].username, String(Math.floor(now / 1000) + 3600));
});

test('Cloudflare credentials are fetched, filtered and cached', async () => {
  const stub = good();
  await refreshCloudflareTurn(cfEnv, stub);
  assert.strictEqual(stub.calls.length, 1);
  const { url, opts } = stub.calls[0];
  assert.strictEqual(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/k/credentials/generate');
  assert.strictEqual(opts.method, 'POST');
  assert.strictEqual(opts.headers.Authorization, 'Bearer t');
  assert.strictEqual(opts.body, '{"ttl":86400}');
  assert.deepStrictEqual(iceServers(cfEnv), expected);
});

test('a failed or throwing refresh keeps the previous credentials', async () => {
  await refreshCloudflareTurn(cfEnv, good());
  await refreshCloudflareTurn(cfEnv, async () => ({ ok: false, status: 500 }));
  assert.deepStrictEqual(iceServers(cfEnv), expected);
  await refreshCloudflareTurn(cfEnv, async () => { throw new Error('boom'); });
  assert.deepStrictEqual(iceServers(cfEnv), expected);
});

test('coturn is appended after Cloudflare entries', async () => {
  await refreshCloudflareTurn(cfEnv, good());
  const servers = iceServers({ ...cfEnv, TURN_URLS: 'turn:t:3478', TURN_SECRET: 's' });
  assert.deepStrictEqual(servers.slice(0, 2), expected);
  assert.strictEqual(servers.length, 3);
});

test('startCloudflareTurn does nothing without the env vars', async () => {
  const stub = good();
  assert.strictEqual(startCloudflareTurn({}, { fetchFn: stub }), null);
  assert.strictEqual(stub.calls.length, 0);
  await refreshCloudflareTurn({}); // clear the cache for other tests
});
