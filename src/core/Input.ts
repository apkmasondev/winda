/** Keyboard + pointer-lock mouse. Layout independent (KeyboardEvent.code). */
export class Input {
  readonly keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  locked = false;
  active = false;
  /** set once the browser has granted pointer lock at least once */
  hadLock = false;
  private dragging = false;
  onLockChange: (locked: boolean) => void = () => {};
  onKey: (code: string) => void = () => {};

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const inMenu = !!target?.closest('button, input, select, textarea, [contenteditable="true"]');
      if (this.active && !inMenu && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (this.active && !inMenu) this.keys.add(e.code);
      this.onKey(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    // fallback when pointer lock is unavailable: drag to look
    window.addEventListener('mousedown', (e) => {
      if (this.active && !this.locked && e.button === 0 && e.target === this.element) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    document.addEventListener('mousemove', (e) => {
      if (!this.active || (!this.locked && !this.dragging)) return;
      // guard against the occasional huge spike some browsers emit on lock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (this.locked) this.hadLock = true;
      document.body.classList.toggle('is-locked', this.locked);
      this.clear();
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
    });
  }

  async lock() {
    if (this.locked) return;
    try {
      // unadjustedMovement gives raw input where supported
      await (this.element.requestPointerLock as (o?: object) => Promise<void> | void).call(this.element, { unadjustedMovement: true });
    } catch {
      try {
        await this.element.requestPointerLock();
      } catch {
        /* the user will be asked again from the panel */
      }
    }
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  clear() {
    this.keys.clear();
    this.dx = this.dy = 0;
    this.dragging = false;
  }

  consumeMouse() {
    const r = { x: this.dx, y: this.dy };
    this.dx = this.dy = 0;
    return r;
  }

  axis() {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    return { forward: f, strafe: s, run: k.has('ShiftLeft') || k.has('ShiftRight') };
  }
}
