const WebSocket = require('ws');

const Friendship = require('./models/friendship');
const User = require('./models/user');
const { send, logDbError } = require('./signalling');
const { verifyToken, OBJECT_ID } = require('./routes/auth');

const TYPING_MS = 1000; // at most one typing event per second per socket

/**
 * Signed-in app sockets (the `hello` mode): message pushes, presence and typing, only between accepted friends.
 * A user may have several sockets (tabs); online = at least one.
 */
function createMessages({ jwtSecret }) {
  const sockets = new Map(); // userId -> Set of ws

  /** Sends to every app socket of the user. */
  function push(userId, message) {
    for (const ws of sockets.get(String(userId)) || []) send(ws, message);
  }

  const online = (userId) => sockets.has(String(userId));

  /** Tells the user's online accepted friends. */
  // ponytail: one friendship query per first open / last close; cache friend lists if it shows up in profiles.
  function presence(userId, isOnline, lastSeen) {
    Friendship.find({ users: userId, status: 'accepted' }, 'users')
      .lean()
      .then((rows) => {
        for (const f of rows) {
          const friend = f.users.map(String).find((id) => id !== userId);
          if (friend) push(friend, { type: 'presence', userId, online: isOnline, lastSeen });
        }
      })
      .catch(logDbError);
  }

  async function hello(ws, data) {
    const fail = (message, code) => {
      send(ws, { type: 'error', message });
      ws.close(code);
    };
    const userId = verifyToken(data.token, jwtSecret);
    let user = null;
    ws.joining = true;
    try {
      user = userId && (await User.exists({ _id: userId }));
    } catch (err) {
      logDbError(err);
      return fail('database error', 1011);
    } finally {
      ws.joining = false;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!user) return fail('unauthorized', 1008);

    ws.user = userId;
    let set = sockets.get(userId);
    if (!set) {
      sockets.set(userId, (set = new Set()));
      presence(userId, true, null);
    }
    set.add(ws);
    send(ws, { type: 'welcome' });
  }

  /** Forwards a typing notice to an accepted friend; anything invalid or too frequent is dropped. */
  function typing(ws, data) {
    if (typeof data.to !== 'string' || !OBJECT_ID.test(data.to)) return;
    const to = data.to.toLowerCase();
    const t = Date.now();
    if (to === ws.user || t - (ws.typingAt || 0) < TYPING_MS) return;
    ws.typingAt = t;
    const from = ws.user;
    Friendship.exists({ users: Friendship.pair(from, to), status: 'accepted' })
      .then((ok) => ok && push(to, { type: 'typing', from }))
      .catch(logDbError);
  }

  /** Socket messages of the hello mode; signalling routes `hello` and anything from a hello socket here. */
  function handle(ws, data) {
    if (data.type === 'hello') {
      if (ws.user || ws.joining) return send(ws, { type: 'error', message: 'already joined' });
      return hello(ws, data);
    }
    if (data.type === 'typing') return typing(ws, data);
    send(ws, { type: 'error', message: 'unknown type' });
  }

  /** On socket close: the last socket of a user records lastSeen and tells friends. */
  function leave(ws) {
    const userId = ws.user;
    const set = sockets.get(userId);
    if (!set || !set.delete(ws) || set.size) return;
    sockets.delete(userId);
    const lastSeen = new Date();
    User.updateOne({ _id: userId }, { $set: { lastSeen } }).catch(logDbError);
    presence(userId, false, lastSeen.toISOString());
  }

  return { handle, leave, push, online };
}

module.exports = { createMessages };
