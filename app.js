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

/** Helper to generate a random user ID */
function generateId() {
  return Math.random().toString(36).substring(2, 9);
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

  // Optional: Send a "connected" message
  ws.send(JSON.stringify({ type: 'connected', msg: `User connected: ${userId}` }));

  console.log(`[Server] Waiting queue: ${waitingQueue}`);
  console.log('[Server] Current partner: ', currentPartner);

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
        console.log('sending candidates')
        // Forward the event to the intended "to" user
        if (data.to && userSockets[data.to]) {
          userSockets[data.to].send(JSON.stringify({
            ...data,
            from: userId
          }));
        }
        break;

      case 'skip':
        handleSkip(userId);
        break;

      case 'hangup':
        handleHangup(userId);
        break;
    }
  });

  /** Handle socket close/disconnect */
  ws.on('close', () => {
    console.log(`[Server] User disconnected: ${userId}`);
    handleHangup(userId);      // Free up partner, if any
    removeFromQueue(userId);   // Remove from waiting queue
    delete userSockets[userId];
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
function tryMatch() {
  while (waitingQueue.length >= 2) {
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();

    // Mark them as partners
    currentPartner[userA] = userB;
    currentPartner[userB] = userA;

    // Tell them to start negotiating (exchange offers/answers)
    userSockets[userA].send(JSON.stringify({ type: 'matched', partnerId: userB , role: 'caller'}));
    userSockets[userB].send(JSON.stringify({ type: 'matched', partnerId: userA }));
  }
}

/** Skip logic */
function handleSkip(userId) {
  // End current call if any
  handleHangup(userId);
  // Put user back into queue
  addUserToQueue(userId);
}

/** Hang up logic (end call, remove partner relationship) */
function handleHangup(userId) {
  const partnerId = currentPartner[userId];
  if (partnerId) {
    // Notify partner to close
    const partnerSocket = userSockets[partnerId];
    if (partnerSocket) {
      partnerSocket.send(JSON.stringify({ type: 'hangup' }));
    }
    // add partner to waiting queue
    addUserToQueue(partnerId);
    // Break both sides
    delete currentPartner[partnerId];
    delete currentPartner[userId];
  }
}
