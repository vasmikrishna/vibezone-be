const express = require('express');
const analyticsRoutes = require('./analytics.routes'); // Ensure the path is correct

const router = express.Router();

// Prefix all analytics routes with '/api'
router.use('/api', analyticsRoutes);

module.exports = router;
