const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // A user signs in with a phone, a Google account, or both.
  phone: { type: String, unique: true, sparse: true },
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String },
  name: { type: String },
  dob: { type: Date },
  photo: { type: String }, // small JPEG data URL, resized in the browser
  bio: { type: String }, // short profile text, at most 160 characters
  // Set when a date of birth under 18 was given; the phone or Google account can never use rooms.
  underage: { type: Boolean },
  streak: { count: Number, best: Number, lastDay: String }, // lastDay: YYYY-MM-DD in STREAK_TZ
  lastSeen: Date, // when the user's last app socket closed
  calls: Number, // calls of at least the streak time; unset until the first one
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
