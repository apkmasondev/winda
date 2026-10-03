import * as THREE from 'three';
import type { Colliders } from '../core/Colliders';
import { LedDisplay } from '../render/Led';
import { patchSurface } from '../render/materials';

export const CABIN = {
  halfWidth: 0.85,
  depth: 2.1,
  height: 2.45,
  doorTravel: 0.505,
  /** where the passenger stands (local) */
  stand: new THREE.Vector3(0, 0, 1.45),
};

export type ElevatorOptions = {
  name: string;
  envMap: THREE.Texture | null;
  colliders?: Colliders;
  /** cast a warm pool of light through the open doors */
  spill?: boolean;
  /** interior light used for the steel reflections (0..1 at start) */
  light?: number;
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The one familiar thing in the world. Each instance is a full cabin cloned
 * from cabin.glb, with its own lights, indicator, doors and colliders.
 */
export class Elevator {
  readonly group = new THREE.Group();
  readonly display = new LedDisplay();
  readonly name: string;
  private doorL!: THREE.Object3D;
  private doorR!: THREE.Object3D;
  private doorBase = { l: 0, r: 0 };
  door = 0;
  private doorFrom = 0;
  private doorTo = 0;
  private doorT = 1;
  private doorDur = 1;
  doorMoving = false;
  onDoorsSettled: (open: boolean) => void = () => {};

  /** ceiling light level 0..1 (with optional flicker applied by the owner) */
  light = 0;
  displayLevel = 0;
  readonly materials: {
    steel: THREE.MeshStandardMaterial;
    steelDark: THREE.MeshStandardMaterial;
    shell: THREE.MeshStandardMaterial;
    floor: THREE.MeshStandardMaterial;
    lights: THREE.MeshBasicMaterial;
    display: THREE.MeshBasicMaterial;
    buttons: THREE.MeshBasicMaterial;
  };
  /** shared lights, attached to whichever cabin matters right now */
  private rig: CabinRig | null = null;
  private spillEnabled: boolean;
  envIntensity = 1;
  private colliders?: Colliders;

  constructor(template: THREE.Object3D, o: ElevatorOptions) {
    this.name = o.name;
    this.colliders = o.colliders;
    const steel = patchSurface(
      new THREE.MeshStandardMaterial({ color: 0xbfbcb6, metalness: 1, roughness: 0.3, envMap: o.envMap }),
      { brushed: true, bakedAO: 0.85, fog: true },
    );
    const steelDark = patchSurface(
      new THREE.MeshStandardMaterial({ color: 0x5d5c5a, metalness: 1, roughness: 0.42, envMap: o.envMap }),
      { bakedAO: 0.85, fog: true },
    );
    const shell = patchSurface(
      new THREE.MeshStandardMaterial({ color: 0x6f6e6c, metalness: 0.9, roughness: 0.5, envMap: o.envMap }),
      { brushed: true, bakedAO: 0.6, fog: true },
    );
    const floor = patchSurface(new THREE.MeshStandardMaterial({ color: 0x2a2826, metalness: 0, roughness: 0.55, envMap: o.envMap }), {
      bakedAO: 0.9,
      masonry: [0, 0, 0.004, 0.42],
      fog: true,
    });
    const lights = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    const display = new THREE.MeshBasicMaterial({ map: this.display.texture, color: 0x000000, toneMapped: false });
    const buttons = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    this.materials = { steel, steelDark, shell, floor, lights, display, buttons };

    const root = template.clone(true);
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      const n = mesh.name;
      if (n === 'Lights') mesh.material = lights;
      else if (n === 'Display' || n === 'DisplayOut') mesh.material = display;
      else if (n === 'Buttons') mesh.material = buttons;
      else {
        const src = (mesh.material as THREE.Material).name;
        mesh.material =
          src === 'Floor' ? floor : src === 'SteelDark' ? steelDark : src === 'Shell' ? shell : steel;
      }
      if (n.startsWith('Cabin')) mesh.castShadow = true;
    });
    // the indicator faces are exported without UVs: replace them with quads
    for (const name of ['Display', 'DisplayOut']) {
      const m = root.getObjectByName(name) as THREE.Mesh | undefined;
      if (!m) continue;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox!;
      const size = bb.getSize(new THREE.Vector3());
      const quad = new THREE.PlaneGeometry(size.x, size.y);
      const inside = name === 'Display';
      if (!inside) quad.rotateY(Math.PI);
      quad.translate((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, inside ? bb.max.z + 0.0005 : bb.min.z - 0.0005);
      m.geometry = quad;
    }
    this.doorL = root.getObjectByName('DoorL')!;
    this.doorR = root.getObjectByName('DoorR')!;
    this.doorBase.l = this.doorL.position.x;
    this.doorBase.r = this.doorR.position.x;
    this.group.add(root);
    this.group.name = o.name;

    this.spillEnabled = !!o.spill;
    this.light = o.light ?? 0;
  }

  /** Take over the shared cabin lights (re-parenting keeps the light count constant). */
  attachRig(rig: CabinRig) {
    if (rig.owner && rig.owner !== this) rig.owner.rig = null;
    rig.owner = this;
    this.rig = rig;
    rig.cabin.position.set(0, 2.25, 1.05);
    rig.display.position.set(0, 2.2, 0.22);
    rig.spill.position.set(0, 2.2, 1.2);
    rig.spillTarget.position.set(0, 0, -4);
    this.group.add(rig.cabin, rig.display, rig.spill, rig.spillTarget);
  }

  /** Place the cabin and register its walls (static) and doors (dynamic). */
  place(position: THREE.Vector3, rotationY: number) {
    this.group.position.copy(position);
    this.group.rotation.set(0, rotationY, 0);
    this.group.updateMatrixWorld(true);
    const c = this.colliders;
    if (!c) return;
    const M = this.group.matrixWorld;
    const hw = CABIN.halfWidth;
    c.box({ x: -1.0, y: -0.4, z: -0.25 }, { x: 1.0, y: 0.0, z: 2.3 }, M); // floor
    c.box({ x: -1.1, y: 0, z: -0.2 }, { x: -hw, y: 2.8, z: 2.3 }, M);
    c.box({ x: hw, y: 0, z: -0.2 }, { x: 1.1, y: 2.8, z: 2.3 }, M);
    c.box({ x: -1.1, y: 0, z: CABIN.depth }, { x: 1.1, y: 2.8, z: 2.4 }, M);
    c.box({ x: -1.1, y: 0, z: -0.2 }, { x: -0.52, y: 2.8, z: 0.0 }, M);
    c.box({ x: 0.52, y: 0, z: -0.2 }, { x: 1.1, y: 2.8, z: 0.0 }, M);
    c.box({ x: -1.1, y: CABIN.height, z: -0.2 }, { x: 1.1, y: 3.0, z: 2.4 }, M);
    c.defineDynamic(`${this.name}-doors`, [[{ x: -0.6, y: 0, z: -0.14 }, { x: 0.6, y: 2.3, z: -0.02 }]], M);
  }

  get isOpen() {
    return this.door > 0.98 && !this.doorMoving;
  }

  openDoors(duration = 2.6) {
    this.animateDoors(1, duration);
  }

  /** move the leaves to an arbitrary opening (0..1) over `duration` seconds */
  doorsTo(to: number, duration: number) {
    this.doorFrom = this.door;
    this.doorTo = to;
    this.doorT = 0;
    this.doorDur = duration;
    this.doorMoving = true;
  }

  closeDoors(duration = 2.8) {
    this.animateDoors(0, duration);
  }

  setDoors(v: number) {
    this.door = v;
    this.doorFrom = this.doorTo = v;
    this.doorT = 1;
    this.doorMoving = false;
    this.applyDoors();
  }

  private animateDoors(to: number, duration: number) {
    this.doorFrom = this.door;
    this.doorTo = to;
    this.doorT = 0;
    this.doorDur = duration * Math.max(0.25, Math.abs(to - this.door));
    this.doorMoving = true;
  }

  private applyDoors() {
    const off = this.door * CABIN.doorTravel;
    this.doorL.position.x = this.doorBase.l - off;
    this.doorR.position.x = this.doorBase.r + off;
    this.colliders?.setDynamic(`${this.name}-doors`, this.door < 0.75);
  }

  /** local -> world for a point in cabin space */
  toWorld(local: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(local).applyMatrix4(this.group.matrixWorld);
  }

  toLocal(world: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(world).applyMatrix4(new THREE.Matrix4().copy(this.group.matrixWorld).invert());
  }

  contains(world: THREE.Vector3, margin = 0) {
    const l = this.toLocal(world);
    return Math.abs(l.x) < CABIN.halfWidth + margin && l.z > -0.05 - margin && l.z < CABIN.depth + margin && l.y > -0.5 && l.y < 3;
  }

  /** world yaw for facing the doors from inside */
  get facingYaw() {
    return this.group.rotation.y;
  }

  update(dt: number) {
    if (this.doorMoving) {
      this.doorT = Math.min(1, this.doorT + dt / this.doorDur);
      this.door = this.doorFrom + (this.doorTo - this.doorFrom) * easeInOut(this.doorT);
      this.applyDoors();
      if (this.doorT >= 1) {
        this.doorMoving = false;
        this.onDoorsSettled(this.doorTo > 0.5);
      }
    }
    const L = Math.max(0, this.light);
    this.materials.lights.color.setRGB(1.0, 0.9, 0.76).multiplyScalar(5.5 * L);
    this.materials.buttons.color.setRGB(1.0, 0.82, 0.6).multiplyScalar(1.4 * Math.max(L, this.displayLevel * 0.008));
    this.materials.display.color.setScalar(1.15 * this.displayLevel);
    if (this.rig) {
      this.rig.cabin.intensity = 3.2 * L;
      this.rig.display.intensity = 0.014 * this.displayLevel * (1 - Math.min(1, L));
      this.rig.spill.intensity = this.spillEnabled ? 30 * L * Math.min(1, this.door * 1.6) : 0;
    }
    const env = this.envIntensity;
    this.materials.steel.envMapIntensity = env;
    this.materials.steelDark.envMapIntensity = env;
    this.materials.shell.envMapIntensity = env * 0.7;
    this.materials.floor.envMapIntensity = env * 0.5;
    this.display.update();
  }
}

export type CabinRig = {
  cabin: THREE.PointLight;
  display: THREE.PointLight;
  spill: THREE.SpotLight;
  spillTarget: THREE.Object3D;
  owner: Elevator | null;
};

export function makeCabinRig(): CabinRig {
  const spill = new THREE.SpotLight(0xffc890, 0, 16, 0.75, 0.65, 2);
  const spillTarget = new THREE.Object3D();
  spill.target = spillTarget;
  return {
    cabin: new THREE.PointLight(0xffd2a0, 0, 7, 2),
    display: new THREE.PointLight(0xff2412, 0, 2.2, 2),
    spill,
    spillTarget,
    owner: null,
  };
}

/**
 * Environment for the steel: the inside of a lit cabin (two warm ceiling
 * panels, dark floor). Prefiltered once with PMREM.
 */
export function makeCabinEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 2.45, 2.1),
    new THREE.MeshBasicMaterial({ color: 0x8f8a83, side: THREE.BackSide }),
  );
  room.position.y = 1.225;
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.1), new THREE.MeshBasicMaterial({ color: 0x1c1a18 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.01;
  scene.add(floor);
  for (const x of [-0.36, 0.36]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 1.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.76).multiplyScalar(9) }));
    p.rotation.x = Math.PI / 2;
    p.position.set(x, 2.43, 0);
    scene.add(p);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0, 0.05, 20, { position: new THREE.Vector3(0, 1.5, 0.3) } as never);
  pm.dispose();
  return rt.texture;
}
