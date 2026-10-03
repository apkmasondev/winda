import * as THREE from 'three';

/**
 * One atmosphere shared by every material, the sky dome and the particles.
 *
 * Exponential height fog: a thin uniform medium (everything far away dissolves,
 * columns vanish upward into the dark) plus a dense layer that thickens below
 * `base` (the abyss reads as luminous mist). The in-scattered colour depends
 * on the view direction (zenith / horizon / abyss) and on a glow source, so
 * the brightest thing in the world bleeds into the air around it - that is
 * how light guides the player without markers.
 */
export const atmosphere = {
  uFogDensity: { value: 0.0062 },
  uFogLayerDensity: { value: 0.018 },
  uFogFalloff: { value: 0.03 },
  uFogBase: { value: -30 },
  uFogZenith: { value: new THREE.Color(0x020306) },
  uFogHorizon: { value: new THREE.Color(0x111822) },
  uFogAbyss: { value: new THREE.Color(0x1c2a33) },
  uGlowPos: { value: new THREE.Vector3(0, 20, -140) },
  uGlowColor: { value: new THREE.Color(0x9fb8d6) },
  uGlowPower: { value: 10 },
  uGlowCore: { value: 1.0 },
  /** a second, purely directional glow (warm light deep in the abyss) */
  uGlow2Dir: { value: new THREE.Vector3(-0.45, -0.42, -0.79).normalize() },
  uGlow2Color: { value: new THREE.Color(0x000000) },
  uGlow2Power: { value: 6 },
  /** 0..1 multiplier on the whole medium (0 inside closed spaces at the start) */
  uFogVisibility: { value: 1 },
  uTime: { value: 0 },
};

export type AtmosphereState = {
  density: number;
  layerDensity: number;
  falloff: number;
  base: number;
  zenith: THREE.ColorRepresentation;
  horizon: THREE.ColorRepresentation;
  abyss: THREE.ColorRepresentation;
  glowPos: THREE.Vector3;
  glowColor: THREE.ColorRepresentation;
  glowPower: number;
  glowCore: number;
  glow2Color?: THREE.ColorRepresentation;
};

const _c = new THREE.Color();
/** Blend the live atmosphere toward a target preset (call every frame). */
export function blendAtmosphere(target: AtmosphereState, k: number) {
  const a = atmosphere;
  a.uFogDensity.value += (target.density - a.uFogDensity.value) * k;
  a.uFogLayerDensity.value += (target.layerDensity - a.uFogLayerDensity.value) * k;
  a.uFogFalloff.value += (target.falloff - a.uFogFalloff.value) * k;
  a.uFogBase.value += (target.base - a.uFogBase.value) * k;
  a.uFogZenith.value.lerp(_c.set(target.zenith), k);
  a.uFogHorizon.value.lerp(_c.set(target.horizon), k);
  a.uFogAbyss.value.lerp(_c.set(target.abyss), k);
  a.uGlowPos.value.lerp(target.glowPos, k);
  a.uGlowColor.value.lerp(_c.set(target.glowColor), k);
  a.uGlowPower.value += (target.glowPower - a.uGlowPower.value) * k;
  a.uGlowCore.value += (target.glowCore - a.uGlowCore.value) * k;
  a.uGlow2Color.value.lerp(_c.set(target.glow2Color ?? 0x000000), k);
}

export function setAtmosphere(target: AtmosphereState) {
  blendAtmosphere(target, 1);
}

export const FOG_PARS = /* glsl */ `
uniform float uFogDensity;
uniform float uFogLayerDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform vec3 uFogZenith;
uniform vec3 uFogHorizon;
uniform vec3 uFogAbyss;
uniform vec3 uGlowPos;
uniform vec3 uGlowColor;
uniform float uGlowPower;
uniform float uGlowCore;
uniform float uFogVisibility;
uniform vec3 uGlow2Dir;
uniform vec3 uGlow2Color;
uniform float uGlow2Power;

vec3 skyColor(vec3 camPos, vec3 dir) {
  float up = dir.y;
  vec3 c = mix(uFogHorizon, uFogZenith, pow(smoothstep(-0.02, 0.7, up), 0.55));
  c = mix(c, uFogAbyss, smoothstep(0.02, 0.55, -up));
  vec3 toGlow = normalize(uGlowPos - camPos);
  float g = max(dot(dir, toGlow), 0.0);
  c += uGlowColor * (pow(g, uGlowPower) * 0.55 + pow(g, uGlowPower * 14.0) * uGlowCore);
  c += uGlow2Color * pow(max(dot(dir, uGlow2Dir), 0.0), uGlow2Power);
  return c;
}

float fogAmount(vec3 camPos, vec3 wp) {
  vec3 ray = wp - camPos;
  float dist = length(ray);
  float k = uFogFalloff;
  float h0 = camPos.y - uFogBase;
  float dy = ray.y;
  // analytic integral of d(y) = layer * exp(-k (y - base)) along the ray
  float e0 = clamp(-k * h0, -30.0, 5.0);
  float kd = k * dy;
  float shape = abs(kd) > 1e-3 ? (1.0 - exp(clamp(-kd, -30.0, 30.0))) / kd : 1.0;
  float layer = uFogLayerDensity * exp(e0) * shape * dist;
  float optical = uFogDensity * dist + max(layer, 0.0);
  return (1.0 - exp(-optical)) * uFogVisibility;
}

vec3 applyFog(vec3 color, vec3 wp) {
  vec3 ray = wp - cameraPosition;
  vec3 dir = normalize(ray);
  return mix(color, skyColor(cameraPosition, dir), fogAmount(cameraPosition, wp));
}
`;

/** Bind the shared uniforms into a compiled shader. */
export function bindAtmosphere(uniforms: Record<string, THREE.IUniform>) {
  for (const [k, v] of Object.entries(atmosphere)) uniforms[k] = v;
}
