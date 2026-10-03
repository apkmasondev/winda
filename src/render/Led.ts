import * as THREE from 'three';

/** Seven-segment glyphs: bit order a b c d e f g */
const GLYPHS: Record<string, number> = {
  '0': 0b1111110, '1': 0b0110000, '2': 0b1101101, '3': 0b1111001, '4': 0b0110011,
  '5': 0b1011011, '6': 0b1011111, '7': 0b1110000, '8': 0b1111111, '9': 0b1111011,
  '-': 0b0000001, ' ': 0, '_': 0b0001000, 'E': 0b1001111, 'r': 0b0000101, 'o': 0b0011101,
  'P': 0b1100111, 'H': 0b0110111, 'L': 0b0001110, 'u': 0b0011100, '=': 0b0001001,
};

// segment polygons in a 10 x 18 cell (y down), drawn slanted
const SEG: number[][][] = [
  [[1.5, 0.5], [8.5, 0.5], [7.3, 1.9], [2.7, 1.9]],          // a
  [[8.9, 0.9], [8.9, 8.4], [8.0, 9.0], [7.5, 8.4], [7.5, 2.2]], // b
  [[8.9, 9.6], [8.9, 17.1], [7.5, 15.8], [7.5, 9.6], [8.0, 9.0]], // c
  [[2.7, 16.1], [7.3, 16.1], [8.5, 17.5], [1.5, 17.5]],      // d
  [[1.1, 9.6], [2.0, 9.0], [2.5, 9.6], [2.5, 15.8], [1.1, 17.1]], // e
  [[1.1, 0.9], [2.5, 2.2], [2.5, 8.4], [2.0, 9.0], [1.1, 8.4]], // f
  [[2.2, 8.3], [7.8, 8.3], [8.6, 9.0], [7.8, 9.7], [2.2, 9.7], [1.4, 9.0]], // g
];

export type Arrow = 'up' | 'down' | null;

/**
 * Elevator position indicator rendered to a canvas texture, styled after the
 * one in the film: red segments, unlit segments faintly visible, arrow left.
 */
export class LedDisplay {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private text = '';
  private arrow: Arrow = null;
  private arrowOn = true;
  private dirty = true;
  /** 0..1 corruption: random segments flicker (used when the floors run out) */
  glitch = 0;

  constructor(w = 256, h = 64) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.draw();
  }

  set(arrow: Arrow, text: string) {
    if (arrow !== this.arrow || text !== this.text) {
      this.arrow = arrow;
      this.text = text;
      this.dirty = true;
    }
  }

  blinkArrow(on: boolean) {
    if (on !== this.arrowOn) {
      this.arrowOn = on;
      this.dirty = true;
    }
  }

  update() {
    if (this.glitch > 0 && Math.random() < this.glitch * 0.5) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
    this.texture.needsUpdate = true;
  }

  private draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const off = 'rgba(70, 8, 4, 0.55)';
    const on = '#ff2a12';

    // arrow
    const ax = W * 0.2;
    const ay = H * 0.5;
    const s = H * 0.36;
    const drawArrow = (dir: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      const t = dir; // 1 = down, -1 = up
      ctx.moveTo(ax - s * 0.14, ay - s * 0.9 * t);
      ctx.lineTo(ax + s * 0.14, ay - s * 0.9 * t);
      ctx.lineTo(ax + s * 0.14, ay + s * 0.05 * t);
      ctx.lineTo(ax + s * 0.55, ay - s * 0.05 * t);
      ctx.lineTo(ax, ay + s * 0.9 * t);
      ctx.lineTo(ax - s * 0.55, ay - s * 0.05 * t);
      ctx.lineTo(ax - s * 0.14, ay + s * 0.05 * t);
      ctx.closePath();
      ctx.fill();
    };
    drawArrow(1, off);
    if (this.arrow && this.arrowOn) drawArrow(this.arrow === 'down' ? 1 : -1, on);

    // two digit cells, right aligned
    const txt = this.text.padStart(2, ' ').slice(-2);
    const cellH = H * 0.72;
    const sc = cellH / 18;
    const slant = 0.12;
    for (let i = 0; i < 2; i++) {
      const ox = W * 0.52 + i * 13 * sc;
      const oy = (H - cellH) / 2;
      const mask = GLYPHS[txt[i]] ?? 0;
      for (let sgi = 0; sgi < 7; sgi++) {
        let lit = (mask >> (6 - sgi)) & 1;
        if (this.glitch > 0 && Math.random() < this.glitch * 0.25) lit = lit ? 0 : 1;
        ctx.fillStyle = lit ? on : off;
        ctx.beginPath();
        SEG[sgi].forEach(([x, y], k) => {
          const px = ox + (x + (18 - y) * slant) * sc;
          const py = oy + y * sc;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/** Same glyphs as inline SVG for the pause panel. */
export function ledSvg(text: string): string {
  const txt = text.padStart(2, ' ').slice(-2);
  let out = '';
  for (let i = 0; i < 2; i++) {
    const mask = GLYPHS[txt[i]] ?? 0;
    const segs = SEG.map((pts, sgi) => {
      const lit = (mask >> (6 - sgi)) & 1;
      const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${(x + (18 - y) * 0.12).toFixed(2)} ${y}`).join(' ') + ' Z';
      return `<path class="seg${lit ? ' on' : ''}" d="${d}"/>`;
    }).join('');
    out += `<svg viewBox="0 0 12 18">${segs}</svg>`;
  }
  return out;
}
