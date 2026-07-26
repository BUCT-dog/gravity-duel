'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');
const {
  FIXED_STEP_MS,
  addPlayer,
  buildState,
  canJoinRoom,
  createRoom,
  emptyKeys,
  sanitizeKeys,
  startRound,
  stepRoom,
} = require('./game-engine');

const BROADCAST_MS = 50;
const RECONNECT_GRACE_MS = 10_000;
const FINISHED_ROOM_TTL_MS = 60_000;
const MAX_CATCH_UP_STEPS = 8;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PUBLIC_ROOT = path.resolve(__dirname, 'public');
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function randomRoomId() {
  let result = '';
  for (let index = 0; index < 4; index += 1) {
    result += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  }
  return result;
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function send(ws, message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, message, exceptPlayer = null) {
  const payload = JSON.stringify(message);
  for (const player of room.players) {
    if (player === exceptPlayer || player.ws?.readyState !== WebSocket.OPEN) continue;
    player.ws.send(payload);
  }
}

function staticHandler(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  if (url.pathname === '/api/health') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify({ ok: true, service: 'gravity-duel' }));
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  const filePath = path.resolve(PUBLIC_ROOT, `.${pathname}`);
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(data);
  });
}

function createGravityServer() {
  const server = http.createServer(staticHandler);
  const wss = new WebSocket.Server({ server });
  const rooms = new Map();

  function uniqueRoomId() {
    let id = randomRoomId();
    while (rooms.has(id)) id = randomRoomId();
    return id;
  }

  function finishRoom(room, winner, reason) {
    if (room.state === 'ended') return;
    room.state = 'ended';
    room.winner = winner;
    room.expiresAt = Date.now() + FINISHED_ROOM_TTL_MS;
    broadcast(room, buildState(room));
    broadcast(room, { type: 'game_over', winner, reason });
    room.gameOverSent = true;
  }

  function detachWaitingMembership(membership) {
    const { room, player } = membership;
    if (!room || !player || room.state !== 'waiting') return;
    rooms.delete(room.id);
    player.connected = false;
  }

  function handleDisconnect(membership, closingSocket) {
    const { room, player } = membership;
    if (!room || !player || !player.connected) return;
    if (player.ws !== closingSocket) return;

    player.connected = false;
    player.keys = emptyKeys();
    player.ws = null;

    if (room.state === 'waiting') {
      rooms.delete(room.id);
      return;
    }

    if (room.state === 'playing') {
      room.state = 'paused';
      room.pausedFrom = 'playing';
      room.expiresAt = Date.now() + RECONNECT_GRACE_MS;
      broadcast(room, {
        type: 'opponent_connection_lost',
        graceMs: RECONNECT_GRACE_MS,
      }, player);
    } else if (room.players.every(candidate => !candidate.connected)) {
      rooms.delete(room.id);
    }
  }

  function processRoom(room, now) {
    if (room.state === 'paused') {
      if (room.expiresAt && now >= room.expiresAt) {
        const survivor = room.players.find(player => player.connected);
        finishRoom(room, survivor?.number || 0, 'opponent_disconnected');
      }
      return;
    }

    if (room.state === 'ended') {
      if (room.expiresAt && now >= room.expiresAt) rooms.delete(room.id);
      return;
    }

    if (room.state !== 'playing') return;

    const elapsed = Math.min(250, Math.max(0, now - room.lastUpdateAt));
    room.lastUpdateAt = now;
    room.accumulatorMs += elapsed;
    let steps = 0;

    while (
      room.accumulatorMs >= FIXED_STEP_MS
      && steps < MAX_CATCH_UP_STEPS
      && room.state === 'playing'
    ) {
      const events = stepRoom(room);
      for (const event of events) broadcast(room, event);
      room.accumulatorMs -= FIXED_STEP_MS;
      steps += 1;
    }

    if (steps === MAX_CATCH_UP_STEPS) room.accumulatorMs = Math.min(room.accumulatorMs, FIXED_STEP_MS);

    if (now - room.lastBroadcastAt >= BROADCAST_MS || room.state === 'ended') {
      room.lastBroadcastAt = now;
      broadcast(room, buildState(room, now));
    }

    if (room.state === 'ended' && !room.gameOverSent) {
      broadcast(room, { type: 'game_over', winner: room.winner, reason: 'round_complete' });
      room.gameOverSent = true;
      room.expiresAt = now + FINISHED_ROOM_TTL_MS;
    }
  }

  const gameLoop = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) processRoom(room, now);
  }, 8);
  gameLoop.unref?.();

  wss.on('connection', ws => {
    ws.isAlive = true;
    const membership = { room: null, player: null };

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        send(ws, { type: 'error', message: '消息格式无效' });
        return;
      }

      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'ping') {
        send(ws, {
          type: 'pong',
          clientTime: Number(message.clientTime) || 0,
          serverTime: Date.now(),
        });
        return;
      }

      if (message.type === 'create_room') {
        detachWaitingMembership(membership);
        const room = createRoom({ id: uniqueRoomId() });
        const player = addPlayer(room, {
          number: 1,
          ws,
          token: randomToken(),
        });
        rooms.set(room.id, room);
        membership.room = room;
        membership.player = player;
        send(ws, {
          type: 'room_created',
          roomId: room.id,
          player: player.number,
          sessionToken: player.token,
        });
        return;
      }

      if (message.type === 'join_room') {
        const roomId = String(message.roomId || '').trim().toUpperCase();
        const room = rooms.get(roomId);
        if (!room) {
          send(ws, { type: 'error', message: '房间不存在或已过期' });
          return;
        }
        if (!canJoinRoom(room)) {
          send(ws, {
            type: 'error',
            message: room.state === 'waiting' ? '房间已满' : '对局已经开始',
          });
          return;
        }

        detachWaitingMembership(membership);
        const player = addPlayer(room, {
          number: 2,
          ws,
          token: randomToken(),
        });
        membership.room = room;
        membership.player = player;
        send(ws, {
          type: 'joined',
          roomId: room.id,
          player: player.number,
          sessionToken: player.token,
        });

        startRound(room);
        const now = Date.now();
        room.lastUpdateAt = now;
        room.lastBroadcastAt = now;
        broadcast(room, { type: 'game_start' });
        broadcast(room, buildState(room, now));
        return;
      }

      if (message.type === 'resume_room') {
        const roomId = String(message.roomId || '').trim().toUpperCase();
        const room = rooms.get(roomId);
        const player = room?.players.find(candidate => candidate.token === message.sessionToken);
        const resumableState = room?.state === 'playing' || room?.state === 'paused';
        if (
          !room
          || !player
          || !resumableState
          || (room.state === 'paused' && Date.now() >= room.expiresAt)
        ) {
          send(ws, { type: 'resume_failed' });
          return;
        }

        const previousSocket = player.ws;
        membership.room = room;
        membership.player = player;
        player.connected = true;
        player.ws = ws;
        player.keys = emptyKeys();
        if (room.state === 'paused') room.state = room.pausedFrom || 'playing';
        room.expiresAt = null;
        room.lastUpdateAt = Date.now();
        room.accumulatorMs = 0;
        send(ws, {
          type: 'resumed',
          roomId: room.id,
          player: player.number,
        });
        send(ws, buildState(room));
        broadcast(room, { type: 'opponent_reconnected' }, player);
        if (previousSocket && previousSocket !== ws) previousSocket.close(1000, 'session resumed elsewhere');
        return;
      }

      const { room, player } = membership;
      if (!room || !player) {
        send(ws, { type: 'error', message: '请先创建或加入房间' });
        return;
      }

      if (message.type === 'input') {
        if (room.state !== 'playing') return;
        const sequence = Number.isSafeInteger(message.seq) ? message.seq : player.lastInputSeq + 1;
        if (sequence < player.lastInputSeq) return;
        player.lastInputSeq = sequence;
        player.keys = sanitizeKeys(message.keys);
        return;
      }

      if (message.type === 'rematch') {
        if (room.state !== 'ended' || !player.connected) return;
        room.rematchVotes.add(player.number);
        const opponent = room.players.find(candidate => candidate !== player);
        send(opponent?.ws, { type: 'rematch_requested' });
        if (room.rematchVotes.size < 2 || room.players.some(candidate => !candidate.connected)) return;

        startRound(room);
        const now = Date.now();
        room.lastUpdateAt = now;
        room.lastBroadcastAt = now;
        broadcast(room, { type: 'game_start' });
        broadcast(room, buildState(room, now));
      }
    });

    ws.on('close', () => handleDisconnect(membership, ws));
    ws.on('error', () => handleDisconnect(membership, ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15_000);
  heartbeat.unref?.();

  server.on('close', () => {
    clearInterval(gameLoop);
    clearInterval(heartbeat);
  });

  return { rooms, server, wss };
}

if (require.main === module) {
  const { server } = createGravityServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  🚀 重力决斗已启动：http://localhost:${port}\n`);
  });
}

module.exports = { createGravityServer };
