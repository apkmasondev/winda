import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { world } from './fixtures.mjs';
import { loadProgress, saveProgress } from '../src/core/Progress.ts';
import { loadSettings, saveSettings } from '../src/core/Settings.ts';
import { setLang, t } from '../src/ui/i18n.ts';

function storage(context) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  } });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  return values;
}

function readSummit(w) {
  w.app.player.teleport(new THREE.Vector3(0, 3000, -3.25), 0, -0.46);
  w.advance(1);
  assert.equal(w.app.story.isReading, true);
  assert.ok(w.app.progress.found.includes('summit'));
}

test('summit explains the ending and never starts it from an idle timeout or while reading', () => {
  const w = world();
  w.director.devStart('summit');
  w.advance(120);
  assert.equal(w.director.state, 'summit');
  assert.equal(w.app.ui.finaleAvailable, true);
  readSummit(w);
  w.advance(100);
  assert.equal(w.director.state, 'summit');
  assert.equal(w.app.story.isReading, true);
});

test('reading has a three-second grace period at the edge, frozen during pause', () => {
  const w = world();
  w.director.devStart('summit');
  readSummit(w);
  w.app.player.teleport(new THREE.Vector3(0, 3000, -10), 0, 0);
  w.advance(1); // reader lingers briefly after looking away
  assert.equal(w.app.story.isReading, false);
  w.advance(2);
  assert.equal(w.director.state, 'summit');
  w.app.paused = true;
  w.advance(20);
  assert.equal(w.director.state, 'summit');
  w.app.paused = false;
  w.advance(1);
  assert.equal(w.director.state, 'finale');
  assert.equal(w.app.ui.finaleAvailable, false);
  assert.equal(w.calls.filter(([name]) => name === 'swell').length, 1);
  w.advance(21);
  assert.equal(w.director.state, 'end');
});

test('returning to the menu clears reading and finale guidance for the next journey', () => {
  const w = world();
  w.director.devStart('summit');
  w.advance(3);
  readSummit(w);
  w.director.toMenu();
  assert.equal(w.app.ui.finaleAvailable, false);
  assert.equal(w.app.story.isReading, false);
  w.director.startChapter(1);
  w.advance(21);
  assert.equal(w.director.state, 'explore');
  assert.equal(w.app.ui.finaleAvailable, false);
});

test('motion zero suppresses breathing, shakes, landing and walking offsets while preserving mouse look', () => {
  const w = world();
  w.director.devStart('landing');
  const p = w.app.player;
  p.motion = 0;
  p.shake = 1.1;
  p.teleport(new THREE.Vector3(0, 6, -4), 0.3, -0.15);
  const intended = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.15, 0.3, 0, 'YXZ'));
  for (let n = 0; n < 180; n++) {
    w.tick();
    assert.ok(w.app.camera.quaternion.angleTo(intended) < 1e-7);
    assert.equal(w.app.camera.position.x, p.position.x);
    assert.equal(w.app.camera.position.z, p.position.z);
  }
  assert.equal(p.onGround, true);
  // Exercise the landing camera response independently of the impact threshold.
  p.settle = 1;
  w.tick();
  assert.ok(w.app.camera.quaternion.angleTo(intended) < 1e-7);
  const heights = [];
  for (let n = 0; n < 300; n++) { w.tick(); heights.push(w.app.camera.position.y); }
  assert.ok(Math.max(...heights) - Math.min(...heights) < 1e-6);
  w.walk(1, -8);
  assert.ok(w.app.camera.quaternion.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ'))) < 1e-7);
  const yaw = p.yaw;
  w.app.input.consumeMouse = () => ({ x: 20, y: 0 });
  w.tick();
  assert.notEqual(p.yaw, yaw);
  w.app.input.consumeMouse = () => ({ x: 0, y: 0 });
  p.motion = 1;
  w.tick();
  assert.ok(w.app.camera.quaternion.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(p.pitch, p.yaw, 0, 'YXZ'))) > 1e-5);
});

test('progress survives a new session and continue opens the saved chapter', context => {
  storage(context);
  const first = world();
  first.director.startChapter(4);
  readSummit(first);
  const second = world();
  assert.equal(second.app.progress.last, 4);
  assert.equal(second.app.progress.reached, 4);
  assert.ok(second.app.progress.found.includes('summit'));
  second.director.startChapter(second.app.progress.last);
  assert.equal(second.director.state, 'summit');
  second.app.story.finish();
  const finished = loadProgress();
  assert.equal(finished.finished, true);
  assert.equal(finished.last, 0);
  assert.equal(finished.reached, 4);
});

test('corrupt, partial and inaccessible progress storage is safe', context => {
  const values = storage(context);
  const key = 'the-elevator:progress';
  const fresh = { reached: 0, last: 0, found: [], finished: false };
  for (const bad of ['{', 'null', 'false', '[]', '{}']) {
    values.set(key, bad);
    assert.deepEqual(loadProgress(), fresh);
  }
  values.set(key, '{"reached":2,"last":9,"found":["summit","summit","unknown",null,7],"finished":"true"}');
  assert.deepEqual(loadProgress(), { reached: 2, last: 2, found: ['summit'], finished: false });
  values.set(key, '{"reached":1e999,"last":-1e999}');
  assert.deepEqual(loadProgress(), fresh);
  localStorage.getItem = () => { throw new Error('unavailable'); };
  localStorage.setItem = () => { throw new Error('quota exceeded'); };
  assert.deepEqual(loadProgress(), fresh);
  assert.doesNotThrow(() => saveProgress(fresh));
});

test('every chapter starts in a playable state and remains replayable after visiting the summit', () => {
  const w = world();
  for (const index of [4, 3, 2, 1, 0]) {
    w.director.toMenu();
    w.director.startChapter(index);
    if (index === 0) {
      assert.equal(w.director.state, 'intro');
      w.app.video.currentTime = 10;
      w.app.video.dispatchEvent(new Event('ended'));
    }
    w.advance(21);
    assert.equal(w.director.state, index === 4 ? 'summit' : 'explore');
    assert.equal(w.app.player.control, 1);
    assert.equal(w.app.player.lookControl, 1);
    assert.ok(w.app.player.position.toArray().every(Number.isFinite));
    if (index > 0) assert.equal(w.app.progress.last, index);
    assert.equal(w.app.progress.reached, 4);
    assert.equal(w.app.story.isReading, false);
  }
});

test('camera preference and language survive reload; finale guidance is localized', context => {
  storage(context);
  const settings = { sound: 2, look: 5, motion: 0, lang: 'pl' };
  saveSettings(settings);
  assert.deepEqual(loadSettings(), settings);
  // setLang also redraws existing story cards; supply the DOM translation surface.
  document.documentElement = { lang: '' };
  document.querySelectorAll = () => [];
  setLang('pl');
  assert.match(t('hint.finale'), /finał.*krawędzi/);
  setLang('en');
  assert.match(t('hint.finale'), /edge.*finale/);
  assert.equal(document.documentElement.lang, 'en');
});
