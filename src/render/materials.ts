import * as THREE from 'three';
import { FOG_PARS, bindAtmosphere } from './atmosphere';

/* ----------------------------------------------------------------------------
 * Shared GLSL
 * ------------------------------------------------------------------------- */

const SURFACE_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

vec3 triWeights(vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  return w / (w.x + w.y + w.z + 1e-5);
}

vec3 triSample(sampler2D tex, vec3 p, vec3 w) {
  return texture2D(tex, p.zy).rgb * w.x + texture2D(tex, p.xz).rgb * w.y + texture2D(tex, p.xy).rgb * w.z;
}

// Ashlar coursing on vertical faces, square paving on horizontal faces.
// x: course height, y: block length, z: joint width, w: paving size
float masonry(vec3 wp, vec3 n, vec4 m) {
  if (m.x <= 0.0) return 0.0;
  float joint = 0.0;
  if (abs(n.y) < 0.6) {
    float row = floor(wp.y / m.x);
    float fy = fract(wp.y / m.x);
    float h = abs(n.x) > abs(n.z) ? wp.z : wp.x;
    float off = (mod(row, 2.0) * 0.5 + hash11(row) * 0.18) * m.y;
    float fx = fract((h + off) / m.y);
    float dy = min(fy, 1.0 - fy) * m.x;
    float dx = min(fx, 1.0 - fx) * m.y;
    float aay = fwidth(wp.y) * 1.2 + 1e-4;
    float aax = fwidth(h) * 1.2 + 1e-4;
    joint = max(1.0 - smoothstep(m.z, m.z + aay, dy), 1.0 - smoothstep(m.z, m.z + aax, dx));
    // sub-pixel joints alias into moving moire: let them dissolve with distance
    joint *= 1.0 - smoothstep(m.z * 1.5, m.z * 6.0, max(aax, aay));
  } else if (m.w > 0.0) {
    vec2 f = fract(wp.xz / m.w);
    vec2 d = min(f, 1.0 - f) * m.w;
    vec2 aa = fwidth(wp.xz) * 1.2 + 1e-4;
    joint = max(1.0 - smoothstep(vec2(m.z * 0.7), vec2(m.z * 0.7) + aa, d).x,
                1.0 - smoothstep(vec2(m.z * 0.7), vec2(m.z * 0.7) + aa, d).y);
    joint *= 1.0 - smoothstep(m.z * 1.0, m.z * 4.5, max(aa.x, aa.y));
  }
  return joint;
}
`;

const WORLD_VARYINGS_VERTEX = /* glsl */ `
{
  vec4 tpW = vec4(transformed, 1.0);
  vec3 tpN = objectNormal;
  #ifdef USE_INSTANCING
    tpW = instanceMatrix * tpW;
    mat3 im = mat3(instanceMatrix);
    tpN /= vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
    tpN = im * tpN;
  #endif
  tpW = modelMatrix * tpW;
  vWPos = tpW.xyz;
  mat3 mm = mat3(modelMatrix);
  tpN /= vec3(dot(mm[0], mm[0]), dot(mm[1], mm[1]), dot(mm[2], mm[2]));
  vWNrm = normalize(mm * tpN);
}
`;

/* ----------------------------------------------------------------------------
 * Textures
 * ------------------------------------------------------------------------- */

export type StoneTextures = { detail: THREE.Texture; normal: THREE.Texture };

export async function loadStoneTextures(loader: THREE.TextureLoader): Promise<StoneTextures> {
  const [detail, normal] = await Promise.all([
    loader.loadAsync('textures/stone_detail.jpg'),
    loader.loadAsync('textures/stone_normal.jpg'),
  ]);
  for (const t of [detail, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return { detail, normal };
}

/* ----------------------------------------------------------------------------
 * Patched MeshStandardMaterial
 * ------------------------------------------------------------------------- */

export type SurfaceOptions = {
  textures?: StoneTextures;
  /** metres per texture tile */
  tile?: number;
  normalStrength?: number;
  /** course height, block length, joint width, paving size (metres) */
  masonry?: [number, number, number, number];
  /** strength of the baked AO stored in the colour attribute (red) */
  bakedAO?: number;
  brushed?: boolean;
  fog?: boolean;
  /** darken with distance from a height band: [centre y, half range, falloff metres] */
  heightFade?: [number, number, number];
};

let materialSerial = 0;

export function patchSurface<T extends THREE.MeshStandardMaterial>(mat: T, o: SurfaceOptions): T {
  const tri = !!o.textures;
  const normalStrength = o.normalStrength ?? 0.6;
  const uniforms: Record<string, THREE.IUniform> = {
    uTriDetail: { value: o.textures?.detail ?? null },
    uTriNormal: { value: o.textures?.normal ?? null },
    uTriScale: { value: 1 / (o.tile ?? 3.2) },
    uNormalStrength: { value: normalStrength },
    uMasonry: { value: new THREE.Vector4(...(o.masonry ?? [0, 0, 0, 0])) },
    uBakedAO: { value: o.bakedAO ?? 0 },
    uHeightFade: { value: new THREE.Vector3(...(o.heightFade ?? [0, 1e6, 1e6])) },
  };
  if (o.bakedAO) mat.vertexColors = true;
  const fog = o.fog !== false;
  const hf = !!o.heightFade;
  const key = `surf-${tri ? 1 : 0}-${o.masonry ? 1 : 0}-${o.bakedAO ? 1 : 0}-${o.brushed ? 1 : 0}-${fog ? 1 : 0}-${normalStrength ? 1 : 0}-${hf ? 1 : 0}`;
  mat.userData.surface = uniforms;
  mat.userData.serial = materialSerial++;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    bindAtmosphere(shader.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${WORLD_VARYINGS_VERTEX}`);

    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <common>',
      `#include <common>
${SURFACE_PARS}
${FOG_PARS}
uniform sampler2D uTriDetail;
uniform sampler2D uTriNormal;
uniform float uTriScale;
uniform float uNormalStrength;
uniform vec4 uMasonry;
uniform float uBakedAO;
uniform vec3 uHeightFade;
float gJoint = 0.0;
vec3 gDetail = vec3(0.5);
float gAO = 1.0;
`,
    );

    // albedo: triplanar detail + masonry joints + baked AO
    fs = fs.replace(
      '#include <color_fragment>',
      `
${o.bakedAO ? 'gAO = mix(1.0, vColor.r, uBakedAO);' : ''}
${
  tri
    ? `{
  vec3 w = triWeights(normalize(vWNrm));
  vec3 p = vWPos * uTriScale;
  gDetail = triSample(uTriDetail, p, w);
  vec3 big = triSample(uTriDetail, p * 0.11 + 0.37, w);
  diffuseColor.rgb *= mix(0.74, 1.12, gDetail.r) * mix(0.84, 1.1, big.b);
}`
    : ''
}
${o.masonry ? 'gJoint = masonry(vWPos, normalize(vWNrm), uMasonry); diffuseColor.rgb *= 1.0 - gJoint * 0.42;' : ''}
${
  o.brushed
    ? `{
  float n1 = hash11(floor(vWPos.y * 1400.0) + floor((vWPos.x + vWPos.z) * 2.0) * 17.0);
  float n2 = hash11(floor(vWPos.y * 380.0) + 3.0);
  gDetail = vec3(0.5, mix(n1, n2, 0.5), 0.5);
  diffuseColor.rgb *= 0.94 + 0.08 * n2;
}`
    : ''
}
`,
    );

    fs = fs.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * mix(0.82, 1.14, gDetail.g) + gJoint * 0.2, 0.04, 1.0);`,
    );

    if (tri && normalStrength) {
      fs = fs.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  vec3 nW = normalize(vWNrm);
  vec3 w = triWeights(nW);
  vec3 p = vWPos * uTriScale;
  vec3 tx = texture2D(uTriNormal, p.zy).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(uTriNormal, p.xz).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(uTriNormal, p.xy).xyz * 2.0 - 1.0;
  tx.xy *= uNormalStrength; ty.xy *= uNormalStrength; tz.xy *= uNormalStrength;
  vec3 nx = vec3(tx.xy + nW.zy, abs(tx.z) * nW.x);
  vec3 ny = vec3(ty.xy + nW.xz, abs(ty.z) * nW.y);
  vec3 nz = vec3(tz.xy + nW.xy, abs(tz.z) * nW.z);
  vec3 wn = normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`,
      );
    }

    fs = fs.replace(
      '#include <aomap_fragment>',
      `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= gAO;
reflectedLight.indirectSpecular *= gAO;
reflectedLight.directDiffuse *= mix(1.0, gAO, 0.55);
reflectedLight.directSpecular *= mix(1.0, gAO, 0.55);`,
    );

    const fade = hf ? 'gl_FragColor.rgb *= exp(-max(abs(vWPos.y - uHeightFade.x) - uHeightFade.y, 0.0) / uHeightFade.z);' : '';
    if (fog) fs = fs.replace('#include <fog_fragment>', `${fade}
gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWPos);`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export function stoneMaterial(textures: StoneTextures, o: Partial<SurfaceOptions> & { color?: THREE.ColorRepresentation; roughness?: number } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0x8a847b,
    roughness: o.roughness ?? 0.92,
    metalness: 0,
  });
  return patchSurface(m, { textures, tile: 3.4, normalStrength: 0.55, ...o });
}

/* ----------------------------------------------------------------------------
 * Fogged unlit / emissive
 * ------------------------------------------------------------------------- */

/** MeshBasicMaterial that still sits inside the atmosphere. HDR colours bloom. */
export function glowMaterial(
  color: THREE.ColorRepresentation,
  intensity = 1,
  o: { fog?: boolean; transparent?: boolean; opacity?: number; side?: THREE.Side; additive?: boolean; map?: THREE.Texture } = {},
) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    transparent: o.transparent ?? !!o.additive,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    toneMapped: false,
    map: o.map ?? null,
    depthWrite: !o.additive,
    blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  if (o.fog !== false) {
    m.onBeforeCompile = (shader) => {
      bindAtmosphere(shader.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n{ vec3 objectNormal = vec3(0.0, 1.0, 0.0); ${WORLD_VARYINGS_VERTEX} }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\n${FOG_PARS}`)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vWPos);');
    };
    m.customProgramCacheKey = () => `glow-fog-${o.map ? 1 : 0}`;
  }
  return m;
}

let haloTexture: THREE.Texture | null = null;
/** soft radial falloff, used for light halos on dark walls */
export function halo() {
  if (haloTexture) return haloTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  haloTexture = new THREE.CanvasTexture(c);
  haloTexture.colorSpace = THREE.NoColorSpace;
  return haloTexture;
}

/* ----------------------------------------------------------------------------
 * Baked stepwell material (lamp irradiance in R, AO in G)
 * ------------------------------------------------------------------------- */

export function bakedMaterial(textures: StoneTextures) {
  const uniforms: Record<string, THREE.IUniform> = {
    uTriDetail: { value: textures.detail },
    uTriNormal: { value: textures.normal },
    uTriScale: { value: 1 / 3.4 },
    uMasonry: { value: new THREE.Vector4(1.5, 4.5, 0.01, 0) },
    uAlbedo: { value: new THREE.Color(0x8a8379) },
    uLampColor: { value: new THREE.Color(1.0, 0.62, 0.36) },
    uLampIntensity: { value: 1.4 },
    uAmbient: { value: new THREE.Color(0x10151d) },
    uSkyLight: { value: new THREE.Color(0x0d1420) },
    uPointPos: { value: new THREE.Vector3(0, -1e5, 0) },
    uPointColor: { value: new THREE.Color(0, 0, 0) },
    uPointRange: { value: 18 },
    uDim: { value: 1 },
  };
  bindAtmosphere(uniforms);
  const m = new THREE.ShaderMaterial({
    uniforms,
    vertexColors: true,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      varying vec3 vWNrm;
      varying vec2 vBake;
      void main() {
        vec3 transformed = position;
        vec3 objectNormal = normal;
        vBake = color.rg;
        ${WORLD_VARYINGS_VERTEX}
        gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${SURFACE_PARS}
      ${FOG_PARS}
      varying vec2 vBake;
      uniform sampler2D uTriDetail;
      uniform sampler2D uTriNormal;
      uniform float uTriScale;
      uniform vec4 uMasonry;
      uniform vec3 uAlbedo;
      uniform vec3 uLampColor;
      uniform float uLampIntensity;
      uniform vec3 uAmbient;
      uniform vec3 uSkyLight;
      uniform vec3 uPointPos;
      uniform vec3 uPointColor;
      uniform float uPointRange;
      uniform float uDim;
      void main() {
        vec3 n = normalize(vWNrm);
        vec3 w = triWeights(n);
        vec3 p = vWPos * uTriScale;
        vec3 d = triSample(uTriDetail, p, w);
        vec3 big = triSample(uTriDetail, p * 0.11 + 0.37, w);
        // micro relief from the normal map, used as a cheap lighting modulation
        vec3 tn = triSample(uTriNormal, p, w) * 2.0 - 1.0;
        float relief = 1.0 + dot(tn.xy, vec2(0.35, 0.5)) * 0.5;
        float joint = masonry(vWPos, n, uMasonry);
        vec3 albedo = uAlbedo * mix(0.74, 1.12, d.r) * mix(0.84, 1.1, big.b) * (1.0 - joint * 0.6);

        float lamp = vBake.x * vBake.x;
        float ao = vBake.y;
        vec3 light = uLampColor * lamp * uLampIntensity * uDim;
        light += uAmbient * ao;
        light += uSkyLight * ao * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);

        vec3 L = uPointPos - vWPos;
        float dist = length(L);
        float att = pow(clamp(1.0 - dist / uPointRange, 0.0, 1.0), 2.0) / (1.0 + dist * dist * 0.08);
        light += uPointColor * max(dot(n, L / max(dist, 1e-3)), 0.0) * att * mix(0.6, 1.0, ao);

        vec3 col = albedo * light * relief;
        col = applyFog(col, vWPos);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  m.userData.uniforms = uniforms;
  return m;
}
