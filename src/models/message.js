const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const messageSchema = new mongoose.Schema({
  from: { type: ObjectId, required: true },
  to: { type: ObjectId, required: true },
  text: { type: String, required: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date }, // unset = unread
});
messageSchema.index({ from: 1, to: 1, createdAt: -1 });
messageSchema.index({ to: 1, readAt: 1 });
/** Filter for the messages between two users, both directions. */
messageSchema.statics.between = (a, b) => ({ $or: [{ from: a, to: b }, { from: b, to: a }] });

const Message = mongoose.model('Message', messageSchema);

/** The API shape: string ids, ISO dates, readAt null when unread. */
const view = (m) => ({
  id: String(m._id),
  from: String(m.from),
  to: String(m.to),
  text: m.text,
  at: m.createdAt.toISOString(),
  readAt: m.readAt ? m.readAt.toISOString() : null,
});

module.exports = Message;
module.exports.view = view;
