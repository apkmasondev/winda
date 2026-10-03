# The Elevator

Atmosferyczne doświadczenie 3D w przeglądarce. Zjazd windą prowadzi do ogromnej
hali, wiszących schodów i miejsc, których nie ma w projekcie budynku.
Tabliczki pozostawione przez konserwatora składają się na kartę przeglądów.

**[Uruchom grę](https://apkmason.dev/winda/)**

Gra wymaga komputera, klawiatury, myszy oraz przeglądarki obsługującej WebGL 2.
Polecane są słuchawki. Interfejs i wpisy są dostępne po polsku i po angielsku.
Postęp i ustawienia pozostają w lokalnej pamięci przeglądarki; aplikacja
nie wymaga konta, serwera aplikacyjnego ani kluczy API.

## Sterowanie

| Klawisz / działanie | Funkcja |
| --- | --- |
| Mysz | Rozglądanie się; kliknięcie przechwytuje kursor |
| W A S D / strzałki | Chodzenie |
| Shift | Szybszy krok |
| Esc | Pauza; w podstronie menu powrót |
| Spojrzenie na tabliczkę z bliska | Odczyt i zapis wpisu |

Menu pozwala kontynuować od zapisanego rozdziału, wybrać odblokowane piętro,
przejrzeć wpisy oraz ustawić głośność, czułość myszy, kołysanie i język.

## Praca lokalna

Wymagania: Git, Node.js 24 i npm. Gotowe zasoby gry są w repozytorium;
Blender, Python i FFmpeg nie są potrzebne do uruchomienia ani budowania.

```bash
git clone https://github.com/apkmasondev/winda.git
cd winda
npm ci
npm run dev
```

Serwer lokalny: `http://127.0.0.1:5173/`.

```bash
npm test           # regresje logiki, sterowania, audio i przejścia trasy
npm run typecheck  # kontrola TypeScript
npm run build      # kontrola TypeScript i build do dist/
npm run preview    # podgląd produkcyjny: http://127.0.0.1:4173/
npm run check:repo # kontrola plików znajdujących się w indeksie Git
```

## Zawartość repozytorium

- `src/` — kod TypeScript, style, sceny, dźwięk i interfejs.
- `public/` — gotowe modele, tekstury, intro, audio i manifest audio.
- `tests/` — testy regresji uruchamiane w Node.js.
- `tools/check-repository.mjs` — kontrola publikowanych plików i wzorców sekretów.
- `.github/workflows/pages.yml` — testowanie, budowanie i wdrażanie GitHub Pages.
- `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`,
  `vite.config.ts` — przenośne pliki wymagane do odtworzenia aplikacji.

Repozytorium nie zawiera lokalnych konfiguracji środowiska, plików `.env`,
tokenów, ustawień edytorów i asystentów, audytów, kopii zapasowych,
surowych nagrań ani materiałów produkcyjnych Blendera. `node_modules/` i `dist/`
są generowane lokalnie lub w CI i nie są wersjonowane.

`.gitignore` ogranicza pliki przeznaczone do publikacji. Kontrola repozytorium
sprawdza indeks Git, blokuje nieznane ścieżki, dowiązania symboliczne oraz
rozpoznawane wzorce danych dostępowych. Przy dodaniu nowego zasobu trzeba
zaktualizować listę w `.gitignore` i skrypcie kontrolnym.
Skan wzorców nie zastępuje przeglądu zmian przed wysłaniem.

## Publikacja

GitHub Pages korzysta z GitHub Actions. Każdy push do `main` uruchamia kontrolę
plików, instalację z lockfile, testy i build; dopiero udany build trafia na stronę.
Pull requesty przechodzą te same kontrole bez publikacji.
Można również ręcznie uruchomić workflow **Test and publish**.

Wdrożenie używa automatycznych uprawnień GitHuba; nie wymaga własnego tokena
ani sekretów w repozytorium. Publikowany jest wyłącznie katalog `dist/`.
Względne ścieżki Vite pozwalają uruchamiać stronę pod `/winda/`.

## Rozwój i cofanie zmian

Tag `v1.0.0` oznacza pierwszy opublikowany punkt odniesienia.
Nową zmianę najlepiej rozwijać na osobnej gałęzi:

```bash
git switch -c feature/nazwa-zmiany
# wprowadź zmiany i dodaj wybrane pliki przez git add
npm run check:repo
npm test
npm run build
git commit -m "Opis zmiany"
git push -u origin feature/nazwa-zmiany
```

Po przeglądzie i połączeniu pull requesta z `main` strona aktualizuje się
automatycznie. Aby cofnąć pojedynczy zwykły commit na `main` bez usuwania historii:

```bash
git switch main
git pull --ff-only
git revert IDENTYFIKATOR_COMMITA
git push origin main
```

Powstaje nowy commit odwracający zmianę, a CI ponownie testuje i publikuje projekt.
Cofanie merge commitów wymaga wskazania właściwego rodzica; nie używaj do tego
przykładu bez sprawdzenia historii. Unikaj `push --force` na `main`.

## Technologia i materiały

Three.js, TypeScript, Vite, `postprocessing`, `three-mesh-bvh` oraz Web Audio.
Modele i tekstury przygotowano dla projektu; tła muzyczne powstały z klipów
wygenerowanych w Suno. Intro i nagrane efekty pochodzą z materiałów projektu.
Repozytorium przechowuje gotowe zasoby używane przez grę, nie ich pliki źródłowe.
Licencje zależności pozostają określone przez ich autorów.
