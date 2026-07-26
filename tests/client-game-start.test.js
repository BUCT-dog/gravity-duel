const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const GravityMath = require('../public/game-math');

class ClassList {
  constructor(...names) {
    this.names = new Set(names);
  }

  add(...names) {
    names.forEach(name => this.names.add(name));
  }

  remove(...names) {
    names.forEach(name => this.names.delete(name));
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, force) {
    if (force === true) this.names.add(name);
    else if (force === false) this.names.delete(name);
    else if (this.names.has(name)) this.names.delete(name);
    else this.names.add(name);
  }
}

function makeElement(...classes) {
  return {
    classList: new ClassList(...classes),
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    addEventListener() {},
    appendChild() {},
    removeChild() {},
    focus() {},
    select() {},
    getBoundingClientRect() {
      return { left: 50, top: 500, width: 130, height: 130 };
    },
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static latest = null;

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    FakeWebSocket.latest = this;
  }

  send() {}
  close() {}
}

function loadClient({
  width = 1200,
  height = 700,
  userAgent = 'node-test',
  hostname = 'localhost',
  host = 'localhost:3000',
  origin = 'http://localhost:3000',
} = {}) {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const clientScript = scripts.at(-1)?.[1];
  assert.ok(clientScript, 'inline client script should exist');

  const elements = new Map([
    ['menuOverlay', makeElement('overlay', 'active')],
    ['waitOverlay', makeElement('overlay', 'hidden')],
    ['endOverlay', makeElement('overlay', 'hidden')],
    ['hud', makeElement('hidden')],
  ]);
  const gradient = { addColorStop() {} };
  const context2d = new Proxy({}, {
    get(target, key) {
      if (key === 'createRadialGradient') return () => gradient;
      if (!(key in target)) target[key] = () => {};
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  const elementFor = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    const element = elements.get(id);
    if (id === 'c') element.getContext = () => context2d;
    return element;
  };
  const storage = new Map();
  const body = makeElement();
  const windowObject = {
    innerWidth: width,
    innerHeight: height,
    GravityMath,
    name: '',
    addEventListener() {},
  };
  windowObject.window = windowObject;

  const sandbox = {
    console,
    Date,
    Math,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    document: {
      body,
      documentElement: makeElement(),
      getElementById: elementFor,
      createElement: () => makeElement(),
      execCommand: () => true,
      querySelectorAll: () => [],
    },
    navigator: { userAgent, clipboard: { writeText: async () => {} } },
    screen: { orientation: {} },
    innerWidth: width,
    innerHeight: height,
    performance: { now: () => 0 },
    prompt: () => null,
    location: {
      protocol: 'http:',
      hostname,
      host,
      origin,
      search: '',
    },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    window: windowObject,
    requestAnimationFrame() {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  windowObject.AudioContext = undefined;
  windowObject.webkitAudioContext = undefined;
  windowObject.sessionStorage = sandbox.sessionStorage;
  vm.runInNewContext(clientScript, sandbox, { filename: htmlPath });
  return { body, elements, socket: FakeWebSocket.latest };
}

test('local page warns that its rooms cannot be joined from a phone', () => {
  const { elements } = loadClient();
  const warning = elements.get('serverScope');

  assert.equal(warning.classList.contains('local'), true);
  assert.match(warning.textContent, /手机无法加入/);
  assert.match(warning.textContent, /Railway 公网网址/);
});

test('mobile portrait gameplay fills the viewport and requests landscape', () => {
  const { body, elements } = loadClient({
    width: 390,
    height: 844,
    userAgent: 'iPhone',
  });
  const app = elements.get('app');

  assert.equal(body.classList.contains('mobile'), true);
  FakeWebSocket.latest.onmessage({
    data: JSON.stringify({ type: 'room_created', roomId: 'ABCD', player: 1 }),
  });
  FakeWebSocket.latest.onmessage({ data: JSON.stringify({ type: 'game_start' }) });

  assert.equal(Number.parseFloat(app.style.width), 390);
  assert.equal(Number.parseFloat(app.style.height), 844);
  assert.equal(body.classList.contains('portrait-mobile'), true);
  assert.equal(app.style.transform, 'none');
});

test('host waiting overlay closes when the game starts', () => {
  const { elements, socket } = loadClient();

  socket.onmessage({
    data: JSON.stringify({ type: 'room_created', roomId: 'ABCD', player: 1 }),
  });
  assert.equal(elements.get('waitOverlay').classList.contains('hidden'), false);

  socket.onmessage({ data: JSON.stringify({ type: 'game_start' }) });

  assert.equal(elements.get('waitOverlay').classList.contains('hidden'), true);
  assert.equal(elements.get('hud').classList.contains('hidden'), false);
});

test('game-over overlay becomes visible at the end of a match', () => {
  const { elements, socket } = loadClient();

  socket.onmessage({
    data: JSON.stringify({ type: 'joined', roomId: 'ABCD', player: 2 }),
  });
  socket.onmessage({ data: JSON.stringify({ type: 'game_start' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'game_over', winner: 2 }) });

  assert.equal(elements.get('endOverlay').classList.contains('hidden'), false);
  assert.equal(elements.get('endOverlay').classList.contains('active'), true);
  assert.equal(elements.get('hud').classList.contains('hidden'), true);
});
