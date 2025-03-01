const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');



const SessionModel = require('./src/models/connections');
const Connection = require('./src/models/matches');

const earlyBirdAccessRoutes = require('./src/routes/earlyBirdAccessRoutes');


const mongoURI = process.env.MONGO_URI;
// const mongoURI = 'mongodb+srv://vamsi:zUm1jwBewRfzb4QA@cluster0.g72xb.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0'
console.log('mongoURI', mongoURI);

// Function to connect to MongoDB
const connectDB = async () => {
  try {
      await mongoose.connect(mongoURI, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
      });
      console.log('MongoDB connected successfully');
  } catch (error) {
      console.error('Error connecting to MongoDB:', error.message);
      process.exit(1); // Exit process with failure
  }
};

connectDB();


const app = express();
app.use(bodyParser.json());
app.use(cors());
/** 1. Create an HTTP server */
const server = http.createServer(app);

/** 2. Attach WebSocket server to the same HTTP server */
const wss = new WebSocket.Server({ server });

// Routes
app.use('/api', earlyBirdAccessRoutes);

app.get('/', (req, res) => {
  res.send('Hello, World!');
})



/** Data structures for matchmaking */
let waitingQueue = [];        // array of userIds
let userSockets = {};         // { userId: ws }
let currentPartner = {};      // { userId: partnerId }
let connectedSockets = {};    
let activeUsers = 0;

/** Helper to generate a random user ID */
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

// Function to broadcast active user count to all connected clients
function broadcastActiveUserCount() {
  const message = JSON.stringify({
    type: 'activeUsers',
    value: activeUserCount,
  });

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Function to update the active user count and broadcast every 10 seconds
function updateActiveUserCount() {
  activeUserCount = wss.clients.size; // Update active user count from WebSocket clients
  console.log(`[Server] Active user count: ${activeUserCount}`);

  // Throttle broadcast every 10 seconds
  if (!updateActiveUserCount.broadcasting) {
    updateActiveUserCount.broadcasting = true;
    broadcastActiveUserCount();
    setTimeout(() => {
      updateActiveUserCount.broadcasting = false;
    }, 1000); // Broadcast every 10 seconds
  }
}

setInterval(() => {
  updateActiveUserCount(); 
}, 10000)
// Update and throttle the broadcast

function logUsers() {
  console.log('all socket ids', Object.keys(userSockets));  
  console.log(`[Server] Waiting queue: ${waitingQueue}, length: ${waitingQueue.length}`);
  console.log('[Server] Current partner: ', currentPartner,);
}

/** 3. Handle new WebSocket connections */
wss.on('connection', (ws) => {
  // Mark isAlive for ping/pong
  ws.isAlive = true;

  // When the server sends a ping, client should auto-respond with a pong
  ws.on('pong', () => {
    ws.isAlive = true; // confirm the connection is alive
  });

  // Generate a userId for each new connection
  const userId = generateId();
  userSockets[userId] = ws;

  console.log(`[Server] User connected: ${userId}`);

  // Place the user in the waiting queue
  addUserToQueue(userId);
  try {
    const user = new SessionModel({ sessionId: userId, startTime: new Date() });
    user.save();
  } catch (e) {
    console.error('Error saving user:', e);
  }

  logUsers();

  ws.send(JSON.stringify({ type: 'activeUsers', value: Object.keys(userSockets).length}));

  // Optional: Send a "connected" message
  ws.send(JSON.stringify({ type: 'connected',id: userId.toString()}));

  /** Handle incoming WebSocket messages */
  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error('Invalid JSON:', msg);
      return;
    }

    switch (data.type) {
      case 'offer':
      case 'answer':
      case 'candidate':
        // console.log('sending candidates', JSON.stringify(data));
        // Forward the event to the intended "to" user
        if (data.to && userSockets[data.to] ) {
          userSockets[data.to].send(JSON.stringify({
            ...data,
            from: userId
          }));
        }
        break;
      case 'skip':
        handleSkip(userId);
        console.log('Skipped');
        logUsers();
        break;
      case 'networkQualityUpdate': 
        console.log('recived data of network', data.to, data.quality);
        if (data.to && userSockets[data.to] ) {
          userSockets[data.to].send(JSON.stringify({
            type: 'networkQualityUpdate',
            quality: data.quality,
          }));
        }
        break;
      case 'hangup':
        handleHangup(userId);
        console.log('Hangup');
        logUsers();
        break;
    }
  });

  /** Handle socket close/disconnect */
  ws.on('close', async () => {
    console.log(`[Server] User disconnected: ${userId}`);
    
    handleHangup(userId);      // Free up partner, if any
    removeFromQueue(userId);   // Remove from waiting queue
    delete userSockets[userId];

    await SessionModel.findOneAndUpdate({ sessionId: userId }, { $set: { endTime: new Date() } });
    logUsers();
  });
});

/** Ping/pong keepalive: periodically check if each connection is alive */
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      // Connection is presumed dead, terminate
      return ws.terminate();
    }
    // Otherwise, mark isAlive as false and send a ping
    ws.isAlive = false;
    ws.ping(); // client should respond with pong
  });
}, 30000);

// On server shutdown, clear the interval
wss.on('close', () => {
  clearInterval(interval);
  logUsers();
});

/** Add user to queue */
function addUserToQueue(userId) {
  if (!waitingQueue.includes(userId)) {
    waitingQueue.push(userId);
    tryMatch();
  }
}

/** Remove user from queue (helper) */
function removeFromQueue(userId) {
  const idx = waitingQueue.indexOf(userId);
  if (idx >= 0) {
    waitingQueue.splice(idx, 1);
  }
}

/** Try to match any two waiting users */
async function tryMatch() {
  while (waitingQueue.length >= 2) {
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();

    const userASocket = userSockets[userA];
    const userBSocket = userSockets[userB];

    // Skip matching if sockets are invalid or users are already partnered
    if (!userASocket || !userBSocket || currentPartner[userA] || currentPartner[userB]) {
      if (userASocket && !currentPartner[userA]) waitingQueue.push(userA);
      if (userBSocket && !currentPartner[userB]) waitingQueue.push(userB);
      continue;
    }

    try {
      // Mark users as partners
      currentPartner[userA] = {id:userB, startTime: new Date()};
      currentPartner[userB] = {id:userA, startTime: new Date()};

      // Notify users of the match
      activeUsers = Object.keys(userSockets).length;
      const userAData = JSON.stringify({ type: 'matched', partnerId: userB, role: 'caller' });
      const userBData = JSON.stringify({ type: 'matched', partnerId: userA });
      const activeUsersData = JSON.stringify({ type: 'activeUsers', value: activeUsers });

      const match = new Connection({ userId:userA, partnerId:userB });
      match.save();



      await Promise.all([
        userASocket.send(userAData),
        userBSocket.send(userBData),
        userASocket.send(activeUsersData),
        userBSocket.send(activeUsersData),
      ]);
    } catch (error) {
      console.error('[Server] Error while sending match data:', error);

      // Requeue users in case of transient errors
      if (userASocket) waitingQueue.push(userA);
      if (userBSocket) waitingQueue.push(userB);
    }
  }
}


/** Skip logic */
function handleSkip(userId) {
  handleHangup(userId);
  addUserToQueue(userId);
}

function handleHangup(userId) {
  const partnerId = currentPartner[userId]?.id;

  if (partnerId) {
    const partnerSocket = userSockets[partnerId];
    if (partnerSocket) {
      partnerSocket.send(JSON.stringify({ type: 'hangup' }));
    }
    
    const data = new Connection({ userId: userId, partnerId: partnerId, callDuration: new Date() - currentPartner[userId].startTime });
    data.save();

    delete currentPartner[partnerId];
    delete currentPartner[userId];

    // Add random delay between 5 to 10 seconds before adding to the queue
    const delay = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 1000;
    setTimeout(() => {
      addUserToQueue(partnerId);
    }, delay);
  }
}



/** Start HTTP and WebSocket server */
const PORT = 3001;
server.listen(PORT, () => {
  console.log(`[Server] HTTP and WebSocket server running on http://localhost:${PORT}`);
});