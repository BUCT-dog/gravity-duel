const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fitContain,
  integratePosition,
  interpolateSnapshot,
} = require('../public/game-math');

test('prediction movement is independent of display refresh rate', () => {
  const keys = { right: true };
  let at60 = { x: 180, y: 350 };
  let at120 = { x: 180, y: 350 };

  for (let i = 0; i < 60; i++) {
    at60 = integratePosition(at60, keys, 1 / 60);
  }
  for (let i = 0; i < 120; i++) {
    at120 = integratePosition(at120, keys, 1 / 120);
  }

  assert.ok(Math.abs(at60.x - at120.x) < 0.001);
  assert.ok(Math.abs(at60.y - at120.y) < 0.001);
  assert.ok(Math.abs(at60.x - 450) < 0.001);
});

test('snapshot interpolation follows asteroid ids instead of shifting array indexes', () => {
  const previous = {
    players: [],
    asteroids: [
      { id: 1, x: 10, y: 10, r: 8 },
      { id: 2, x: 100, y: 20, r: 9 },
    ],
    time: 180,
    state: 'playing',
  };
  const current = {
    players: [],
    asteroids: [
      { id: 2, x: 120, y: 20, r: 9 },
      { id: 3, x: 200, y: 30, r: 10 },
    ],
    time: 179,
    state: 'playing',
  };

  const result = interpolateSnapshot(previous, current, 0.5);

  assert.equal(result.asteroids[0].id, 2);
  assert.equal(result.asteroids[0].x, 110);
  assert.equal(result.asteroids[1].id, 3);
  assert.equal(result.asteroids[1].x, 200);
});

test('mobile stages preserve the 12:7 world ratio in both orientations', () => {
  const portrait = fitContain(390, 844, 1200 / 700);
  const landscape = fitContain(844, 390, 1200 / 700);

  assert.ok(Math.abs(portrait.width / portrait.height - 1200 / 700) < 0.001);
  assert.ok(Math.abs(landscape.width / landscape.height - 1200 / 700) < 0.001);
  assert.equal(portrait.width, 390);
  assert.equal(landscape.height, 390);
});
