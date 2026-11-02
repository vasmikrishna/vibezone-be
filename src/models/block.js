const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  blockedDevice: { type: String, required: true },
});
blockSchema.index({ deviceId: 1, blockedDevice: 1 }, { unique: true });
// Room blocks reuse this collection with user ids in place of device ids.
blockSchema.statics.between = function (a, b) {
  return this.exists({ $or: [{ deviceId: a, blockedDevice: b }, { deviceId: b, blockedDevice: a }] });
};

module.exports = mongoose.model('Block', blockSchema);
