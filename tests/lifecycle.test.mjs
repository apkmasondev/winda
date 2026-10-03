import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../src/core/Input.ts';
import { AudioEngine } from '../src/audio/AudioEngine.ts';
import { world } from './fixtures.mjs';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('keyboard menus remain accessible and inactive/blurred input is discarded', () => {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { body: { classList: { toggle() {} } } });
  const canvas = new EventTarget();
  const input = new Input(canvas);
  const key = (code, target = null, repeat = false) => {
    const e = new Event('keydown', { cancelable: true });
    Object.defineProperties(e, { code: { value: code }, repeat: { value: repeat }, target: { value: target } });
    window.dispatchEvent(e); return e;
  };
  assert.equal(key('Tab').defaultPrevented, false);
  key('KeyW'); assert.equal(input.axis().forward, 0);
  input.active = true;
  assert.equal(key('ArrowUp', null, true).defaultPrevented, true);
  key('KeyW', { closest: () => ({}) }); assert.equal(input.axis().forward, 0);
  key('KeyW'); assert.equal(input.axis().forward, 1);
  input.dragging = true; input.dx = 9;
  window.dispatchEvent(new Event('blur'));
  assert.equal(input.axis().forward, 0);
  assert.equal(input.dragging, false);
  assert.deepEqual(input.consumeMouse(), { x: 0, y: 0 });
});

test('pending video rejection cannot restart playback after pausing', async () => {
  const { app, director } = world();
  let reject, plays = 0;
  app.video.play = () => { plays++; return new Promise((_, r) => { reject = r; }); };
  director.begin();
  app.paused = true; director.onPause(true);
  reject(new Error('play interrupted by pause')); await flush();
  assert.equal(plays, 1);
  assert.equal(app.video.muted, false);
  assert.equal(director.state, 'intro');
});

test('stale playback rejection cannot affect the next ride', async () => {
  const { app, director } = world();
  const rejections = [];
  app.video.play = () => new Promise((_, reject) => rejections.push(reject));
  director.begin(); director.restart();
  rejections[0](new Error('old request')); await flush();
  assert.equal(rejections.length, 2);
  assert.equal(app.video.muted, false);
  assert.equal(director.state, 'intro');
});

test('unplayable video falls back to the playable 3D experience', async () => {
  const { app, director } = world();
  app.video.play = async () => { throw new Error('unsupported video'); };
  director.begin(); await flush(); await flush();
  assert.equal(director.state, 'arrival');
});

function param() {
  return { value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} };
}
class AudioNodeMock extends EventTarget {
  constructor() {
    super();
    for (const k of ['gain','frequency','Q','threshold','knee','ratio','attack','release','delayTime','pan',
      'positionX','positionY','positionZ','forwardX','forwardY','forwardZ','upX','upY','upZ']) this[k] = param();
  }
  connect(node) { return node; }
  disconnect() {}
  start() {}
  stop(at) { this.stopAt = at ?? 0; }
}
class AudioContextMock {
  state = 'suspended'; currentTime = 0; sampleRate = 1000;
  destination = new AudioNodeMock(); listener = new AudioNodeMock(); sources = [];
  constructor() {
    for (const name of ['Gain','DynamicsCompressor','BiquadFilter','Delay','Convolver','Panner','StereoPanner']) this[`create${name}`] = () => new AudioNodeMock();
  }
  resume() { this.resumes = (this.resumes ?? 0) + 1; return new Promise(() => {}); }
  async suspend() { this.suspends = (this.suspends ?? 0) + 1; }
  async close() {}
  createBuffer(channels, length) { const data = Array.from({length:channels}, () => new Float32Array(length)); return { getChannelData: i => data[i] }; }
  createOscillator() { const node = new AudioNodeMock(); this.sources.push(node); return node; }
  createBufferSource() { return this.createOscillator(); }
}

test('audio initializes despite pending autoplay permission and preserves requested zone', async () => {
  globalThis.window = { AudioContext: AudioContextMock };
  const audio = new AudioEngine();
  audio.setZone('hall', 0);
  await audio.init();
  assert.equal(audio.ready, true);
  assert.equal(audio.currentZone, 'hall');
  const ctx = audio.ctx;
  await audio.init(); assert.equal(audio.ctx, ctx);
  audio.suspend(true); assert.equal(ctx.suspends, 1);
  const resumes = ctx.resumes;
  audio.setVolume(0.3); assert.equal(ctx.resumes, resumes);
  audio.suspend(false); assert.equal(ctx.resumes, resumes + 1);
});

test('restart stops one shots, delayed door effects and final swell LFOs', async () => {
  globalThis.window = { AudioContext: AudioContextMock };
  const audio = new AudioEngine(); await audio.init();
  audio.doors(3, true); audio.swell(13);
  assert.ok(audio.transients.size > 10);
  const active = [...audio.transients];
  audio.hush(0.5);
  assert.equal(audio.transients.size, 0);
  assert.ok(active.every(node => node.stopAt === 0));
  assert.equal(audio.cues.time, 0);
  assert.equal(audio.cues.cues.length, 0);
});

test('absence of WebAudio does not crash cinematic cues', async () => {
  globalThis.window = {};
  const audio = new AudioEngine(); await audio.init();
  assert.equal(audio.ready, false);
  assert.doesNotThrow(() => { audio.creak(); audio.distantMetal(); audio.hush(); });
});
