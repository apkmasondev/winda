import type { Lang } from '../ui/i18n';

/**
 * The inspection log. Every lift carries a card of its inspections; this one's
 * entries are left on brass plates in places no building has. Same hand,
 * ninety-five years apart. The last one is dated the day you read it.
 *
 * Polish copy avoids gendered first-person past forms on purpose: nobody in
 * this story has a name or a face.
 */
export type EntryId = 'card' | 'landing' | 'gate' | 'steps' | 'slit' | 'stairs' | 'alcove' | 'summit';

export type Entry = {
  id: EntryId;
  floor: string;
  /** day, month (1-12), year - or null for "today" */
  date: [number, number, number] | null;
  text: Record<Lang, string>;
};

export const ENTRIES: Entry[] = [
  {
    id: 'card',
    floor: '0',
    date: null,
    text: {
      pl: 'Dźwig osobowy nr 0. Udźwig: jedna osoba. Przystanki: 0 i −9.\nUwaga: przystanku −9 nie ma w projekcie budynku.\nPrzeglądy: 1931, 1957, 1979, 1994, 2009, 2023 — wszystkie tym samym charakterem pisma.',
      en: 'Passenger lift no. 0. Capacity: one person. Stops: 0 and −9.\nNote: stop −9 does not appear in the building plans.\nInspections: 1931, 1957, 1979, 1994, 2009, 2023 — all in the same handwriting.',
    },
  },
  {
    id: 'landing',
    floor: '−9',
    date: [12, 3, 1931],
    text: {
      pl: 'Zjazd na −9. Hala jest większa niż budynek nad nią. Lina i hamulce w normie. Nikt tu nie czeka, a światła są zapalone.',
      en: 'Descent to −9. The hall is larger than the building above it. Rope and brakes within norms. Nobody waits here, yet the lights are on.',
    },
  },
  {
    id: 'gate',
    floor: '−9',
    date: [4, 10, 1957],
    text: {
      pl: 'Most nie prowadzi nad niczym. Pion z obciążnikiem: sto metrów sznurka, dna brak. Zalecenie: nie upuszczać kluczy.',
      en: 'The bridge crosses nothing. Plumb line: a hundred metres of cord, no bottom. Recommendation: do not drop the keys.',
    },
  },
  {
    id: 'steps',
    floor: '−9',
    date: [21, 6, 1979],
    text: {
      pl: 'Stopnie wiszą w powietrzu. Każdy leży dokładnie tam, gdzie stawia się stopę — jakby ktoś znał ten krok na pamięć.',
      en: 'The steps hang in the air. Each lies exactly where the foot comes down — as if someone knew this stride by heart.',
    },
  },
  {
    id: 'slit',
    floor: '−9',
    date: [2, 2, 1994],
    text: {
      pl: 'Szczelina oddycha: ciepły wydech, jak z szybu. To nie wiatr. To winda jedzie gdzieś głęboko pod spodem.',
      en: 'The slit breathes: a warm exhale, like a shaft. It is not the wind. It is a lift running somewhere far below.',
    },
  },
  {
    id: 'stairs',
    floor: '−9',
    date: [17, 11, 2009],
    text: {
      pl: 'Klatka schodowa. Nie liczyć pięter — schody liczą lepiej. Kto się zgubi, niech idzie dalej. Winda przyjedzie sama.',
      en: 'Stairwell. Do not count the floors — the stairs count better. Whoever gets lost should keep walking. The lift will come on its own.',
    },
  },
  {
    id: 'alcove',
    floor: '−∞',
    date: [30, 9, 2023],
    text: {
      pl: 'Tu staje winda, choć nie ma szybu. Drzwi, oświetlenie, przycisk alarmowy — sprawne. Przycisk „w górę” jedzie wyżej niż dach.',
      en: 'The lift stops here, though there is no shaft. Doors, lighting, alarm button — working. The “up” button goes higher than the roof.',
    },
  },
  {
    id: 'summit',
    floor: '0',
    date: null,
    text: {
      pl: 'Ostatni wpis. Nad budynkiem nie ma dachu i nigdy nie było. Sprawdzam to od prawie stu lat i za każdym razem niebo otwiera się jak drzwi. Klucze są już u ciebie.',
      en: 'Last entry. There is no roof above the building, and there never was. I have checked for almost a hundred years, and every time the sky opens like doors. The keys are already yours.',
    },
  },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** inspection-log style: 12 III 1931 */
export function formatDate(d: [number, number, number] | null, now = new Date()) {
  const [day, month, year] = d ?? [now.getDate(), now.getMonth() + 1, now.getFullYear()];
  return `${day} ${ROMAN[month - 1]} ${year}`;
}

export const entryById = (id: EntryId) => ENTRIES.find((e) => e.id === id)!;
