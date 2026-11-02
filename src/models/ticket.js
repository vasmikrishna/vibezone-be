const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  room: { type: mongoose.Schema.Types.ObjectId, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});
ticketSchema.index({ room: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Ticket', ticketSchema);
