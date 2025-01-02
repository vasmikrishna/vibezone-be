const mongoose = require('mongoose');

// Define a schema for user sessions
const sessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  startTime: {
    type: Date,
  },
  endTime: {
    type: Date,
  },
});

const SessionModel = mongoose.model('Sessions', sessionSchema);

module.exports = SessionModel;
