const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// ============ 游戏常量 ============
const CANVAS_W = 1200;
const CANVAS_H = 700;
const PLANET_RADIUS = 38;
const GRAVITY_RADIUS = 230;
const GRAVITY_STRENGTH = 1200;
const PLAYER_SPEED = 4.5;
const MAX_ASTEROIDS = 20;
const ASTEROID_SPAWN_MS = 1000;
const ASTEROID_MIN_R = 7;
const ASTEROID_MAX_R = 14;
const ASTEROID_MAX_SPEED = 9;
const MAX_HP = 5;
const ROUND_TIME = 180;
const PHYSICS_TICK = 16;   // 物理 ~60fps
const BROADCAST_TICK = 33; // 广播 ~30fps

// ============ HTTP ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, 'public', url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============ WebSocket ============
const wss = new WebSocket.Server({ server });

// ============ 工具函数 ============
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ============ 房间管理 ============
const rooms = new Map();

function createRoom() {
  let id;
  do { id = genRoomId(); } while (rooms.has(id));
  const room = {
    id, players: [], asteroids: [],
    state: 'waiting', spawnTimer: 0,
    gameTimer: ROUND_TIME, winner: null,
    lastPhysics: Date.now(), lastBroadcast: 0,
  };
  rooms.set(id, room);
  return room;
}

function spawnAsteroid(room) {
  const side = Math.floor(Math.random() * 4);
  let x, y;
  const tx = rand(CANVAS_W * 0.15, CANVAS_W * 0.85);
  const ty = rand(CANVAS_H * 0.15, CANVAS_H * 0.85);

  switch (side) {
    case 0: x = -30; y = rand(0, CANVAS_H); break;
    case 1: x = CANVAS_W + 30; y = rand(0, CANVAS_H); break;
    case 2: x = rand(0, CANVAS_W); y = -30; break;
    case 3: x = rand(0, CANVAS_W); y = CANVAS_H + 30; break;
  }

  const angle = Math.atan2(ty - y, tx - x) + rand(-0.4, 0.4);
  const speed = rand(2, 4.5);
  room.asteroids.push({
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius: rand(ASTEROID_MIN_R, ASTEROID_MAX_R),
  });
}

// ============ 物理引擎（单步） ============
function physicsTick(room) {
  // 1. 移动玩家
  for (const p of room.players) {
    if (!p.keys) continue;
    let dx = 0, dy = 0;
    if (p.keys.up)    dy -= 1;
    if (p.keys.down)  dy += 1;
    if (p.keys.left)  dx -= 1;
    if (p.keys.right) dx += 1;
    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }
    p.x = clamp(p.x + dx * PLAYER_SPEED, PLANET_RADIUS, CANVAS_W - PLANET_RADIUS);
    p.y = clamp(p.y + dy * PLAYER_SPEED, PLANET_RADIUS, CANVAS_H - PLANET_RADIUS);
  }

  // 2. 引力
  for (const ast of room.asteroids) {
    for (const p of room.players) {
      const d = dist(ast, p);
      if (d < GRAVITY_RADIUS && d > 8) {
        const force = GRAVITY_STRENGTH / (d * d);
        ast.vx += ((p.x - ast.x) / d) * force;
        ast.vy += ((p.y - ast.y) / d) * force;
      }
    }
    const spd = Math.hypot(ast.vx, ast.vy);
    if (spd > ASTEROID_MAX_SPEED) {
      ast.vx = (ast.vx / spd) * ASTEROID_MAX_SPEED;
      ast.vy = (ast.vy / spd) * ASTEROID_MAX_SPEED;
    }
    ast.x += ast.vx;
    ast.y += ast.vy;
  }

  // 3. 碰撞
  for (let i = room.asteroids.length - 1; i >= 0; i--) {
    const ast = room.asteroids[i];
    for (const p of room.players) {
      if (dist(ast, p) < PLANET_RADIUS + ast.radius) {
        p.hp--;
        broadcast(room, { type: 'hit', player: p.number, x: ast.x, y: ast.y });
        room.asteroids.splice(i, 1);
        break;
      }
    }
  }

  // 4. 清理离屏陨石
  room.asteroids = room.asteroids.filter(a =>
    a.x > -120 && a.x < CANVAS_W + 120 && a.y > -120 && a.y < CANVAS_H + 120
  );

  // 5. 生成
  room.spawnTimer -= PHYSICS_TICK;
  if (room.spawnTimer <= 0 && room.asteroids.length < MAX_ASTEROIDS) {
    spawnAsteroid(room);
    room.spawnTimer = ASTEROID_SPAWN_MS + rand(0, 800);
  }

  // 6. 胜负判定
  room.gameTimer -= PHYSICS_TICK / 1000;
  const dead = room.players.filter(p => p.hp <= 0);
  if (dead.length > 0) {
    room.state = 'ended';
    room.winner = room.players.find(p => p.hp > 0)?.number || 0;
  } else if (room.gameTimer <= 0) {
    room.state = 'ended';
    const [a, b] = room.players;
    room.winner = a.hp > b.hp ? a.number : b.hp > a.hp ? b.number : 0;
  }
}

// ============ 构建状态（精简版，不发送轨迹） ============
function buildState(room) {
  return {
    type: 'game_state',
    players: room.players.map(p => ({ n: p.number, x: p.x, y: p.y, hp: p.hp })),
    asteroids: room.asteroids.map(a => ({
      x: a.x, y: a.y, vx: a.vx, vy: a.vy, r: a.radius,
    })),
    time: Math.max(0, Math.ceil(room.gameTimer)),
    state: room.state,
    winner: room.winner,
  };
}

function broadcast(room, msg) {
  const raw = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

// ============ 游戏主循环 ============
let loopStarted = false;
function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.state !== 'playing') continue;

      // 物理步进（追赶实际时间，每次最多追赶3帧防 spiral）
      const dt = now - room.lastPhysics;
      room.lastPhysics = now;
      const steps = Math.min(Math.round(dt / PHYSICS_TICK), 3);
      for (let i = 0; i < steps; i++) physicsTick(room);

      // 广播（限 30fps）
      if (now - room.lastBroadcast >= BROADCAST_TICK) {
        room.lastBroadcast = now;
        broadcast(room, buildState(room));

        if (room.state === 'ended') {
          broadcast(room, { type: 'game_over', winner: room.winner });
        }
      }
    }

    // 清理空房间
    for (const [id, room] of rooms) {
      if (room.players.every(p => p.ws.readyState > 1)) rooms.delete(id);
    }
  }, PHYSICS_TICK);
}

// ============ 连接处理 ============
wss.on('connection', (ws) => {
  ws.isAlive = true;
  let myRoom = null;
  let myPlayer = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const room = createRoom();
        myRoom = room;
        myPlayer = { ws, number: 1, hp: MAX_HP, x: 180, y: CANVAS_H / 2, keys: {} };
        room.players.push(myPlayer);
        ws.send(JSON.stringify({ type: 'room_created', roomId: room.id, player: 1 }));
        break;
      }

      case 'join_room': {
        const code = msg.roomId?.toUpperCase?.() || '';
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: '房间不存在。请确认电脑和手机打开的是同一个公网网址，并检查房间码' })); return; }
        if (room.players.length >= 2) { ws.send(JSON.stringify({ type: 'error', message: '房间已满' })); return; }
        if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', message: '游戏已开始，无法加入' })); return; }

        myRoom = room;
        myPlayer = { ws, number: 2, hp: MAX_HP, x: CANVAS_W - 180, y: CANVAS_H / 2, keys: {} };
        room.players.push(myPlayer);
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id, player: 2 }));

        // 开局
        room.state = 'playing';
        room.lastPhysics = Date.now();
        room.lastBroadcast = 0;
        room.spawnTimer = 300;
        for (let i = 0; i < 8; i++) spawnAsteroid(room);
        broadcast(room, { type: 'game_start' });
        startLoop();
        break;
      }

      case 'input': {
        if (myPlayer && myRoom?.state === 'playing') {
          myPlayer.keys = msg.keys || {};
        }
        break;
      }

      case 'rematch': {
        if (!myRoom || myRoom.state !== 'ended') break;
        if (myRoom._rematchVotes == null) myRoom._rematchVotes = new Set();
        myRoom._rematchVotes.add(myPlayer?.number);
        const other = myRoom.players.find(p => p !== myPlayer);
        if (other?.ws.readyState === WebSocket.OPEN) {
          other.ws.send(JSON.stringify({ type: 'rematch_requested' }));
        }
        if (myRoom._rematchVotes.size >= 2) {
          myRoom._rematchVotes.clear();
          myRoom.asteroids = [];
          myRoom.gameTimer = ROUND_TIME;
          myRoom.winner = null;
          myRoom.state = 'playing';
          myRoom.lastPhysics = Date.now();
          myRoom.lastBroadcast = 0;
          myRoom.spawnTimer = 300;
          for (const p of myRoom.players) {
            p.hp = MAX_HP;
            p.keys = {};
            p.x = p.number === 1 ? 180 : CANVAS_W - 180;
            p.y = CANVAS_H / 2;
          }
          for (let i = 0; i < 8; i++) spawnAsteroid(myRoom);
          broadcast(myRoom, { type: 'game_start' });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myRoom) return;
    const other = myRoom.players.find(p => p !== myPlayer);
    if (other?.ws.readyState === WebSocket.OPEN) {
      other.ws.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
    // 清理
    if (myRoom.players.every(p => p === myPlayer || p.ws.readyState > 1)) {
      rooms.delete(myRoom.id);
    }
  });
});

// ============ 心跳检测 ============
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   🪐  引力对决  Gravity Duel       ║');
  console.log('  ║                                    ║');
  console.log(`  ║  本地: http://localhost:${PORT}         ║`);
  console.log('  ║  联机: 创建房间 → 分享码 → 对战   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
