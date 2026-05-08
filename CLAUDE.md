# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static-frontend GeoGuessr clone served by a tiny Express app. **All game logic runs in the browser** — the server only exists because some browsers/tools reject `file://` for fetch and the Mapillary CDN. There is no backend persistence, auth, leaderboard, or multiplayer.

This repo is co-worked with `purplethunder715` (the source/owner). Both work directly out of `master` — no PR workflow for now (small project, low coordination cost).

## Commands

```bash
npm install        # one-time
npm start          # node server.js  →  http://localhost:3000
npm test           # unit tests (plain-node assertions, no framework)
npm run test:e2e   # Playwright e2e tests with mocked Mapillary
npm run test:all   # both
npm run lint       # eslint + prettier --check (read-only)
npm run lint:fix   # eslint --fix + prettier --write
```

`npm test` runs a single file ([tests/test.js](tests/test.js)). To run a subset of unit tests, comment out `group(...)` calls. For e2e, use `npx playwright test <pattern>` to run a single spec.

## Standing rule: 5 mandates per meaningful change

A "meaningful change" is anything that produces a code or config change, or a documented decision. Pure clarifying-question turns don't qualify.

The mandates run in order. Don't skip ahead — each step assumes the previous one passed. Don't add extra "safety" steps either: don't re-run tests after lint, don't pull before push. If `git push` is rejected because remote is ahead, deal with that conflict _then_ (which may reset the flow because there's new code to retest — that's fine).

### 1. CLAUDE.md is self-updating

If your change makes anything in this file stale or missing — new symbols, changed conventions, new gotchas, new files, the _why_ behind a decision — update this file **in the same session**. Don't defer to "next time".

### 2. Tests must pass

- Run `npm test` (unit) always — even for changes that don't touch test code, in case of regressions.
- For UI / DOM / state-machine changes in `game.js`, also run `npm run test:e2e` (Playwright with mocked Mapillary).
- **Prefer fixing the code over fixing the tests.** Only update tests when behavior intentionally changed.
- **Add tests** for new functionality _before_ re-running:
  - New pure helpers in [public/lib.js](public/lib.js) → matching `group(...)` block in [tests/test.js](tests/test.js).
  - New game-flow / UI behavior → matching spec in [tests/e2e/](tests/e2e/).
- **Never let e2e tests hit real Mapillary endpoints** — see [Mocking external APIs in e2e](#mocking-external-apis-in-e2e) below. Token quota is finite.

### 3. Local instance must be running

- `npm start` should be running on <http://localhost:3000> while iterating, so manual UI testing works.
- Static files in `public/` are served as-is — browser refresh shows changes. No rebuild needed.
- Before declaring a UI change done, verify in the browser. Type checking and tests verify _code correctness_, not _feature correctness_.
- If port 3000 isn't responding, restart with `npm start` (run in background).

### 4. Lint + format fixes

- After tests pass: `npm run lint:fix` (runs `eslint . --fix` then `prettier --write .`).
- No test re-run needed afterward — formatting/lint changes don't affect runtime behavior.
- If eslint reports unfixable errors, address them before moving on.

### 5. Commit + push

- Commit on `master` with a _why_-focused message (not "update files").
- `git push origin master`.
- The repo lives at <https://github.com/purplethunder715/geoguess-game>.
- **GitHub Actions runs the same gate as your local flow**
  ([.github/workflows/ci.yml](.github/workflows/ci.yml)): `npm run lint`,
  `npm test`, Playwright e2e on every push to master and every PR. A red CI
  run means something slipped through your local checks — investigate and
  fix forward in a follow-up commit. Watch runs at
  <https://github.com/purplethunder715/geoguess-game/actions>.
- Dependabot opens grouped weekly PRs for npm + github-actions updates
  ([.github/dependabot.yml](.github/dependabot.yml)). Treat them like any
  other PR — CI gates them automatically.

[public/config.js](public/config.js) stays out of every commit (see [Secrets](#secrets--publicconfigjs) below).

## Architecture in two paragraphs

The game is a four-screen state machine in [public/game.js](public/game.js) (start → game → result → end), driven by direct DOM manipulation and a single `state` object. Each round queries Mapillary's Graph API for a panorama near a curated city center ([public/locations.js](public/locations.js)), drops the player into the Mapillary viewer, lets them place a pin on a Leaflet map (Esri satellite + labels overlays), and scores by Haversine distance from the guess to the **actual photo coords** — not the city center, since they may differ by hundreds of meters.

The non-obvious bit: **prefetching is continuous and infinite-retry**. `primeRoundQueue` seeds the pool with `(remaining + POOL_BUFFER)` lookups; `ensurePoolFull` is called after every round consumed AND after every individual pool task resolves/rejects so the search density stays at full POOL_BUFFER while the user plays. Each `prepareRound` fires `PARALLEL_ATTEMPTS` (3) location lookups in parallel via `Promise.any` and **retries forever** — coverage misses (no panos at this random spot) never surface to the user. The only error path is "Mapillary unreachable", surfaced after `MAX_CONSECUTIVE_HTTP_BATCHES` (20) consecutive batches of pure HTTP/network failure (a coverage miss resets the counter). When that counter is incrementing we **back off exponentially** between batches (`BACKOFF_BASE_MS = 1500`, doubles each batch, capped at `BACKOFF_MAX_MS = 30000`) so a Mapillary throttle window can expire instead of being prolonged by our retries. `state.gameRunning` is the kill switch flipped by `resetGame` and `endGame` so background loops exit cleanly when the game ends.

**Hard-learned tuning constraint**: the bottleneck is **Mapillary's free-tier rate limit, not the user's machine**. An earlier version had `PARALLEL_ATTEMPTS=8 + POOL_BUFFER=10` (≥80 simultaneous requests) and Mapillary started 500ing every call within seconds — which the browser surfaces as "blocked by CORS policy" because Mapillary's 5xx responses don't include CORS headers. Don't crank these constants past PARALLEL_ATTEMPTS=4 / POOL_BUFFER=4 even when the user asks for max parallelism. The user's CPU/RAM/GPU/bandwidth is irrelevant; the limit lives on Mapillary's edge. Each individual lookup is a single Mapillary Graph API call with `is_pano=true` inside a fixed `SEARCH_DELTA_DEG` (0.04° ≈ 4 km) bbox, with a `FETCH_TIMEOUT_MS` (5 s) AbortController so a slow API can't hang the prefetch. **Two hard requirements on every spawn**:

1. **Look-around**: only `is_pano=true` results — never flat dashcam images.
2. **Walkable**: only panoramas whose sequence has ≥`MIN_SEQUENCE_SIZE` (4) other panos in the same bbox, guaranteeing at least 3 navigation arrows worth of motion. Isolated panos are filtered out in `pickAndExtractCoords` even if they're the only ones returned.

Locations that fail either check return `null` from `findMapillaryImage`, and the caller (`prepareRound`'s parallel-attempts loop) picks a different spot. The thumbnail URL is preloaded via `preloadImage()` once a round resolves so the browser already has it cached when the viewer renders. If the Mapillary viewer's `moveTo()` rejects (bad image ID, internal corruption), `showImageInViewer` tears the viewer down and rebuilds — without that, the player gets stuck on the previous round's panorama.

Locations come from two sources, blended in `pickRandomLocation` with `CURATED_PROBABILITY` (0.4): a hand-picked list of ~100 well-covered cities (`CURATED_LOCATIONS`) and procedurally-generated random points inside country bounding boxes (`REGIONS`). The procedural side gives an effectively unlimited pool while keeping picks inside Mapillary-friendly areas.

## Where things live

Symbol names are stable anchors — Ctrl+F or Grep them in the listed file. Avoiding line numbers because they shift with every edit.

### Game lifecycle — [public/game.js](public/game.js)

- `ROUNDS_PER_GAME`, `ROUND_SECONDS`, `TOKEN_STORAGE` — round / timer / storage-key constants
- `SEARCH_DELTA_DEG` — fixed 0.04° (~4 km) bbox half-size for Mapillary lookups
- `FETCH_TIMEOUT_MS` — 5 s per-fetch AbortController timeout
- `PARALLEL_ATTEMPTS` (3), `POOL_BUFFER` (3) — prefetch concurrency knobs. **Read the "Hard-learned tuning constraint" architecture paragraph before changing — Mapillary's free-tier rate limit, not the user's machine, is the bottleneck**
- `MAX_CONSECUTIVE_HTTP_BATCHES` (20) — abort threshold; coverage misses reset, only HTTP / network failures count
- `BACKOFF_BASE_MS` (1500), `BACKOFF_MAX_MS` (30000) — exponential backoff between HTTP-failure batches
- `MIN_SEQUENCE_SIZE` (4) — minimum panos-per-sequence for the "walkable" check (≥3 navigation arrows)
- `DEMO_ROUNDS` — 5 hardcoded `{ lat, lng, name, hint }` famous-landmark entries used by guest/demo mode in lieu of real Mapillary data; powers the full gameplay flow without API calls. Hints are evocative but **must not contain the city or country name** — that would defeat the guessing
- `CURATED_PROBABILITY` (0.4) — chance of picking from `CURATED_LOCATIONS` vs. region-random
- `SATELLITE_TILES`, `LABELS_TILES` — Esri tile URL templates
- `state` — global game state (round, score, viewer, both maps, `roundPool`, `usedIndices`, `gameRunning` kill switch, `guestMode` flag)
- `showScreen(name)` — swap visible screen
- `pickFromCurated()` — pick from `CURATED_LOCATIONS` with no-repeat tracking via `state.usedIndices`
- `pickFromRegions()` — generate a random `{ lat, lng, name: "Somewhere in <country>" }` inside a `REGIONS` bbox
- `pickRandomLocation()` — router: rolls `CURATED_PROBABILITY` and dispatches to one of the above
- `startRound()` — increments round, defers map init via `setTimeout(..., 50)`. In `guestMode`, pulls `DEMO_ROUNDS[round-1]` into `state.currentLocation` / `state.actualPoint` (skipping Mapillary and the prefetch pool entirely) and shows the demo placeholder over the panorama area. Timer + scoring + result + end all run the normal flow
- `submitGuess(timedOut)` — Haversine + score, drives result screen
- `showResult(distance, points, timedOut)` — markers, dashed line, `fitBounds`
- `endGame()` — flips `gameRunning` off (background prefetch loops bail), shows final score + rating bucket
- `resetGame()` — flips `gameRunning` off **before** clearing state, so in-flight `prepareRound` loops exit on their next iteration. Also clears `guestMode`, hides the guest placeholder, restores the timer HUD slot

### Mapillary integration — [public/game.js](public/game.js)

- `resolveToken()` — config.js → localStorage → input
- `mapillaryQuery(lat, lng, token, panoOnly)` — single Graph API call with AbortController timeout. Requests `id, geometry, computed_geometry, thumb_1024_url, sequence`; `limit=50` to leave headroom for the sequence-grouping filter
- `findMapillaryImage(lat, lng, token)` — pano-only query, **no flat-image fallback** (deliberate: flat dashcam frames make a frozen-photo round). Returns `null` if no walkable sequence here, letting the caller pick a different spot
- `pickAndExtractCoords(imgs)` — groups by `sequence`, keeps only sequences with `≥MIN_SEQUENCE_SIZE` panos in the bbox, picks a random pano from a random walkable sequence. Returns `{ id, lat, lng, thumbUrl }` or `null`
- `preloadImage(url)` — fires-and-forgets a background `new Image()` load to warm the browser cache before the viewer renders
- `showImageInViewer(imageId, token)` — creates a fresh viewer or `moveTo()`; on `moveTo` rejection, tears the viewer down and rebuilds via the inner `create()` closure
- `attemptOneLocation(token)` — one location pick + `findMapillaryImage`; throws `"No imagery near <name>"` on coverage miss
- `isHttpFailure(err)` — classifies an error as HTTP/network (true: counts toward abort threshold) vs. coverage miss (false: doesn't count)
- `prepareRound(token)` — **infinite loop**: `Promise.any` over `PARALLEL_ATTEMPTS` parallel `attemptOneLocation`s. All-HTTP-failure batch → increment counter + exponential backoff; mixed batch (any coverage miss) → counter resets, immediate retry. Throws `"Mapillary API appears unreachable"` only after `MAX_CONSECUTIVE_HTTP_BATCHES` consecutive HTTP-only batches; throws `"Game ended"` if `state.gameRunning` flips false
- `createRoundPool(onSettled)` — race-based pool: `add(promise)` enqueues; `take()` returns the first-_resolved_ (not first-queued); `onSettled` fires after every task settle so the caller can top off. Eliminates "round 1 waits on a slow lookup while later prefetches already finished"
- `ensurePoolFull()` — keeps `(rounds remaining) + POOL_BUFFER` lookups in flight or ready. Called at game start, after every round consumed, and after every pool task settles
- `primeRoundQueue()` — flips `gameRunning` on, builds the pool, kicks off the initial `ensurePoolFull`
- `showPrefetchedRound()` — `await state.roundPool.take()`; 200 ms-debounced "Loading panorama..." overlay; calls `ensurePoolFull()` after consume to keep search density high. Only error path is "Mapillary unreachable" (shows rate-limit message + token suggestion)

### Maps (Leaflet) — [public/game.js](public/game.js)

- `buildSatelliteLayers(map)` — imagery + labels overlay; **labels must load second**
- `initGuessMap()` — click-to-pin, hover-resize handler with `invalidateSize`
- Result map (markers + dashed `polyline` + `fitBounds`) is built inline inside `showResult()`

### Timer — [public/game.js](public/game.js)

- `startTimer()` — counts down, auto-submits at 0
- `stopTimer()`

### Start screen wiring — [public/game.js](public/game.js)

End-of-file block under the comment `--- Start screen wiring ---`:

- `refreshStartButton()` — Start is **always enabled**; label is `"Start Game"` if a ≥10-char token is configured, else `"Start as guest"`
- `presetToken` pre-fill — copies any saved/preset token into the Settings input so the user sees what's configured
- `settingsToggle` click handler — toggles the `#settings-panel` (token entry + future per-user settings)
- `startBtn` click handler — saves typed token to localStorage if changed; if a token resolves, calls `primeRoundQueue` for a normal game; otherwise sets `state.guestMode = true` and skips prefetch. Always calls `startRound`
- `back-to-start-btn` (in the guest placeholder) — `resetGame` + back to start screen
- `guest-save-btn` (in the guest placeholder) — paste-then-save upgrade path: writes the typed token to localStorage, syncs the start-screen Settings input, then `resetGame` + `primeRoundQueue` + `startRound` for a normal game. Disabled until the input has 10+ chars
- `guess-btn`, `next-btn`, `restart-btn` listeners at file bottom

### Pure helpers — [public/lib.js](public/lib.js)

Reused by both the browser and Node tests via the dual-export shim at the bottom (CJS for tests, browser globals).

- `haversineDistance(lat1, lon1, lat2, lon2)` — km
- `calculateScore(km)` — `5000 * exp(-km/2000)`, rounded, ≥0
- `formatDistance(km)` — `"50 m"` under 1 km, else rounded km
- `ratingFor(totalScore)` — final-game bucket text

### Location dataset — [public/locations.js](public/locations.js)

- `CURATED_LOCATIONS` — hand-picked cities with strong Mapillary coverage; entries are `{ lat, lng, name: 'City, Country' }`. Recognizable names show on the result screen
- `REGIONS` — country-level bounding boxes; entries are `{ name, latMin, latMax, lngMin, lngMax }`. `pickFromRegions` samples uniformly inside; effectively unlimited variety
- `LOCATIONS = CURATED_LOCATIONS` — backwards-compat alias still consumed by [tests/test.js](tests/test.js) via the `new Function` shim
- **Excluded from Prettier** ([.prettierignore](.prettierignore)) — the aligned columns are intentional and trailing-zero stripping (`40.7580` → `40.758`) is unwanted

### Markup — [public/index.html](public/index.html)

- Four screens: `#start-screen`, `#game-screen`, `#result-screen`, `#end-screen`
- HUD: `#hud`, `#round-num`, `#score`, `#timer-hud`, `#timer`
- Start screen: `#timer-toggle`, `#start-btn`, `#settings-toggle`, `#settings-panel`, `#api-key-section`, `#api-key-input`
- Mini-map panel: `#map-panel`, `#guess-map`, `#guess-btn`
- Status overlay: `#streetview-status`
- Demo-mode placeholder: `#guest-placeholder`, `#demo-round-num`, `#demo-hint`, `#guest-token-input`, `#guest-save-btn`, `#back-to-start-btn` — overlays the panorama area when entering without a token; shows demo round indicator + textual hint (substitutes for the panorama) + in-place token entry so the user can upgrade without bouncing back to the start screen
- **Script load order** at bottom: `leaflet → mapillary → config → lib → locations → game` — do not reorder

### Styles — [public/style.css](public/style.css)

- `.screen` / `.hidden` — screen container + show/hide utility
- `.card` — start/result/end card visual
- `.link-btn` — link-styled `<button>` (used for `#settings-toggle`)
- `#hud`, `.hud-item` — top-left HUD
- `#map-panel`, `#map-panel:hover` — mini-map hover-to-expand (CSS transitions on `width`/`height` — paired with `invalidateSize` on `transitionend` in `initGuessMap`)
- `.result-card` — overlay on result screen
- `#mapillary-viewer`, `#result-map` — full-bleed canvases
- `#settings-panel` — collapsible token-entry panel below the Start button
- `#guest-placeholder` — full-bleed overlay on the panorama area in guest mode
- `.guest-token-form`, `#guest-token-input`, `#guest-save-btn` — inline token entry inside the placeholder (the upgrade path)

### Unit tests — [tests/test.js](tests/test.js)

- Top of file: `lib.js` `require` + `locations.js` load via a `new Function` shim that returns both `LOCATIONS` and `REGIONS` (locations.js declares them as browser-script `const`s with no module export)
- `group('haversineDistance', ...)` — zero, Paris↔London, NYC↔LA, antipodes, symmetry
- `group('calculateScore', ...)` — exact hit, monotonicity, ~1000km ≈ 3000pts, huge→0, null/NaN/negative
- `group('formatDistance', ...)` — sub-km, ≥1 km, null/undefined
- `group('ratingFor', ...)` — bucket boundary cases
- `group('LOCATIONS dataset', ...)` — shape, lat/lng ranges, no duplicate coords
- `group('REGIONS dataset', ...)` — shape, valid bbox ranges, latMin < latMax / lngMin < lngMax (inverted bboxes would generate points outside the named region)

### E2E tests — [tests/e2e/](tests/e2e/)

Playwright + Chromium. Server is auto-started via `webServer` config; pre-existing servers are reused.

- [tests/e2e/smoke.spec.js](tests/e2e/smoke.spec.js) — start-screen UX (Settings panel, token persistence) + the full guest/demo flow: round-1 single submit, full 5-round playthrough → end screen → restart, demo+timer combination, save-token upgrade button states
- [tests/e2e/game-flow.spec.js](tests/e2e/game-flow.spec.js) — token-mode flows with mocked Mapillary: Start → drop pin → Submit → result, timer-toggle HUD, guest-saves-token-mid-demo upgrade
- [playwright.config.mjs](playwright.config.mjs) — chromium-only, headless, `reuseExistingServer: true`

### Server — [server.js](server.js)

- Express app, serves `public/` on port 3000. No routes, no API. Don't add any without a clear reason.

### Tooling config

- [eslint.config.mjs](eslint.config.mjs) — flat config, browser globals for `public/`, node globals for `server.js`/`tests/`. Per-file globals match the script-load layout (`game.js` consumes globals defined by `lib.js` / `locations.js` / `config.js`).
- [.prettierrc.json](.prettierrc.json) — single quotes, semis, 2-space, trailing commas, 90-char width
- [.prettierignore](.prettierignore) — excludes `node_modules/`, `package-lock.json`, `public/config.js` (gitignored), `public/locations.js` (alignment is intentional)
- [playwright.config.mjs](playwright.config.mjs) — chromium-only e2e runner; auto-starts/reuses `npm start` on port 3000

## Mocking external APIs in e2e

**Hard rule: e2e tests must never reach real Mapillary or Esri endpoints.** The Mapillary token has a finite quota and Esri is shared infrastructure. The reusable mock helper lives in [tests/e2e/game-flow.spec.js](tests/e2e/game-flow.spec.js) (`mockExternalsAndStubViewer`); copy or factor it out when adding new e2e tests that hit the game screen.

What it does, and why each piece is needed:

- **`page.route('**/graph.mapillary.com/**', ...)`** — returns a fake pano (Paris coords) for every Graph API request. Without this, `findMapillaryImage` would hit live Mapillary.
- **`page.route('**/unpkg.com/mapillary-js@**', ...)`** — blocks the Mapillary JS SDK (and its CSS). Necessary because we provide our own stub `window.mapillary.Viewer`; loading the real SDK would overwrite it.
- **`page.route('**/server.arcgisonline.com/**', ...)`** — blocks Esri tile requests. Leaflet still handles clicks without tiles, so the test works fine — and we save Esri the bandwidth.
- **`page.addInitScript(() => { window.mapillary = { Viewer: ... } })`** — installs a no-op stub _before_ any page script runs. The stub satisfies `new mapillary.Viewer(...)`, `viewer.moveTo()`, `viewer.remove()` so `showImageInViewer` works without trying to render.
- **`localStorage.setItem('geoguess.mapillaryToken', ...)`** — pre-sets a fake token via `addInitScript`, skipping the start-screen input.

When adding new e2e tests, prefer reusing the helper. If you need a different mock response (e.g., empty-data path, error path), customize within the test rather than mutating the helper.

## Conventions

- **Pure logic in [public/lib.js](public/lib.js).** Has a CJS export shim so tests can `require()` it and the browser uses it as globals. New pure helpers go here.
- **`game.js` owns DOM + state.** Depends on `lib.js` and `locations.js`; never the reverse.
- **Defer Leaflet/Mapillary init** until after `showScreen()` _plus_ a `setTimeout(..., 50)` — both libraries need a sized, visible container or they render blank/grey. See pattern in `startRound` and `showResult`.
- **No location repeats within a game** — `state.usedIndices` enforces this in `pickRandomLocation`.
- **Comments**: explain _why_, not _what_.
- **No test framework.** Don't add Jest/Mocha just to bump the count; for a project this size the cost isn't worth it.

## Adding more locations

**A curated city**: append `{ lat, lng, name: 'City, Country' }` to `CURATED_LOCATIONS` in [public/locations.js](public/locations.js). Pick spots with known Mapillary coverage (major cities NA/EU/JP/AU are reliable; sparser elsewhere). Tests check lat/lng ranges and coord uniqueness against the `LOCATIONS` alias.

**A new region** (country bbox): append `{ name, latMin, latMax, lngMin, lngMax }` to `REGIONS`. Keep the bbox to land area only — `pickFromRegions` samples uniformly inside, so all-water or pure-desert bboxes burn batch attempts on guaranteed coverage misses (the infinite-retry loop handles this gracefully but it wastes API calls).

## Guest / demo mode (no token)

The Mapillary token is **not gating** — the user can click Start at any time. With no token configured (`resolveToken()` returns `''`), the click handler sets `state.guestMode = true`, skips `primeRoundQueue` entirely (no Graph API calls, no pool), and routes through the **demo path** in `startRound`.

The demo path uses `DEMO_ROUNDS` (5 hardcoded famous landmarks) in place of prefetched Mapillary results. `state.currentLocation` and `state.actualPoint` get populated from `DEMO_ROUNDS[round-1]`, so **the production code path runs end-to-end**:

- The guess map renders normally (Esri tiles still work — Leaflet doesn't need a token).
- The timer runs if the user enabled it on the start screen.
- Submit enables after a pin drop, just like a real round.
- Haversine scoring runs against the canned coordinates.
- The result screen shows actual-vs-guess markers + dashed line + distance.
- Round counter increments, end screen reaches `ratingFor(state.score)`.

The only thing missing is the actual panorama — the Mapillary SDK requires a real token, so the panorama area stays a placeholder card showing "Demo round X of 5", a textual hint that substitutes for the visual clues a panorama would give (`#demo-hint`, populated from `DEMO_ROUNDS[round-1].hint`), and the upgrade prompt.

The placeholder offers two exits:

- **`#guest-save-btn` ("Save & play for real")** — the upgrade path. Paste a token into `#guest-token-input` (button enables at ≥10 chars), click Save: writes to localStorage, syncs the start-screen Settings input, calls `resetGame` + `primeRoundQueue` + `startRound`. Mid-demo progress is reset; the user starts fresh at round 1 with real panoramas.
- **`#back-to-start-btn`** — `resetGame` + back to start screen.

Two equivalent token-entry points exist (start-screen Settings panel + in-place demo form); both write the same localStorage key and `apiKeyInput.value` is kept in sync between them.

Future per-user auth (eventually) will populate the token via login, replacing the localStorage path. Don't add new gating UX in front of Start — demo gameplay is the contract.

## Token resolution order

In `resolveToken()`:

1. `MAPILLARY_TOKEN` global from [public/config.js](public/config.js) (preferred — auto path; gitignored).
2. `localStorage["geoguess.mapillaryToken"]` — populated by typing into the start screen.
3. Input field on the start screen (saved to localStorage on first start).

If 1 or 2 returns a token, the start-screen input is hidden so the flow is just "Start Game".

## Secrets — `public/config.js`

[public/config.js](public/config.js) holds a personal Mapillary access token. It is in [.gitignore](.gitignore) and **must stay out of every commit, push, PR, gist, paste, or upload** unless the user has _explicitly_ said "yes, include the token". The default answer is always _don't include it_.

Before any push or share:

- Confirm: `git check-ignore public/config.js`
- If somehow staged or committed: stop and tell the user _before_ pushing — do not silently push secrets.
- For teammates: suggest committing a `public/config.example.js` with an empty token; don't bake the real one into shared code.

Sharing a token with Claude in chat ≠ sharing publicly. The rule still applies.

## Common pitfalls

- **Script load order** in [public/index.html](public/index.html) is meaningful: `leaflet → mapillary → config → lib → locations → game`. Globals from earlier files are available in later ones; don't reorder casually.
- **Mapillary `moveTo()` rejections** are now caught and trigger a viewer rebuild in `showImageInViewer`. If a round still looks frozen, check the console for repeated rebuild warnings — that suggests a deeper problem (e.g. stale image IDs from a long-pending prefetch).
- **Mapillary coverage is patchier than Google Street View.** `prepareRound`'s infinite parallel-attempts loop exists because rural / region-random picks often come back empty — coverage misses don't surface as errors, just as another retry batch. Tight rural curated entries amplify this; prefer urban centers.
- **Esri tile order matters.** Labels overlay must be added _after_ imagery in `buildSatelliteLayers` or labels disappear behind imagery. If satellite goes blank, Esri may have rate-limited briefly.
- **Hover-to-expand map** needs `invalidateSize` on `transitionend` (in `initGuessMap`). Leaflet doesn't auto-detect container resize; without this the expanded half renders grey.
- **Bbox API rejects too-large queries.** `SEARCH_DELTA_DEG` is 0.04° as a balance: wide enough to find coverage in most cities, tight enough that Mapillary doesn't return "reduce the amount of data" in dense downtowns. If you increase it, expect the error in places like central Tokyo or Manhattan.
- **Slow Mapillary responses** would otherwise hang the prefetch — the `FETCH_TIMEOUT_MS` (5 s) abort + parallel-attempts loop ensure one slow city doesn't block the game. Sustained slow responses still trip `MAX_CONSECUTIVE_HTTP_BATCHES` (20) via `AbortError` (which `isHttpFailure` counts), surfacing the rate-limit message; that's the intended behavior.

## What this project is _not_

- No backend persistence, auth, or leaderboard.
- No multiplayer.
- No country-only or difficulty modes.

Listed as stretch goals in the original spec; intentionally not implemented.
