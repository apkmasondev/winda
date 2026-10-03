import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collision is authored separately from the visuals: simple boxes, slanted
 * boxes over stairs (smooth descent instead of bumping down 34 risers) and
 * invisible guard walls where the architecture has no parapet. Everything
 * static is merged into one BVH; doors and other movable blockers live in
 * small dynamic sets that can be toggled.
 */
export class Colliders {
  private parts: THREE.BufferGeometry[] = [];
  static: { geometry: THREE.BufferGeometry; bvh: MeshBVH } | null = null;
  readonly dynamic = new Map<string, { geometry: THREE.BufferGeometry; bvh: MeshBVH; enabled: boolean; matrix: THREE.Matrix4; inverse: THREE.Matrix4 }>();

  /** Axis aligned box from min/max corners. */
  box(min: THREE.Vector3Like, max: THREE.Vector3Like, matrix?: THREE.Matrix4) {
    const g = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
    g.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    if (matrix) g.applyMatrix4(matrix);
    this.add(g);
  }

  /** Box with arbitrary transform. */
  obb(center: THREE.Vector3, size: THREE.Vector3, quaternion: THREE.Quaternion) {
    const g = new THREE.BoxGeometry(size.x, size.y, size.z);
    g.applyMatrix4(new THREE.Matrix4().compose(center, quaternion, new THREE.Vector3(1, 1, 1)));
    this.add(g);
  }

  /**
   * Walkable ramp between two points on the centre line of a flight (top
   * surface passes through a and b), `width` across, `thickness` below.
   */
  ramp(a: THREE.Vector3, b: THREE.Vector3, width: number, thickness = 0.6, matrix?: THREE.Matrix4) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const g = new THREE.BoxGeometry(width, thickness, len);
    g.translate(0, -thickness / 2, 0);
    const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
    // lookAt makes -z point from a to b; our box spans z symmetric -> centre
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    g.applyMatrix4(new THREE.Matrix4().compose(c, q, new THREE.Vector3(1, 1, 1)));
    if (matrix) g.applyMatrix4(matrix);
    this.add(g);
  }

  add(g: THREE.BufferGeometry) {
    const clean = new THREE.BufferGeometry();
    clean.setAttribute('position', g.getAttribute('position'));
    clean.setIndex(g.getIndex());
    this.parts.push(clean);
  }

  build() {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error('no colliders');
    this.static = { geometry: merged, bvh: new MeshBVH(merged) };
    this.parts = [];
  }

  /** A movable set of boxes (local space) placed with `matrix`. */
  defineDynamic(name: string, boxes: Array<[THREE.Vector3Like, THREE.Vector3Like]>, matrix: THREE.Matrix4) {
    const gs = boxes.map(([min, max]) => {
      const g = new THREE.BoxGeometry(max.x - min.x, max.y - min.y, max.z - min.z);
      g.translate((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      const c = new THREE.BufferGeometry();
      c.setAttribute('position', g.getAttribute('position'));
      c.setIndex(g.getIndex());
      return c;
    });
    const geometry = mergeGeometries(gs, false)!;
    this.dynamic.set(name, { geometry, bvh: new MeshBVH(geometry), enabled: true, matrix: matrix.clone(), inverse: matrix.clone().invert() });
  }

  setDynamic(name: string, enabled: boolean) {
    const d = this.dynamic.get(name);
    if (d) d.enabled = enabled;
  }

  setDynamicMatrix(name: string, matrix: THREE.Matrix4) {
    const d = this.dynamic.get(name);
    if (d) {
      d.matrix.copy(matrix);
      d.inverse.copy(matrix).invert();
    }
  }
}
