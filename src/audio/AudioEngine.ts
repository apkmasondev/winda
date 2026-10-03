import * as THREE from 'three';
import { Timeline } from '../story/Timeline';

/**
 * Procedural sound for the whole experience - no samples required.
 *
 *   ambience bus  (drone, wind, distant metal, slit) -> occlusion lowpass -> master
 *   sfx bus       (elevator mechanics, steps)                              -> master
 *   both feed a long convolution reverb ("the size of the place") through a
 *   faint feedback delay that suggests walls very far away.
 *
 * Optional recorded beds can replace the synthetic ones: drop files listed in
 * public/audio/manifest.json (see README) and they are crossfaded in by zone.
 */

type BedDef = { file: string; gain?: number; loopStart?: number; loopEnd?: number };

export type Zone = 'silent' | 'cabin' | 'hall' | 'canyon' | 'stepwell' | 'ride' | 'summit';

type ZoneMix = {
  drone: number;
  droneHz: number;
  bright: number;
  wind: number;
  air: number;
  big: number;
  small: number;
  occlusion: number;
  clangEvery: number;
  slit: number;
};

const MIX: Record<Zone, ZoneMix> = {
  silent: { drone: 0, droneHz: 55, bright: 0, wind: 0, air: 0, big: 0.0, small: 0, occlusion: 400, clangEvery: 0, slit: 0 },
  cabin: { drone: 0.25, droneHz: 49, bright: 0, wind: 0.0, air: 0.25, big: 0.15, small: 0.5, occlusion: 520, clangEvery: 0, slit: 0 },
  hall: { drone: 1, droneHz: 55, bright: 0.15, wind: 1, air: 1, big: 1, small: 0.0, occlusion: 16000, clangEvery: 11, slit: 1 },
  canyon: { drone: 0.8, droneHz: 55, bright: 0.35, wind: 1.3, air: 0.7, big: 0.8, small: 0.15, occlusion: 16000, clangEvery: 22, slit: 1 },
  stepwell: { drone: 0.85, droneHz: 49, bright: 0.05, wind: 0.25, air: 0.8, big: 0.9, small: 0.25, occlusion: 9000, clangEvery: 16, slit: 0.25 },
  ride: { drone: 0.35, droneHz: 49, bright: 0.2, wind: 0.0, air: 0.4, big: 0.2, small: 0.6, occlusion: 700, clangEvery: 0, slit: 0 },
  summit: { drone: 0.7, droneHz: 55, bright: 1, wind: 1.6, air: 0.5, big: 0.55, small: 0, occlusion: 16000, clangEvery: 0, slit: 0 },
};

export class AudioEngine {
  ctx!: AudioContext;
  private master!: GainNode;
  private amb!: GainNode;
  private sfx!: GainNode;
  private occl!: BiquadFilterNode;
  private bigIn!: GainNode;
  private bigOut!: GainNode;
  private smallIn!: GainNode;
  private smallOut!: GainNode;
  private noise!: AudioBuffer;
  private droneOscs: OscillatorNode[] = [];
  private droneGain!: GainNode;
  private brightGain!: GainNode;
  private brightOscs: OscillatorNode[] = [];
  private windGain!: GainNode;
  private airGain!: GainNode;
  private slitGain!: GainNode;
  private slitPanner!: PannerNode;
  private rumble: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private hum: { gain: GainNode; osc: OscillatorNode[]; filter: BiquadFilterNode; whir: GainNode } | null = null;
  private zone: Zone = 'silent';
  private nextClang = 6;
  private nextCreak = 14;
  private time = 0;
  private volume = 0.8;
  ready = false;
  /** extra positional sources that can host distant one-shots */
  clangSites: THREE.Vector3[] = [];
  private listenerPos = new THREE.Vector3();
  /** optional recorded ambience per zone (see public/audio/README.md) */
  private beds = new Map<Zone, { gain: GainNode; level: number }>();
  private pendingBeds: Record<string, BedDef> | null = null;
  private bedBase = '';
  private samples = new Map<string, AudioBuffer>();
  private sampleUrls: Record<string, string> = {};
  private paused = false;
  private readonly cues = new Timeline();
  private readonly transients = new Set<AudioScheduledSourceNode>();

  async init() {
    if (this.ready) { this.suspend(this.paused); return; }
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      // Build synchronously: resume may remain pending until the next user gesture.
      const c = this.ctx;

      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.01;
      comp.release.value = 0.4;
      this.master = c.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp).connect(c.destination);

      this.occl = c.createBiquadFilter();
      this.occl.type = 'lowpass';
      this.occl.frequency.value = 400;
      this.occl.Q.value = 0.4;
      this.amb = c.createGain();
      this.amb.connect(this.occl).connect(this.master);
      this.sfx = c.createGain();
      this.sfx.connect(this.master);

      this.noise = this.makeNoise(4);

      // big space: feedback delay into a long, darkening reverb
      this.bigIn = c.createGain();
      const pre = c.createDelay(1);
      pre.delayTime.value = 0.06;
      const echo = c.createDelay(3);
      echo.delayTime.value = 1.15;
      const fb = c.createGain();
      fb.gain.value = 0.32;
      const echoLp = c.createBiquadFilter();
      echoLp.type = 'lowpass';
      echoLp.frequency.value = 1400;
      const conv = c.createConvolver();
      conv.buffer = this.makeIR(8.5, 2.6, 0.5);
      this.bigOut = c.createGain();
      this.bigOut.gain.value = 0;
      this.bigIn.connect(pre).connect(conv).connect(this.bigOut).connect(this.occl);
      pre.connect(echo).connect(echoLp).connect(fb).connect(echo);
      echoLp.connect(conv);

      this.smallIn = c.createGain();
      const convS = c.createConvolver();
      convS.buffer = this.makeIR(0.55, 3.5, 0.05);
      this.smallOut = c.createGain();
      this.smallOut.gain.value = 0;
      this.smallIn.connect(convS).connect(this.smallOut).connect(this.master);

      this.buildDrone();
      this.buildWind();
      this.buildSlit();
      this.ready = true;
      this.setZone(this.zone, 0);
      this.suspend(this.paused);
      void this.decodeBeds();
      void this.decodeSamples();
    } catch (error) {
      this.ready = false;
      if (this.ctx) void this.ctx.close().catch(() => {});
      console.warn('Audio unavailable; continuing without sound.', error);
    }
  }

  /**
   * Looks for public/audio/manifest.json:
   *   { "beds": { "hall": { "file": "hall.ogg", "gain": 0.8 }, "stepwell": { "file": "well.ogg" } } }
   * Missing manifest = procedural sound only. Beds are decoded after init().
   */
  async loadBeds(base: string) {
    try {
      const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const json = (await res.json()) as { beds?: Record<string, BedDef> };
      if (!json.beds) return;
      this.pendingBeds = json.beds;
      this.bedBase = base;
      if (this.ready) await this.decodeBeds();
    } catch {
      /* no recorded beds - fine */
    }
  }

  private async decodeBeds() {
    const beds = this.pendingBeds;
    this.pendingBeds = null;
    if (!beds) return;
    // several zones may share one file: decode each file once
    const buffers = new Map<string, Promise<AudioBuffer>>();
    const load = (file: string) => {
      let p = buffers.get(file);
      if (!p) {
        p = fetch(this.bedBase + file)
          .then((r) => r.arrayBuffer())
          .then((data) => this.ctx.decodeAudioData(data));
        buffers.set(file, p);
      }
      return p;
    };
    await Promise.all(
      Object.entries(beds).map(async ([zone, def]) => {
        try {
          const buffer = await load(def.file);
          const src = this.ctx.createBufferSource();
          src.buffer = buffer;
          src.loop = true;
          // files are padded with wrapped audio; loop strictly inside the padding
          if (def.loopEnd && def.loopEnd <= buffer.duration) {
            src.loopStart = def.loopStart ?? 0;
            src.loopEnd = def.loopEnd;
          }
          const gain = this.ctx.createGain();
          gain.gain.value = 0;
          src.connect(gain).connect(this.amb);
          const send = this.ctx.createGain();
          send.gain.value = 0.25;
          gain.connect(send).connect(this.bigIn);
          src.start(0, def.loopStart ?? 0);
          this.beds.set(zone as Zone, { gain, level: def.gain ?? 1 });
        } catch {
          /* skip a bed that fails to load */
        }
      }),
    );
    this.setZone(this.zone, 2);
  }

  /** register one-shot samples; decoded after init() */
  useSamples(urls: Record<string, string>) {
    this.sampleUrls = urls;
    if (this.ready) void this.decodeSamples();
  }

  private async decodeSamples() {
    await Promise.all(
      Object.entries(this.sampleUrls).map(async ([name, url]) => {
        if (this.samples.has(name)) return;
        try {
          const data = await (await fetch(url)).arrayBuffer();
          this.samples.set(name, await this.ctx.decodeAudioData(data));
        } catch {
          /* fall back to the synthesised impact */
        }
      }),
    );
  }

  /** a recorded impact through the cabin (small) and the space (big) reverbs */
  impact(name: string, level = 1, space = 0.3, lowpass = 20000) {
    if (!this.ready) return;
    const buffer = this.samples.get(name);
    if (!buffer) {
      this.thunk(level);
      return;
    }
    const c = this.ctx;
    const src = this.track(c.createBufferSource());
    src.buffer = buffer;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const g = c.createGain();
    g.gain.value = level;
    src.connect(lp).connect(g).connect(this.sfx);
    const s1 = c.createGain();
    s1.gain.value = 0.45;
    g.connect(s1).connect(this.smallIn);
    const s2 = c.createGain();
    s2.gain.value = space;
    g.connect(s2).connect(this.bigIn);
    src.start(c.currentTime + 0.005);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ready) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  suspend(paused: boolean) {
    this.paused = paused;
    if (!this.ready) return;
    // Freeze scheduled sounds and envelopes along with the simulation clock.
    void (paused ? this.ctx.suspend() : this.ctx.resume()).catch(() => {});
  }

  private track<T extends AudioScheduledSourceNode>(source: T): T {
    this.transients.add(source);
    source.addEventListener('ended', () => {
      this.transients.delete(source);
      source.disconnect();
    }, { once: true });
    return source;
  }

  // ---------------------------------------------------------------- building blocks

  private makeNoise(seconds: number) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let p = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        p = 0.97 * p + 0.03 * w; // a touch of pink
        d[i] = w * 0.75 + p * 2.2;
      }
    }
    return b;
  }

  private makeIR(seconds: number, decay: number, early: number) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // the tail darkens as it decays (air absorption)
        const k = 0.9 - t * 0.85;
        const w = Math.random() * 2 - 1;
        lp = lp + (w - lp) * Math.max(0.02, k);
        let v = lp * Math.pow(1 - t, decay);
        // sparse early reflections
        if (early > 0 && t < early * 0.25 && Math.random() < 0.0009) v += (Math.random() - 0.5) * 2.5 * (1 - t);
        d[i] = v;
      }
      // soft onset
      for (let i = 0; i < Math.min(len, 1200); i++) d[i] *= i / 1200;
    }
    return b;
  }

  private noiseSource(loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    s.loopStart = Math.random() * 2;
    s.loopEnd = s.loopStart + 1.9;
    return loop ? s : this.track(s);
  }

  private lfo(freq: number, depth: number, target: AudioParam) {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(target);
    o.start();
    return o;
  }

  private buildDrone() {
    const c = this.ctx;
    this.droneGain = c.createGain();
    this.droneGain.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.droneGain.connect(lp);
    lp.connect(this.amb);
    const send = c.createGain();
    send.gain.value = 0.5;
    lp.connect(send).connect(this.bigIn);
    const partials: Array<[number, number, OscillatorType]> = [
      [1, 0.34, 'sine'], [1.006, 0.3, 'sine'], [1.5, 0.08, 'triangle'], [2.003, 0.1, 'sine'], [0.5, 0.18, 'sine'],
    ];
    for (const [ratio, amp, type] of partials) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = 55 * ratio;
      const g = c.createGain();
      g.gain.value = amp;
      o.connect(g).connect(this.droneGain);
      this.lfo(0.031 + ratio * 0.013, amp * 0.35, g.gain);
      o.start();
      (o as OscillatorNode & { ratio: number }).ratio = ratio;
      this.droneOscs.push(o);
    }
    // airy upper partials, brought in at the top of the world
    this.brightGain = c.createGain();
    this.brightGain.gain.value = 0;
    const blp = c.createBiquadFilter();
    blp.type = 'lowpass';
    blp.frequency.value = 2400;
    this.brightGain.connect(blp).connect(this.amb);
    const bs = c.createGain();
    bs.gain.value = 0.8;
    blp.connect(bs).connect(this.bigIn);
    for (const [hz, amp] of [[220, 0.12], [277.18, 0.07], [329.63, 0.08], [440, 0.05], [554.37, 0.025], [659.26, 0.03]] as const) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = c.createGain();
      g.gain.value = amp;
      o.connect(g).connect(this.brightGain);
      this.lfo(0.05 + hz * 0.0002, amp * 0.6, g.gain);
      o.start();
      this.brightOscs.push(o);
    }
    // the air of the place: a band of rumble
    this.airGain = c.createGain();
    this.airGain.gain.value = 0;
    const n = this.noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 160;
    bp.Q.value = 0.8;
    const ag = c.createGain();
    ag.gain.value = 0.11;
    n.connect(bp).connect(ag).connect(this.airGain).connect(this.amb);
    this.lfo(0.07, 40, bp.frequency);
    n.start();
  }

  private buildWind() {
    const c = this.ctx;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    const n = this.noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.7;
    const g = c.createGain();
    g.gain.value = 0.06;
    const pan = c.createStereoPanner();
    n.connect(bp).connect(g).connect(pan).connect(this.windGain);
    this.windGain.connect(this.amb);
    const send = c.createGain();
    send.gain.value = 0.35;
    this.windGain.connect(send).connect(this.bigIn);
    this.lfo(0.061, 260, bp.frequency);
    this.lfo(0.093, 0.035, g.gain);
    this.lfo(0.027, 0.6, pan.pan);
    // a faint whistle riding on top
    const n2 = this.noiseSource();
    const bp2 = c.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 1650;
    bp2.Q.value = 9;
    const g2 = c.createGain();
    g2.gain.value = 0.012;
    n2.connect(bp2).connect(g2).connect(this.windGain);
    this.lfo(0.043, 220, bp2.frequency);
    this.lfo(0.071, 0.01, g2.gain);
    n.start();
    n2.start();
  }

  private buildSlit() {
    // the slit sings very softly - you can find it with your ears
    const c = this.ctx;
    this.slitPanner = this.panner(new THREE.Vector3(0, 6, -142), 18, 1.1);
    this.slitGain = c.createGain();
    this.slitGain.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    this.slitGain.connect(lp).connect(this.slitPanner).connect(this.amb);
    const send = c.createGain();
    send.gain.value = 0.6;
    this.slitPanner.connect(send).connect(this.bigIn);
    for (const [hz, amp] of [[440, 0.05], [659.26, 0.035], [987.77, 0.018], [1318.5, 0.008]] as const) {
      const o = c.createOscillator();
      o.frequency.value = hz;
      const g = c.createGain();
      g.gain.value = amp;
      o.connect(g).connect(this.slitGain);
      this.lfo(0.11 + hz * 0.0001, amp * 0.8, g.gain);
      this.lfo(0.2, 0.8, o.frequency);
      o.start();
    }
    const n = this.noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 4200;
    bp.Q.value = 3;
    const g = c.createGain();
    g.gain.value = 0.02;
    n.connect(bp).connect(g).connect(this.slitGain);
    n.start();
  }

  private panner(pos: THREE.Vector3, ref = 10, rolloff = 1, max = 2000) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = max;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    return p;
  }

  // ---------------------------------------------------------------- zones

  setZone(zone: Zone, fade = 3) {
    if (!this.ready) {
      this.zone = zone;
      return;
    }
    this.zone = zone;
    const m = MIX[zone];
    const t = this.ctx.currentTime;
    const tc = Math.max(0.01, fade / 3);
    const bed = this.beds.get(zone);
    this.droneGain.gain.setTargetAtTime(m.drone * 0.5 * (bed ? 0.55 : 1), t, tc);
    this.brightGain.gain.setTargetAtTime(m.bright * 0.5, t, tc * 1.5);
    this.windGain.gain.setTargetAtTime(m.wind, t, tc);
    this.airGain.gain.setTargetAtTime(m.air, t, tc);
    this.bigOut.gain.setTargetAtTime(m.big * 0.9, t, tc);
    this.smallOut.gain.setTargetAtTime(m.small * 0.6, t, tc);
    this.occl.frequency.setTargetAtTime(m.occlusion, t, tc * 0.6);
    this.slitGain.gain.setTargetAtTime(m.slit, t, tc);
    for (const o of this.droneOscs) {
      const r = (o as OscillatorNode & { ratio: number }).ratio;
      o.frequency.setTargetAtTime(m.droneHz * r, t, tc * 2);
    }
    for (const [z, bed] of this.beds) bed.gain.gain.setTargetAtTime(z === zone ? bed.level : 0, t, tc * 1.5);
  }

  get currentZone() {
    return this.zone;
  }

  /** open/close the "doors" between the listener and the space */
  setOcclusion(hz: number, fade = 1) {
    if (this.ready) this.occl.frequency.setTargetAtTime(hz, this.ctx.currentTime, fade / 3);
  }

  setBigReverb(level: number, fade = 1) {
    if (this.ready) this.bigOut.gain.setTargetAtTime(level, this.ctx.currentTime, fade / 3);
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, camera: THREE.Camera) {
    if (!this.ready || this.paused || dt <= 0) return;
    this.cues.update(dt);
    this.time += dt;
    const l = this.ctx.listener;
    const p = camera.position;
    this.listenerPos.copy(p);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02);
      l.upY.setTargetAtTime(u.y, t, 0.02);
      l.upZ.setTargetAtTime(u.z, t, 0.02);
    } else {
      (l as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(p.x, p.y, p.z);
    }
    const m = MIX[this.zone];
    if (m.clangEvery > 0) {
      this.nextClang -= dt;
      if (this.nextClang <= 0) {
        this.nextClang = m.clangEvery * (0.6 + Math.random() * 0.9);
        this.distantMetal(this.zone === 'stepwell');
      }
      this.nextCreak -= dt;
      if (this.nextCreak <= 0) {
        this.nextCreak = 18 + Math.random() * 26;
        this.creak();
      }
    }
  }

  /** move the slit voice (it follows the real slit position) */
  setSlitPosition(p: THREE.Vector3) {
    if (!this.ready) return;
    this.slitPanner.positionX.value = p.x;
    this.slitPanner.positionY.value = p.y;
    this.slitPanner.positionZ.value = p.z;
  }

  // ---------------------------------------------------------------- one-shots

  private env(g: AudioParam, t: number, a: number, peak: number, d: number) {
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  /** far away metal: a struck beam, mostly heard through the reverb */
  distantMetal(deep = false) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.05;
    const site = this.clangSites.length && Math.random() < 0.5
      ? this.clangSites[Math.floor(Math.random() * this.clangSites.length)]
      : this.listenerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.6) * 0.8, (Math.random() - 0.5) * 2).normalize().multiplyScalar(90 + Math.random() * 160));
    const pan = this.panner(site, 25, 1.0);
    const out = c.createGain();
    out.gain.value = deep ? 0.5 : 0.8;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = deep ? 700 : 1600;
    out.connect(lp).connect(pan).connect(this.amb);
    const send = c.createGain();
    send.gain.value = 2.2;
    lp.connect(send).connect(this.bigIn);
    const f0 = deep ? 48 + Math.random() * 30 : 70 + Math.random() * 110;
    const ratios = deep ? [1, 2.0, 3.01, 4.17, 5.43] : [1, 2.76, 5.4, 8.93, 13.34];
    const amps = [1, 0.55, 0.36, 0.22, 0.12];
    const decays = deep ? [7, 5, 3.5, 2.5, 1.8] : [4.2, 3, 2, 1.4, 0.9];
    ratios.forEach((r, i) => {
      const o = this.track(c.createOscillator());
      o.frequency.value = f0 * r * (1 + (Math.random() - 0.5) * 0.004);
      const g = c.createGain();
      o.connect(g).connect(out);
      this.env(g.gain, t, deep ? 0.04 : 0.002, amps[i] * 0.12, decays[i]);
      o.start(t);
      o.stop(t + decays[i] + 0.1);
    });
    if (!deep) {
      const n = this.noiseSource(false);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      const g = c.createGain();
      n.connect(bp).connect(g).connect(out);
      this.env(g.gain, t, 0.001, 0.08, 0.06);
      n.start(t);
      n.stop(t + 0.2);
    }
  }

  /** a long cable groan somewhere above */
  creak() {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.05;
    const pos = this.listenerPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 120, 40 + Math.random() * 80, (Math.random() - 0.5) * 120));
    const pan = this.panner(pos, 20, 1);
    const n = this.noiseSource(false);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300;
    bp.Q.value = 1.5;
    const d = c.createDelay(0.05);
    const fb = c.createGain();
    fb.gain.value = 0.93;
    const g = c.createGain();
    n.connect(bp).connect(d).connect(fb).connect(d);
    d.connect(g).connect(pan).connect(this.amb);
    const send = c.createGain();
    send.gain.value = 1.4;
    pan.connect(send).connect(this.bigIn);
    const base = 0.0042 + Math.random() * 0.003;
    d.delayTime.setValueAtTime(base, t);
    d.delayTime.linearRampToValueAtTime(base * 1.22, t + 2.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.03, t + 0.8);
    g.gain.linearRampToValueAtTime(0.022, t + 1.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
    n.start(t);
    n.stop(t + 3);
  }

  land(impact: number) {
    if (!this.ready) return;
    this.thunk(Math.min(1, impact / 12) * 0.5);
  }

  /** elevator relay */
  click(level = 0.5) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.01;
    const n = this.noiseSource(false);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const g = c.createGain();
    n.connect(hp).connect(g).connect(this.sfx);
    const s = c.createGain();
    s.gain.value = 0.5;
    g.connect(s).connect(this.smallIn);
    this.env(g.gain, t, 0.0005, 0.25 * level, 0.018);
    n.start(t);
    n.stop(t + 0.05);
  }

  /** a soft, low mechanical stop (synthesised: no metallic partials) */
  thunk(level = 1) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.01;
    const o = this.track(c.createOscillator());
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.3);
    const g = c.createGain();
    o.connect(g).connect(this.sfx);
    const s = c.createGain();
    s.gain.value = 0.5;
    g.connect(s).connect(this.smallIn);
    this.env(g.gain, t, 0.006, 0.5 * level, 0.5);
    o.start(t);
    o.stop(t + 0.7);
    const n = this.noiseSource(false);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const ng = c.createGain();
    n.connect(lp).connect(ng).connect(this.sfx);
    this.env(ng.gain, t, 0.004, 0.35 * level, 0.16);
    n.start(t);
    n.stop(t + 0.3);
  }

  /** door operator: motor whine + rollers, ends in a soft stop */
  doors(duration: number, opening: boolean, level = 1) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.02;
    const out = c.createGain();
    out.gain.value = level;
    out.connect(this.sfx);
    const s = c.createGain();
    s.gain.value = 0.5;
    out.connect(s).connect(this.smallIn);
    const s2 = c.createGain();
    s2.gain.value = 0.25;
    out.connect(s2).connect(this.bigIn);
    const n = this.noiseSource(false);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650;
    bp.Q.value = 1.4;
    const g = c.createGain();
    n.connect(bp).connect(g).connect(out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.35);
    g.gain.linearRampToValueAtTime(0.045, t + duration - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    n.start(t);
    n.stop(t + duration + 0.1);
    const o = this.track(c.createOscillator());
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(opening ? 120 : 135, t);
    o.frequency.linearRampToValueAtTime(opening ? 175 : 185, t + duration * 0.5);
    o.frequency.linearRampToValueAtTime(110, t + duration);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const og = c.createGain();
    o.connect(lp).connect(og).connect(out);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.02, t + 0.3);
    og.gain.linearRampToValueAtTime(0.016, t + duration - 0.3);
    og.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.start(t);
    o.stop(t + duration + 0.1);
    this.cues.at(this.cues.time + Math.max(0, duration - 0.05), () => this.thunk(0.16));
  }

  /** the arrival chime. `space` (0..1) decides how much of the hall answers */
  chime(space = 0.3, pitch = 1) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.02;
    const out = c.createGain();
    out.gain.value = 1;
    out.connect(this.sfx);
    const s = c.createGain();
    s.gain.value = space * 1.6;
    out.connect(s).connect(this.bigIn);
    const sm = c.createGain();
    sm.gain.value = 0.4;
    out.connect(sm).connect(this.smallIn);
    const f0 = 659.25 * pitch;
    for (const [r, a, d] of [[1, 0.09, 3.2], [2.0, 0.025, 1.8], [3.01, 0.012, 1.1], [4.18, 0.006, 0.6], [0.5, 0.02, 2.5]] as const) {
      const o = this.track(c.createOscillator());
      o.frequency.value = f0 * r;
      const g = c.createGain();
      o.connect(g).connect(out);
      this.env(g.gain, t, 0.003, a, d);
      o.start(t);
      o.stop(t + d + 0.1);
    }
  }

  /** a plate read for the first time: one soft, low struck tone and its answer */
  note(level = 0.5) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.02;
    const out = c.createGain();
    out.gain.value = level;
    out.connect(this.sfx);
    const s = c.createGain();
    s.gain.value = 0.9;
    out.connect(s).connect(this.smallIn);
    // A3 and E4, the fifth of the drone's key, the upper one late and quiet
    for (const [f, a, d, delay] of [[220, 0.05, 2.6, 0], [440.4, 0.012, 1.4, 0], [329.6, 0.03, 2.2, 0.16]] as const) {
      const o = this.track(c.createOscillator());
      o.frequency.value = f;
      const g = c.createGain();
      o.connect(g).connect(out);
      this.env(g.gain, t + delay, 0.012, a, d);
      o.start(t + delay);
      o.stop(t + delay + d + 0.1);
    }
  }

  /** shaft rumble while the cabin moves without power */
  setRumble(level: number, fade = 0.6) {
    if (!this.ready) return;
    const c = this.ctx;
    if (!this.rumble) {
      const n = this.noiseSource();
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 140;
      lp.Q.value = 1.2;
      const g = c.createGain();
      g.gain.value = 0;
      n.connect(lp).connect(g).connect(this.sfx);
      const rush = this.noiseSource();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 380;
      bp.Q.value = 0.9;
      const rg = c.createGain();
      rg.gain.value = 0.18;
      rush.connect(bp).connect(rg).connect(g);
      this.lfo(0.37, 0.08, rg.gain);
      this.lfo(0.9, 30, lp.frequency);
      n.start();
      rush.start();
      this.rumble = { gain: g, filter: lp };
    }
    this.rumble.gain.gain.setTargetAtTime(level * 0.55, c.currentTime, fade / 3);
  }

  /** powered motor hum (rides) */
  setHum(level: number, speed = 0.5, fade = 0.8) {
    if (!this.ready) return;
    const c = this.ctx;
    if (!this.hum) {
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 240;
      filter.Q.value = 2.2;
      const gain = c.createGain();
      gain.gain.value = 0;
      filter.connect(gain).connect(this.sfx);
      const sm = c.createGain();
      sm.gain.value = 0.4;
      gain.connect(sm).connect(this.smallIn);
      const o1 = c.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 48;
      const o2 = c.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 96;
      const g2 = c.createGain();
      g2.gain.value = 0.18;
      o1.connect(filter);
      o2.connect(g2).connect(filter);
      this.lfo(5.5, 0.5, o1.frequency);
      o1.start();
      o2.start();
      const n = this.noiseSource();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1150;
      bp.Q.value = 3;
      const whir = c.createGain();
      whir.gain.value = 0.0;
      n.connect(bp).connect(whir).connect(gain);
      n.start();
      this.hum = { gain, osc: [o1, o2], filter, whir };
    }
    const t = c.currentTime;
    this.hum.gain.gain.setTargetAtTime(level * 0.16, t, fade / 3);
    this.hum.osc[0].frequency.setTargetAtTime(40 + speed * 26, t, fade);
    this.hum.osc[1].frequency.setTargetAtTime(80 + speed * 52, t, fade);
    this.hum.filter.frequency.setTargetAtTime(160 + speed * 260, t, fade);
    this.hum.whir.gain.setTargetAtTime(0.12 * speed, t, fade);
  }

  /** the final swell as the sky opens */
  swell(duration: number) {
    if (!this.ready) return;
    const c = this.ctx;
    const t = c.currentTime + 0.05;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + duration * 0.85);
    out.gain.linearRampToValueAtTime(0.0001, t + duration + 2.5);
    out.connect(this.sfx);
    const s = c.createGain();
    s.gain.value = 1.2;
    out.connect(s).connect(this.bigIn);
    for (const hz of [110, 164.81, 220, 277.18, 329.63, 440, 659.26, 880]) {
      const o = this.track(c.createOscillator());
      o.frequency.value = hz;
      const g = c.createGain();
      g.gain.value = 0.05 / Math.sqrt(hz / 110);
      o.connect(g).connect(out);
      this.track(this.lfo(0.13 + hz * 0.0003, 0.6, o.frequency)).stop(t + duration + 3);
      o.start(t);
      o.stop(t + duration + 3);
    }
    const n = this.track(this.noiseSource());
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + duration);
    bp.Q.value = 0.8;
    const ng = c.createGain();
    ng.gain.value = 0.05;
    n.connect(bp).connect(ng).connect(out);
    n.start(t);
    n.stop(t + duration + 3);
  }

  /** silence everything (end card) */
  hush(fade = 2) {
    this.cues.reset();
    for (const source of this.transients) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.transients.clear();
    if (!this.ready) return;
    this.setZone('silent', fade);
    this.setRumble(0, fade);
    this.setHum(0, 0, fade);
  }
}
