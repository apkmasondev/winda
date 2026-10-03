import * as THREE from 'three';
import type { Colliders } from '../core/Colliders';
import type { Input } from '../core/Input';

const EYE = 1.62;
const RADIUS = 0.3;
// unhurried, human pace: this is a place to look at, not to sprint through
const WALK = 2.35;
const RUN = 4.3;
const STRAFE = 0.82;
const BACK = 0.68;
const GRAVITY = 22;
const SUBSTEPS = 4;

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _tri = new THREE.Vector3();
const _cap = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * First-person body: a capsule resolved against the static BVH and any enabled
 * dynamic blockers. The camera rides on top: eased mouse look, a smoothed eye
 * height (no collision jitter on ramps), a footfall-shaped head bob, and a
 * little body inertia when starting, stopping and strafing.
 */
export class Player {
  /** feet position */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  private yawTarget = 0;
  private pitchTarget = 0;
  onGround = false;
  /** 0 = frozen (cutscene), 1 = full control. Blends look and movement. */
  control = 0;
  lookControl = 0;
  sensitivity = 1;
  /** head bob, sway and lean scale (accessibility setting) */
  motion = 1;
  private gait = 0;
  private gaitAmp = 0;
  private runBlend = 0;
  private eyeY = Number.NaN;
  private lean = 0;
  private roll = 0;
  private prevForwardSpeed = 0;
  private lastStepPhase = 0;
  private settle = 0;
  private airTime = 0;
  distanceWalked = 0;
  lastSafe = new THREE.Vector3();
  private safeTimer = 0;
  /** optional cinematic look target (blended by `assist`) */
  assistTarget: { yaw: number; pitch: number } | null = null;
  assist = 0;
  shake = 0;
  onStep: (speed: number) => void = () => {};
  onLand: (impact: number) => void = () => {};
  runningFor = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly colliders: Colliders) {}

  teleport(feet: THREE.Vector3, yaw?: number, pitch?: number) {
    this.position.copy(feet);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = this.yawTarget = yaw;
    if (pitch !== undefined) this.pitch = this.pitchTarget = pitch;
    this.lastSafe.copy(feet);
    this.eyeY = Number.NaN;
    this.onGround = false;
    this.airTime = this.safeTimer = this.settle = 0;
    this.gait = this.gaitAmp = this.lastStepPhase = this.runBlend = 0;
    this.lean = this.roll = this.prevForwardSpeed = this.runningFor = 0;
    this.camera.position.copy(feet).y += EYE;
    this.camera.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0));
  }

  /** Shift the player and everything relative (used by the endless stepwell). */
  offset(d: THREE.Vector3) {
    this.position.add(d);
    this.lastSafe.add(d);
    this.eyeY += d.y;
    this.camera.position.add(d);
  }

  setLook(yaw: number, pitch: number) {
    this.yaw = this.yawTarget = yaw;
    this.pitch = this.pitchTarget = pitch;
  }

  update(dt: number, input: Input, time: number) {
    // --- look ---------------------------------------------------------------
    const m = input.consumeMouse();
    if (dt <= 0) return;
    const sens = 0.0021 * this.sensitivity * this.lookControl;
    this.yawTarget -= m.x * sens;
    this.pitchTarget -= m.y * sens;
    this.pitchTarget = THREE.MathUtils.clamp(this.pitchTarget, -1.45, 1.45);
    const lk = 1 - Math.exp(-dt * 28);
    this.yaw += (this.yawTarget - this.yaw) * lk;
    this.pitch += (this.pitchTarget - this.pitch) * lk;
    if (this.assistTarget && this.assist > 0) {
      const a = 1 - Math.exp(-dt * 2.2 * this.assist);
      let dy = this.assistTarget.yaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * a;
      this.pitch += (this.assistTarget.pitch - this.pitch) * a;
      this.yawTarget = this.yaw;
      this.pitchTarget = this.pitch;
    }

    // --- desired motion -----------------------------------------------------
    const ax = input.axis();
    let fwd = ax.forward * this.control;
    let str = ax.strafe * this.control;
    const len = Math.hypot(fwd, str);
    if (len > 1) {
      fwd /= len;
      str /= len;
    }
    // people walk slower sideways and backwards
    fwd *= fwd < 0 ? BACK : 1;
    str *= STRAFE;
    this.runningFor = ax.run && len > 0 ? this.runningFor + dt : 0;
    this.runBlend += ((ax.run && len > 0 ? 1 : 0) - this.runBlend) * (1 - Math.exp(-dt * 2.5));
    const speed = WALK + (RUN - WALK) * this.runBlend;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const tx = (-sin * fwd + cos * str) * speed;
    const tz = (-cos * fwd - sin * str) * speed;
    // a body takes a moment to get going and a moment to stop
    const accel = this.onGround ? (len > 0.01 ? 4.2 : 6.0) : 1.0;
    const k = 1 - Math.exp(-dt * accel);
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    // --- integrate with substeps -------------------------------------------
    const h = dt / SUBSTEPS;
    let grounded = false;
    let impact = 0;
    for (let i = 0; i < SUBSTEPS; i++) {
      if (this.onGround) this.velocity.y = Math.min(this.velocity.y, -4.5);
      else this.velocity.y -= GRAVITY * h;
      this.position.addScaledVector(this.velocity, h);
      const r = this.resolve(h);
      if (r.ground) {
        if (!this.onGround && this.airTime > 0.25) impact = Math.max(impact, -this.velocity.y);
        grounded = true;
      }
      this.onGround = r.ground;
    }
    this.onGround = grounded;
    if (grounded) {
      if (this.airTime > 0.35 && impact > 3) {
        this.settle = Math.min(1, impact / 14);
        this.onLand(impact);
      }
      this.airTime = 0;
      this.safeTimer += dt;
      if (this.safeTimer > 0.5) {
        this.safeTimer = 0;
        this.lastSafe.copy(this.position);
      }
    } else {
      this.airTime += dt;
    }

    // --- gait ---------------------------------------------------------------
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    this.distanceWalked += hs * dt;
    const moving = grounded && hs > 0.25;
    const ampTarget = moving ? Math.min(1, hs / WALK) : 0;
    this.gaitAmp += (ampTarget - this.gaitAmp) * (1 - Math.exp(-dt * 4));
    if (moving) {
      // metres per full cycle (two steps): ~1 m steps walking, longer when running
      const stride = 2.0 + this.runBlend * 0.8;
      this.gait += ((hs * dt) / stride) * Math.PI * 2;
      const phase = Math.floor(this.gait / Math.PI);
      if (phase !== this.lastStepPhase) {
        this.lastStepPhase = phase;
        this.onStep(hs);
      }
    }
    this.settle *= Math.exp(-dt * 5);

    // body inertia: lean back when setting off, forward when stopping, into strafes
    const fwdSpeed = -Math.sin(this.yaw) * this.velocity.x - Math.cos(this.yaw) * this.velocity.z;
    const sideSpeed = Math.cos(this.yaw) * this.velocity.x - Math.sin(this.yaw) * this.velocity.z;
    const fwdAccel = dt > 0 ? (fwdSpeed - this.prevForwardSpeed) / dt : 0;
    this.prevForwardSpeed = fwdSpeed;
    const li = 1 - Math.exp(-dt * 5);
    this.lean += (THREE.MathUtils.clamp(fwdAccel * 0.0028, -0.012, 0.012) - this.lean) * li;
    this.roll += (THREE.MathUtils.clamp(-sideSpeed * 0.0035, -0.01, 0.01) - this.roll) * li;

    // --- camera -------------------------------------------------------------
    const bobScale = this.motion;
    const A = this.gaitAmp * (0.014 + 0.01 * this.runBlend) * bobScale;
    // lowest just after each footfall (phase 0, pi), highest mid-stride
    const c2 = Math.cos(this.gait * 2);
    const bob = -A * (c2 + 0.35 * c2 * c2 * Math.sign(c2));
    const sway = Math.sin(this.gait) * 0.006 * this.gaitAmp * bobScale;
    const nod = c2 * 0.0022 * this.gaitAmp * bobScale;
    const stepRoll = Math.sin(this.gait) * 0.0012 * this.gaitAmp * bobScale;
    const breathe = Math.sin(time * 1.3) * 0.0035;
    const shakeX = this.shake > 0 ? (Math.sin(time * 61) + Math.sin(time * 37)) * 0.004 * this.shake : 0;
    const shakeY = this.shake > 0 ? (Math.sin(time * 53) + Math.sin(time * 29)) * 0.005 * this.shake : 0;
    _e.set(this.pitch + shakeY - this.settle * 0.04 + nod + this.lean * bobScale, this.yaw + shakeX, stepRoll + this.roll * bobScale);
    _q.setFromEuler(_e);
    this.camera.quaternion.copy(_q);

    // eye height follows the feet through a short filter: ramps and the
    // collision solver no longer translate into a twitching camera
    const eyeTarget = this.position.y + EYE;
    if (!Number.isFinite(this.eyeY) || Math.abs(eyeTarget - this.eyeY) > 1.2) this.eyeY = eyeTarget;
    else this.eyeY += (eyeTarget - this.eyeY) * (1 - Math.exp(-dt * 16));
    _v.set(sway, 0, 0).applyAxisAngle(_v2.set(0, 1, 0), this.yaw);
    this.camera.position.set(
      this.position.x + _v.x,
      this.eyeY + bob + breathe - this.settle * 0.12,
      this.position.z + _v.z,
    );
  }

  private resolve(h: number) {
    const st = this.colliders.static!;
    const p = this.position;
    _seg.start.set(p.x, p.y + EYE - 0.32, p.z);
    _seg.end.set(p.x, p.y + RADIUS, p.z);
    const before = _v2.copy(_seg.end);

    const push = (bvh: typeof st.bvh, toLocal?: THREE.Matrix4, toWorld?: THREE.Matrix4) => {
      if (toLocal) {
        _seg.start.applyMatrix4(toLocal);
        _seg.end.applyMatrix4(toLocal);
      }
      _box.makeEmpty();
      _box.expandByPoint(_seg.start);
      _box.expandByPoint(_seg.end);
      _box.min.addScalar(-RADIUS);
      _box.max.addScalar(RADIUS);
      bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(_seg, _tri, _cap);
          if (d < RADIUS) {
            const depth = RADIUS - d;
            _dir.subVectors(_cap, _tri).normalize();
            _seg.start.addScaledVector(_dir, depth);
            _seg.end.addScaledVector(_dir, depth);
          }
        },
      });
      if (toWorld) {
        _seg.start.applyMatrix4(toWorld);
        _seg.end.applyMatrix4(toWorld);
      }
    };

    push(st.bvh);
    for (const d of this.colliders.dynamic.values()) if (d.enabled) push(d.bvh, d.inverse, d.matrix);

    const delta = _v.subVectors(_seg.end, before);
    const ground = delta.y > Math.abs(h * this.velocity.y * 0.25) && delta.y > 1e-5 && delta.y > Math.hypot(delta.x, delta.z) * 0.5;
    p.add(delta);
    if (delta.lengthSq() > 1e-10) {
      const n = delta.normalize();
      if (!ground) this.velocity.addScaledVector(n, -n.dot(this.velocity));
    }
    if (ground && this.velocity.y < 0) this.velocity.y = Math.max(this.velocity.y, -4.5);
    return { ground };
  }
}
