const mongoose = require('mongoose');

// Define a schema for user sessions
const connectionsSchema = new mongoose.Schema({
    userId: { 
        type: String, 
        required: true,
        index: true
    },
    partnerId: { 
        type: String, 
        required: true,
        index: true
    },
    connectedAt: { 
        type: Date, 
        default: Date.now
    },
    callDuration: { 
        type: Number, 
        default: 0
    },
});

const Connection = mongoose.model('Connections', connectionsSchema);

module.exports = Connection;
