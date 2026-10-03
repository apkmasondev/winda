import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Colliders } from '../core/Colliders';
import { beamMaterial, GlowPoints, makeBeam } from '../render/fx';
import { glowMaterial, halo, stoneMaterial, type StoneTextures } from '../render/materials';
import { Elevator } from './Elevator';
import { LAYOUT, slabTop } from './layout';

type Kit = Record<'Column' | 'BridgeSeg' | 'Slab' | 'Monolith' | 'Landing' | 'Gate', THREE.BufferGeometry>;

export type HallContext = {
  kit: Kit;
  cabin: THREE.Object3D;
  textures: StoneTextures;
  colliders: Colliders;
  cabinEnv: THREE.Texture;
};

/** Collects boxes and merges them into a single draw call. */
class BoxBatch {
  private geos: THREE.BufferGeometry[] = [];
  add(min: THREE.Vector3Like, max: THREE.Vector3Like) {
    const g = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
    g.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    this.geos.push(g);
    return this;
  }
  mesh(material: THREE.Material) {
    const g = mergeGeometries(this.geos, false)!;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true;
    return m;
  }
}

type Mover = { mesh: THREE.Object3D; base: number; amp: number; period: number; offset: number };

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The first impossible space: a forest of endless columns between two towers,
 * crossed by one thin causeway that leads to a slit of light.
 */
export class Hall {
  readonly group = new THREE.Group();
  /** lights live outside `group` so hiding the hall never changes the light count */
  readonly lights = new THREE.Group();
  readonly arrival: Elevator;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly slitSpot: THREE.SpotLight;
  readonly shaftSpot: THREE.SpotLight;
  readonly canyonSpot: THREE.SpotLight;
  readonly flood: THREE.SpotLight;
  private monolith!: THREE.Mesh;
  private slabs: THREE.Mesh[] = [];
  private slabBase: number[] = [];
  private movers: Mover[] = [];
  private beams: THREE.Mesh[] = [];
  readonly slitCenter = V(0, 8, -150);
  readonly moverPositions: THREE.Vector3[] = [];
  /** 0..1 global multiplier for everything that lights the hall */
  lightLevel = 1;

  constructor(private readonly ctx: HallContext) {
    const { textures } = ctx;
    const L = LAYOUT;

    // ---------------------------------------------------------------- materials
    // sparse, large coursing reads as colossal; dense detail would read as small
    const tower = stoneMaterial(textures, { color: 0x77726a, masonry: [2.4, 7.2, 0.03, 0], heightFade: [10, 60, 140], tile: 7 });
    const kitStone = stoneMaterial(textures, { color: 0x8c867d, bakedAO: 0.9, masonry: [0.9, 2.4, 0.01, 1.5] });
    const kitPlain = stoneMaterial(textures, { color: 0x8c867d, bakedAO: 0.9 });
    // code-built blocks have no baked AO attribute
    const built = stoneMaterial(textures, { color: 0x7d7872, masonry: [1.8, 5.4, 0.016, 1.5], tile: 9, normalStrength: 0 });
    const column = stoneMaterial(textures, { color: 0x6f6a63, masonry: [6.0, 1000, 0.05, 0], heightFade: [0, 50, 110], tile: 11, normalStrength: 0 });
    const walkway = stoneMaterial(textures, { color: 0x6b665f, normalStrength: 0, heightFade: [0, 60, 160], tile: 6 });

    // ---------------------------------------------------------------- arrival
    this.arrival = new Elevator(ctx.cabin, { name: 'arrival', envMap: ctx.cabinEnv, colliders: ctx.colliders });
    this.arrival.place(V(0, 0, 0), 0);
    this.arrival.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.name === 'DoorL' || m.name === 'DoorR')) m.castShadow = true;
    });
    this.group.add(this.arrival.group);

    const landing = new THREE.Mesh(ctx.kit.Landing, kitStone);
    landing.receiveShadow = landing.castShadow = true;
    this.group.add(landing);

    // ---------------------------------------------------------------- towers
    const tb = new BoxBatch();
    const tb2 = new BoxBatch();
    const Y = 1600;
    const t1 = L.t1;
    // T1 with a hole for the portal recess (2.4 x 3.2)
    // (the hole matches the outside of the portal lining, so no faces coincide)
    tb.add(V(-t1.halfWidth, -Y, t1.zFront), V(-1.5, Y, t1.zBack));
    tb.add(V(1.5, -Y, t1.zFront), V(t1.halfWidth, Y, t1.zBack));
    tb.add(V(-1.5, 3.5, t1.zFront), V(1.5, Y, t1.zBack));
    tb.add(V(-1.5, -Y, t1.zFront), V(1.5, -0.3, t1.zBack));
    tb.add(V(-1.5, -0.3, 2.45), V(1.5, 3.5, t1.zBack));
    // T2: recessed frame around the slit, then the slit itself
    const t2 = L.t2;
    const s = L.slit;
    tb2.add(V(-t2.halfWidth, -Y, t2.zRecess), V(-t2.recessHalf, Y, t2.zFront));
    tb2.add(V(t2.recessHalf, -Y, t2.zRecess), V(t2.halfWidth, Y, t2.zFront));
    tb2.add(V(-t2.recessHalf, t2.recessTop, t2.zRecess), V(t2.recessHalf, Y, t2.zFront));
    tb2.add(V(-t2.recessHalf, -Y, t2.zRecess), V(t2.recessHalf, L.b2.y - 1.6, t2.zFront));
    tb2.add(V(-t2.halfWidth, -Y, t2.zBack), V(-s.half - 1, Y, t2.zRecess));
    tb2.add(V(s.half + 1, -Y, t2.zBack), V(t2.halfWidth, Y, t2.zRecess));
    tb2.add(V(-s.half - 1, s.y1, -165), V(s.half + 1, Y, t2.zRecess));
    tb2.add(V(-s.half - 1, -Y, -165), V(s.half + 1, s.y0 - 1.3, t2.zRecess));
    tb2.add(V(-s.half - 1, -Y, t2.zBack), V(s.half + 1, Y, -165));
    // endless towers and columns would (correctly) block all slanted light -
    // only the local architecture casts shadows
    const towers = tb.mesh(tower);
    towers.castShadow = false;
    // the destination tower is darker stone: a monolith that the slit cuts open
    const towerDark = stoneMaterial(textures, { color: 0x4a4641, masonry: [2.4, 7.2, 0.03, 0], heightFade: [10, 50, 120], tile: 7 });
    const tower2 = tb2.mesh(towerDark);
    this.group.add(towers, tower2);

    // pilasters on both tower faces: vertical rhythm that reads the height
    const pil = new THREE.BoxGeometry(1.4, 2 * Y, 0.9);
    const pilasters = (xs: number[], z: number, mat: THREE.Material) => {
      const im = new THREE.InstancedMesh(pil, mat, xs.length);
      xs.forEach((x, i) => im.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, z)));
      im.receiveShadow = true;
      this.group.add(im);
    };
    pilasters([-36, -28, -20, -12, 12, 20, 28, 36], t1.zFront - 0.45, tower);
    pilasters([-55, -45, -35, -25, -15, 15, 25, 35, 45, 55], t2.zFront + 0.45, towerDark);

    // ---------------------------------------------------------------- causeway
    const segs: THREE.Matrix4[] = [];
    for (let z = L.b1.z0 - 6; z >= L.b1.z1 + 6 - 1e-3; z -= 12) segs.push(new THREE.Matrix4().makeTranslation(0, L.b1.y, z));
    for (let z = L.b2.z0 - 6; z >= L.b2.z1 + 6 - 1e-3; z -= 12) segs.push(new THREE.Matrix4().makeTranslation(0, L.b2.y, z));
    const bridge = new THREE.InstancedMesh(ctx.kit.BridgeSeg, kitStone, segs.length);
    segs.forEach((m, i) => bridge.setMatrixAt(i, m));
    bridge.receiveShadow = bridge.castShadow = true;
    this.group.add(bridge);

    // threshold in front of the slit
    const thr = new BoxBatch()
      .add(V(-t2.recessHalf, L.b2.y - 1.6, t2.zRecess), V(t2.recessHalf, L.b2.y, L.b2.z1))
      .add(V(-t2.recessHalf, L.b2.y, L.b2.z1 - 0.5), V(-L.deckHalf - 0.6, L.b2.y + 0.22, L.b2.z1))
      .add(V(L.deckHalf + 0.6, L.b2.y, L.b2.z1 - 0.5), V(t2.recessHalf, L.b2.y + 0.22, L.b2.z1))
      .mesh(built);
    this.group.add(thr);

    // gate
    const gate = new THREE.Mesh(ctx.kit.Gate, kitPlain);
    gate.position.set(0, 0, L.gateZ);
    gate.castShadow = gate.receiveShadow = true;
    this.group.add(gate);

    // monolith
    this.monolith = new THREE.Mesh(ctx.kit.Monolith, kitPlain);
    this.monolith.position.copy(L.monolith);
    this.monolith.castShadow = true;
    this.monolith.receiveShadow = true;
    this.group.add(this.monolith);

    // floating slabs
    for (let i = 0; i < L.slabs.count; i++) {
      const { z, y } = slabTop(i);
      const m = new THREE.Mesh(ctx.kit.Slab, kitStone);
      const jitter = Math.sin(i * 12.9898 + 1.3);
      m.position.set(jitter * 0.3, y, z);
      m.rotation.y = jitter * 0.06;
      // narrower than the pitch: the gaps show the void under every step
      m.scale.set(1, 1, 0.78);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      this.slabs.push(m);
      this.slabBase.push(y);
    }

    // ---------------------------------------------------------------- columns
    this.buildColumns(column);

    // ---------------------------------------------------------------- walkways at other depths
    this.buildWalkways(walkway);

    // ---------------------------------------------------------------- canyon
    this.buildCanyon(built);

    // ---------------------------------------------------------------- elevators where they should not be
    this.buildFacades();
    this.buildMovers();

    // ---------------------------------------------------------------- light
    this.hemi = new THREE.HemisphereLight(0x2b384a, 0x0a0c0f, 0.0);
    this.lights.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xc9d6ee, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -46;
    sc.right = 46;
    sc.top = 46;
    sc.bottom = -46;
    sc.near = 1;
    sc.far = 520;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.06;
    this.lights.add(this.sun, this.sun.target);

    // the slit throws a long cold wash down the lower causeway
    this.slitSpot = new THREE.SpotLight(0xbcd2f0, 0, 170, 0.32, 0.9, 1.1);
    this.slitSpot.position.set(0, 14, -146);
    this.slitSpot.target.position.set(0, L.b2.y, -95);
    this.lights.add(this.slitSpot, this.slitSpot.target);

    // light pouring down the canyon from its top
    this.canyonSpot = new THREE.SpotLight(0xd8e6ff, 0, 90, 0.42, 0.7, 0.6);
    this.canyonSpot.position.set(0, s.y1 - 1, -147);
    this.canyonSpot.target.position.set(0, s.y0, -150);
    this.lights.add(this.canyonSpot, this.canyonSpot.target);

    // one shaft of light lands exactly where the causeway breaks
    const sunDir = L.sunDir;
    const pool = V(0, L.b1.y, -56);
    this.shaftSpot = new THREE.SpotLight(0xffe2c0, 0, 0, 0.034, 0.65, 0);
    this.shaftSpot.position.copy(pool).addScaledVector(sunDir, -150);
    this.shaftSpot.target.position.copy(pool);
    this.lights.add(this.shaftSpot, this.shaftSpot.target);

    // light entering the arrival cabin as its doors part (shadowed by the doors)
    this.flood = new THREE.SpotLight(0xb7c9e6, 0, 14, 0.42, 0.85, 1.4);
    this.flood.position.set(0, 2.6, -7);
    this.flood.target.position.set(0, 0.6, 2.0);
    this.flood.castShadow = true;
    this.flood.shadow.mapSize.set(1024, 1024);
    this.flood.shadow.bias = -0.0006;
    this.flood.shadow.camera.near = 2;
    this.flood.shadow.camera.far = 14;
    this.lights.add(this.flood, this.flood.target);

    // shafts
    const beamMat = beamMaterial(0xffe0bc, 0.34, 'hall-beam');
    const beamMatFar = beamMaterial(0xffe0bc, 0.09, 'hall-beam-far');
    const beams: Array<[THREE.Vector3, number, number, THREE.ShaderMaterial]> = [
      [pool, 175, 3.8, beamMat],
      [V(47, -36, -31), 260, 6, beamMatFar],
      [V(-62, -92, -102), 320, 9, beamMatFar],
      [V(96, -24, -112), 250, 5, beamMatFar],
      [V(-34, -64, 22), 290, 7, beamMatFar],
      [V(-128, -40, -64), 320, 12, beamMatFar],
      [V(150, -70, 10), 330, 10, beamMatFar],
    ];
    for (const [p, len, r, mat] of beams) {
      const from = p.clone().addScaledVector(sunDir, -len);
      const b = makeBeam(from, sunDir, len, r, r * 1.05, mat);
      this.beams.push(b);
      this.group.add(b);
    }

    this.buildColliders();
  }

  // ---------------------------------------------------------------------------
  private buildColumns(material: THREE.Material) {
    const geo = this.ctx.kit.Column;
    const mats: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const rnd = (n: number) => {
      const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    let n = 0;
    // a broad nave around the causeway, then an ordered forest that grows
    // in scale with distance until its size can no longer be judged
    for (let ix = -9; ix <= 9; ix++) {
      if (ix === 0) continue;
      for (let iz = -4; iz <= 15; iz++) {
        const xs = Math.sign(ix) * (30 + (Math.abs(ix) - 1) * 32);
        const z = -22 - iz * 32;
        const ax = Math.abs(xs);
        if (ax < 48 && z > -8) continue; // T1
        if (ax < 70 && z < -126 && z > -244) continue; // T2
        n++;
        const dist = Math.hypot(xs, Math.max(0, Math.abs(z + 70) - 70));
        const scale = 1 + THREE.MathUtils.smoothstep(dist, 50, 300) * (1.2 + rnd(n) * 1.8);
        const near = dist < 120;
        const ks = near ? [-2, -1, 0, 1, 2] : [-1, 0, 1];
        // keep the banding rings away from eye level near the causeway
        let jitterY = (rnd(n + 9) - 0.5) * 36;
        if (near && Math.abs(jitterY) < 14) jitterY = 14 * Math.sign(jitterY || 1) + jitterY * 0.3;
        for (const k of ks) {
          mats.push(new THREE.Matrix4().compose(V(xs, k * 120 + jitterY + 20, z), q, V(scale, 1, scale)));
        }
      }
    }
    // a few colossal ones far out: the scale stops being readable
    const giants = [V(-210, 0, -300), V(260, 0, -180), V(-320, 0, 40), V(180, 0, -420), V(-90, 0, -460)];
    giants.forEach((p, i) => {
      for (const k of [-1, 0, 1]) mats.push(new THREE.Matrix4().compose(V(p.x, k * 120 * 3.2, p.z), q, V(4.5 + i * 0.6, 3.2, 4.5 + i * 0.6)));
    });
    const im = new THREE.InstancedMesh(geo, material, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = false;
    im.receiveShadow = true;
    this.group.add(im);
  }

  private buildWalkways(material: THREE.Material) {
    // [axis, fixed coordinate, height, from, to]
    const ways: Array<['x' | 'z', number, number, number, number]> = [
      ['x', -70, -48, -300, 300],
      ['z', -78, -22, 140, -440],
      ['z', 110, 26, 120, -420],
      ['x', -102, 64, -300, 300],
      ['x', -38, -112, -300, 300],
      ['z', -142, -78, 60, -420],
      ['x', -6, 120, -260, 260],
    ];
    const geos: THREE.BufferGeometry[] = [];
    const lamps: THREE.Vector3[] = [];
    for (const [axis, c, y, a, b] of ways) {
      const len = Math.abs(b - a);
      const mid = (a + b) / 2;
      const deck = new THREE.BoxGeometry(axis === 'x' ? len : 4.4, 0.8, axis === 'x' ? 4.4 : len);
      const keel = new THREE.BoxGeometry(axis === 'x' ? len : 1.6, 2.2, axis === 'x' ? 1.6 : len);
      deck.translate(axis === 'x' ? mid : c, y - 0.4, axis === 'x' ? c : mid);
      keel.translate(axis === 'x' ? mid : c, y - 1.9, axis === 'x' ? c : mid);
      geos.push(deck, keel);
      for (let t = Math.min(a, b) + 6; t < Math.max(a, b); t += 18) {
        const side = Math.round(t / 18) % 2 === 0 ? 1.9 : -1.9;
        lamps.push(axis === 'x' ? V(t, y + 0.9, c + side) : V(c + side, y + 0.9, t));
      }
    }
    const mesh = new THREE.Mesh(mergeGeometries(geos, false)!, material);
    mesh.receiveShadow = true;
    this.group.add(mesh);

    this.group.add(new GlowPoints(lamps, 0xffb070, 9, 0.45, 2.4).points);
  }

  private buildCanyon(material: THREE.Material) {
    const L = LAYOUT;
    const s = L.slit;
    const b = new BoxBatch();
    const z0 = L.t2.zRecess;
    b.add(V(-s.half - 1, s.y0 - 1.3, s.zEnd), V(-s.half, s.y1, z0));
    b.add(V(s.half, s.y0 - 1.3, s.zEnd), V(s.half + 1, s.y1, z0));
    b.add(V(-s.half - 1, s.y0 - 1.3, s.zEnd), V(s.half + 1, s.y0, z0)); // floor
    // wall above the low passage at the end of the canyon - kept a few cm off
    // the stepwell corridor's ceiling block so the two never share a face
    b.add(V(-s.half, s.y0 + 4.53, s.zEnd - 1), V(s.half, s.y1, s.zEnd + 0.03));
    const m = b.mesh(material);
    m.castShadow = true;
    this.group.add(m);

    // the light source: a luminous strip high above, and the glowing end wall
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2 * s.half, Math.abs(s.zEnd - z0) + 0.1), glowMaterial(0xdfeaff, 7, { fog: false }));
    sky.rotation.x = Math.PI / 2;
    sky.position.set(0, s.y1 - 0.05, (s.zEnd + z0) / 2);
    this.group.add(sky);

    // scattering in the slot, visible from the whole causeway
    const vol = makeBeam(V(0, s.y1, -147), V(0, -1, 0.0), s.y1 - s.y0, 1.9, 1.9, beamMaterial(0xd6e4ff, 0.09, 'slit-vol'));
    this.group.add(vol);
  }

  private buildFacades() {
    // closed doors scattered on the origin tower - including where no floor could be
    const z = LAYOUT.t1.zFront;
    const closed: Array<[number, number]> = [
      [-24, 14], [23, -31], [-15, 47], [31, 83], [-33, -64], [9, 128], [-17, -118], [33, 22], [-16, -27], [3, 210], [-31, 168], [16, 160],
    ];
    const open: Array<[number, number]> = [
      [17, 36], [-25, 104], [24, 62],
    ];
    const frame: THREE.BufferGeometry[] = [];
    const add = (min: THREE.Vector3, max: THREE.Vector3) => {
      const g = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
      g.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      frame.push(g);
    };
    // local: +z out of the wall
    add(V(-0.62, 0, 0), V(-0.5, 2.22, 0.05));
    add(V(0.5, 0, 0), V(0.62, 2.22, 0.05));
    add(V(-0.5, 2.1, 0), V(0.5, 2.22, 0.05));
    add(V(-1.0, -0.35, 0), V(1.0, 0, 1.1));
    add(V(-0.16, 2.32, 0), V(0.16, 2.42, 0.03));
    const frameGeo = mergeGeometries(frame, false)!;
    const doors: THREE.BufferGeometry[] = [];
    const dl = new THREE.BoxGeometry(0.497, 2.1, 0.03);
    dl.translate(-0.2515, 1.05, -0.02);
    const dr = dl.clone();
    dr.translate(0.503, 0, 0);
    doors.push(dl, dr);
    const doorGeo = mergeGeometries(doors, false)!;

    const metal = new THREE.MeshStandardMaterial({ color: 0x8b8a87, metalness: 0.55, roughness: 0.38 });
    const all = [...closed, ...open];
    const frames = new THREE.InstancedMesh(frameGeo, metal, all.length);
    const doorMesh = new THREE.InstancedMesh(doorGeo, metal, closed.length);
    const rotY = new THREE.Matrix4().makeRotationY(Math.PI);
    all.forEach(([x, y], i) => frames.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y, z).multiply(rotY)));
    closed.forEach(([x, y], i) => doorMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y, z).multiply(rotY)));
    this.group.add(frames, doorMesh);

    // indicators (tiny red), and the warm interior of the open ones
    const ind = new GlowPoints(all.map(([x, y]) => V(x, y + 2.37, z - 0.05)), 0xff2a12, 7, 0.12, 1.8).points;
    // light leaking between the closed leaves: the seam, again and again
    const seam = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.06, 2.06), glowMaterial(0xffd2a0, 12), closed.length);
    closed.forEach(([x, y], i) => seam.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y + 1.05, z - 0.036).multiply(rotY)));
    this.group.add(seam);
    const interior = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.0, 2.1), glowMaterial(0xffcf94, 4.5), open.length);
    open.forEach(([x, y], i) => interior.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y + 1.05, z - 0.03).multiply(rotY)));
    // the warm light each one throws onto the dark wall and its little ledge
    const haloMat = glowMaterial(0xffb877, 0.3, { additive: true, map: halo() });
    const halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, all.length);
    all.forEach(([x, y], i) => {
      const k = i >= closed.length ? 2.2 : 1;
      halos.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y + 1.0, z - 0.06).multiply(rotY).multiply(new THREE.Matrix4().makeScale(3.6 * k, 5.6 * k, 1)));
    });
    halos.renderOrder = 5;
    this.group.add(ind, interior, halos);
  }

  private buildMovers() {
    // lit cabins travelling on the faces of distant columns
    const shell = new THREE.BoxGeometry(2.0, 2.9, 2.4);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x3b3a39, metalness: 0.6, roughness: 0.5 });
    const faceMat = glowMaterial(0xffcd90, 3.4);
    const face = new THREE.PlaneGeometry(1.0, 2.1);
    const glowBand = new THREE.PlaneGeometry(0.3, 0.06);
    const defs: Array<[THREE.Vector3, number, number, number, number]> = [
      // position (x, z on the column face), facing yaw, base y, amplitude, period
      [V(57.3, 0, -22), Math.PI / 2, -6, 64, 96],
      [V(-57.3, 0, -118), -Math.PI / 2, 20, 120, 130],
      [V(89.3, 0, -86), Math.PI / 2, -40, 110, 112],
      [V(-121.3, 0, -54), -Math.PI / 2, 10, 160, 150],
      [V(153.3, 0, -214), Math.PI / 2, -60, 140, 170],
    ];
    defs.forEach(([p, yaw, base, amp, period], i) => {
      const g = new THREE.Group();
      const sh = new THREE.Mesh(shell, shellMat);
      sh.position.y = 1.45;
      const f = new THREE.Mesh(face, faceMat);
      f.position.set(0, 1.05, -1.21);
      f.rotation.y = Math.PI;
      const band = new THREE.Mesh(glowBand, glowMaterial(0xff2a12, 5));
      band.position.set(0, 2.45, -1.215);
      band.rotation.y = Math.PI;
      g.add(sh, f, band);
      g.position.set(p.x, base, p.z);
      g.rotation.y = yaw + Math.PI;
      this.group.add(g);
      this.movers.push({ mesh: g, base, amp, period, offset: i * 0.37 });
      this.moverPositions.push(g.position);
    });
  }

  private buildColliders() {
    const c = this.ctx.colliders;
    const L = LAYOUT;
    const dh = L.deckHalf;
    const wallH = 1.6;
    const inner = dh - L.curb + 0.02;
    const ld = L.landing;
    // T1 face around the portal recess, and the recess walls
    c.box(V(-60, -2, ld.zBack - 1), V(-1.2, 8, ld.zBack));
    c.box(V(1.2, -2, ld.zBack - 1), V(60, 8, ld.zBack));
    c.box(V(-1.2, 3.2, ld.zBack - 1), V(1.2, 8, -0.1));
    c.box(V(-2, -1, ld.zBack - 0.1), V(-1.2, 4, -0.1));
    c.box(V(1.2, -1, ld.zBack - 0.1), V(2, 4, -0.1));
    c.box(V(-1.2, -1, ld.zBack - 0.1), V(1.2, 0, -0.1));
    c.box(V(-1.2, 0, -0.32), V(-0.52, 3.2, -0.1));
    c.box(V(0.52, 0, -0.32), V(1.2, 3.2, -0.1));
    // landing deck and guard walls
    c.box(V(-ld.halfWidth, -1.2, ld.zFront), V(ld.halfWidth, 0, ld.zBack));
    c.box(V(-ld.halfWidth - 1, 0, ld.zFront - 0.5), V(-ld.halfWidth + L.curb, wallH, ld.zBack));
    c.box(V(ld.halfWidth - L.curb, 0, ld.zFront - 0.5), V(ld.halfWidth + 1, wallH, ld.zBack));
    c.box(V(-ld.halfWidth, 0, ld.zFront - 0.6), V(-dh, wallH, ld.zFront + 0.3));
    c.box(V(dh, 0, ld.zFront - 0.6), V(ld.halfWidth, wallH, ld.zFront + 0.3));
    // B1
    c.box(V(-dh, -0.6, L.b1.z1), V(dh, 0, L.b1.z0));
    c.box(V(-dh - 1, 0, L.b1.z1), V(-inner, wallH, L.b1.z0 + 0.4));
    c.box(V(inner, 0, L.b1.z1), V(dh + 1, wallH, L.b1.z0 + 0.4));
    // slabs: one ramp with guard walls (the stones float, the ramp is the walk)
    const a = V(0, L.b1.y, L.slabs.z0 + 0.2);
    const b = V(0, L.b2.y, L.b2.z0 - 0.2);
    c.ramp(a, b, 3.4, 0.8);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const len = a.distanceTo(b);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, -1), b.clone().sub(a).normalize());
    c.obb(mid.clone().add(V(-2.15, 0.6, 0)), V(0.6, 3.0, len + 1), q);
    c.obb(mid.clone().add(V(2.15, 0.6, 0)), V(0.6, 3.0, len + 1), q);
    // B2 and threshold
    c.box(V(-dh, L.b2.y - 0.6, L.b2.z1), V(dh, L.b2.y, L.b2.z0));
    c.box(V(-dh - 1, L.b2.y, L.b2.z1 + 0.5), V(-inner, L.b2.y + wallH, L.b2.z0 + 0.4));
    c.box(V(inner, L.b2.y, L.b2.z1 + 0.5), V(dh + 1, L.b2.y + wallH, L.b2.z0 + 0.4));
    const t2 = L.t2;
    c.box(V(-t2.recessHalf, L.b2.y - 1.6, t2.zRecess), V(t2.recessHalf, L.b2.y, L.b2.z1));
    c.box(V(-t2.recessHalf - 1, L.b2.y, t2.zRecess), V(-t2.recessHalf, L.b2.y + 6, L.b2.z1));
    c.box(V(t2.recessHalf, L.b2.y, t2.zRecess), V(t2.recessHalf + 1, L.b2.y + 6, L.b2.z1));
    c.box(V(-t2.recessHalf, L.b2.y, L.b2.z1 - 0.5), V(-dh - 0.6 + 0.3, L.b2.y + wallH, L.b2.z1 + 0.6));
    c.box(V(dh + 0.6 - 0.3, L.b2.y, L.b2.z1 - 0.5), V(t2.recessHalf, L.b2.y + wallH, L.b2.z1 + 0.6));
    c.box(V(-t2.recessHalf, L.b2.y, t2.zRecess - 1), V(-L.slit.half, L.b2.y + 10, t2.zRecess));
    c.box(V(L.slit.half, L.b2.y, t2.zRecess - 1), V(t2.recessHalf, L.b2.y + 10, t2.zRecess));
    // canyon
    const s = L.slit;
    c.box(V(-s.half, s.y0 - 1.3, s.zEnd), V(s.half, s.y0, t2.zRecess));
    c.box(V(-s.half - 1, s.y0, s.zEnd - 0.5), V(-s.half, s.y0 + 12, t2.zRecess));
    c.box(V(s.half, s.y0, s.zEnd - 0.5), V(s.half + 1, s.y0 + 12, t2.zRecess));
  }

  /** world-space elevator positions on the origin tower (for audio) */
  update(dt: number, t: number) {
    void dt;
    // the monolith turns imperceptibly and breathes
    this.monolith.rotation.y = t * 0.012;
    this.monolith.position.y = LAYOUT.monolith.y + Math.sin(t * 0.21) * 0.6;
    this.slabs.forEach((m, i) => {
      m.position.y = this.slabBase[i] + Math.sin(t * 0.6 + i * 0.9) * 0.035;
    });
    for (const mv of this.movers) {
      const ph = ((t / mv.period + mv.offset) % 1 + 1) % 1;
      let k: number;
      if (ph < 0.42) k = THREE.MathUtils.smootherstep(ph / 0.42, 0, 1);
      else if (ph < 0.5) k = 1;
      else if (ph < 0.92) k = 1 - THREE.MathUtils.smootherstep((ph - 0.5) / 0.42, 0, 1);
      else k = 0;
      mv.mesh.position.y = mv.base + (k - 0.5) * 2 * mv.amp;
    }
  }

  /** keep the shadow frustum around the player, texel-snapped */
  followShadow(p: THREE.Vector3) {
    const d = LAYOUT.sunDir;
    const center = V(p.x, p.y, p.z - 10);
    const texel = 92 / 2048;
    // snap in light space
    const lightRot = new THREE.Matrix4().lookAt(V(0, 0, 0), d, V(0, 1, 0));
    const inv = lightRot.clone().invert();
    center.applyMatrix4(inv);
    center.x = Math.round(center.x / texel) * texel;
    center.y = Math.round(center.y / texel) * texel;
    center.applyMatrix4(lightRot);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(d, -300);
    this.sun.target.updateMatrixWorld();
  }

  setBeamIntensity(k: number) {
    for (const b of this.beams) ((b.material as THREE.ShaderMaterial).uniforms.uIntensity.value = k);
  }
}
