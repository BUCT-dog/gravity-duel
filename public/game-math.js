(function exposeGravityMath(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GravityMath = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createGravityMath() {
  'use strict';

  const WORLD_WIDTH = 1200;
  const WORLD_HEIGHT = 700;
  const PLAYER_RADIUS = 38;
  const PLAYER_SPEED = 270;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function fitContain(viewportWidth, viewportHeight, aspect = WORLD_WIDTH / WORLD_HEIGHT) {
    if (viewportWidth / viewportHeight > aspect) {
      return { width: viewportHeight * aspect, height: viewportHeight };
    }
    return { width: viewportWidth, height: viewportWidth / aspect };
  }

  function integratePosition(position, keys, deltaSeconds, speed = PLAYER_SPEED) {
    const boundedDelta = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
    let dx = Number(keys?.right === true) - Number(keys?.left === true);
    let dy = Number(keys?.down === true) - Number(keys?.up === true);
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
    return {
      x: clamp(position.x + dx * speed * boundedDelta, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS),
      y: clamp(position.y + dy * speed * boundedDelta, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS),
    };
  }

  function interpolateCollection(previousItems, currentItems, keyName, alpha) {
    const previousByKey = new Map(previousItems.map(item => [item[keyName], item]));
    return currentItems.map(current => {
      const previous = previousByKey.get(current[keyName]);
      if (!previous) return { ...current };
      return {
        ...current,
        x: lerp(previous.x, current.x, alpha),
        y: lerp(previous.y, current.y, alpha),
      };
    });
  }

  function interpolateSnapshot(previous, current, alpha) {
    if (!current) return null;
    if (!previous) return current;
    const boundedAlpha = clamp(alpha, 0, 1);
    return {
      ...current,
      players: interpolateCollection(previous.players || [], current.players || [], 'n', boundedAlpha),
      asteroids: interpolateCollection(previous.asteroids || [], current.asteroids || [], 'id', boundedAlpha),
    };
  }

  function lerp(from, to, alpha) {
    return from + (to - from) * alpha;
  }

  return {
    PLAYER_RADIUS,
    PLAYER_SPEED,
    WORLD_HEIGHT,
    WORLD_WIDTH,
    clamp,
    fitContain,
    integratePosition,
    interpolateSnapshot,
    lerp,
  };
}));
