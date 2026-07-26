'use strict';

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 700;
const PLAYER_RADIUS = 38;
const GRAVITY_RADIUS = 230;
const GRAVITY_STRENGTH = 1200;
const PLAYER_SPEED_PER_STEP = 4.5;
const MAX_ASTEROIDS = 20;
const MAX_HP = 5;
const ROUND_MS = 180_000;
const FIXED_STEP_MS = 1000 / 60;

function createRoom({ id, random = Math.random } = {}) {
  return {
    id,
    random,
    players: [],
    asteroids: [],
    nextAsteroidId: 1,
    state: 'waiting',
    winner: null,
    spawnTimer: 0,
    gameTimerMs: ROUND_MS,
    tick: 0,
    accumulatorMs: 0,
    lastUpdateAt: 0,
    lastBroadcastAt: 0,
    gameOverSent: false,
    rematchVotes: new Set(),
    expiresAt: null,
  };
}

function addPlayer(room, { number, ws = null, token = null } = {}) {
  const player = {
    ws,
    token,
    number,
    hp: MAX_HP,
    x: number === 1 ? 180 : WORLD_WIDTH - 180,
    y: WORLD_HEIGHT / 2,
    keys: emptyKeys(),
    connected: true,
    lastInputSeq: 0,
  };
  room.players.push(player);
  return player;
}

function canJoinRoom(room) {
  return Boolean(
    room
    && room.state === 'waiting'
    && room.players.length === 1
    && room.players[0].connected,
  );
}

function emptyKeys() {
  return { up: false, down: false, left: false, right: false };
}

function sanitizeKeys(keys) {
  return {
    up: keys?.up === true,
    down: keys?.down === true,
    left: keys?.left === true,
    right: keys?.right === true,
  };
}

function spawnAsteroid(room) {
  const random = room.random;
  const side = Math.floor(random() * 4);
  let x;
  let y;
  const targetX = 180 + random() * (WORLD_WIDTH - 360);
  const targetY = 100 + random() * (WORLD_HEIGHT - 200);

  if (side === 0) {
    x = -30;
    y = random() * WORLD_HEIGHT;
  } else if (side === 1) {
    x = WORLD_WIDTH + 30;
    y = random() * WORLD_HEIGHT;
  } else if (side === 2) {
    x = random() * WORLD_WIDTH;
    y = -30;
  } else {
    x = random() * WORLD_WIDTH;
    y = WORLD_HEIGHT + 30;
  }

  const angle = Math.atan2(targetY - y, targetX - x) + (random() - 0.5) * 0.8;
  const speed = 2 + random() * 3;
  const asteroid = {
    id: room.nextAsteroidId++,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    r: 7 + random() * 7,
  };
  room.asteroids.push(asteroid);
  return asteroid;
}

function startRound(room) {
  room.asteroids = [];
  room.nextAsteroidId = 1;
  room.state = 'playing';
  room.winner = null;
  room.spawnTimer = 300;
  room.gameTimerMs = ROUND_MS;
  room.tick = 0;
  room.accumulatorMs = 0;
  room.gameOverSent = false;
  room.rematchVotes.clear();
  room.expiresAt = null;

  for (const player of room.players) {
    player.hp = MAX_HP;
    player.x = player.number === 1 ? 180 : WORLD_WIDTH - 180;
    player.y = WORLD_HEIGHT / 2;
    player.keys = emptyKeys();
  }

  for (let index = 0; index < 8; index += 1) spawnAsteroid(room);
}

function movePlayers(room) {
  for (const player of room.players) {
    if (!player.connected || player.hp <= 0) continue;
    let dx = Number(player.keys.right === true) - Number(player.keys.left === true);
    let dy = Number(player.keys.down === true) - Number(player.keys.up === true);
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    player.x = clamp(player.x + dx * PLAYER_SPEED_PER_STEP, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
    player.y = clamp(player.y + dy * PLAYER_SPEED_PER_STEP, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
  }
}

function moveAsteroids(room) {
  for (const asteroid of room.asteroids) {
    for (const player of room.players) {
      if (!player.connected || player.hp <= 0) continue;
      const dx = player.x - asteroid.x;
      const dy = player.y - asteroid.y;
      const distance = Math.hypot(dx, dy);
      if (distance < GRAVITY_RADIUS && distance > 8) {
        const force = GRAVITY_STRENGTH / (distance * distance);
        asteroid.vx += (dx / distance) * force;
        asteroid.vy += (dy / distance) * force;
      }
    }

    const speed = Math.hypot(asteroid.vx, asteroid.vy);
    if (speed > 9) {
      asteroid.vx = (asteroid.vx / speed) * 9;
      asteroid.vy = (asteroid.vy / speed) * 9;
    }
    asteroid.x += asteroid.vx;
    asteroid.y += asteroid.vy;
  }
}

function resolveCollisions(room, events) {
  for (let index = room.asteroids.length - 1; index >= 0; index -= 1) {
    const asteroid = room.asteroids[index];
    for (const player of room.players) {
      if (!player.connected || player.hp <= 0) continue;
      if (Math.hypot(asteroid.x - player.x, asteroid.y - player.y) >= PLAYER_RADIUS + asteroid.r) continue;

      player.hp = Math.max(0, player.hp - 1);
      events.push({
        type: 'hit',
        player: player.number,
        asteroidId: asteroid.id,
        x: asteroid.x,
        y: asteroid.y,
      });
      room.asteroids.splice(index, 1);
      break;
    }
  }
}

function updateRoundState(room) {
  const living = room.players.filter(player => player.hp > 0 && player.connected);
  if (living.length < room.players.length) {
    room.state = 'ended';
    room.winner = living.length === 1 ? living[0].number : 0;
    return;
  }

  if (room.gameTimerMs > 0) return;
  room.state = 'ended';
  const [first, second] = room.players;
  room.winner = first.hp > second.hp ? first.number : second.hp > first.hp ? second.number : 0;
}

function stepRoom(room) {
  if (room.state !== 'playing') return [];

  const events = [];
  movePlayers(room);
  moveAsteroids(room);
  resolveCollisions(room, events);

  room.asteroids = room.asteroids.filter(asteroid => (
    asteroid.x > -120
    && asteroid.x < WORLD_WIDTH + 120
    && asteroid.y > -120
    && asteroid.y < WORLD_HEIGHT + 120
  ));

  room.spawnTimer -= FIXED_STEP_MS;
  if (room.spawnTimer <= 0 && room.asteroids.length < MAX_ASTEROIDS) {
    spawnAsteroid(room);
    room.spawnTimer = 800 + room.random() * 800;
  }

  room.gameTimerMs = Math.max(0, room.gameTimerMs - FIXED_STEP_MS);
  room.tick += 1;
  updateRoundState(room);
  return events;
}

function buildState(room, now = Date.now()) {
  return {
    type: 'game_state',
    tick: room.tick,
    ts: now,
    players: room.players.map(player => ({
      n: player.number,
      x: player.x,
      y: player.y,
      hp: player.hp,
      connected: player.connected,
      ack: player.lastInputSeq,
    })),
    asteroids: room.asteroids.map(asteroid => ({
      id: asteroid.id,
      x: asteroid.x,
      y: asteroid.y,
      vx: asteroid.vx,
      vy: asteroid.vy,
      r: asteroid.r,
    })),
    time: Math.max(0, Math.ceil(room.gameTimerMs / 1000)),
    state: room.state,
    winner: room.winner,
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = {
  FIXED_STEP_MS,
  GRAVITY_RADIUS,
  MAX_HP,
  PLAYER_RADIUS,
  ROUND_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  addPlayer,
  buildState,
  canJoinRoom,
  createRoom,
  emptyKeys,
  sanitizeKeys,
  spawnAsteroid,
  startRound,
  stepRoom,
};
