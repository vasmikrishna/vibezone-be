const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporterDevice: { type: String, required: true },
  reportedDevice: { type: String, required: true, index: true },
  reason: { type: String, required: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, index: true }, // set for reports from private rooms
  // Last chat lines of the reported call, kept only because a report was filed.
  evidence: [
    {
      _id: false,
      sender: { type: String, enum: ['reporter', 'reported'], required: true },
      text: { type: String, required: true },
      at: { type: Date, required: true },
    },
  ],
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('Report', reportSchema);
