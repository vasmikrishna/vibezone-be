const WebSocket = require('ws');

const User = require('./models/user');
const Room = require('./models/room');
const Ticket = require('./models/ticket');
const Block = require('./models/block');
const Report = require('./models/report');
const Ban = require('./models/ban');
const { REASONS, FORWARD, send, forward, chat, evidence, autoBan, logDbError } = require('./signalling');
const { verifyToken, adult, OBJECT_ID } = require('./routes/auth');
const { iceServers } = require('./ice');
const { recordStreak, STREAK_CALL_MS } = require('./streak');

const EARLY_MIN = 10; // attendees and host may join this long before startsAt

/**
 * Live private rooms: the host talks 1-to-1 with each attendee in join order, one turn at a time.
 * State is in memory, like random matchmaking. minuteMs scales all durations (tests).
 */
function createRooms({ jwtSecret, minuteMs, env, streakMs = STREAK_CALL_MS }) {
  const live = new Map(); // roomId -> room

  const entry = (m) => m && { userId: m.userId, name: m.name };

  /** Host sees the queue with names; attendees see only their own position. */
  function broadcast(room) {
    const endsAt = room.current ? new Date(room.sessionEndsAt).toISOString() : null;
    if (room.host) {
      send(room.host.ws, { type: 'roomState', role: 'host', queue: room.queue.map(entry), current: entry(room.current), endsAt });
    }
    for (const m of room.members.values()) {
      const mine = room.current === m;
      const position = room.queue.indexOf(m) + 1 || null;
      send(m.ws, { type: 'roomState', role: 'attendee', queue: [], position, current: mine ? entry(m) : null, endsAt: mine ? endsAt : null });
    }
  }

  function endSession(room) {
    const m = room.current;
    if (!m) return;
    clearTimeout(room.sessionTimer);
    room.current = null;
    const counts = Date.now() - room.sessionStart >= streakMs;
    for (const c of [m, room.host]) {
      if (!c) continue;
      c.partner = null;
      c.chatLog = null;
      send(c.ws, { type: 'partnerLeft' });
      if (counts) recordStreak(c.userId, env).then((s) => s && send(c.ws, { type: 'streak', ...s }));
    }
  }

  function next(room) {
    endSession(room);
    const m = room.queue.shift();
    if (m) {
      const host = room.host;
      const t = Date.now();
      room.current = m;
      room.sessionStart = t;
      room.sessionEndsAt = Math.min(t + room.interactionMin * minuteMs, room.endsAt);
      host.partner = m;
      m.partner = host;
      host.chatLog = m.chatLog = [];
      room.sessionTimer = setTimeout(() => {
        endSession(room);
        broadcast(room);
      }, room.sessionEndsAt - t).unref();
      const endsAt = new Date(room.sessionEndsAt).toISOString();
      send(host.ws, { type: 'matched', role: 'caller', partnerId: m.userId, partnerName: m.name, sharedTags: [], endsAt });
      send(m.ws, { type: 'matched', role: 'callee', partnerId: host.userId, partnerName: host.name, sharedTags: [], endsAt });
    }
    broadcast(room);
  }

  function closeRoom(room) {
    endSession(room);
    clearTimeout(room.endTimer);
    live.delete(room.id);
    for (const m of [room.host, ...room.members.values()]) {
      if (!m) continue;
      m.ws.member = null;
      send(m.ws, { type: 'roomClosed' });
    }
  }

  /** Removes a member (socket closed, replaced, blocked or deleted) and updates everyone else. */
  function leave(m) {
    const room = m.room;
    if (m.ws.member === m) m.ws.member = null;
    if (room.current === m || (room.host === m && room.current)) endSession(room);
    if (room.host === m) room.host = null;
    else if (room.members.get(m.userId) === m) {
      room.members.delete(m.userId);
      room.queue = room.queue.filter((q) => q !== m);
    }
    broadcast(room);
  }

  function liveRoom(doc) {
    const id = String(doc._id);
    let room = live.get(id);
    if (room) return room;
    room = {
      id,
      hostId: String(doc.host),
      startsAt: doc.startsAt.getTime(),
      endsAt: doc.endsAt.getTime(),
      interactionMin: doc.interactionMin,
      host: null,
      members: new Map(), // attendees by userId
      queue: [],
      current: null,
    };
    room.endTimer = setTimeout(() => {
      Room.updateOne({ _id: doc._id, status: 'scheduled' }, { $set: { status: 'ended' } }).catch(logDbError);
      closeRoom(room);
    }, room.endsAt - Date.now()).unref();
    live.set(id, room);
    return room;
  }

  async function join(ws, data) {
    const fail = (message) => send(ws, { type: 'error', message });
    const userId = verifyToken(data.token, jwtSecret);
    if (!userId) return fail('unauthorized');
    if (typeof data.roomId !== 'string' || !OBJECT_ID.test(data.roomId)) return fail('invalid room');

    ws.joining = true;
    let user, doc, allowed, banned;
    try {
      [user, doc, banned] = await Promise.all([
        User.findById(userId).lean(),
        Room.findById(data.roomId).lean(),
        Ban.exists({ deviceId: userId, until: { $gt: new Date() } }),
      ]);
      const isHost = doc && String(doc.host) === userId;
      allowed =
        isHost ||
        (doc &&
          (await Ticket.exists({ room: doc._id, user: userId })) &&
          !(await Block.between(String(doc.host), userId)));
    } catch (err) {
      logDbError(err);
      return fail('database error');
    } finally {
      ws.joining = false;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!user || !adult(user)) return fail('unauthorized');
    if (banned) return fail('banned');
    const t = Date.now();
    if (!doc || doc.status !== 'scheduled') return fail('room not found');
    if (t < doc.startsAt.getTime() - EARLY_MIN * minuteMs || t >= doc.endsAt.getTime()) return fail('room not open');
    if (!allowed) return fail('no ticket');

    const room = liveRoom(doc);
    const isHost = room.hostId === userId;
    const older = isHost ? room.host : room.members.get(userId);
    if (older) {
      leave(older);
      older.ws.close(4000, 'replaced');
    }
    const m = { ws, room, userId, deviceId: userId, name: user.name || 'Guest', partner: null, chatLog: null, chatTimes: [] };
    ws.member = m;
    if (isHost) room.host = m;
    else {
      room.members.set(userId, m);
      room.queue.push(m);
    }
    send(ws, { type: 'ready', iceServers: iceServers(env) });
    broadcast(room);
  }

  /** Ends the session; the attendee leaves the room and can no longer join this host's rooms. */
  function block(m) {
    const partner = m.partner;
    const room = m.room;
    Block.updateOne(
      { deviceId: m.userId, blockedDevice: partner.userId },
      { $set: { blockedDevice: partner.userId } },
      { upsert: true }
    ).catch(logDbError);
    const attendee = m === room.host ? partner : m;
    leave(attendee);
    send(attendee.ws, { type: 'roomClosed' });
  }

  function handle(ws, data) {
    if (data.type === 'roomJoin') {
      if (ws.member || ws.joining) return send(ws, { type: 'error', message: 'already joined' });
      return join(ws, data);
    }
    const m = ws.member;
    const room = m.room;
    if (FORWARD[data.type]) return forward(m, data);

    switch (data.type) {
      case 'chat':
        return chat(m, data);
      case 'roomNext':
        if (m !== room.host) return send(ws, { type: 'error', message: 'host only' });
        if (Date.now() < room.startsAt) return send(ws, { type: 'error', message: 'room not started' });
        return next(room);
      case 'roomEnd':
        if (m !== room.host) return send(ws, { type: 'error', message: 'host only' });
        Room.updateOne({ _id: room.id, status: 'scheduled' }, { $set: { status: 'ended' } }).catch(logDbError);
        return closeRoom(room);
      case 'report':
        if (!REASONS.includes(data.reason)) return send(ws, { type: 'error', message: 'invalid reason' });
        if (m.partner) {
          const reported = m.partner.userId;
          new Report({ reporterDevice: m.userId, reportedDevice: reported, reason: data.reason, roomId: room.id, evidence: evidence(m) })
            .save()
            .then(() => autoBan(reported))
            .then((until) => until && api.kickUser(reported))
            .catch(logDbError);
        }
      // falls through: a report also blocks
      case 'block':
        if (m.partner) block(m);
        return;
      default:
        return send(ws, { type: 'error', message: 'unknown type' });
    }
  }

  const api = {
    handle,
    leave,
    close(roomId) {
      const room = live.get(roomId);
      if (room) closeRoom(room);
    },
    /** Removes a deleted user from every live room, closing the ones they host. */
    kickUser(userId) {
      for (const room of live.values()) {
        if (room.hostId === userId) closeRoom(room);
        else if (room.members.has(userId)) {
          const m = room.members.get(userId);
          leave(m);
          send(m.ws, { type: 'roomClosed' });
        }
      }
    },
  };
  return api;
}

module.exports = { createRooms };
