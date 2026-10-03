import { CHAPTERS, type Progress } from '../core/Progress';
import type { Settings } from '../core/Settings';
import { ledSvg } from '../render/Led';
import { ENTRIES, formatDate, type Entry } from '../story/entries';
import { lang, onLang, t, type StringKey } from './i18n';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

type Page = 'main' | 'pause' | 'floors' | 'log' | 'settings';
export type MenuMode = 'main' | 'pause' | 'hidden';
export type SettingKey = 'sound' | 'look' | 'motion' | 'lang';

const ICON = {
  descend: '<path d="M7 9 H17 L12 16 Z" />',
  doors: '<path d="M9 6 L4 12 L9 18 M15 6 L20 12 L15 18" />',
  floors: '<path d="M6 7 H18 M6 12 H18 M6 17 H18" />',
  log: '<path d="M7 4 H17 V20 H7 Z M9.5 8.5 H14.5 M9.5 12 H14.5 M9.5 15.5 H13" />',
  settings: '<path d="M5 8 H19 M5 16 H19" /><circle cx="9" cy="8" r="2" /><circle cx="15" cy="16" r="2" />',
  back: '<path d="M14 6 L8 12 L14 18" />',
  sound: '<path d="M5 10 H8 L12 6 V18 L8 14 H5 Z M15 9 Q17.5 12 15 15" />',
  look: '<circle cx="12" cy="12" r="3" /><path d="M3 12 Q12 4 21 12 Q12 20 3 12 Z" />',
  motion: '<path d="M3 12 Q7.5 6 12 12 T21 12" />',
};
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

/**
 * Everything on top of the world: the operating panel (main menu, pause and
 * their pages), a whispered hint, the text of a plate being read, the end.
 */
export class UI {
  readonly menuEl = $('#menu');
  readonly hint = $<HTMLParagraphElement>('#hint');
  readonly end = $('#end');
  private led = $('#led');
  private sheet = $('#sheet');
  private reader = $('#reader');
  private pages = new Map<Page, HTMLElement>();
  private page: Page = 'main';
  private root: Page = 'main';
  private hintRemaining = 0;
  private loaded = false;
  private settings!: Settings;
  private progress!: Progress;
  private mode: MenuMode = 'main';

  onDescend: () => void = () => {};
  onContinue: () => void = () => {};
  onChapter: (index: number) => void = () => {};
  onResume: () => void = () => {};
  onGroundFloor: () => void = () => {};
  onAgain: () => void = () => {};
  onSetting: (key: SettingKey) => void = () => {};

  constructor() {
    document.querySelectorAll<HTMLElement>('.layer').forEach((el) => {
      el.inert = !el.classList.contains('is-visible');
    });
    document.querySelectorAll<HTMLElement>('.page').forEach((el) => this.pages.set(el.dataset.page as Page, el));
    this.go('main');
    this.led.innerHTML = ledSvg('  ');
    onLang(() => {
      if (this.progress) this.build();
      this.menuEl.setAttribute('aria-label', this.mode === 'pause' ? t('paused') : 'The Elevator');
    });
  }

  bind(settings: Settings, progress: Progress) {
    this.settings = settings;
    this.progress = progress;
    this.build();
  }

  // ---------------------------------------------------------------- loading

  /** the indicator counts down as the world arrives */
  setProgress(p: number) {
    if (this.loaded) return;
    const floor = Math.round(Math.min(1, Math.max(0, p)) * 9);
    this.led.innerHTML = ledSvg(floor === 0 ? '0' : `-${floor}`);
  }

  ready() {
    this.loaded = true;
    this.led.innerHTML = ledSvg('0');
    this.build();
    if (this.mode === 'main') this.focusFirst();
  }

  // ---------------------------------------------------------------- menu

  menu(mode: MenuMode) {
    this.mode = mode;
    if (mode === 'hidden') {
      this.show(this.menuEl, false);
      return;
    }
    this.menuEl.dataset.mode = mode;
    this.menuEl.setAttribute('aria-label', mode === 'pause' ? t('paused') : 'The Elevator');
    this.root = mode;
    this.build();
    this.go(mode);
    if (mode === 'main') this.led.innerHTML = ledSvg(this.loaded ? '0' : '  ');
    this.show(this.menuEl, true);
    this.focusFirst();
  }

  /** Escape inside the panel: one page back. Returns false at the root. */
  back() {
    if (this.mode === 'hidden' || this.page === this.root) return false;
    this.go(this.root);
    this.focusFirst();
    return true;
  }

  setFloor(text: string) {
    this.led.innerHTML = ledSvg(text);
  }

  private go(page: Page) {
    this.page = page;
    this.menuEl.dataset.page = page;
    for (const [name, el] of this.pages) el.hidden = name !== page;
    if (page !== 'log') this.sheet.classList.remove('is-visible');
  }

  private focusFirst() {
    requestAnimationFrame(() => this.pages.get(this.page)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true }));
  }

  private build() {
    if (!this.progress) return;
    const p = this.progress;
    const s = this.settings;
    const ready = this.loaded;
    // rebuilding replaces the buttons: remember which one had focus
    const current = this.pages.get(this.page)!;
    const focusIndex = current.contains(document.activeElement) ? [...current.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement) : -1;

    // main
    const main: HTMLElement[] = [this.key(ICON.descend, 'descend', () => this.onDescend(), !ready)];
    if (p.last > 0) {
      const k = this.key(ICON.doors, 'continue', () => this.onContinue(), !ready);
      k.append(this.span('sub', t(`ch.${CHAPTERS[p.last]}` as StringKey)));
      main.push(k);
    }
    if (p.reached > 0) main.push(this.key(ICON.floors, 'floors', () => this.open('floors'), !ready));
    if (p.found.length > 0) main.push(this.key(ICON.log, 'log', () => this.open('log'), !ready));
    main.push(this.key(ICON.settings, 'settings', () => this.open('settings'), !ready));
    this.fill('main', main);

    // pause
    this.fill('pause', [
      this.key(ICON.doors, 'resume', () => this.onResume()),
      this.key(ICON.log, 'log', () => this.open('log')),
      this.key(ICON.settings, 'settings', () => this.open('settings')),
      this.key(null, 'groundFloor', () => this.onGroundFloor(), false, '0'),
    ]);

    // floors: one button per chapter, lit once reached
    this.fill('floors', [
      ...CHAPTERS.map((c, i) => this.key(null, `ch.${c}` as StringKey, () => this.onChapter(i), i > p.reached, ROMAN[i])),
      this.backKey(),
    ]);

    // log: the inspection card, one line per entry
    const rows = ENTRIES.map((e) => {
      const found = p.found.includes(e.id);
      const k = this.key(null, null, () => this.showSheet(e), !found, e.floor);
      k.querySelector('.label')!.textContent = found ? formatDate(e.date) : t('unread');
      if (found) {
        k.addEventListener('focus', () => this.showSheet(e));
        k.addEventListener('mouseenter', () => this.showSheet(e));
      }
      return k;
    });
    const title = this.span('page-title', t('logTitle'));
    const log: HTMLElement[] = [title, ...rows, this.backKey()];
    if (p.found.length === 0) log.splice(1, 0, this.span('page-note', t('logEmpty')));
    this.fill('log', log);

    // settings
    const pipKey = (icon: string, label: StringKey, key: 'sound' | 'look' | 'motion') => {
      const k = this.key(icon, label, () => {
        this.onSetting(key);
        this.setPips(k, label, s[key]);
      });
      this.setPips(k, label, s[key]);
      return k;
    };
    const langKey = this.key(null, 'language', () => this.onSetting('lang'), false, lang().toUpperCase());
    this.fill('settings', [
      pipKey(ICON.sound, 'sound', 'sound'),
      pipKey(ICON.look, 'look', 'look'),
      pipKey(ICON.motion, 'motion', 'motion'),
      langKey,
      this.backKey(),
    ]);

    if (focusIndex >= 0) current.querySelectorAll<HTMLButtonElement>('button')[focusIndex]?.focus({ preventScroll: true });
  }

  private open(page: Page) {
    this.go(page);
    this.focusFirst();
  }

  private showSheet(e: Entry) {
    $('#sheet-floor').textContent = e.floor;
    $('#sheet-date').textContent = formatDate(e.date);
    $('#sheet-body').textContent = e.text[lang()];
    this.sheet.classList.add('is-visible');
  }

  private fill(page: Page, children: HTMLElement[]) {
    const el = this.pages.get(page)!;
    el.replaceChildren(...children);
  }

  private span(cls: string, text: string) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  private backKey() {
    const k = this.key(ICON.back, 'back', () => this.back());
    k.classList.add('is-back');
    return k;
  }

  private key(icon: string | null, label: StringKey | null, action: () => void, disabled = false, glyph?: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key';
    b.disabled = disabled;
    const lens = document.createElement('span');
    lens.className = 'lens';
    if (icon) lens.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
    else lens.append(this.span('glyph', glyph ?? ''));
    const l = this.span('label', label ? t(label) : '');
    b.append(lens, l);
    b.addEventListener('click', () => {
      if (!b.disabled) action();
    });
    return b;
  }

  private setPips(k: HTMLElement, label: StringKey, level: number) {
    let pips = k.querySelector('.pips');
    if (!pips) {
      pips = document.createElement('span');
      pips.className = 'pips';
      k.append(pips);
    }
    pips.innerHTML = Array.from({ length: 5 }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
    k.setAttribute('aria-label', `${t(label)}: ${level} / 5`);
  }

  // ---------------------------------------------------------------- layers

  show(el: HTMLElement, on: boolean) {
    el.classList.toggle('is-visible', on);
    el.inert = !on;
    if (on) el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    else if (el.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
  }

  showEnd(found: number, total: number) {
    $('#end-inspection').textContent = t('endInspection', { date: formatDate(null) });
    $('#end-found').textContent = t('endFound', { n: found, total });
    $('#end-keys').replaceChildren(
      this.key(ICON.doors, 'again', () => this.onAgain()),
      this.key(null, 'groundFloor', () => this.onGroundFloor(), false, '0'),
    );
    this.show(this.end, true);
  }

  // ---------------------------------------------------------------- in the world

  /** the text of the plate being looked at */
  read(e: Entry, count: string) {
    $('#reader-floor').textContent = e.floor;
    $('#reader-date').textContent = formatDate(e.date);
    $('#reader-count').textContent = count;
    $('#reader-body').textContent = e.text[lang()];
    this.reader.classList.add('is-visible');
  }

  unread() {
    this.reader.classList.remove('is-visible');
  }

  get reading() {
    return this.reader.classList.contains('is-visible');
  }

  /** a quiet line at the bottom of the screen; html allowed for <b> */
  whisper(html: string, seconds = 0) {
    this.hint.innerHTML = html;
    this.hint.classList.add('is-visible');
    this.hintRemaining = seconds;
  }

  hush() {
    this.hintRemaining = 0;
    this.hint.classList.remove('is-visible');
  }

  update(dt: number) {
    if (this.hintRemaining <= 0) return;
    this.hintRemaining -= dt;
    if (this.hintRemaining <= 0) this.hush();
  }
}
