import * as THREE from 'three';
import { BloomEffect, Effect, EffectComposer, EffectPass, RenderPass, BlendFunction } from 'postprocessing';

/**
 * Final grade in one fragment pass:
 *   exposure -> filmic tonemap (AgX-like) -> split-tone via per-channel gamma
 *   -> saturation -> vignette -> luminance-weighted grain -> fade.
 *
 * Everything here maps black to black. That matters: the film ends on pure
 * black and the first realtime frames must be indistinguishable from it.
 */
class GradeEffect extends Effect {
  constructor() {
    super(
      'GradeEffect',
      /* glsl */ `
      uniform float uExposure;
      uniform float uSaturation;
      uniform vec3 uGamma;
      uniform float uVignette;
      uniform float uGrain;
      uniform float uTime;
      uniform float uFade;
      uniform vec3 uFadeColor;
      uniform float uContrast;

      // AgX (minimal fit, Benjamin Wrensch) - gentle highlight roll-off
      vec3 agxContrast(vec3 x) {
        vec3 x2 = x * x; vec3 x4 = x2 * x2;
        return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
      }
      vec3 agx(vec3 c) {
        const mat3 inM = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                              0.0784335999999992, 0.878468636469772, 0.0784336,
                              0.0792237451477643, 0.0791661274605434, 0.879142973793104);
        const mat3 outM = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                              -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                              -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
        const float minEv = -12.47393;
        const float maxEv = 4.026069;
        c = inM * c;
        c = clamp(log2(max(c, 1e-10)), minEv, maxEv);
        c = (c - minEv) / (maxEv - minEv);
        c = agxContrast(c);
        c = outM * c;
        // back to linear
        return pow(max(c, 0.0), vec3(2.2));
      }

      float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = max(inputColor.rgb, 0.0) * uExposure;
        float black = step(dot(c, vec3(1.0)), 1e-6);
        c = agx(c);
        // AgX lifts absolute black very slightly - pin it back to zero.
        c = max(c - 0.00045, 0.0) * mix(1.0, 0.0, black);
        // contrast around mid grey in perceptual space, black stays black
        vec3 pc = pow(c, vec3(1.0 / 2.2));
        pc = clamp((pc - 0.42) * uContrast + 0.42, 0.0, 1.0) * step(1e-5, pc);
        c = pow(pc, vec3(2.2));
        c = pow(c, uGamma);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSaturation);
        vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
        c *= mix(1.0, 1.0 - smoothstep(0.15, 1.05, length(d)), uVignette);
        float n = h12(uv * resolution + fract(uTime * 7.31) * 911.0) - 0.5;
        c += n * uGrain * (sqrt(l) * 0.09);
        c = mix(c, uFadeColor, uFade);
        outputColor = vec4(max(c, 0.0), inputColor.a);
      }
      `,
      {
        blendFunction: BlendFunction.SET,
        uniforms: new Map<string, THREE.Uniform>([
          ['uExposure', new THREE.Uniform(1)],
          ['uSaturation', new THREE.Uniform(0.86)],
          ['uGamma', new THREE.Uniform(new THREE.Vector3(1.0, 0.98, 0.94))],
          ['uVignette', new THREE.Uniform(0.55)],
          ['uGrain', new THREE.Uniform(1)],
          ['uTime', new THREE.Uniform(0)],
          ['uFade', new THREE.Uniform(0)],
          ['uFadeColor', new THREE.Uniform(new THREE.Color(0, 0, 0))],
          ['uContrast', new THREE.Uniform(1.06)],
        ]),
      },
    );
  }
  u(name: string) {
    return this.uniforms.get(name)!;
  }
}

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  private readonly grade: GradeEffect;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, msaa: number) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: msaa,
      stencilBuffer: false,
    });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: 0.75,
      luminanceSmoothing: 0.35,
      intensity: 1.15,
      radius: 0.8,
      levels: 7,
    });
    this.grade = new GradeEffect();
    const pass = new EffectPass(camera, this.bloom, this.grade);
    pass.dithering = true;
    this.composer.addPass(pass);
  }

  get exposure() { return this.grade.u('uExposure').value as number; }
  set exposure(v: number) { this.grade.u('uExposure').value = v; }
  get fade() { return this.grade.u('uFade').value as number; }
  set fade(v: number) { this.grade.u('uFade').value = v; }
  get fadeColor() { return this.grade.u('uFadeColor').value as THREE.Color; }
  set grain(v: number) { this.grade.u('uGrain').value = v; }
  set vignette(v: number) { this.grade.u('uVignette').value = v; }
  set saturation(v: number) { this.grade.u('uSaturation').value = v; }
  get gamma() { return this.grade.u('uGamma').value as THREE.Vector3; }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h, false);
  }

  render(dt: number, time: number) {
    this.grade.u('uTime').value = time;
    this.composer.render(dt);
  }
}
