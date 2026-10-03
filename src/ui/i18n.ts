/** Two languages, plain dictionaries. The DOM carries data-i18n keys. */
export type Lang = 'pl' | 'en';

const STRINGS = {
  pl: {
    descend: 'zjazd',
    continue: 'kontynuuj',
    floors: 'piętra',
    log: 'karta',
    settings: 'ustawienia',
    back: 'wróć',
    resume: 'dalej',
    groundFloor: 'parter',
    sound: 'dźwięk',
    look: 'czułość',
    motion: 'kołysanie',
    language: 'język',
    headphones: 'słuchawki',
    again: 'jeszcze raz',
    logTitle: 'Karta przeglądów',
    logEmpty: 'Brak wpisów. Tabliczki czekają po drodze.',
    unread: '· · ·',
    'ch.descent': 'zjazd',
    'ch.hall': 'hala',
    'ch.slit': 'szczelina',
    'ch.stairwell': 'klatka',
    'ch.summit': 'szczyt',
    'hint.look': '<b>mysz</b> rozglądanie      <b>w a s d</b> chód',
    'hint.run': '<b>shift</b> szybciej',
    cardTitle: 'Karta przeglądów',
    endInspection: 'Przegląd {date}. Dźwig sprawny.',
    endNext: 'Następny przegląd: kiedy zechcesz.',
    endFound: 'wpisy {n} / {total}',
    unsupported: 'To doświadczenie wymaga WebGL 2 i przeglądarki na komputerze.',
    loadError: 'Coś poszło nie tak podczas ładowania. Odśwież stronę.',
    paused: 'Pauza',
  },
  en: {
    descend: 'descend',
    continue: 'continue',
    floors: 'floors',
    log: 'log',
    settings: 'settings',
    back: 'back',
    resume: 'continue',
    groundFloor: 'ground floor',
    sound: 'sound',
    look: 'look',
    motion: 'head bob',
    language: 'language',
    headphones: 'headphones',
    again: 'ride again',
    logTitle: 'Inspection log',
    logEmpty: 'No entries yet. The plates wait along the way.',
    unread: '· · ·',
    'ch.descent': 'descent',
    'ch.hall': 'the hall',
    'ch.slit': 'the slit',
    'ch.stairwell': 'the stairwell',
    'ch.summit': 'the summit',
    'hint.look': '<b>mouse</b> look      <b>w a s d</b> walk',
    'hint.run': '<b>shift</b> faster',
    cardTitle: 'Inspection card',
    endInspection: 'Inspection {date}. Lift in working order.',
    endNext: 'Next inspection: whenever you like.',
    endFound: 'entries {n} / {total}',
    unsupported: 'This experience needs WebGL 2 and a desktop browser.',
    loadError: 'Something went wrong while loading. Please reload.',
    paused: 'Paused',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['pl'];

let current: Lang = 'en';
const listeners = new Set<(lang: Lang) => void>();

export const defaultLang = (): Lang => {
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return nav.toLowerCase().startsWith('pl') ? 'pl' : 'en';
};

export const lang = () => current;

export function setLang(l: Lang) {
  current = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n as StringKey);
    });
  }
  for (const fn of listeners) fn(l);
}

export const onLang = (fn: (lang: Lang) => void) => listeners.add(fn);

export function t(key: StringKey, vars: Record<string, string | number> = {}) {
  let s: string = STRINGS[current][key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
