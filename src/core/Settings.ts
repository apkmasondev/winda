import { defaultLang, type Lang } from '../ui/i18n';

/** Per-viewer preferences. Storage can be unavailable (private mode) - never required. */
const KEY = 'the-elevator:settings';

export type Settings = { sound: number; look: number; motion: number; lang: Lang };

const level = (v: unknown, min: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(min, Math.round(v))) : fallback;

export function loadSettings(): Settings {
  const d: Settings = { sound: 4, look: 3, motion: 4, lang: defaultLang() };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      d.sound = level(s.sound, 0, d.sound);
      d.look = level(s.look, 1, d.look);
      d.motion = level(s.motion, 0, d.motion);
      if (s.lang === 'pl' || s.lang === 'en') d.lang = s.lang;
    }
  } catch {
    /* ignore */
  }
  return d;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export const soundGain = (level: number) => (level <= 0 ? 0 : Math.pow(level / 5, 1.6) * 1.0);
export const lookScale = (level: number) => [0.5, 0.7, 1.0, 1.35, 1.8][Math.min(5, Math.max(1, level)) - 1];
/** Additional camera motion: 0 (off) .. 1 (default, level 4) .. 1.25. */
export const motionScale = (level: number) => Math.min(5, Math.max(0, level)) * 0.25;
