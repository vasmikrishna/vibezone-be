const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  blockedDevice: { type: String, required: true },
});
blockSchema.index({ deviceId: 1, blockedDevice: 1 }, { unique: true });

module.exports = mongoose.model('Block', blockSchema);
