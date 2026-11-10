const mongoose = require('mongoose');

const { ObjectId } = mongoose.Types;

const friendshipSchema = new mongoose.Schema({
  users: { type: [mongoose.Schema.Types.ObjectId], required: true, index: true }, // pair(a, b)
  requester: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['pending', 'accepted'], required: true },
  createdAt: { type: Date, default: Date.now },
  acceptedAt: { type: Date },
  last: { text: String, from: mongoose.Schema.Types.ObjectId, at: Date }, // newest message, for the friends list
});
// ponytail: unique on the whole sorted array so a pair has at most one document.
friendshipSchema.index({ 'users.0': 1, 'users.1': 1 }, { unique: true });

/** The two user ids as ObjectIds, sorted ascending as strings. */
const pair = (a, b) => [String(a), String(b)].sort().map((id) => new ObjectId(id));

const Friendship = mongoose.model('Friendship', friendshipSchema);
module.exports = Friendship;
module.exports.pair = pair;
