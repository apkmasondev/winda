import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Timeline } from '../src/story/Timeline.ts';
import { world } from './fixtures.mjs';
import { loadSettings } from '../src/core/Settings.ts';
import { defaultLang } from '../src/ui/i18n.ts';

test('timeline fires chronologically once; pause and reset cancel stale cues', () => {
  const tl = new Timeline(), seen = [];
  tl.at(2, () => seen.push(2)).at(1, () => seen.push(1));
  tl.update(0); assert.deepEqual(seen, []);
  tl.update(3); tl.update(3); assert.deepEqual(seen, [1, 2]);
  tl.reset();
  tl.at(1, () => { tl.reset(); tl.at(1, () => seen.push('new')); }).at(2, () => seen.push('stale'));
  tl.update(3); assert.deepEqual(seen, [1, 2]);
  tl.update(1); assert.deepEqual(seen, [1, 2, 'new']);
});

test('settings reject non-finite values and tolerate unavailable storage', () => {
  const lang = defaultLang();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => '{"sound":1e999,"look":-1e999,"motion":null,"lang":"xx"}' } });
  assert.deepEqual(loadSettings(), { sound: 4, look: 3, motion: 4, lang });
  globalThis.localStorage.getItem = () => '{"sound":-2,"look":8.5,"motion":9,"lang":"pl"}';
  assert.deepEqual(loadSettings(), { sound: 0, look: 5, motion: 5, lang: 'pl' });
  globalThis.localStorage.getItem = () => { throw new Error('denied'); };
  assert.deepEqual(loadSettings(), { sound: 4, look: 3, motion: 4, lang });
  delete globalThis.localStorage;
});

test('arrival, entire walking route, endless stairs, elevator ride and finale', () => {
  const { app, director, advance, walk } = world();
  director.devStart(null);
  advance(21);
  assert.equal(director.state, 'explore');
  assert.equal(app.hall.arrival.isOpen, true);
  for (const [x, z] of [[0,-4],[0,-54],[0,-86],[0,-135],[0,-162.25],[13.75,-162.25],
    [13.75,-184.75],[36.25,-184.75],[36.25,-162.25],[13.75,-162.25]]) walk(x,z);
  assert.equal(app.stepwell.spawned, true);
  assert.ok(app.stepwell.wraps >= 1);
  walk(13.75,-184.75); walk(36.25,-184.75);
  advance(5);
  assert.equal(app.stepwell.elevator.isOpen, true);
  walk(39.1,-184.75, 15);
  advance(22);
  assert.equal(director.state, 'summit');
  assert.ok(Math.abs(app.player.position.y - 3000) < 0.1);
  // around the lectern that carries the last plate
  walk(1.2,-3); walk(1.2,-6.5); walk(0,-11);
  assert.equal(director.state, 'finale');
  advance(21);
  assert.equal(director.state, 'end');
});

test('pause freezes simulation; restart cancels pending elevator events', () => {
  const { app, director, advance, calls } = world();
  director.devStart('elevator'); advance(0.1);
  const position = app.player.position.clone();
  const before = calls.length;
  app.paused = true; advance(4);
  assert.ok(app.player.position.equals(position));
  assert.equal(app.stepwell.elevator.doorMoving, false);
  assert.equal(calls.length, before);
  app.paused = false;
  director.reset(); director.devStart('landing'); advance(4);
  assert.equal(app.stepwell.spawned, false);
  assert.equal(app.stepwell.elevator.doorMoving, false);
  assert.equal(app.stepwell.elevator.light, 0);
});

test('zero delta cannot move the player; stepwell offset moves the camera immediately', () => {
  const { app } = world();
  app.player.teleport(new THREE.Vector3(0, 0, 1.6), 0, 0);
  const before = app.player.position.clone();
  app.player.update(0, app.input, 0);
  assert.ok(app.player.position.equals(before));
  const cameraBefore = app.camera.position.clone();
  app.player.offset(new THREE.Vector3(0,24,0));
  assert.equal(app.camera.position.y, cameraBefore.y + 24);
});

test('ascent wraps also summon the elevator', () => {
  const { app } = world();
  app.player.teleport(app.stepwell.toWorld(new THREE.Vector3(-11,5,0)));
  app.stepwell.update(1/60, app.player);
  assert.equal(app.stepwell.spawned, true);
  assert.equal(app.stepwell.wraps, 1);
  assert.equal(app.stepwell.depth, 0);
});

test('looking at a plate reads it once; chapters unlock as they are reached', () => {
  const { app, director, advance } = world();
  app.progress.found.length = 0;
  app.progress.reached = app.progress.last = 0;
  director.devStart('landing');
  advance(0.2);
  assert.deepEqual(app.progress.found, []);
  // stand in front of the plate beside the arrival door and look at it
  const at = new THREE.Vector3(2.95, 0, -2.9);
  app.player.teleport(at, Math.PI, -0.1);
  advance(1);
  assert.deepEqual(app.progress.found, ['landing']);
  app.player.teleport(at, Math.PI / 2, 0);
  advance(1);
  assert.deepEqual(app.progress.found, ['landing']);
  director.toMenu();
  assert.equal(director.state, 'start');
  director.startChapter(3);
  assert.equal(director.state, 'explore');
  assert.ok(app.player.position.distanceTo(app.stepwell.toWorld(new THREE.Vector3(-25, 0, 15.6))) < 0.5);
  assert.equal(app.progress.reached, 3);
  director.toMenu();
  director.startChapter(4);
  assert.equal(director.state, 'summit');
  assert.equal(app.progress.reached, 4);
  assert.equal(app.progress.last, 4);
});
