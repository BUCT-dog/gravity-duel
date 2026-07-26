const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FIXED_STEP_MS,
  addPlayer,
  buildState,
  canJoinRoom,
  createRoom,
  spawnAsteroid,
  stepRoom,
} = require('../game-engine');

function playingRoom() {
  const room = createRoom({ id: 'TEST', random: () => 0.5 });
  addPlayer(room, { number: 1 });
  addPlayer(room, { number: 2 });
  room.state = 'playing';
  room.spawnTimer = 999999;
  return room;
}

test('server movement retains the original 270 world-units per second', () => {
  const room = playingRoom();
  room.players[0].keys = { right: true };

  for (let i = 0; i < Math.round(1000 / FIXED_STEP_MS); i++) stepRoom(room);

  assert.ok(Math.abs(room.players[0].x - 450) < 0.01);
});

test('asteroids receive stable monotonic ids that survive snapshots', () => {
  const room = playingRoom();
  const first = spawnAsteroid(room);
  const second = spawnAsteroid(room);
  room.asteroids.shift();
  const third = spawnAsteroid(room);

  assert.deepEqual([first.id, second.id, third.id], [1, 2, 3]);
  assert.deepEqual(buildState(room).asteroids.map(asteroid => asteroid.id), [2, 3]);
});

test('multiple same-tick collisions never reduce hp below zero', () => {
  const room = playingRoom();
  const player = room.players[0];
  player.hp = 1;
  room.asteroids = [
    { id: 1, x: player.x, y: player.y, vx: 0, vy: 0, r: 10 },
    { id: 2, x: player.x, y: player.y, vx: 0, vy: 0, r: 10 },
  ];

  stepRoom(room);

  assert.equal(player.hp, 0);
  assert.equal(room.state, 'ended');
});

test('only a waiting room with one connected player can be joined', () => {
  const room = createRoom({ id: 'TEST' });
  addPlayer(room, { number: 1 });
  assert.equal(canJoinRoom(room), true);

  room.state = 'playing';
  assert.equal(canJoinRoom(room), false);
});
