import * as THREE from 'three';
import type { App } from '../App';
import { CHAPTERS } from '../core/Progress';
import { soundGain } from '../core/Settings';
import { atmosphere, blendAtmosphere, setAtmosphere, type AtmosphereState } from '../render/atmosphere';
import { GlowPoints } from '../render/fx';
import { t } from '../ui/i18n';
import { CABIN } from '../world/Elevator';
import { LAYOUT } from '../world/layout';
import { Timeline, clamp01, ramp, smooth } from './Timeline';

export type State = 'start' | 'intro' | 'arrival' | 'explore' | 'ride' | 'summit' | 'finale' | 'end';
type Region = 'cabin' | 'hall' | 'canyon' | 'stepwell' | 'summit';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const PRESET: Record<'hall' | 'canyon' | 'stepwell' | 'summit', AtmosphereState> = {
  hall: {
    density: 0.0044, layerDensity: 0.016, falloff: 0.03, base: -24,
    zenith: 0x010205, horizon: 0x172331, abyss: 0x283846,
    glowPos: V(0, 22, -150), glowColor: 0x8faacb, glowPower: 26, glowCore: 1.5, glow2Color: 0x3a2412,
  },
  canyon: {
    density: 0.011, layerDensity: 0.0, falloff: 0.03, base: -1000,
    zenith: 0x1d2836, horizon: 0x0f1620, abyss: 0x0b1016,
    glowPos: V(0, 80, -148), glowColor: 0x9db5d6, glowPower: 5, glowCore: 0.8,
  },
  stepwell: {
    density: 0.021, layerDensity: 0.0, falloff: 0.03, base: -1000,
    zenith: 0x161e2a, horizon: 0x0b0a0a, abyss: 0x020202,
    glowPos: V(25, 4000, -173.5), glowColor: 0x1f2a3a, glowPower: 3, glowCore: 0,
  },
  summit: {
    density: 0.00022, layerDensity: 0.03, falloff: 0.08, base: LAYOUT.summit.y - 75,
    zenith: 0x07112b, horizon: 0x6f7090, abyss: 0x5c5a6e,
    glowPos: V(0, LAYOUT.summit.y + 40, -4000), glowColor: 0xffb98e, glowPower: 9, glowCore: 0.7,
  },
};

const ARRIVAL_STAND = V(0, 0, 1.6);
const HEMI = 2.4;
const EXPOSURE = 1.2;
const FILM_PITCH = 0.084;

/**
 * The whole experience as a sequence: call button -> film -> darkness ->
 * the same cabin, rendered -> doors open on the impossible -> exploration ->
 * the endless stepwell -> the elevator where it should not be -> the ride ->
 * the top of the world -> the sky opens.
 */
export class Director {
  state: State = 'start';
  private tl = new Timeline();
  private t = 0;
  private region: Region = 'cabin';
  private fov = 41;
  private fovTarget = 41;
  private exposureTarget = 1;
  private hintStage = 0;
  private hintClock = 0;
  private walkedAtHint = 0;
  private runHintShown = false;
  private elevatorArrived = false;
  private summitClock = 0;
  private finaleStarted = false;
  private counter = 0;
  private hallLight = 0;
  private floodLevel = 0;
  private hemiCabin = 0;
  private renderTick = 0;
  private stepwellElevatorHeard = false;
  private filmAttempt = 0;

  constructor(private readonly app: App) {
    const v = app.video;
    v.addEventListener('ended', () => this.onFilmEnded());
    v.addEventListener('error', () => {
      if (this.state === 'intro') this.onFilmEnded(true);
    });
    app.player.onLand = (impact) => app.audio.land(impact);
    // after one full lap - in either direction - the alcove is no longer empty
    app.stepwell.onWrap = () => {
      if (!app.stepwell.spawned) app.stepwell.spawn();
    };
    app.audio.clangSites = app.hall.moverPositions;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Put every system back to the first frame after the film. */
  reset() {
    const a = this.app;
    this.state = 'start';
    this.filmAttempt++;
    a.video.pause();
    a.video.classList.remove('is-playing');
    a.input.clear();
    this.tl.reset();
    this.t = 0;
    this.hintStage = 0;
    this.hintClock = this.walkedAtHint = this.counter = 0;
    a.player.distanceWalked = 0;
    this.runHintShown = false;
    this.elevatorArrived = false;
    this.summitClock = 0;
    this.finaleStarted = false;
    this.stepwellElevatorHeard = false;
    this.hallLight = 1;
    this.floodLevel = 0;
    this.hemiCabin = 0;

    a.hall.group.visible = true;
    a.stepwell.group.visible = false;
    a.stepwell.elevator.group.visible = false;
    a.stepwell.spawned = false;
    a.stepwell.wraps = 0;
    a.stepwell.depth = 0;
    a.stepwell.elevator.setDoors(0);
    a.stepwell.elevator.light = 0;
    a.stepwell.elevator.displayLevel = 0;
    (a.stepwell.material.uniforms.uPointColor.value as THREE.Color).setRGB(0, 0, 0);
    a.summit.group.visible = false;
    a.summit.elevator.setDoors(0);

    const e = a.hall.arrival;
    e.setDoors(0);
    e.light = 0;
    e.displayLevel = 0;
    e.envIntensity = 0;
    e.display.set(null, '');
    e.display.glitch = 0;
    e.attachRig(a.rig);
    e.update(0);

    this.configureHallSun();
    this.applyHallLighting(1);
    a.hall.flood.intensity = 0;
    a.hall.flood.shadow.autoUpdate = true;
    a.hall.hemi.intensity = 0;
    a.hall.sun.intensity = 0;
    setAtmosphere(PRESET.hall);
    atmosphere.uFogVisibility.value = 0;
    const sky = a.sky.uniforms;
    sky.uStars.value = 0;
    sky.uDawn.value = 0;
    sky.uSeam.value = 0;
    sky.uSeamOpen.value = 0;
    a.dust.uniforms.uOpacity.value = 0;

    a.player.teleport(ARRIVAL_STAND, 0, FILM_PITCH);
    a.player.control = 0;
    a.player.lookControl = 0;
    a.player.assist = 0;
    a.player.assistTarget = null;
    a.player.shake = 0;
    this.fov = this.fovTarget = a.filmFov(41);
    a.camera.fov = this.fov;
    a.camera.updateProjectionMatrix();
    a.post.exposure = EXPOSURE;
    this.exposureTarget = EXPOSURE;
    a.post.fade = 0;
    a.post.fadeColor.setRGB(0, 0, 0);
    a.post.grain = 1;
    this.region = 'cabin';
    a.ui.hush();
    a.story?.close();
  }

  /** From the call button. */
  begin() {
    const a = this.app;
    if (this.state !== 'start') return;
    a.input.active = true;
    a.ui.menu('hidden');
    void a.audio.init();
    void a.input.lock();
    this.playFilm();
  }

  restart() {
    const a = this.app;
    a.resume(false);
    a.ui.show(a.ui.end, false);
    a.ui.menu('hidden');
    a.audio.hush(0.5);
    this.reset();
    a.input.active = true;
    void a.audio.init();
    void a.input.lock();
    this.playFilm();
  }

  private playFilm() {
    const a = this.app;
    this.state = 'intro';
    const v = a.video;
    v.currentTime = 0;
    v.muted = false;
    v.volume = soundGain(a.settings.sound);
    v.classList.add('is-playing');
    this.resumeFilm();
  }

  private resumeFilm() {
    const v = this.app.video;
    const attempt = ++this.filmAttempt;
    const current = () => attempt === this.filmAttempt && this.state === 'intro' && !this.app.paused;
    void v.play().catch(() => {
      if (!current()) return;
      // autoplay with sound refused (should not happen after a click): try muted
      v.muted = true;
      void v.play().catch(() => { if (current()) this.onFilmEnded(true); });
    });
  }

  private onFilmEnded(force = false) {
    if (this.state !== 'intro') return;
    const v = this.app.video;
    // ignore a stale 'ended' from a previous play while the seek to 0 settles
    if (!force && isFinite(v.duration) && v.currentTime < v.duration - 0.5) return;
    this.filmAttempt++;
    v.pause();
    // the film ends on true black; drop it instantly - the canvas is black too
    v.style.transition = 'none';
    v.classList.remove('is-playing');
    void v.offsetWidth;
    v.style.transition = '';
    this.startArrival();
  }

  /**
   * From the floor buttons (and "continue"): 0 is the whole descent with the
   * film, 1 the arrival in the hall, then the slit, the stairwell, the summit.
   */
  startChapter(index: number) {
    const a = this.app;
    if (this.state !== 'start') return;
    if (index <= 0) {
      this.begin();
      return;
    }
    a.ui.menu('hidden');
    a.input.active = true;
    void a.audio.init();
    void a.input.lock();
    if (index === 1) {
      this.startArrival();
      return;
    }
    const chapter = CHAPTERS[Math.min(index, CHAPTERS.length - 1)];
    this.jumpTo(chapter);
    a.story.reach(chapter);
    // out of black, like every other arrival
    a.post.fade = 1;
  }

  /** "ground floor": stop everything and return to the panel */
  toMenu() {
    const a = this.app;
    a.paused = false;
    a.audio.suspend(false);
    a.audio.hush(0.4);
    a.ui.show(a.ui.end, false);
    this.reset();
    a.input.active = false;
    a.input.clear();
    a.input.unlock();
    a.ui.menu('main');
  }

  /** ?skip / ?at=... for development */
  devStart(at: string | null) {
    const a = this.app;
    a.ui.menu('hidden');
    a.input.active = true;
    void a.audio.init();
    if (!at) this.startArrival();
    else this.jumpTo(at);
  }

  private jumpTo(at: string) {
    const a = this.app;
    this.state = 'explore';
    atmosphere.uFogVisibility.value = 1;
    const e = a.hall.arrival;
    e.setDoors(1);
    e.envIntensity = 0.55;
    this.floodLevel = 1;
    this.hemiCabin = 1;
    a.player.control = 1;
    a.player.lookControl = 1;
    this.fov = this.fovTarget = 56;
    this.hintStage = 3;
    const spots: Record<string, [THREE.Vector3, number]> = {
      landing: [V(0, 0, -4), 0],
      bridge: [V(0, 0, -30), 0],
      slabs: [V(0, 0, -54), 0],
      lower: [V(0, LAYOUT.b2.y, -100), 0],
      slit: [V(0, LAYOUT.b2.y, -126), 0],
      canyon: [V(0, LAYOUT.b2.y, -150), 0],
      stepwell: [a.stepwell.toWorld(V(-11.2, 0, 11)), 0],
      stairwell: [a.stepwell.toWorld(V(-25, 0, 15.6)), 0],
      elevator: [a.stepwell.toWorld(V(2, -9.4, -11.2)), -Math.PI / 2],
      back: [V(0, 0, -40), Math.PI],
    };
    if (at === 'elevator') {
      a.stepwell.spawn();
    }
    if (at === 'summit') {
      this.enterSummit(true);
      return;
    }
    const s = spots[at] ?? spots.landing;
    a.player.teleport(s[0], s[1], 0);
    // arrive already inside the right air and light (no visible blend)
    this.region = this.regionAt(s[0]);
    const preset = this.region === 'stepwell' ? PRESET.stepwell : this.region === 'canyon' ? PRESET.canyon : PRESET.hall;
    setAtmosphere(preset);
    this.hallLight = this.region === 'stepwell' ? 0 : 1;
    a.audio.setZone(this.region === 'cabin' ? 'hall' : this.region, 0.5);
    this.reachRegion();
  }

  /** remember chapters as they are reached (floor buttons, "continue") */
  private reachRegion() {
    const st = this.app.story;
    if (!st || this.state !== 'explore') return;
    if (this.region === 'canyon' || (this.region === 'hall' && this.app.player.position.z < LAYOUT.b2.z1 + 8)) st.reach('slit');
    else if (this.region === 'stepwell') st.reach('stairwell');
  }

  wantsLock() {
    return this.state !== 'start' && this.state !== 'end';
  }

  shouldRender() {
    if (this.state === 'start') return false;
    if (this.state === 'intro') return this.renderTick++ % 4 === 0;
    return true;
  }

  onPause(p: boolean) {
    const v = this.app.video;
    if (this.state === 'intro') {
      if (p) { this.filmAttempt++; v.pause(); }
      else this.resumeFilm();
    }
  }

  onResize() {
    if (this.state === 'start' || this.state === 'intro' || (this.state === 'arrival' && this.tl.time < 14.2)) {
      this.fov = this.fovTarget = this.app.filmFov(41);
      this.app.camera.fov = this.fov;
      this.app.camera.updateProjectionMatrix();
    }
  }

  floorText() {
    const a = this.app;
    switch (this.state) {
      case 'start':
      case 'intro':
        return '0';
      case 'arrival':
        return this.counter <= 0 ? String(this.counter) : '--';
      case 'ride':
        return String(this.counter);
      case 'summit':
      case 'finale':
      case 'end':
        return '0';
      default:
        if (this.region === 'stepwell' && a.stepwell.depth > 0) return `-${Math.min(9, a.stepwell.depth)}`;
        return '--';
    }
  }

  activeElevator() {
    const a = this.app;
    if (this.state === 'summit' || this.state === 'finale') return a.summit.elevator;
    if (this.state === 'ride') return a.summit.group.visible ? a.summit.elevator : a.stepwell.elevator;
    if (a.stepwell.spawned && this.region === 'stepwell') return a.stepwell.elevator;
    return a.hall.arrival;
  }

  // ---------------------------------------------------------------- lighting

  private configureHallSun() {
    const sun = this.app.hall.sun;
    sun.color.set(0xffdcb4);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -46;
    sc.right = sc.top = 46;
    sc.near = 1;
    sc.far = 520;
    sc.updateProjectionMatrix();
  }

  applyHallLighting(level: number) {
    const h = this.app.hall;
    h.sun.intensity = 1.9 * level;
    h.hemi.color.set(0x2b384a);
    h.hemi.groundColor.set(0x18232d);
    h.hemi.intensity = HEMI * level;
    h.slitSpot.intensity = 900 * level;
    h.canyonSpot.intensity = 260 * level;
    h.shaftSpot.intensity = 9 * level;
    h.setBeamIntensity(level);
  }

  // ---------------------------------------------------------------- arrival

  private startArrival() {
    const a = this.app;
    const e = a.hall.arrival;
    this.state = 'arrival';
    this.tl.reset();
    this.counter = 0;
    a.player.teleport(ARRIVAL_STAND, 0, FILM_PITCH);
    atmosphere.uFogVisibility.value = 0;
    a.audio.setZone('cabin', 4);
    a.audio.setRumble(0);

    const count = [-1, -2, -3, -4, -5, -6, -7, -8, -9];
    const times = [3.6, 4.35, 5.0, 5.55, 6.0, 6.4, 6.75, 7.05, 7.3];
    this.tl
      .at(0.3, () => a.audio.setRumble(0.55, 3))
      .at(1.6, () => a.audio.creak())
      .at(2.7, () => {
        a.audio.click(0.6);
        e.displayLevel = 1;
        e.display.set('down', '0');
      });
    count.forEach((n, i) =>
      this.tl.at(times[i], () => {
        this.counter = n;
        e.display.set('down', String(n));
        a.audio.click(0.15);
        a.audio.setRumble(0.55 + i * 0.05, 0.5);
      }),
    );
    this.tl
      .at(7.55, () => {
        e.display.glitch = 0.7;
        e.display.set('down', '-9');
      })
      .at(8.7, () => {
        e.display.glitch = 0;
        e.display.set('down', '--');
        this.counter = 1;
      })
      .at(9.3, () => {
        // the cabin hits bottom, and settles twice (the knocks are in the recording)
        a.audio.impact('bottom', 1, 0.25);
        a.audio.setRumble(0, 0.8);
        a.player.shake = 1.1;
      })
      .at(9.93, () => (a.player.shake = Math.max(a.player.shake, 0.55)))
      .at(10.49, () => (a.player.shake = Math.max(a.player.shake, 0.3)))
      .at(10.4, () => a.audio.click(0.3))
      .at(10.8, () => e.display.set(null, '--'))
      .at(11.7, () => a.audio.setBigReverb(0.75, 0.3))
      .at(11.8, () => a.audio.chime(0.95, 1))
      .at(12.9, () => {
        // a crack of light between the doors - the seam the film ended on
        e.doorsTo(0.025, 1.1);
        a.audio.setOcclusion(1400, 1.5);
      })
      .at(14.2, () => {
        e.openDoors(3.4);
        a.audio.doors(3.4, true, 0.8);
        a.audio.setZone('hall', 7);
        a.audio.setOcclusion(1600, 0.1);
        this.exposureTarget = EXPOSURE;
        a.post.exposure = 1.6;
        this.fovTarget = 56;
      })
      .at(15.4, () => a.audio.setOcclusion(16000, 4))
      .at(19.5, () => {
        a.hall.flood.shadow.autoUpdate = false;
        a.hall.flood.shadow.needsUpdate = true;
      })
      .at(18.6, () => {
        this.state = 'explore';
        this.hintStage = 1;
        this.hintClock = 0;
        a.story.reach('hall');
      });
  }

  // ---------------------------------------------------------------- frame

  update(dt: number, time: number) {
    const a = this.app;
    if (a.paused || dt <= 0) return;
    this.t += dt;
    if (this.state === 'start' || this.state === 'end') return;
    this.tl.update(dt);
    const p = a.player;

    if (this.state === 'intro') {
      p.update(0, a.input, time);
      return;
    }

    // ---- arrival-specific continuous values
    if (this.state === 'arrival' || this.state === 'explore') {
      const e = a.hall.arrival;
      const door = e.door;
      this.floodLevel = door;
      this.hemiCabin = Math.max(this.hemiCabin, smooth(door * 1.4));
      a.hall.flood.intensity = 26 * Math.pow(this.floodLevel, 0.8);
      e.envIntensity = 0.6 * smooth(door * 1.3);
      // no air inside a sealed cabin: the atmosphere arrives with the opening
      if (this.state === 'arrival') atmosphere.uFogVisibility.value = smooth(door * 6);
    }
    if (this.state === 'ride') {
      const rt = this.tl.time;
      const motion = ramp(rt, 4.3, 6.5) * (1 - ramp(rt, 12.5, 14.3));
      p.shake = Math.max(p.shake * Math.exp(-dt * 3), motion * 0.22);
    }
    if (this.state === 'arrival' || this.state === 'summit') {
      p.shake *= Math.exp(-dt * 3);
      if (this.tl.time > 16.8) {
        p.lookControl = Math.min(1, p.lookControl + dt / 2.2);
      }
    }
    if (this.state === 'explore' && p.control < 1) {
      p.lookControl = Math.min(1, p.lookControl + dt / 2.2);
      p.control = Math.min(1, p.control + dt / 1.8);
    }

    // ---- simulation
    p.update(dt, a.input, time);
    if (a.stepwell.group.visible) a.stepwell.update(dt, p);
    a.hall.update(dt, time);
    a.hall.arrival.update(dt);
    if (a.stepwell.spawned) a.stepwell.elevator.update(dt);
    if (a.summit.group.visible) {
      a.summit.update(dt, time);
      a.summit.elevator.update(dt);
    }

    // ---- regions
    if (this.state !== 'summit' && this.state !== 'finale' && this.state !== 'ride') this.updateRegion(dt);
    if (this.state !== 'finale') a.story.update(dt, time);
    if (this.state === 'explore') this.updateExplore(dt);
    if (this.state === 'summit') this.updateSummit(dt);
    if (this.state === 'finale') this.updateFinale(dt);

    // hall light: off inside the stepwell (baked light there), and the
    // hemisphere fill must be zero inside the closed cabin
    if (this.state !== 'summit' && this.state !== 'finale' && !(this.state === 'ride' && a.summit.group.visible)) {
      const target = this.region === 'stepwell' ? 0 : 1;
      this.hallLight += (target - this.hallLight) * (1 - Math.exp(-dt * 1.5));
      this.applyHallLighting(this.hallLight);
      a.hall.hemi.intensity = HEMI * this.hallLight * this.hemiCabin;
      // thin cabin walls vs a 4.5 cm shadow texel: keep the sun out of the sealed cabin
      if (this.state === 'arrival') a.hall.sun.intensity *= smooth(a.hall.arrival.door * 4);
    }

    // ---- camera, exposure
    const fk = 1 - Math.exp(-dt * 0.55);
    this.fov += (this.fovTarget - this.fov) * fk;
    if (!(Math.abs(a.camera.fov - this.fov) <= 0.01)) {
      a.camera.fov = this.fov;
      a.camera.updateProjectionMatrix();
      GlowPoints.resize(a.camera, a.renderer.domElement.height);
    }
    const ek = 1 - Math.exp(-dt * 0.45);
    a.post.exposure += (this.exposureTarget - a.post.exposure) * ek;

    // dust in the light by the doors
    const du = a.dust.uniforms;
    (du.uLightPos.value as THREE.Vector3).set(0, 1.4, -1.5);
    (du.uLightColor.value as THREE.Color).setRGB(0.55, 0.65, 0.8).multiplyScalar(this.region === 'hall' || this.region === 'cabin' ? this.floodLevel * 1.4 : 0);
  }

  private regionAt(pos: THREE.Vector3): Region {
    const a = this.app;
    if (a.stepwell.contains(pos)) return 'stepwell';
    if (pos.z < LAYOUT.t2.zRecess - 0.5) return 'canyon';
    if (a.hall.arrival.contains(pos) && a.hall.arrival.door < 0.5) return 'cabin';
    return 'hall';
  }

  private updateRegion(dt: number) {
    const a = this.app;
    const r = this.regionAt(a.player.position);
    if (r !== this.region) {
      this.region = r;
      if (this.state === 'explore') a.audio.setZone(r === 'cabin' ? 'hall' : r, r === 'stepwell' ? 5 : 4);
      this.reachRegion();
    }
    if (this.state === 'explore' && r === 'hall' && a.player.position.z < LAYOUT.b2.z1 + 8) this.reachRegion();
    const k = 1 - Math.exp(-dt * (r === 'stepwell' ? 0.9 : 0.6));
    const preset = r === 'stepwell' ? PRESET.stepwell : r === 'canyon' ? PRESET.canyon : PRESET.hall;
    blendAtmosphere(preset, k);

    const inWell = r === 'stepwell';
    a.hall.group.visible = !inWell || !a.stepwell.inShaft(a.player.position) ? true : false;
    const nearT2 = a.player.position.z < LAYOUT.b2.z1 + 6;
    a.stepwell.group.visible = nearT2;
    a.stepwell.elevator.group.visible = nearT2 && a.stepwell.spawned;
    const sunOn = !inWell;
    a.hall.sun.shadow.autoUpdate = sunOn;
    if (sunOn) a.hall.followShadow(a.player.position);
    a.dust.uniforms.uOpacity.value += ((inWell ? 0.35 : r === 'canyon' ? 0.55 : 0.5) - (a.dust.uniforms.uOpacity.value as number)) * k;
  }

  private updateExplore(dt: number) {
    const a = this.app;
    const p = a.player;

    // ---- the only instructions, once
    this.hintClock += dt;
    if (this.hintStage === 1 && this.hintClock > 0.8) {
      a.ui.whisper(t('hint.look'));
      this.hintStage = 2;
      this.walkedAtHint = p.distanceWalked;
      this.hintClock = 0;
    } else if (this.hintStage === 2 && (p.distanceWalked - this.walkedAtHint > 4 || this.hintClock > 14)) {
      a.ui.hush();
      this.hintStage = 3;
    }
    if (!this.runHintShown && this.hintStage >= 3 && !a.ui.reading && p.position.z < -16 && p.position.z > -50 && p.runningFor === 0 && p.distanceWalked > 22) {
      this.runHintShown = true;
      a.ui.whisper(t('hint.run'), 5);
    }
    if (p.runningFor > 0.5 && this.runHintShown) a.ui.hush();

    // ---- safety: nothing should let you fall, but if it ever happens, the place catches you
    if (p.position.y < this.floorBelow(p.position) - 25) {
      p.teleport(p.lastSafe.clone(), p.yaw, 0);
      a.post.fade = 1;
    }
    if (a.post.fade > 0 && this.state === 'explore') a.post.fade = Math.max(0, a.post.fade - dt * 0.8);

    // ---- the stepwell elevator
    const sw = a.stepwell;
    if (sw.spawned) {
      const e = sw.elevator;
      const front = e.toWorld(V(0, 0, -1.2));
      const d = front.distanceTo(p.position);
      if (!this.stepwellElevatorHeard && d < 30 && Math.abs(front.y - p.position.y) < 9) {
        this.stepwellElevatorHeard = true;
        a.audio.setHum(0.3, 0.1, 2);
        this.tl.at(this.tl.time + 3.5, () => a.audio.setHum(0, 0, 3));
      }
      if (!this.elevatorArrived && d < 14 && Math.abs(front.y - p.position.y) < 5) {
        this.elevatorArrived = true;
        e.attachRig(a.rig);
        a.audio.impact('stop', 0.3, 0.6, 2500);
        this.tl.at(this.tl.time + 0.7, () => {
          a.audio.chime(1, 1);
          e.light = 1;
          e.envIntensity = 1;
          e.display.set(null, '0');
        });
        this.tl.at(this.tl.time + 1.7, () => {
          e.openDoors(2.8);
          a.audio.doors(2.8, true, 1);
        });
      }
      if (this.elevatorArrived && e.isOpen && e.contains(p.position, -0.1)) {
        const l = e.toLocal(p.position);
        if (l.z > 0.55) this.startRide();
      }
    }
  }

  private floorBelow(pos: THREE.Vector3) {
    if (this.app.stepwell.contains(pos)) return LAYOUT.stepwell.y0 - 30;
    if (pos.z < LAYOUT.slabs.z0) return LAYOUT.b2.y;
    return 0;
  }

  // ---------------------------------------------------------------- ride

  private startRide() {
    const a = this.app;
    const e = a.stepwell.elevator;
    const p = a.player;
    this.state = 'ride';
    this.tl.reset();
    a.ui.hush();
    p.control = 0;
    p.assistTarget = { yaw: e.facingYaw, pitch: 0.06 };
    p.assist = 1;
    a.audio.setZone('ride', 4);
    const depth = Math.max(1, Math.min(9, a.stepwell.depth));
    this.counter = -depth;
    this.tl
      .at(0.7, () => {
        e.closeDoors(2.8);
        a.audio.doors(2.8, false, 1);
      })
      .at(3.7, () => {
        a.audio.click(0.5);
        e.display.set('up', String(-depth));
      })
      .at(4.05, () => {
        // the light stutters as the cabin starts to move (and hides the swap)
        e.light = 0.2;
        a.audio.click(0.4);
      })
      .at(4.3, () => {
        a.audio.setHum(1, 0.2, 1.5);
        this.transferToSummit();
        a.summit.elevator.light = 0.25;
      })
      .at(4.55, () => (a.summit.elevator.light = 1))
      .at(4.7, () => (a.summit.elevator.light = 0.55))
      .at(4.8, () => (a.summit.elevator.light = 1))
      .at(5.0, () => a.audio.setHum(1, 0.85, 4));
    // the count runs up past where the floors should end, and stops at 0
    const steps: number[] = [];
    for (let n = -depth + 1; n <= 0; n++) steps.push(n);
    const t0 = 5.4;
    const t1 = 12.6;
    steps.forEach((n, i) => {
      const k = steps.length > 1 ? i / (steps.length - 1) : 1;
      const t = t0 + (t1 - t0) * Math.pow(k, 0.8);
      this.tl.at(t, () => {
        this.counter = n;
        a.summit.elevator.display.set('up', String(n));
        a.audio.click(0.12);
      });
    });
    this.tl
      .at(12.9, () => a.audio.setHum(0.6, 0.2, 1.2))
      .at(14.3, () => {
        a.audio.setHum(0, 0, 0.6);
        a.audio.impact('stop', 0.55, 0.15, 5000);
        p.shake = 0.5;
        a.summit.elevator.display.set(null, '0');
      })
      .at(15.4, () => a.audio.chime(0.35, 1))
      .at(16.3, () => {
        a.summit.elevator.openDoors(3.6);
        a.audio.doors(3.6, true, 1);
        a.audio.setZone('summit', 6);
        a.post.exposure = 1.6;
        this.exposureTarget = EXPOSURE;
      })
      .at(18.6, () => {
        this.state = 'summit';
        p.assist = 0;
        p.assistTarget = null;
        this.summitClock = 0;
      });
  }

  /** Swap the world while the doors are closed: same cabin, different top. */
  private transferToSummit() {
    const a = this.app;
    const from = a.stepwell.elevator;
    const to = a.summit.elevator;
    const p = a.player;
    const local = from.toLocal(p.position);
    const yawLocal = p.yaw - from.facingYaw;
    this.enterSummit(false);
    const world = to.toWorld(local);
    p.teleport(world, to.facingYaw + yawLocal, p.pitch);
    p.assistTarget = { yaw: to.facingYaw, pitch: 0.06 };
    to.display.set('up', String(this.counter));
    to.displayLevel = 1;
  }

  private enterSummit(direct: boolean) {
    const a = this.app;
    a.hall.group.visible = false;
    a.stepwell.group.visible = false;
    a.stepwell.elevator.group.visible = false;
    a.summit.group.visible = true;
    a.hall.slitSpot.intensity = 0;
    a.hall.canyonSpot.intensity = 0;
    a.hall.shaftSpot.intensity = 0;
    a.hall.flood.intensity = 0;
    a.hall.flood.shadow.autoUpdate = false;
    a.hall.sun.shadow.autoUpdate = true;
    a.summit.configureLights(1);
    setAtmosphere(PRESET.summit);
    this.region = 'summit';
    a.story.reach('summit');
    const sky = a.sky.uniforms;
    sky.uDawn.value = 1;
    sky.uStars.value = 0.7;
    sky.uSeam.value = 1;
    sky.uSeamOpen.value = 0;
    a.dust.uniforms.uOpacity.value = 0.18;
    const e = a.summit.elevator;
    e.attachRig(a.rig);
    e.light = 1;
    e.envIntensity = 1;
    e.displayLevel = 1;
    this.fov = this.fovTarget = 56;
    if (direct) {
      e.setDoors(1);
      this.state = 'summit';
      a.player.teleport(e.toWorld(CABIN.stand), e.facingYaw, 0.05);
      a.player.control = 1;
      a.player.lookControl = 1;
      a.audio.setZone('summit', 1);
      this.summitClock = 0;
    } else {
      e.setDoors(0);
    }
  }

  // ---------------------------------------------------------------- summit + finale

  private updateSummit(dt: number) {
    const a = this.app;
    const p = a.player;
    p.control = Math.min(1, p.control + dt / 1.5);
    p.lookControl = Math.min(1, p.lookControl + dt / 1.5);
    if (a.post.fade > 0) a.post.fade = Math.max(0, a.post.fade - dt * 0.8);
    this.summitClock += dt;
    const local = p.position.clone().sub(a.summit.origin);
    const outside = !a.summit.elevator.contains(p.position, 0.2);
    if (!this.finaleStarted && ((outside && local.z < a.summit.edgeZ + 3) || (outside && this.summitClock > 45) || this.summitClock > 80)) {
      this.startFinale();
    }
  }

  private finaleT = 0;

  private startFinale() {
    const a = this.app;
    this.finaleStarted = true;
    this.state = 'finale';
    this.finaleT = 0;
    this.tl.reset();
    a.story.close();
    a.audio.swell(13);
    this.tl.at(16.5, () => a.audio.hush(3));
  }

  private updateFinale(dt: number) {
    const a = this.app;
    this.finaleT += dt;
    const t = this.finaleT;
    const sky = a.sky.uniforms;
    sky.uSeamOpen.value = Math.pow(clamp01(t / 13), 2.2);
    atmosphere.uGlowCore.value = 0.6 + ramp(t, 2, 12) * 6;
    atmosphere.uGlowPower.value = 7 - ramp(t, 2, 12) * 5;
    this.exposureTarget = EXPOSURE + ramp(t, 4, 13) * 3;
    a.player.control = Math.max(0, 1 - t / 5);
    if (t < 15) {
      a.post.fadeColor.setRGB(1, 0.98, 0.95);
      a.post.fade = ramp(t, 9.5, 13.5);
    } else {
      a.post.fade = 1;
      const k = ramp(t, 15, 18.5);
      a.post.fadeColor.setRGB(1 - k, 0.98 * (1 - k), 0.95 * (1 - k));
    }
    if (t > 19.5) this.toEnd();
  }

  private toEnd() {
    const a = this.app;
    this.state = 'end';
    a.input.active = false;
    a.input.clear();
    a.input.unlock();
    a.story.finish();
    a.ui.showEnd(a.story.found, a.story.total);
  }
}

if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.PRESET = PRESET;
  w.snapAtmo = (k: keyof typeof PRESET) => setAtmosphere(PRESET[k]);
}
