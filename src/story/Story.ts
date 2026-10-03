import * as THREE from 'three';
import type { App } from '../App';
import { CHAPTERS, saveProgress, type Chapter } from '../core/Progress';
import { onLang } from '../ui/i18n';
import { LAYOUT } from '../world/layout';
import { Plaques } from '../world/Plaques';
import { ENTRIES, entryById, type EntryId } from './entries';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** a glance is not reading: the plate has to hold the eye for a moment */
const SETTLE = 0.35;
const LINGER = 0.7;

/**
 * The narrative layer: where the plates are, what has been read, and how far
 * the viewer has come (for "continue" and the floor buttons).
 */
export class Story {
  readonly plaques = new Plaques();
  readonly total = ENTRIES.length;
  private candidate: EntryId | null = null;
  private held = 0;
  private reading: EntryId | null = null;
  private lost = 0;

  constructor(private readonly app: App) {
    const P = this.plaques;
    const b2 = LAYOUT.b2.y;
    // the same card hangs in every cabin: it is the same lift
    // (the arrival cabin's own light stays off: its card lives on the light spilling in)
    for (const e of [app.hall.arrival, app.stepwell.elevator, app.summit.elevator]) {
      P.add('card', 'card', e.group, V(-0.838, 1.42, 1.0), V(1, 0, 0), { ambient: e === app.hall.arrival ? 0.3 : 0 });
    }
    // beside the door the film arrived through
    P.add('landing', 'wall', app.hall.group, V(2.95, 1.45, -1.4), V(0, 0, -1));
    // inner face of the gate's left post, over nothing
    P.add('gate', 'wall', app.hall.group, V(-3.15, 1.45, -24), V(1, 0, 0));
    // set into the paving at the foot of the floating steps
    P.add('steps', 'floor', app.hall.group, V(0, b2, -87.5), V(0, 1, 0));
    // on the dark tower, left of the slit
    P.add('slit', 'wall', app.hall.group, V(-3.8, b2 + 1.45, LAYOUT.t2.zRecess), V(0, 0, 1));
    // facing the low passage where the stairwell begins
    // (the stepwell is lit by baked light only: the plates get their share)
    P.add('stairs', 'wall', app.stepwell.group, V(-25, 1.45, 9.5), V(0, 0, 1), { ambient: 1.6 });
    // on the landing where the lift will be
    P.add('alcove', 'wall', app.stepwell.group, V(11.0, -12 + 1.45, -13), V(0, 0, 1), { ambient: 0.8 });
    // the last one, on the lectern on the summit
    const l = app.summit.lectern;
    P.add('summit', 'lectern', app.summit.group, l.top, l.normal, { up: l.up });

    P.markRead(this.progress.found);
    onLang(() => {
      P.redraw();
      if (this.reading) this.show(this.reading, false);
    });
  }

  private get progress() {
    return this.app.progress;
  }

  get found() {
    return this.progress.found.length;
  }

  update(dt: number, time: number) {
    const id = this.plaques.update(dt, this.app.camera, time);
    if (id) {
      this.lost = 0;
      if (id !== this.candidate) {
        this.candidate = id;
        this.held = 0;
      }
      this.held += dt;
      if (this.held > SETTLE && this.reading !== id) this.open(id);
    } else {
      this.candidate = null;
      if (this.reading) {
        this.lost += dt;
        if (this.lost > LINGER) this.close();
      }
    }
  }

  /** stop reading (state changes, menus) without touching progress */
  close() {
    this.reading = null;
    this.candidate = null;
    this.app.ui.unread();
  }

  private open(id: EntryId) {
    const first = !this.progress.found.includes(id);
    if (first) {
      this.progress.found.push(id);
      saveProgress(this.progress);
      this.plaques.markRead(this.progress.found);
      this.app.audio.note(0.5);
    }
    this.reading = id;
    this.show(id, first);
  }

  private show(id: EntryId, first: boolean) {
    const index = ENTRIES.findIndex((e) => e.id === id) + 1;
    this.app.ui.hush();
    this.app.ui.read(entryById(id), first ? `${this.found} / ${this.total}` : `${index} / ${this.total}`);
  }

  /** record a chapter as reached: unlocks its floor button, becomes "continue" */
  reach(chapter: Chapter) {
    const i = CHAPTERS.indexOf(chapter);
    const p = this.progress;
    if (p.last === i && p.reached >= i) return;
    p.last = i;
    p.reached = Math.max(p.reached, i);
    saveProgress(p);
  }

  finish() {
    this.progress.finished = true;
    // a finished journey continues from the beginning
    this.progress.last = 0;
    saveProgress(this.progress);
  }
}
