const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporterDevice: { type: String, required: true },
  reportedDevice: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Report', reportSchema);
