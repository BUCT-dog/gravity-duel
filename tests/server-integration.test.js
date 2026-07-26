const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { createGravityServer } = require('../server');

function nextMessage(socket, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(raw);
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('two clients play, reject late joins, and resume after a brief disconnect', async t => {
  const gravityServer = createGravityServer();
  await new Promise(resolve => gravityServer.server.listen(0, '127.0.0.1', resolve));
  const address = gravityServer.server.address();
  const url = `ws://127.0.0.1:${address.port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => gravityServer.server.close(resolve));
  });

  const host = await openSocket(url);
  sockets.push(host);
  const createdPromise = nextMessage(host, message => message.type === 'room_created');
  host.send(JSON.stringify({ type: 'create_room' }));
  const created = await createdPromise;
  assert.match(created.roomId, /^[A-Z2-9]{4}$/);
  assert.ok(created.sessionToken);

  const guest = await openSocket(url);
  sockets.push(guest);
  const joinedPromise = nextMessage(guest, message => message.type === 'joined');
  const startPromise = nextMessage(host, message => message.type === 'game_start');
  const initialStatePromise = nextMessage(host, message => message.type === 'game_state');
  guest.send(JSON.stringify({ type: 'join_room', roomId: created.roomId }));
  const [joined, initialState] = await Promise.all([
    joinedPromise,
    initialStatePromise,
    startPromise,
  ]).then(([joinedMessage, stateMessage]) => [joinedMessage, stateMessage]);

  assert.equal(initialState.players.length, 2);
  assert.equal(new Set(initialState.asteroids.map(asteroid => asteroid.id)).size, 8);

  const movedStatePromise = nextMessage(
    host,
    message => message.type === 'game_state'
      && message.players.find(player => player.n === 1)?.x > 184,
  );
  host.send(JSON.stringify({
    type: 'input',
    seq: 1,
    keys: { right: true },
  }));
  const movedState = await movedStatePromise;
  assert.ok(movedState.players.find(player => player.n === 1).x > 184);

  const lateGuest = await openSocket(url);
  sockets.push(lateGuest);
  const rejectedPromise = nextMessage(lateGuest, message => message.type === 'error');
  lateGuest.send(JSON.stringify({ type: 'join_room', roomId: created.roomId }));
  const rejected = await rejectedPromise;
  assert.match(rejected.message, /已经开始/);

  const lostPromise = nextMessage(host, message => message.type === 'opponent_connection_lost');
  guest.close();
  await lostPromise;

  const resumedGuest = await openSocket(url);
  sockets.push(resumedGuest);
  const resumedPromise = nextMessage(resumedGuest, message => message.type === 'resumed');
  const reconnectedPromise = nextMessage(host, message => message.type === 'opponent_reconnected');
  resumedGuest.send(JSON.stringify({
    type: 'resume_room',
    roomId: created.roomId,
    sessionToken: joined.sessionToken,
  }));
  const resumed = await resumedPromise;
  await reconnectedPromise;
  assert.equal(resumed.player, 2);
});
