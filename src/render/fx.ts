import * as THREE from 'three';
import { FOG_PARS, bindAtmosphere, atmosphere } from './atmosphere';

/* ----------------------------------------------------------------------------
 * Sky: the atmosphere at infinity, plus the summit features (stars, dawn band,
 * and the seam - a vertical line of light in the sky that finally opens).
 * ------------------------------------------------------------------------- */

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor() {
    this.uniforms = {
      uStars: { value: 0 },
      uDawn: { value: 0 },
      uDawnColor: { value: new THREE.Color(1.0, 0.56, 0.32) },
      uSeam: { value: 0 },
      uSeamOpen: { value: 0 },
      uSeamYaw: { value: 0 },
      uSeamColor: { value: new THREE.Color(1.0, 0.97, 0.92) },
    };
    bindAtmosphere(this.uniforms);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * viewMatrix * vec4(position * 1000.0 + cameraPosition, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        varying vec3 vDir;
        uniform float uStars;
        uniform float uDawn;
        uniform vec3 uDawnColor;
        uniform float uSeam;
        uniform float uSeamOpen;
        uniform float uSeamYaw;
        uniform vec3 uSeamColor;

        float h13(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

        void main() {
          vec3 dir = normalize(vDir);
          vec3 c = skyColor(cameraPosition, dir);

          if (uDawn > 0.0) {
            float h = 1.0 - abs(dir.y);
            float band = pow(max(h, 0.0), 7.0) * smoothstep(-0.2, 0.02, dir.y);
            float az = atan(dir.x, -dir.z);
            float toward = pow(0.5 + 0.5 * cos(az - uSeamYaw), 2.5);
            c += uDawnColor * band * uDawn * (0.12 + toward * 1.1);
          }
          if (uStars > 0.0 && dir.y > 0.0) {
            vec3 q = dir * 380.0;
            vec3 cell = floor(q);
            float r = h13(cell);
            float star = step(0.9965, r) * (1.0 - smoothstep(0.05, 0.5, length(fract(q) - 0.5)));
            c += vec3(0.75, 0.8, 1.0) * star * uStars * smoothstep(0.05, 0.4, dir.y) * (0.4 + 0.6 * h13(cell + 7.0));
          }
          if (uSeam > 0.0) {
            float az = atan(dir.x, -dir.z) - uSeamYaw;
            az = atan(sin(az), cos(az));
            // two halves of the sky part like elevator doors: a crisp, widening band
            float width = mix(0.0012, 1.2, uSeamOpen * uSeamOpen);
            float d = abs(az) - width;
            float vert = smoothstep(-0.32, 0.05, dir.y) * (1.0 - smoothstep(0.6, 1.0, dir.y));
            float core = 1.0 - smoothstep(0.0, 0.0025 + uSeamOpen * 0.01, d);
            float halo = exp(-max(d, 0.0) * mix(70.0, 14.0, uSeamOpen));
            c = mix(c, c * (1.0 - 0.5 * uSeamOpen), (1.0 - smoothstep(0.0, 0.4, d)) * uSeamOpen);
            c += uSeamColor * (core * (3.0 + uSeamOpen * 22.0) + halo * (0.22 + uSeamOpen * 1.6)) * vert * uSeam;
          }
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }
}

/* ----------------------------------------------------------------------------
 * Light shafts: additive volumes with soft edges and drifting dust density.
 * ------------------------------------------------------------------------- */

const beamMaterialCache = new Map<string, THREE.ShaderMaterial>();

export function beamMaterial(color: THREE.ColorRepresentation, intensity: number, key = String(color) + intensity) {
  const cached = beamMaterialCache.get(key);
  if (cached) return cached;
  const uniforms: Record<string, THREE.IUniform> = {
    uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
    uIntensity: { value: 1 },
    uTime: atmosphere.uTime,
  };
  bindAtmosphere(uniforms);
  const m = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      varying vec3 vNrm;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWPos = w.xyz;
        vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FOG_PARS}
      varying vec3 vWPos;
      varying vec3 vNrm;
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        vec3 v = normalize(cameraPosition - vWPos);
        float edge = abs(dot(normalize(vNrm), v));
        edge = pow(edge, 2.2);
        // vUv.y: 0 at the source end, 1 at the far end
        float along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
        float dust = 0.65 + 0.35 * vn(vec2(vUv.x * 6.0, vUv.y * 40.0 - uTime * 0.25));
        float a = edge * along * dust * uIntensity;
        // the beam lives in the same air: farther = more diluted
        float f = fogAmount(cameraPosition, vWPos);
        gl_FragColor = vec4(uColor * a * (1.0 - f * 0.85), 1.0);
      }
    `,
  });
  beamMaterialCache.set(key, m);
  return m;
}

/** An open cylinder from `from` along `dir` with radius r and length len. */
export function makeBeam(from: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number, mat: THREE.Material) {
  const geo = new THREE.CylinderGeometry(r1, r0, len, 28, 1, true);
  // uv.y: 0 at top (source) -> 1 at bottom; Cylinder uv.y is 1 at top
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geo.translate(0, -len / 2, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  mesh.renderOrder = 10;
  mesh.frustumCulled = true;
  return mesh;
}

/* ----------------------------------------------------------------------------
 * Dust motes: a box of points that wraps around the camera.
 * ------------------------------------------------------------------------- */

export class Dust {
  readonly points: THREE.Points;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(count = 1400, size = 22) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * size;
      pos[i * 3 + 1] = Math.random() * size;
      pos[i * 3 + 2] = Math.random() * size;
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = {
      uBox: { value: size },
      uCam: { value: new THREE.Vector3() },
      uTime: atmosphere.uTime,
      uColor: { value: new THREE.Color(0.85, 0.82, 0.76) },
      uOpacity: { value: 0 },
      uLightPos: { value: new THREE.Vector3(0, -1e4, 0) },
      uLightColor: { value: new THREE.Color(0, 0, 0) },
      uScale: { value: 1 },
    };
    bindAtmosphere(this.uniforms);
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float seed;
        uniform float uBox;
        uniform vec3 uCam;
        uniform float uTime;
        uniform float uScale;
        varying float vSeed;
        varying vec3 vWPos;
        void main() {
          vSeed = seed;
          vec3 drift = vec3(sin(uTime * 0.05 + seed * 30.0), -0.25 - seed * 0.2, cos(uTime * 0.04 + seed * 21.0)) * uTime * 0.12;
          vec3 p = position + drift;
          p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
          vWPos = p;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uScale * (0.6 + seed * 1.2) * 26.0 / max(-mv.z, 0.5);
        }
      `,
      fragmentShader: /* glsl */ `
        ${FOG_PARS}
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform vec3 uLightPos;
        uniform vec3 uLightColor;
        uniform float uBox;
        uniform vec3 uCam;
        varying float vSeed;
        varying vec3 vWPos;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float a = 1.0 - smoothstep(0.0, 0.5, length(q));
          float d = distance(vWPos, uCam);
          float near = smoothstep(0.35, 1.4, d) * (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d));
          float lit = 1.0 / (1.0 + pow(distance(vWPos, uLightPos) * 0.35, 2.0));
          vec3 c = uColor * 0.25 + uLightColor * lit;
          float tw = 0.85 + 0.15 * sin(vSeed * 80.0 + vWPos.y * 0.7);
          gl_FragColor = vec4(c * a * near * uOpacity * tw * (1.0 - fogAmount(cameraPosition, vWPos)), 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  update(cam: THREE.Vector3) {
    (this.uniforms.uCam.value as THREE.Vector3).copy(cam);
  }
}

/* ----------------------------------------------------------------------------
 * Distant point lights (lamps, indicators). Small bright things far away are
 * sub-pixel and shimmer as the camera moves; these keep a minimum on-screen
 * size and trade the extra area for brightness, so they stay steady.
 * ------------------------------------------------------------------------- */

const glowPointSets: Array<{ uniforms: Record<string, THREE.IUniform> }> = [];

export class GlowPoints {
  readonly points: THREE.Points;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(positions: THREE.Vector3[], color: THREE.ColorRepresentation, intensity: number, worldSize: number, minPixels = 2.2) {
    const g = new THREE.BufferGeometry().setFromPoints(positions);
    this.uniforms = {
      uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
      uSize: { value: worldSize },
      uMinPx: { value: minPixels },
      uProj: { value: 600 },
    };
    bindAtmosphere(this.uniforms);
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        ${FOG_PARS}
        uniform float uSize;
        uniform float uMinPx;
        uniform float uProj;
        varying float vEnergy;
        varying float vFog;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vFog = clamp(fogAmount(cameraPosition, w.xyz), 0.0, 1.0);
          vec4 mv = viewMatrix * w;
          gl_Position = projectionMatrix * mv;
          float px = uSize * uProj / max(-mv.z, 0.1);
          float size = max(px, uMinPx);
          vEnergy = clamp((px * px) / (size * size), 0.0, 1.0);
          gl_PointSize = size * 2.0;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vEnergy;
        varying float vFog;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r = min(length(q) * 2.0, 1.0);
          float core = 1.0 - smoothstep(0.0, 0.55, r);
          float halo = exp(-r * 4.0) * 0.35 * (1.0 - r);
          gl_FragColor = vec4(uColor * (core + halo) * min(1.0, vEnergy * 4.0) * (1.0 - vFog), 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    glowPointSets.push(this);
  }

  /** pixels per metre at distance 1 for the current camera */
  static resize(camera: THREE.PerspectiveCamera, heightPx: number) {
    const proj = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const s of glowPointSets) s.uniforms.uProj.value = proj;
  }
}
