const EarlyBirdAccess = require('../models/EarlyBirdAccess');

// Validate Early Bird Access Form Data
const validateEarlyBirdAccessData = ({ name, phoneNumber, email, gender, dob }) => {
  if (!name || !phoneNumber || !email || !gender || !dob) {
    return 'All fields are required.';
  }
  return null;
};

// Save Early Bird Access Data
const saveEarlyBirdAccessData = async ({ name, phoneNumber, email, gender, dob }) => {
  const newAccessRequest = new EarlyBirdAccess({
    name,
    phoneNumber,
    email,
    gender,
    dob,
  });
  return await newAccessRequest.save();
};

module.exports = {
  validateEarlyBirdAccessData,
  saveEarlyBirdAccessData,
};
