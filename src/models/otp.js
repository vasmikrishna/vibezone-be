const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true }, // HMAC-SHA256 with OTP_SECRET, never the code
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 300 },
});

module.exports = mongoose.model('Otp', otpSchema);
