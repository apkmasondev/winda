import * as THREE from 'three';

/**
 * World plan (metres, three.js axes, -z is "forward" from the arrival cabin).
 *
 *   T1  origin tower - the arrival elevator is set into its face (z = -1.4)
 *   B1  upper causeway z -9 .. -57, deck y = 0
 *       gate frame at z = -21, monolith hovering over z = -45
 *   S   ten floating slabs stepping down to
 *   B2  lower causeway z -84 .. -132, deck y = -6.8
 *   T2  destination tower, face z = -136, recessed frame around a 62 m slit
 *   C   canyon inside the slit, ends in a low passage
 *   W   endless stepwell inside T2 (entry landing at y = -6.8)
 *   M   summit: the top of the world, far above (y = 3000)
 */
export const LAYOUT = {
  deckHalf: 2.2,
  curb: 0.32,
  b1: { z0: -9, z1: -57, y: 0 },
  slabs: { count: 10, z0: -57, pitch: 2.7, y0: 0, y1: -6.8 },
  b2: { z0: -84, z1: -132, y: -6.8 },
  landing: { halfWidth: 5, zFront: -9, zBack: -1.4 },
  t1: { halfWidth: 40, zFront: -1.4, zBack: 80 },
  t2: { halfWidth: 60, zFront: -136, zRecess: -139, zBack: -236, recessHalf: 6, recessTop: 70 },
  slit: { half: 2, y0: -6.8, y1: 56, zEnd: -156.5 },
  gateZ: -24,
  monolith: new THREE.Vector3(0, 40, -46),
  stepwell: { x: 25, z: -173.5, y0: -6.8, period: 24 },
  summit: new THREE.Vector3(0, 3000, 0),
  /** direction light travels (from an unseen aperture far above and behind the origin tower) */
  sunDir: new THREE.Vector3(0.32, -1, -0.27).normalize(),
};

export function slabTop(i: number) {
  const s = LAYOUT.slabs;
  const zc = s.z0 - s.pitch / 2 - i * s.pitch;
  // tops lie on the straight line from the end of B1 to the start of B2
  const t = (s.z0 - zc) / (s.z0 - LAYOUT.b2.z0);
  return { z: zc, y: s.y0 + (s.y1 - s.y0) * t };
}
