const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  host: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  hostName: { type: String },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true, index: true },
  durationMin: { type: Number, required: true },
  interactionMin: { type: Number, required: true },
  tickets: { type: Number, required: true },
  sold: { type: Number, default: 0 },
  status: { type: String, enum: ['scheduled', 'cancelled', 'ended'], default: 'scheduled' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Room', roomSchema);
