/** A tiny cue list: functions fired once when the clock passes their time. */
export class Timeline {
  private cues: Array<{ t: number; fn: () => void }> = [];
  private generation = 0;
  time = 0;

  at(t: number, fn: () => void) {
    this.cues.push({ t, fn });
    this.cues.sort((a, b) => a.t - b.t);
    return this;
  }

  reset() {
    this.generation++;
    this.cues = [];
    this.time = 0;
  }

  update(dt: number) {
    if (dt <= 0) return;
    this.time += dt;
    const generation = this.generation;
    const due = this.cues.filter((c) => c.t <= this.time);
    this.cues = this.cues.filter((c) => c.t > this.time);
    for (const c of due) {
      if (generation !== this.generation) break;
      c.fn();
    }
  }
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
export const ramp = (t: number, t0: number, t1: number) => smooth((t - t0) / (t1 - t0));
