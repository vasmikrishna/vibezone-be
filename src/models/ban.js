const mongoose = require('mongoose');

const banSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  until: { type: Date, required: true },
  reason: { type: String },
});

module.exports = mongoose.model('Ban', banSchema);
