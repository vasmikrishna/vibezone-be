/**
 * server.js
 *
 * 1) Creates an HTTP server on port 3001.
 * 2) Attaches a WebSocket server (ws) to it.
 * 3) Handles a waiting queue + skip + hangup logic for a Chatroulette-like app.
 * 4) Implements server-side ping/pong keepalive and cleans up partners on disconnect.
 */

const http = require('http');
const WebSocket = require('ws');

/** 1. Create an HTTP server */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>WebSocket Signaling Server is Running on HTTP</h1>');
});

/** 2. Attach WebSocket server to the same HTTP server */
const wss = new WebSocket.Server({ server });

/** Start listening */
server.listen(3001, () => {
  console.log('[Server] HTTP and WebSocket server running on http://localhost:3001');
});

/** Data structures for matchmaking */
let waitingQueue = [];        // array of userIds
let userSockets = {};         // { userId: ws }
let currentPartner = {};      // { userId: partnerId }
let connectedSockets = {};    

/** Helper to generate a random user ID */
function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

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

      case 'hangup':
        handleHangup(userId);
        console.log('Hangup');
        logUsers();
        break;
    }
  });

  /** Handle socket close/disconnect */
  ws.on('close', () => {
    console.log(`[Server] User disconnected: ${userId}`);
    
    handleHangup(userId);      // Free up partner, if any
    removeFromQueue(userId);   // Remove from waiting queue
    delete userSockets[userId];
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
      currentPartner[userA] = userB;
      currentPartner[userB] = userA;

      // Notify users of the match
      const activeUsers = Object.keys(userSockets).length;
      const userAData = JSON.stringify({ type: 'matched', partnerId: userB, role: 'caller' });
      const userBData = JSON.stringify({ type: 'matched', partnerId: userA });
      const activeUsersData = JSON.stringify({ type: 'activeUsers', value: activeUsers });

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

/** Hang up logic (end call, remove partner relationship) */function handleHangup(userId) {
  const partnerId = currentPartner[userId];
  if (partnerId) {
    const partnerSocket = userSockets[partnerId];
    if (partnerSocket) {
      partnerSocket.send(JSON.stringify({ type: 'hangup' }));
    }

    delete currentPartner[partnerId];
    delete currentPartner[userId];

    // Add random delay between 5 to 10 seconds before adding to the queue
    const delay = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 1000;
    setTimeout(() => {
      addUserToQueue(partnerId);
    }, delay);
  }
}

