const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: { type: String },
  dob: { type: Date },
  // Set when a date of birth under 18 was given; the phone can never use rooms.
  underage: { type: Boolean },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
