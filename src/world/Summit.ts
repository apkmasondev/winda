import * as THREE from 'three';
import type { Colliders } from '../core/Colliders';
import { FOG_PARS, bindAtmosphere, atmosphere } from '../render/atmosphere';
import { glowMaterial, stoneMaterial, type StoneTextures } from '../render/materials';
import { Elevator } from './Elevator';
import { LAYOUT } from './layout';

export type SummitContext = {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  column: THREE.BufferGeometry;
  cabin: THREE.Object3D;
  textures: StoneTextures;
  colliders: Colliders;
  cabinEnv: THREE.Texture;
};

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The top of the world: the column tops break through a sea of cloud at dawn.
 * Straight ahead, a vertical seam of light hangs in the sky - the same seam the
 * film ended on, between two closed doors - and it is about to open.
 */
export class Summit {
  readonly group = new THREE.Group();
  readonly origin = LAYOUT.summit.clone();
  readonly elevator: Elevator;
  private clouds: THREE.Mesh;
  /** platform front edge (local z) - reaching it starts the finale */
  readonly edgeZ = -12.6;
  /** the last plate rests on a lectern on the axis toward the seam (local) */
  readonly lectern = { top: v3(0, 0.984, -4.6), normal: v3(0, 0.866, 0.5), up: v3(0, 0.5, -0.866) };

  constructor(private readonly ctx: SummitContext) {
    const { textures } = ctx;
    this.group.position.copy(this.origin);
    const stone = stoneMaterial(textures, { color: 0x9a938a, masonry: [0.9, 2.2, 0.012, 1.6] });
    const col = stoneMaterial(textures, { color: 0x8a847c, masonry: [6.0, 1000, 0.05, 0], normalStrength: 0, tile: 11 });

    // platform: a broad capital on a doubled column
    const cap = new THREE.Mesh(new THREE.BoxGeometry(16, 1.6, 16), stone);
    cap.position.set(0, -0.8, -5);
    const cap2 = new THREE.Mesh(new THREE.BoxGeometry(14.6, 1.2, 14.6), stone);
    cap2.position.set(0, -2.2, -5);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(16.3, 0.24, 16.3), stone);
    lip.position.set(0, -1.72, -5);
    cap.receiveShadow = cap2.receiveShadow = true;
    this.group.add(cap, cap2, lip);

    // lectern: a stone block with a top raked 30 degrees toward the cabin,
    // set 5 cm into the platform
    const lg = new THREE.BoxGeometry(0.5, 1, 0.36);
    const pos = lg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) pos.setY(i, 0.38 + (0.18 - pos.getZ(i)) * Math.tan(Math.PI / 6));
      else pos.setY(i, -0.55);
    }
    lg.computeVertexNormals();
    // one block of stone: no coursing on something this small
    const lectern = new THREE.Mesh(lg, stoneMaterial(textures, { color: 0x9a938a }));
    lectern.position.set(0, 0.5, this.lectern.top.z);
    lectern.castShadow = lectern.receiveShadow = true;
    this.group.add(lectern);

    const mats: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    for (const k of [0, 1, 2]) mats.push(new THREE.Matrix4().compose(v3(0, -62.8 - k * 120, -5), q, v3(1.9, 1, 1.9)));

    // other column tops: none close, a few colossal ones, and a far field
    // whose size can no longer be judged. The axis toward the seam stays clear.
    const rnd = (n: number) => {
      const x = Math.sin(n * 91.7 + 17.3) * 43758.5453;
      return x - Math.floor(x);
    };
    const tops: THREE.Matrix4[] = [];
    const place = (x: number, z: number, scale: number, rise: number) => {
      // rise: how far the top stands above the platform (can be negative)
      for (const k of [0, 1]) mats.push(new THREE.Matrix4().compose(v3(x, rise - 60 - k * 120, z), q, v3(scale, 1, scale)));
      // a single broad abacus slab
      tops.push(new THREE.Matrix4().compose(v3(x, rise + 0.45 * scale, z), q, v3(scale * 9.4, scale * 0.9, scale * 9.4)));
    };
    // two that frame the seam like the jambs of a door
    place(-420, -1100, 13, 70);
    place(480, -1250, 15, 95);
    // near presences, mostly below the platform: you look down on them
    place(-150, -120, 4.2, -26);
    place(190, -40, 5.0, -10);
    place(-170, 190, 6.0, 14);
    place(240, 260, 4.4, -34);
    place(30, 330, 7.0, 34);
    for (let i = 0; i < 46; i++) {
      const a = rnd(i) * Math.PI * 2;
      const r = 650 + Math.pow(rnd(i + 100), 1.2) * 3400;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (z < -400 && Math.abs(x) < -z * 0.3) continue; // keep the seam axis clear
      const scale = 6 + rnd(i + 200) * (4 + r / 160);
      const rise = -30 + rnd(i + 300) * (40 + r * 0.05);
      place(x, z, scale, rise);
    }
    const colMesh = new THREE.InstancedMesh(ctx.column, col, mats.length);
    mats.forEach((m, i) => colMesh.setMatrixAt(i, m));
    colMesh.receiveShadow = true;
    const capMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), col, tops.length);
    tops.forEach((m, i) => capMesh.setMatrixAt(i, m));
    this.group.add(colMesh, capMesh);

    // a second elevator, alone on a column top far away, lit
    const far = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.9, 2.4), new THREE.MeshStandardMaterial({ color: 0x4a4846, metalness: 0.6, roughness: 0.5 }));
    shell.position.y = 1.45;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 2.1), glowMaterial(0xffc98a, 4));
    face.position.set(0, 1.05, -1.21);
    face.rotation.y = Math.PI;
    far.add(shell, face);
    // ... standing on top of the near-left column, facing us
    far.position.set(-150, -26 + 0.9 * 4.2 + 0.01, -120);
    far.rotation.y = Math.PI * 0.8;
    far.scale.setScalar(1);
    this.group.add(far);

    // cloud sea
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 1, 1), cloudMaterial());
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = -46;
    this.group.add(this.clouds);

    // the cabin
    this.elevator = new Elevator(ctx.cabin, { name: 'summit', envMap: ctx.cabinEnv, colliders: ctx.colliders, spill: true, light: 1 });
    // 5 mm proud of the platform so the two floors never share a plane
    this.elevator.place(this.origin.clone().add(v3(0, 0.005, 0)), 0);
    this.group.attach(this.elevator.group);

    this.buildColliders();
    this.group.visible = false;
  }

  private buildColliders() {
    const c = this.ctx.colliders;
    const o = this.origin;
    const M = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z);
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => c.box({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, M);
    box(-8, -1.6, -13, 8, 0, 3);
    // a soft guard short of the edge - the edge is where the world ends
    box(-9, 0, -13.6, 9, 2, -12.9);
    box(-9, 0, -13.6, -7.4, 2, 3);
    box(7.4, 0, -13.6, 9, 2, 3);
    box(-9, 0, 2.5, 9, 2, 3.5);
    const lz = this.lectern.top.z;
    box(-0.25, 0, lz - 0.18, 0.25, 1.1, lz + 0.18);
  }

  /** Re-aim the shared sun for dawn at the top of the world. */
  configureLights(level: number) {
    const { sun, hemi } = this.ctx;
    sun.color.set(0xffc49a);
    sun.intensity = 2.4 * level;
    sun.position.copy(this.origin).add(v3(30, 70, -260));
    sun.target.position.copy(this.origin).add(v3(0, 0, -5));
    sun.target.updateMatrixWorld();
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -18;
    sc.right = sc.top = 18;
    sc.near = 150;
    sc.far = 420;
    sc.updateProjectionMatrix();
    hemi.color.set(0x5a6c90);
    hemi.groundColor.set(0x6d5a50);
    hemi.intensity = 1.1 * level;
  }

  update(dt: number, t: number) {
    void dt;
    (this.clouds.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
  }
}

function cloudMaterial() {
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uLow: { value: new THREE.Color(0x232a3c) },
    uMid: { value: new THREE.Color(0x6c6a80) },
    uHigh: { value: new THREE.Color(0xffc49a) },
    uSun: { value: new THREE.Vector3(0.1, 0.18, -1).normalize() },
    uBright: { value: 1 },
  };
  bindAtmosphere(uniforms);
  void atmosphere;
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWPos = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FOG_PARS}
      varying vec3 vWPos;
      uniform float uTime;
      uniform vec3 uLow;
      uniform vec3 uMid;
      uniform vec3 uHigh;
      uniform vec3 uSun;
      uniform float uBright;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
      float field(vec2 p) {
        vec2 q = p + vec2(fbm(p * 0.7 + uTime * 0.002), fbm(p * 0.7 - 3.1)) * 0.8;
        return fbm(q);
      }
      void main() {
        float d = distance(vWPos.xz, cameraPosition.xz);
        vec2 p = vWPos.xz * 0.0045 + vec2(uTime * 0.0012, uTime * 0.0005);
        float e = 0.03;
        float c0 = field(p);
        float cx = field(p + vec2(e, 0.0));
        float cz = field(p + vec2(0.0, e));
        // billowing height field -> normal; fade relief with distance
        float relief = mix(9.0, 2.0, smoothstep(300.0, 2500.0, d));
        vec3 nrm = normalize(vec3((c0 - cx) * relief / e * 0.06, 1.0, (c0 - cz) * relief / e * 0.06));
        float lit = clamp(dot(nrm, uSun) * 2.2 + 0.25, 0.0, 1.0);
        float crest = smoothstep(0.35, 0.75, c0);
        vec3 col = mix(uLow, uMid, crest);
        // light raking from the seam side
        vec3 dir = normalize(vWPos - cameraPosition);
        float toward = 0.5 + 0.5 * dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSun.x, 0.0, uSun.z)));
        col += uHigh * lit * crest * (0.25 + 0.95 * pow(toward, 3.0));
        col *= uBright;
        col = applyFog(col, vWPos);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
