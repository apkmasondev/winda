import * as THREE from 'three';
import { glowMaterial, halo, patchSurface } from '../render/materials';
import { entryById, formatDate, type EntryId } from '../story/entries';
import { lang, t } from '../ui/i18n';

/**
 * Brass plates with the inspection entries, and the inspection card framed in
 * every cabin. The engraving holds a faint warm light: a plate is the only
 * small warm rectangle in a cold, enormous room, so it is found by eye, never
 * by a marker. Reading is by looking: stand in front of one and it is read.
 */
export type PlaqueKind = 'wall' | 'floor' | 'lectern' | 'card';

type Plaque = {
  id: EntryId;
  kind: PlaqueKind;
  mesh: THREE.Mesh;
  face: THREE.MeshStandardMaterial;
  map: THREE.CanvasTexture;
  glowMap: THREE.CanvasTexture | null;
  /** warm light the engraving throws on the stone around it */
  halo: THREE.MeshBasicMaterial | null;
  reach: number;
  glow: number;
  focus: number;
  read: boolean;
};

const SIZE: Record<PlaqueKind, [number, number, number]> = {
  wall: [0.42, 0.3, 0.012],
  floor: [0.62, 0.44, 0.03],
  lectern: [0.46, 0.33, 0.012],
  card: [0.21, 0.297, 0.004],
};
const PX = 1024;
const SERIF = 'Georgia, "Times New Roman", serif';

/** uniform "baked" light for the plate face: places lit only by baked light
 * (the stepwell) have no realtime light that could reach it */
let white: THREE.DataTexture | null = null;
const ambientMap = () => {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
  }
  return white;
};

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Plaques {
  readonly items: Plaque[] = [];
  private edge = patchSurface(new THREE.MeshStandardMaterial({ color: 0x6b5435, metalness: 0.8, roughness: 0.45 }), { fog: true });
  private steel = patchSurface(new THREE.MeshStandardMaterial({ color: 0x4b4a48, metalness: 1, roughness: 0.4 }), { fog: true });

  /**
   * position: centre of the plate's back on the surface (parent space)
   * normal: out of the surface; up: text up direction (defaults to world up,
   * or -z for plates lying on the floor)
   */
  add(id: EntryId, kind: PlaqueKind, parent: THREE.Object3D, position: THREE.Vector3, normal: THREE.Vector3, o: { up?: THREE.Vector3; ambient?: number } = {}) {
    const up = o.up;
    const [w, h, d] = SIZE[kind];
    const geo = new THREE.BoxGeometry(w, h, d);
    // three draw calls instead of six: edges (+x -x +y -y), face (+z), back (-z)
    geo.clearGroups();
    geo.addGroup(0, 24, 0);
    geo.addGroup(24, 6, 1);
    geo.addGroup(30, 6, 0);
    const map = new THREE.CanvasTexture(document.createElement('canvas'));
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    const card = kind === 'card';
    const glowMap = card ? null : new THREE.CanvasTexture(document.createElement('canvas'));
    if (glowMap) {
      glowMap.colorSpace = THREE.SRGBColorSpace;
      glowMap.anisotropy = 8;
    }
    const face = patchSurface(
      new THREE.MeshStandardMaterial({
        map,
        emissiveMap: glowMap,
        emissive: card ? 0x000000 : 0xffb878,
        emissiveIntensity: 0,
        // the floor plate lies in the slit's hard light: keep it out of the highlights
        color: kind === 'floor' ? 0x8a8a8a : 0xffffff,
        metalness: card ? 0 : kind === 'floor' ? 0.3 : 0.55,
        roughness: card ? 0.85 : kind === 'floor' ? 0.62 : 0.5,
        lightMap: o.ambient ? ambientMap() : null,
        lightMapIntensity: o.ambient ?? 0,
      }),
      { fog: true },
    );
    const side = card ? this.steel : this.edge;
    const mesh = new THREE.Mesh(geo, [side, face]);
    mesh.name = `plaque-${id}`;
    mesh.receiveShadow = true;

    // +z of the box faces out; the back sits a few mm proud of the surface
    // (standoffs) so no face ever shares a plane with the wall behind it
    const n = normal.clone().normalize();
    const textUp = (up ?? (Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0))).clone();
    const x = new THREE.Vector3().crossVectors(textUp, n).normalize();
    const y = new THREE.Vector3().crossVectors(n, x).normalize();
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
    // floor plates are set into the paving: 12 mm proud, the rest below
    const lift = kind === 'floor' ? 0.012 - d / 2 : d / 2 + (card ? 0.002 : 0.004);
    mesh.position.copy(position).addScaledVector(n, lift);
    parent.add(mesh);

    let haloMat: THREE.MeshBasicMaterial | null = null;
    if (!card) {
      haloMat = glowMaterial(0xffb877, 0, { additive: true, map: halo() });
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, h * 3.6), haloMat);
      hm.quaternion.copy(mesh.quaternion);
      // on the surface, under the plate (1 cm out: never at the wall's depth)
      hm.position.copy(position).addScaledVector(n, 0.01);
      hm.renderOrder = 5;
      parent.add(hm);
    }

    const p: Plaque = { id, kind, mesh, face, map, glowMap, halo: haloMat, reach: kind === 'floor' ? 3.2 : kind === 'card' ? 1.6 : 2.7, glow: 0, focus: 0, read: false };
    this.items.push(p);
    this.draw(p);
    return p;
  }

  markRead(ids: Iterable<EntryId>) {
    const set = new Set(ids);
    for (const p of this.items) p.read = set.has(p.id);
  }

  redraw() {
    for (const p of this.items) this.draw(p);
  }

  /**
   * Returns the entry the viewer is reading, if any: close enough, in front
   * of the plate, and looking at it.
   */
  update(dt: number, camera: THREE.Camera, time: number): EntryId | null {
    let best: Plaque | null = null;
    let bestDot = 0;
    camera.getWorldDirection(_f);
    for (const p of this.items) {
      if (visible(p.mesh)) {
        p.mesh.getWorldPosition(_c);
        _n.set(0, 0, 1).applyQuaternion(p.mesh.getWorldQuaternion(_q));
        _v.subVectors(_c, camera.position);
        const dist = _v.length();
        if (dist < p.reach && dist > 0.05) {
          _v.divideScalar(dist);
          const facing = -_v.dot(_n);
          // tolerance grows as the plate gets closer (it fills more of the view)
          const look = _v.dot(_f);
          const need = Math.cos(THREE.MathUtils.degToRad(THREE.MathUtils.clamp(14 / dist, 9, 26)));
          if (facing > 0.25 && look > need && look > bestDot) {
            best = p;
            bestDot = look;
          }
        }
      }
    }
    for (const p of this.items) {
      const target = p === best ? 1 : 0;
      p.focus += (target - p.focus) * (1 - Math.exp(-dt * 4));
      if (p.kind === 'card') continue;
      // unread plates breathe slowly; read ones keep only an ember
      const idle = p.read ? 0.55 : 1.1 + Math.sin(time * 0.9 + p.mesh.id) * 0.25;
      const g = idle + p.focus * 1.6;
      if (Math.abs(g - p.glow) > 0.002) {
        p.glow = g;
        p.face.emissiveIntensity = g;
        p.halo?.color.setRGB(1, 0.72, 0.47).multiplyScalar(0.045 * g);
      }
    }
    return best ? best.id : null;
  }

  // ---------------------------------------------------------------- drawing

  private draw(p: Plaque) {
    const [w, h] = SIZE[p.kind];
    const W = PX;
    const H = Math.round((PX * h) / w);
    const c = p.map.image as HTMLCanvasElement;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    if (p.kind === 'card') drawCard(g, W, H);
    else {
      const glow = p.glowMap!.image as HTMLCanvasElement;
      glow.width = W;
      glow.height = H;
      drawPlate(g, glow.getContext('2d')!, W, H, p.id);
      p.glowMap!.needsUpdate = true;
    }
    p.map.needsUpdate = true;
  }
}

function visible(o: THREE.Object3D) {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

function wrap(g: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number, align: 'left' | 'right' | 'center') {
  const chars = [...text];
  const width = chars.reduce((s, ch) => s + g.measureText(ch).width + spacing, -spacing);
  let cx = align === 'left' ? x : align === 'right' ? x - width : x - width / 2;
  for (const ch of chars) {
    g.fillText(ch, cx, y);
    cx += g.measureText(ch).width + spacing;
  }
}

/** cast bronze: base colour, a bevelled border and engraved (dark, glowing) letters */
function drawPlate(g: CanvasRenderingContext2D, glow: CanvasRenderingContext2D, W: number, H: number, id: EntryId) {
  const e = entryById(id);
  // metal
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#7d6342');
  grad.addColorStop(0.5, '#6a5236');
  grad.addColorStop(1, '#5a452d');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // fine brushing and patina
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${rnd() > 0.5 ? '255,235,200' : '20,12,4'},${0.02 + rnd() * 0.04})`;
    g.fillRect(rnd() * W, rnd() * H, 30 + rnd() * 160, 1);
  }
  for (let i = 0; i < 26; i++) {
    const r = 20 + rnd() * 90;
    const x = rnd() * W;
    const y = rnd() * H;
    const pg = g.createRadialGradient(x, y, 0, x, y, r);
    pg.addColorStop(0, 'rgba(40,70,55,0.10)');
    pg.addColorStop(1, 'rgba(40,70,55,0)');
    g.fillStyle = pg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // the metal itself holds a little of the light, so the plate reads as bronze in the dark
  glow.fillStyle = '#1f160c';
  glow.fillRect(0, 0, W, H);

  // border: a raised fillet
  const m = W * 0.045;
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,230,190,0.22)';
  g.strokeRect(m, m, W - 2 * m, H - 2 * m);
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(15,8,2,0.55)';
  g.strokeRect(m + 6, m + 6, W - 2 * m - 12, H - 2 * m - 12);
  // screws
  for (const [sx, sy] of [[m * 0.55, m * 0.55], [W - m * 0.55, m * 0.55], [m * 0.55, H - m * 0.55], [W - m * 0.55, H - m * 0.55]]) {
    const sg = g.createRadialGradient(sx - 3, sy - 3, 1, sx, sy, 13);
    sg.addColorStop(0, '#b39a72');
    sg.addColorStop(1, '#3b2c1a');
    g.fillStyle = sg;
    g.beginPath();
    g.arc(sx, sy, 12, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(20,10,0,0.7)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(sx - 8, sy + 4);
    g.lineTo(sx + 8, sy - 4);
    g.stroke();
  }

  const engrave = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    // a light lip below each cut, the cut itself dark; the glow follows the cut
    g.save();
    g.translate(0, 2.5);
    g.fillStyle = 'rgba(255,232,196,0.28)';
    draw(g);
    g.restore();
    g.fillStyle = '#1d140b';
    draw(g);
    glow.fillStyle = '#fff';
    draw(glow);
  };

  const pad = m + W * 0.06;
  const head = `${e.floor}`;
  const date = formatDate(e.date);
  const font = (ctx: CanvasRenderingContext2D, px: number, style = '') => (ctx.font = `${style} ${px}px ${SERIF}`.trim());
  engrave((ctx) => {
    font(ctx, 46);
    ctx.textBaseline = 'alphabetic';
    spaced(ctx, head, pad, pad + 40, 10, 'left');
    spaced(ctx, date, W - pad, pad + 40, 10, 'right');
  });
  // rule
  engrave((ctx) => ctx.fillRect(pad, pad + 66, W - 2 * pad, 3));
  // body
  const body = e.text[lang()];
  let px = 44;
  let lines: string[] = [];
  const maxH = H - (pad + 104) - pad;
  for (; px >= 28; px -= 2) {
    font(g, px, 'italic');
    lines = wrap(g, body, W - 2 * pad);
    if (lines.length * px * 1.42 <= maxH) break;
  }
  engrave((ctx) => {
    font(ctx, px, 'italic');
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + 104 + i * px * 1.42));
  });
}

/** the inspection card behind the cabin's panel: same signature on every line */
function drawCard(g: CanvasRenderingContext2D, W: number, H: number) {
  const e = entryById('card');
  g.fillStyle = '#d9d2c2';
  g.fillRect(0, 0, W, H);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(90,70,40,${rnd() * 0.05})`;
    g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 6, 2 + rnd() * 6);
  }
  const ink = '#2a2622';
  const pad = W * 0.08;
  g.fillStyle = ink;
  g.textBaseline = 'alphabetic';
  g.font = `600 50px ${SERIF}`;
  spaced(g, t('cardTitle').toUpperCase(), W / 2, pad + 50, 6, 'center');
  g.fillRect(pad, pad + 78, W - 2 * pad, 3);

  const body = e.text[lang()].split('\n').slice(0, 2).join('\n');
  g.font = `34px ${SERIF}`;
  const lines = wrap(g, body, W - 2 * pad);
  lines.forEach((l, i) => g.fillText(l, pad, pad + 136 + i * 46));

  // the table: year, check, signature - one hand for ninety-five years
  const years = ['1931', '1957', '1979', '1994', '2009', '2023'];
  const top = pad + 150 + lines.length * 46;
  const row = 74;
  g.strokeStyle = 'rgba(40,34,28,0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= years.length + 1; i++) {
    g.beginPath();
    g.moveTo(pad, top + i * row);
    g.lineTo(W - pad, top + i * row);
    g.stroke();
  }
  g.font = `32px ${SERIF}`;
  const today = formatDate(null);
  [...years, today].forEach((y, i) => {
    const yy = top + i * row + row * 0.66;
    g.fillStyle = ink;
    g.fillText(i < years.length ? y : today, pad + 10, yy);
    if (i < years.length) {
      g.fillText('✓', W * 0.46, yy);
      signature(g, W * 0.6, yy - 6, i);
    }
  });
}

function signature(g: CanvasRenderingContext2D, x: number, y: number, i: number) {
  // the same stroke every time, with the tiny tremor of a real hand
  g.save();
  g.translate(x, y);
  g.rotate(-0.04 + i * 0.004);
  g.strokeStyle = 'rgba(28,36,70,0.85)';
  g.lineWidth = 3.2;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 6);
  g.bezierCurveTo(14, -30, 30, -26, 24, 4);
  g.bezierCurveTo(20, 22, 44, 10, 52, -8);
  g.bezierCurveTo(60, -24, 66, 14, 80, 2);
  g.bezierCurveTo(96, -12, 110, 10, 128, -2);
  g.bezierCurveTo(150, -16, 176, 6, 196, -10);
  g.stroke();
  g.beginPath();
  g.moveTo(8, 18);
  g.bezierCurveTo(60, 12, 140, 14, 210, 8);
  g.stroke();
  g.restore();
}
