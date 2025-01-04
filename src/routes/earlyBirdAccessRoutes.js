const express = require('express');
const router = express.Router();

const {
  validateEarlyBirdAccessData,
  saveEarlyBirdAccessData,
} = require('../service/earlyBirdAccessService');    

router.post('/early-bird-access', async (req, res) => {
  try {
    const { name, phoneNumber, email, gender, dob } = req.body;

    // Validate data
    const validationError = validateEarlyBirdAccessData({
      name,
      phoneNumber,
      email,
      gender,
      dob,
    });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Save data
    await saveEarlyBirdAccessData({ name, phoneNumber, email, gender, dob });
    res.status(201).json({
      message: 'You have successfully registered for Early Bird Access!',
    });
  } catch (error) {
    console.error('Error saving Early Bird Access data:', error);

    // Handle unique email errors
    if (error.code === 11000) {
      return res
        .status(400)
        .json({ error: 'Email already exists. Please use a different email.' });
    }

    res.status(500).json({
      error: 'Failed to submit your request. Please try again.',
    });
  }
});

module.exports = router;
