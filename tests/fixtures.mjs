import * as THREE from 'three';
import { Colliders } from '../src/core/Colliders.ts';
import { Player } from '../src/player/Player.ts';
import { Hall } from '../src/world/Hall.ts';
import { Stepwell } from '../src/world/Stepwell.ts';
import { Summit } from '../src/world/Summit.ts';
import { makeCabinRig } from '../src/world/Elevator.ts';
import { Director } from '../src/story/Director.ts';
import { Story } from '../src/story/Story.ts';
import { loadProgress } from '../src/core/Progress.ts';

const noop = () => {};
export function world() {
  // Canvas drawing is irrelevant to simulation; all geometry/collision code is real.
  const gradient = () => ({ addColorStop: noop });
  const ctx = new Proxy({}, { get: (_, key) => key === 'createRadialGradient' || key === 'createLinearGradient' ? gradient
    : key === 'measureText' ? (text) => ({ width: String(text).length * 20 }) : noop });
  globalThis.document = { createElement: () => ({ getContext: () => ctx }) };
  const cabin = new THREE.Group();
  for (const name of ['DoorL', 'DoorR']) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    door.name = name;
    cabin.add(door);
  }
  const colliders = new Colliders();
  const textures = { normal: new THREE.Texture(), detail: new THREE.Texture() };
  const base = { cabin, colliders, textures, cabinEnv: new THREE.Texture() };
  const kit = Object.fromEntries(['Column','BridgeSeg','Slab','Monolith','Landing','Gate'].map(k => [k, new THREE.BoxGeometry()]));
  const hall = new Hall({ ...base, kit });
  const stepwell = new Stepwell({ ...base, module: new THREE.BoxGeometry(), cap: new THREE.BoxGeometry(), lamps: new THREE.BoxGeometry() });
  const summit = new Summit({ ...base, sun: hall.sun, hemi: hall.hemi, column: kit.Column });
  colliders.build();
  const camera = new THREE.PerspectiveCamera();
  const player = new Player(camera, colliders);
  const calls = [];
  const audio = new Proxy({ init: async () => {}, clangSites: [] }, {
    get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]),
  });
  let motion = { forward: 0, strafe: 0, run: false };
  const input = { clear: () => { motion = { forward: 0, strafe: 0, run: false }; }, lock: async () => {}, unlock: noop,
    consumeMouse: () => ({ x: 0, y: 0 }), axis: () => motion };
  const uniforms = (names) => Object.fromEntries(names.map(n => [n, { value: n.includes('Color') ? new THREE.Color() : n.includes('Pos') ? new THREE.Vector3() : 0 }]));
  const video = Object.assign(new EventTarget(), { pause: noop, play: async () => {}, classList: { add: noop, remove: noop }, style: {}, duration: 10, currentTime: 0 });
  const app = { hall, stepwell, summit, colliders, camera, player, audio, input, video, paused: false,
    settings: { sound: 4, look: 3 }, filmFov: () => 41, resume: noop, rig: makeCabinRig(),
    renderer: { domElement: { height: 1080 } },
    ui: { show: noop, hush: noop, whisper: noop, menu: noop, showEnd: noop, read: noop, unread: noop, reading: false },
    progress: loadProgress(),
    sky: { uniforms: uniforms(['uStars', 'uDawn', 'uSeam', 'uSeamOpen']) },
    dust: { uniforms: uniforms(['uOpacity', 'uLightPos', 'uLightColor']) },
    post: { fadeColor: new THREE.Color(), exposure: 1, fade: 0 },
  };
  app.story = new Story(app);
  const director = app.director = new Director(app);
  director.reset();
  let time = 0;
  const tick = (seconds = 1 / 60) => { time += seconds; director.update(seconds, time); };
  const advance = seconds => { for (let n = 0; n < Math.ceil(seconds * 60); n++) tick(); };
  const walk = (x, z, maxSeconds = 90) => {
    motion = { forward: 1, strafe: 0, run: true };
    for (let n = 0; n < maxSeconds * 60; n++) {
      const dx = x - player.position.x, dz = z - player.position.z;
      if (Math.hypot(dx, dz) < 0.25) { input.clear(); return; }
      player.setLook(Math.atan2(-dx, -dz), 0);
      tick();
    }
    throw new Error(`Cannot reach [${x},${z}]; at ${player.position.toArray()}, state=${director.state}`);
  };
  return { app, director, tick, advance, walk, calls };
}
