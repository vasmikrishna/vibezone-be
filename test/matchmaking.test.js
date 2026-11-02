const test = require('node:test');
const assert = require('node:assert');

const { createMatcher } = require('../src/matchmaking');

const user = (deviceId, tags = [], extra = {}) => ({ deviceId, tags, blocks: new Set(), lastPartner: null, ...extra });

function setup() {
  const clock = { t: 0 };
  const matcher = createMatcher({ now: () => clock.t, waitMs: 10000 });
  return { clock, matcher };
}

test('matches two untagged users immediately, oldest is a', () => {
  const { matcher } = setup();
  matcher.add(user('a'));
  assert.strictEqual(matcher.next(), null);
  matcher.add(user('b'));
  const pair = matcher.next();
  assert.deepStrictEqual([pair.a.deviceId, pair.b.deviceId, pair.sharedTags], ['a', 'b', []]);
  assert.strictEqual(matcher.size, 0);
});

test('tagged user prefers a partner sharing a tag', () => {
  const { matcher } = setup();
  matcher.add(user('a', ['music']));
  matcher.add(user('b', ['games']));
  matcher.add(user('c', ['music', 'art']));
  const pair = matcher.next();
  assert.deepStrictEqual([pair.a.deviceId, pair.b.deviceId, pair.sharedTags], ['a', 'c', ['music']]);
});

test('tagged user without a shared tag waits 10s, then matches anyone', () => {
  const { clock, matcher } = setup();
  matcher.add(user('a', ['music']));
  matcher.add(user('b'));
  assert.strictEqual(matcher.next(), null);
  clock.t = 9999;
  assert.strictEqual(matcher.next(), null);
  clock.t = 10000;
  assert.deepStrictEqual(matcher.next().sharedTags, []);
});

test('never matches the same device to itself', () => {
  const { matcher } = setup();
  const a = user('a');
  matcher.add(a);
  matcher.add(a);
  assert.strictEqual(matcher.size, 1);
  assert.strictEqual(matcher.next(), null);
});

test('never matches a blocked pair in either direction, even after waiting', () => {
  for (const [blocker, blocked] of [['a', 'b'], ['b', 'a']]) {
    const { clock, matcher } = setup();
    const users = { a: user('a'), b: user('b') };
    users[blocker].blocks.add(blocked);
    matcher.add(users.a);
    matcher.add(users.b);
    clock.t = 60000;
    assert.strictEqual(matcher.next(), null);
  }
});

test('blocks added after queueing still apply', () => {
  const { matcher } = setup();
  const a = user('a');
  matcher.add(a);
  a.blocks.add('b');
  matcher.add(user('b'));
  assert.strictEqual(matcher.next(), null);
});

test('skips the previous partner when someone else is waiting', () => {
  const { clock, matcher } = setup();
  matcher.add(user('a', [], { lastPartner: 'b' }));
  matcher.add(user('b', [], { lastPartner: 'a' }));
  matcher.add(user('c'));
  clock.t = 60000;
  const pair = matcher.next();
  assert.deepStrictEqual([pair.a.deviceId, pair.b.deviceId], ['a', 'c']);
  assert.strictEqual(matcher.next(), null);
});

test('rematches the previous partner only when alone together and after 10s', () => {
  const { clock, matcher } = setup();
  matcher.add(user('a', [], { lastPartner: 'b' }));
  matcher.add(user('b', [], { lastPartner: 'a' }));
  assert.strictEqual(matcher.next(), null);
  clock.t = 10000;
  assert.deepStrictEqual(matcher.next().b.deviceId, 'b');
});

test('remove takes a user out of the queue', () => {
  const { matcher } = setup();
  matcher.add(user('a'));
  matcher.remove('a');
  matcher.add(user('b'));
  assert.strictEqual(matcher.has('a'), false);
  assert.strictEqual(matcher.next(), null);
});
