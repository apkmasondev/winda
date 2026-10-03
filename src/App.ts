import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { AudioEngine } from './audio/AudioEngine';
import { Colliders } from './core/Colliders';
import { Input } from './core/Input';
import { loadProgress } from './core/Progress';
import { loadSettings, lookScale, motionScale, saveSettings, soundGain, type Settings } from './core/Settings';
import { Player } from './player/Player';
import { atmosphere } from './render/atmosphere';
import { Dust, GlowPoints, Sky } from './render/fx';
import { loadStoneTextures } from './render/materials';
import { Post } from './render/Post';
import { Director } from './story/Director';
import { Story } from './story/Story';
import { setLang, t } from './ui/i18n';
import { UI } from './ui/UI';
import { makeCabinEnvironment, makeCabinRig, type CabinRig } from './world/Elevator';
import { Hall } from './world/Hall';
import { Stepwell } from './world/Stepwell';
import { Summit } from './world/Summit';

const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.5);

export class App {
  readonly canvas = document.getElementById('gl') as HTMLCanvasElement;
  readonly video = document.getElementById('intro') as HTMLVideoElement;
  renderer!: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(41, 16 / 9, 0.05, 7000);
  post!: Post;
  readonly input = new Input(this.canvas);
  readonly audio = new AudioEngine();
  readonly ui = new UI();
  readonly colliders = new Colliders();
  player!: Player;
  hall!: Hall;
  stepwell!: Stepwell;
  summit!: Summit;
  sky!: Sky;
  dust!: Dust;
  rig!: CabinRig;
  director!: Director;
  story!: Story;
  settings: Settings = loadSettings();
  readonly progress = loadProgress();
  hallEnv: THREE.Texture | null = null;
  private clock = new THREE.Timer();
  time = 0;
  paused = false;
  private pixelRatio = MAX_PIXEL_RATIO;
  private frameTimes: number[] = [];
  private lastAdapt = 0;
  readonly params = new URLSearchParams(location.search);

  async boot() {
    setLang(this.settings.lang);
    this.ui.bind(this.settings, this.progress);
    if (!this.supportsWebGL2()) {
      const el = document.getElementById('unsupported')!;
      el.textContent = t('unsupported');
      this.ui.show(el, true);
      this.ui.menu('hidden');
      return;
    }
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 1);

    this.post = new Post(this.renderer, this.scene, this.camera, 4);
    this.post.fade = 1;
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    // some hosts change the viewport without a window resize event
    new ResizeObserver(() => this.onResize()).observe(this.canvas);

    // ------------------------------------------------------------ assets
    const manager = new THREE.LoadingManager();
    const progress = { assets: 0, compile: 0 };
    const report = () => this.ui.setProgress(progress.assets * 0.8 + progress.compile * 0.2);
    manager.onProgress = (_url, loaded, total) => {
      progress.assets = loaded / total;
      report();
    };
    const draco = new DRACOLoader(manager);
    draco.setDecoderPath(DRACO_GLTF_CONFIG);
    const gltf = new GLTFLoader(manager);
    gltf.setDRACOLoader(draco);
    const tex = new THREE.TextureLoader(manager);
    this.video.src = 'video/intro.mp4';
    this.video.load();

    const [cabin, arch, well, textures] = await Promise.all([
      gltf.loadAsync('models/cabin.glb'),
      gltf.loadAsync('models/arch.glb'),
      gltf.loadAsync('models/stepwell.glb'),
      loadStoneTextures(tex),
    ]).finally(() => draco.dispose());
    const geo = (root: THREE.Object3D, name: string) => {
      const o = root.getObjectByName(name) as THREE.Mesh | undefined;
      if (!o?.geometry) throw new Error(`missing node ${name}`);
      return o.geometry;
    };

    // ------------------------------------------------------------ world
    const cabinEnv = makeCabinEnvironment(this.renderer);
    this.rig = makeCabinRig();
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);

    this.hall = new Hall({
      kit: {
        Column: geo(arch.scene, 'Column'),
        BridgeSeg: geo(arch.scene, 'BridgeSeg'),
        Slab: geo(arch.scene, 'Slab'),
        Monolith: geo(arch.scene, 'Monolith'),
        Landing: geo(arch.scene, 'Landing'),
        Gate: geo(arch.scene, 'Gate'),
      },
      cabin: cabin.scene,
      textures,
      colliders: this.colliders,
      cabinEnv,
    });
    this.scene.add(this.hall.group, this.hall.lights);

    this.stepwell = new Stepwell({
      module: geo(well.scene, 'StepwellModule'),
      cap: geo(well.scene, 'StepwellCap'),
      lamps: geo(well.scene, 'StepwellLamps'),
      cabin: cabin.scene,
      textures,
      colliders: this.colliders,
      cabinEnv,
    });
    this.scene.add(this.stepwell.group, this.stepwell.elevator.group);

    this.summit = new Summit({
      sun: this.hall.sun,
      hemi: this.hall.hemi,
      column: geo(arch.scene, 'Column'),
      cabin: cabin.scene,
      textures,
      colliders: this.colliders,
      cabinEnv,
    });
    this.scene.add(this.summit.group);

    this.dust = new Dust();
    this.scene.add(this.dust.points);

    this.colliders.build();
    this.player = new Player(this.camera, this.colliders);
    this.player.sensitivity = lookScale(this.settings.look);
    this.player.motion = motionScale(this.settings.motion);
    this.audio.setVolume(soundGain(this.settings.sound));

    this.story = new Story(this);
    this.director = new Director(this);
    GlowPoints.resize(this.camera, this.renderer.domElement.height);
    void this.audio.loadBeds('audio/');
    this.audio.useSamples({ bottom: 'audio/sfx/bottom.m4a', stop: 'audio/sfx/stop.m4a' });

    // reflections of the hall for the arrival cabin's steel, captured once
    this.hallEnv = this.captureEnvironment(new THREE.Vector3(0, 1.7, -4));
    this.hall.arrival.materials.steel.envMap = this.hallEnv;
    this.hall.arrival.materials.steelDark.envMap = this.hallEnv;
    this.hall.arrival.materials.shell.envMap = this.hallEnv;
    this.hall.arrival.materials.floor.envMap = this.hallEnv;
    this.hall.arrival.attachRig(this.rig);
    this.director.reset();

    // ------------------------------------------------------------ warm up every program
    await this.precompile();
    progress.compile = 1;
    report();

    this.bindUI();
    this.renderer.setAnimationLoop(() => this.frame());
    this.ui.ready();
    if (this.params.has('skip') || this.params.has('at')) this.director.devStart(this.params.get('at'));
  }

  private supportsWebGL2() {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  }

  private captureEnvironment(at: THREE.Vector3) {
    // make the hall fully lit for the capture, then restore
    const prev = { sun: this.hall.sun.intensity, hemi: this.hall.hemi.intensity, fog: atmosphere.uFogVisibility.value };
    this.director.applyHallLighting(1);
    atmosphere.uFogVisibility.value = 1;
    this.hall.followShadow(at);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.sky.mesh.position.copy(at);
    const rt = pm.fromScene(this.scene, 0.02, 0.5, 4000, { position: at } as never);
    pm.dispose();
    this.hall.sun.intensity = prev.sun;
    this.hall.hemi.intensity = prev.hemi;
    atmosphere.uFogVisibility.value = prev.fog;
    return rt.texture;
  }

  private async precompile() {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      this.renderer.compile(this.scene, this.camera);
    }
    // one real frame through the whole chain (shadow passes, post)
    this.post.render(0.016, 0);
    for (const o of hidden) o.visible = false;
  }

  private bindUI() {
    const ui = this.ui;
    const s = this.settings;
    ui.onDescend = () => this.director.begin();
    ui.onContinue = () => this.director.startChapter(this.progress.last);
    ui.onChapter = (i) => this.director.startChapter(i);
    ui.onAgain = () => this.director.restart();
    ui.onResume = () => this.resume();
    ui.onGroundFloor = () => this.director.toMenu();
    ui.onSetting = (key) => {
      if (key === 'sound') {
        s.sound = (s.sound + 1) % 6;
        this.audio.setVolume(soundGain(s.sound));
        this.video.volume = soundGain(s.sound);
      } else if (key === 'look') {
        s.look = (s.look % 5) + 1;
        this.player.sensitivity = lookScale(s.look);
      } else if (key === 'motion') {
        s.motion = (s.motion + 1) % 6;
        this.player.motion = motionScale(s.motion);
      } else {
        s.lang = s.lang === 'pl' ? 'en' : 'pl';
        setLang(s.lang);
      }
      saveSettings(s);
    };
    this.input.onLockChange = (locked) => {
      if (!locked && this.input.hadLock && this.director.wantsLock()) this.pause();
    };
    this.canvas.addEventListener('click', () => {
      if (this.director.wantsLock() && !this.paused) {
        this.audio.suspend(false);
        if (!this.input.locked) void this.input.lock();
      }
    });
    this.input.onKey = (code) => {
      if (code !== 'Escape') return;
      // inside the panel Escape steps back one page
      if (this.ui.back()) return;
      if (!this.director.wantsLock()) return;
      // Native Escape releases pointer lock and pointerlockchange opens the panel.
      if (!this.paused && !this.input.locked) this.pause();
    };
    window.addEventListener('blur', () => {
      if (this.director.wantsLock() && !this.params.has('nopause')) this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.director.wantsLock() && !this.params.has('nopause')) this.pause();
    });
  }

  pause() {
    if (this.paused || !this.director.wantsLock()) return;
    this.paused = true;
    this.input.active = false;
    this.input.clear();
    this.input.unlock();
    this.director.onPause(true);
    this.audio.suspend(true);
    this.story.close();
    this.ui.menu('pause');
    this.ui.setFloor(this.director.floorText());
  }

  resume(lock = true) {
    if (!this.paused) return;
    this.paused = false;
    this.ui.menu('hidden');
    this.input.active = true;
    this.input.clear();
    this.audio.suspend(false);
    this.director.onPause(false);
    if (lock) void this.input.lock();
  }

  private lastSize = '';
  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // a hidden tab or collapsed container reports 0 x 0: keep the last good size
    if (w < 2 || h < 2) return;
    const key = `${w}x${h}@${this.pixelRatio}`;
    if (key === this.lastSize) return;
    this.lastSize = key;
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.director?.onResize();
    GlowPoints.resize(this.camera, h * this.pixelRatio);
  }

  /** vertical FOV that matches the film framing under object-fit: cover */
  filmFov(base = 41) {
    const a = this.camera.aspect;
    if (!Number.isFinite(a) || a <= 0) return base;
    const filmA = 16 / 9;
    if (a <= filmA) return base;
    const t = Math.tan(THREE.MathUtils.degToRad(base / 2)) * (filmA / a);
    return THREE.MathUtils.radToDeg(Math.atan(t)) * 2;
  }

  private adapt(dt: number) {
    if (this.director.state === 'intro' || this.director.state === 'start') return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    this.frameTimes = [];
    const now = this.time;
    if (now - this.lastAdapt < 2) return;
    let next = this.pixelRatio;
    if (p80 > 1 / 52) next = Math.max(0.6, this.pixelRatio - 0.1);
    // vsync hides headroom at 60 Hz; only fast displays can prove there is room to grow
    else if (p80 < 1 / 100) next = Math.min(MAX_PIXEL_RATIO, this.pixelRatio + 0.05);
    if (Math.abs(next - this.pixelRatio) > 0.001) {
      this.pixelRatio = next;
      this.lastAdapt = now;
      this.renderer.setPixelRatio(next);
      this.onResize();
    }
  }

  private frame() {
    this.clock.update();
    const raw = Math.min(this.clock.getDelta(), 0.1);
    const dt = this.paused ? 0 : raw;
    this.time += dt;
    atmosphere.uTime.value = this.time;
    if (!this.paused) {
      this.director.update(dt, this.time);
      this.audio.update(dt, this.camera);
      this.ui.update(dt);
    }
    this.dust.update(this.camera.position);
    this.sky.mesh.position.copy(this.camera.position);
    if (this.director.shouldRender()) this.post.render(dt, this.time);
    if (!this.paused) this.adapt(raw);
  }
}
