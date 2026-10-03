import { ENTRIES, type EntryId } from '../story/entries';

/** What the viewer has reached and read. Lives in localStorage; never required. */
const KEY = 'the-elevator:progress';

export const CHAPTERS = ['descent', 'hall', 'slit', 'stairwell', 'summit'] as const;
export type Chapter = (typeof CHAPTERS)[number];

export type Progress = {
  /** highest chapter index ever reached (unlocks the floor buttons) */
  reached: number;
  /** chapter of the most recent run, for "continue" */
  last: number;
  found: EntryId[];
  finished: boolean;
};

const fresh = (): Progress => ({ reached: 0, last: 0, found: [], finished: false });

export function loadProgress(): Progress {
  const p = fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return p;
    const s = JSON.parse(raw) as Partial<Progress>;
    const idx = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(CHAPTERS.length - 1, Math.max(0, Math.round(v))) : 0);
    p.reached = idx(s.reached);
    p.last = Math.min(p.reached, idx(s.last));
    const ids = new Set(ENTRIES.map((e) => e.id));
    if (Array.isArray(s.found)) p.found = [...new Set(s.found.filter((id): id is EntryId => ids.has(id as EntryId)))];
    p.finished = s.finished === true;
  } catch {
    /* ignore */
  }
  return p;
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
