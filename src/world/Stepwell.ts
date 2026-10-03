import * as THREE from 'three';
import type { Colliders } from '../core/Colliders';
import { bakedMaterial, glowMaterial, type StoneTextures } from '../render/materials';
import { Elevator } from './Elevator';
import { LAYOUT } from './layout';

export type StepwellContext = {
  module: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  lamps: THREE.BufferGeometry;
  cabin: THREE.Object3D;
  textures: StoneTextures;
  colliders: Colliders;
  cabinEnv: THREE.Texture;
};

const S = 13;
const V = 9.5;
const RENDER_COPIES = [-5, -4, -3, -2, -1, 0, 1, 2, 3];

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The endless stepwell. Geometry, lighting and fog are all periodic, so moving
 * the player by exactly one period is invisible. The only thing that is not
 * periodic is the elevator, which appears in the alcove after the first lap.
 */
export class Stepwell {
  readonly group = new THREE.Group();
  readonly origin: THREE.Vector3;
  readonly period = LAYOUT.stepwell.period;
  readonly elevator: Elevator;
  readonly material: THREE.ShaderMaterial;
  wraps = 0;
  /** downward wraps only - the descent counter shown on the panel */
  depth = 0;
  spawned = false;
  arrived = false;
  onWrap: (dir: number) => void = () => {};

  constructor(private readonly ctx: StepwellContext) {
    const sw = LAYOUT.stepwell;
    this.origin = v3(sw.x, sw.y0, sw.z);
    this.material = bakedMaterial(ctx.textures);

    const mod = new THREE.InstancedMesh(ctx.module, this.material, RENDER_COPIES.length);
    const lamps = new THREE.InstancedMesh(ctx.lamps, glowMaterial(0xffb27a, 5.5), RENDER_COPIES.length);
    const capCopies = RENDER_COPIES.filter((k) => k !== 0);
    const caps = new THREE.InstancedMesh(ctx.cap, this.material, capCopies.length);
    RENDER_COPIES.forEach((k, i) => {
      const m = new THREE.Matrix4().makeTranslation(0, k * this.period, 0);
      mod.setMatrixAt(i, m);
      lamps.setMatrixAt(i, m);
    });
    capCopies.forEach((k, i) => caps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(0, k * this.period, 0)));
    mod.frustumCulled = lamps.frustumCulled = caps.frustumCulled = false;
    this.group.add(mod, lamps, caps);
    this.group.position.copy(this.origin);

    this.elevator = new Elevator(ctx.cabin, { name: 'stepwell', envMap: ctx.cabinEnv, colliders: ctx.colliders, spill: false, light: 0 });
    // alcove on the east wall at the NE landing; cabin interior runs +x
    // 5 mm proud of the stone: the cabin floor must never share the alcove floor's plane
    this.elevator.place(this.toWorld(v3(13.22, -12 + 0.005, -11.25)), Math.PI / 2);
    this.elevator.group.visible = false;
    this.elevator.envIntensity = 0.0;

    this.buildColliders();
  }

  toWorld(local: THREE.Vector3) {
    return local.clone().add(this.origin);
  }

  toLocal(world: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(world).sub(this.origin);
  }

  /** is the point inside the shaft or its corridor (where the hall cannot be seen) */
  contains(world: THREE.Vector3) {
    const l = this.toLocal(world);
    return l.x > -23 && l.x < 16 && l.z > -16 && l.z < 13.5;
  }

  inShaft(world: THREE.Vector3) {
    const l = this.toLocal(world);
    return Math.abs(l.x) < 13.4 && Math.abs(l.z) < 13.4;
  }

  private buildColliders() {
    const c = this.ctx.colliders;
    for (const k of [-1, 0, 1]) {
      const o = this.origin.clone().add(v3(0, k * this.period, 0));
      const M = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z);
      const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
        c.box({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, M);
      const ramp = (a: THREE.Vector3, b: THREE.Vector3) => c.ramp(a, b, 3.5, 0.9, M);
      const lift = 0.05;
      // landings
      box(-S, -1.3, V, -V, 0, S);
      box(-S, -7.3, -S, -V, -6, -V);
      box(V, -13.3, -S, S, -12, -V);
      box(V, -19.3, V, S, -18, S);
      // flights
      ramp(v3(-11.25, lift, V), v3(-11.25, -6 + lift, -V));
      ramp(v3(-V, -6 + lift, -11.25), v3(V, -12 + lift, -11.25));
      ramp(v3(11.25, -12 + lift, -V), v3(11.25, -18 + lift, V));
      ramp(v3(V, -18 + lift, 11.25), v3(-V, -24 + lift, 11.25));
      // walls (inner faces), with the corridor mouth and the alcove left open
      box(-13.8, -19, -S, -S, 5, V);
      box(-13.8, -19, V, -S, 0, S);
      box(-13.8, 4.5, V, -S, 5, S);
      box(S, -19, -S, 13.8, 5, -12.45);
      box(S, -19, -12.45, 13.8, -12, -10.05);
      box(S, -8.8, -12.45, 13.8, 5, -10.05);
      box(S, -19, -10.05, 13.8, 5, S);
      box(-S, -19, -13.8, S, 5, -S);
      box(-S, -19, S, S, 5, 13.8);
      // alcove sides
      box(S, -12, -12.75, 15.6, -8.8, -12.45);
      box(S, -12, -10.05, 15.6, -8.8, -9.75);
      // parapets (as tall guards over the void edges) and newels
      box(-9.85, -7.4, -V, -V, 1.4, V);
      box(-V, -13.4, -9.85, V, -4.6, -V);
      box(V, -19.4, -V, 9.85, -10.6, V);
      box(-V, -25.4, V, V, -16.6, 9.85);
      box(-9.9, -1.4, V - 0.05, -9.4, 1.4, V + 0.4);
      box(-9.9, -7.4, -V - 0.4, -9.4, -4.6, -V + 0.05);
      box(9.4, -13.4, -V - 0.4, 9.9, -10.6, -V + 0.05);
      box(9.4, -19.4, V - 0.05, 9.9, -16.6, V + 0.4);
      // corridor + stub
      box(-28, -1.3, 8.5, -S, 0, 17);
      box(-28, 0, 8.5, -S, 4.5, V);
      box(-28, 0, V, -27, 4.5, 17);
      box(-23, 0, S, -S, 4.5, 14);
      box(-23, 0, S, -22, 4.5, 17);
      box(-28, 4.5, 8.5, -S, 5.5, 17);
      if (k !== 0) box(-27, 0, 17, -23, 4.5, 18);
    }
  }

  /** Spawn the elevator into the alcove (called once, on the first full lap). */
  spawn() {
    if (this.spawned) return;
    this.spawned = true;
    const e = this.elevator;
    e.group.visible = true;
    e.setDoors(0);
    e.light = 0;
    e.displayLevel = 1;
    e.display.set('down', '--');
    e.envIntensity = 0.0;
  }

  /** Wrap the player by one period when they leave the band. */
  update(dt: number, player: { position: THREE.Vector3; offset: (d: THREE.Vector3) => void }) {
    void dt;
    if (this.inShaft(player.position)) {
      const ly = player.position.y - this.origin.y;
      if (ly < -21) {
        player.offset(v3(0, this.period, 0));
        this.wraps++;
        this.depth++;
        this.onWrap(1);
      } else if (ly > 4.5) {
        player.offset(v3(0, -this.period, 0));
        this.wraps++;
        this.depth = Math.max(0, this.depth - 1);
        this.onWrap(-1);
      }
    }
    // the elevator's light falls on the baked stone
    const e = this.elevator;
    const u = this.material.uniforms;
    if (this.spawned) {
      const front = e.toWorld(v3(0, 1.6, -0.9));
      (u.uPointPos.value as THREE.Vector3).copy(front);
      const k = e.light * (0.25 + 0.75 * e.door) + e.displayLevel * 0.04;
      (u.uPointColor.value as THREE.Color).setRGB(1.0, 0.8, 0.56).multiplyScalar(2.6 * k);
    }
  }
}
