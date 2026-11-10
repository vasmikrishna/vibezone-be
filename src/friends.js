const Friendship = require('./models/friendship');
const Block = require('./models/block');
const Message = require('./models/message');
const { hourlyLimit } = require('./routes/auth');

const { pair } = Friendship;
const REQUESTS_PER_HOUR = 20;

/** The friendship as seen by user `me`: none, requested, incoming or friends. */
function statusFor(doc, me) {
  if (!doc) return 'none';
  if (doc.status === 'accepted') return 'friends';
  return String(doc.requester) === me ? 'requested' : 'incoming';
}

/**
 * Friend requests during a call, shared by random chat and rooms.
 * A client has ws, userId, name and partner. send and logDbError come from signalling (avoids a require cycle).
 */
const RECENT_PARTNER_MS = 10 * 60 * 1000;
/** The last call partner, for up to 10 minutes after the call ended (set by signalling's endCall). */
const recentPartner = (client) => (client.recentPartner && Date.now() - client.recentPartner.at < RECENT_PARTNER_MS ? client.recentPartner : null);

function createFriends({ send, logDbError }) {
  const allow = hourlyLimit(REQUESTS_PER_HOUR); // one limit across random chat and rooms

  /** matched fields for each side: { a: {...}, b: {...} }. One indexed query; 'none' on a DB error. */
  async function matchFields(a, b) {
    if (!a.userId || !b.userId) {
      const none = { canAddFriend: false, friendStatus: 'none' };
      return { a: none, b: none };
    }
    let doc = null;
    try {
      doc = await Friendship.findOne({ users: pair(a.userId, b.userId) }).lean();
    } catch (err) {
      logDbError(err);
    }
    return {
      a: { canAddFriend: true, friendStatus: statusFor(doc, a.userId) },
      b: { canAddFriend: true, friendStatus: statusFor(doc, b.userId) },
    };
  }

  async function request(client) {
    const fail = (message) => send(client.ws, { type: 'error', message });
    const partner = client.partner || recentPartner(client);
    if (!client.userId) return fail('sign in to add friends');
    if (!partner) return fail('not in a call');
    if (!partner.userId) return fail('partner is a guest');
    if (!allow(client.userId)) return fail('too many friend requests, try later');

    const me = client.userId;
    const users = pair(me, partner.userId);
    const friends = () => {
      send(client.ws, { type: 'friendStatus', status: 'friends' });
      send(partner.ws, { type: 'friendStatus', status: 'friends' });
    };
    try {
      if (await Block.between(me, partner.userId)) return fail('blocked');
      const doc = await Friendship.findOne({ users }).lean();
      const status = statusFor(doc, me);
      if (status === 'friends') return send(client.ws, { type: 'friendStatus', status: 'friends' });
      if (status === 'incoming') {
        await Friendship.updateOne({ _id: doc._id, status: 'pending' }, { $set: { status: 'accepted', acceptedAt: new Date() } });
        return friends();
      }
      if (status === 'none') {
        const { upsertedCount } = await Friendship.updateOne(
          { users },
          { $setOnInsert: { requester: client.userId, status: 'pending', createdAt: new Date() } },
          { upsert: true }
        );
        // The partner's request landed first: accept it.
        if (!upsertedCount) {
          const res = await Friendship.updateOne(
            { users, status: 'pending', requester: partner.userId },
            { $set: { status: 'accepted', acceptedAt: new Date() } }
          );
          if (res.modifiedCount) return friends();
        } else {
          send(partner.ws, { type: 'friendRequestReceived', name: client.name });
        }
      }
      send(client.ws, { type: 'friendStatus', status: 'requested' });
    } catch (err) {
      logDbError(err);
      fail('database error');
    }
  }

  /** Blocking or reporting removes any friendship or request, and the messages, between two signed-in users. */
  function unfriend(a, b) {
    if (!a || !b) return;
    Friendship.deleteOne({ users: pair(a, b) }).catch(logDbError);
    Message.deleteMany(Message.between(a, b)).catch(logDbError);
  }

  return { matchFields, request, unfriend };
}

module.exports = { createFriends, statusFor };
