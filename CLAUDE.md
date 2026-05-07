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
- `MAX_LOCATION_TRIES` — city-retry budget when Mapillary returns nothing
- `SATELLITE_TILES`, `LABELS_TILES` — Esri tile URL templates
- `state` — global game state (round, score, viewer, both maps, prefetch promises, used-indices)
- `showScreen(name)` — swap visible screen
- `pickRandomLocation()` — no-repeat picker via `state.usedIndices`
- `startRound()` — increments round, defers map init via `setTimeout(..., 50)`
- `submitGuess(timedOut)` — Haversine + score, drives result screen
- `showResult(distance, points, timedOut)` — markers, dashed line, `fitBounds`
- `endGame()` — final score + rating bucket
- `resetGame()` — clears state for "Play Again"

### Mapillary integration — [public/game.js](public/game.js)

- `resolveToken()` — config.js → localStorage → input
- `mapillaryQuery(lat, lng, token, panoOnly)` — single Graph API call with AbortController timeout
- `findMapillaryImage(lat, lng, token)` — pano-only query, falls back to any-image if empty (≤2 calls total)
- `pickAndExtractCoords(imgs)` — random pick + `geometry`/`computed_geometry` extraction
- `showImageInViewer(imageId, token)` — creates a fresh viewer or `moveTo()`; on `moveTo` rejection, tears the viewer down and rebuilds via the inner `create()` closure
- `prepareRound(token)` — one round's lookup + city-retry loop (up to `MAX_LOCATION_TRIES`)
- `primeRoundQueue()` — fires all 5 lookups in parallel at game start
- `showPrefetchedRound()` — consumes prefetch, 200ms-debounced loading overlay, live-fallback on prefetch error

### Maps (Leaflet) — [public/game.js](public/game.js)

- `buildSatelliteLayers(map)` — imagery + labels overlay; **labels must load second**
- `initGuessMap()` — click-to-pin, hover-resize handler with `invalidateSize`
- Result map (markers + dashed `polyline` + `fitBounds`) is built inline inside `showResult()`

### Timer — [public/game.js](public/game.js)

- `startTimer()` — counts down, auto-submits at 0
- `stopTimer()`

### Start screen wiring — [public/game.js](public/game.js)

End-of-file block under the comment `--- Start screen wiring ---`:

- `refreshStartButton()` — enables Start once a ≥10-char token is present (typed or preset)
- `presetToken` check — hides input section if a token is already available
- `startBtn` click handler — saves typed token to localStorage, calls `primeRoundQueue` then `startRound`
- `guess-btn`, `next-btn`, `restart-btn` listeners at file bottom

### Pure helpers — [public/lib.js](public/lib.js)

Reused by both the browser and Node tests via the dual-export shim at the bottom (CJS for tests, browser globals).

- `haversineDistance(lat1, lon1, lat2, lon2)` — km
- `calculateScore(km)` — `5000 * exp(-km/2000)`, rounded, ≥0
- `formatDistance(km)` — `"50 m"` under 1 km, else rounded km
- `ratingFor(totalScore)` — final-game bucket text

### Location dataset — [public/locations.js](public/locations.js)

- `LOCATIONS` — flat array of `{ lat, lng, name }` for major cities with known Mapillary coverage
- **Excluded from Prettier** ([.prettierignore](.prettierignore)) — the aligned columns are intentional and trailing-zero stripping (`40.7580` → `40.758`) is unwanted

### Markup — [public/index.html](public/index.html)

- Four screens: `#start-screen`, `#game-screen`, `#result-screen`, `#end-screen`
- HUD: `#hud`, `#round-num`, `#score`, `#timer-hud`, `#timer`
- Start screen: `#api-key-section`, `#api-key-input`, `#timer-toggle`, `#start-btn`
- Mini-map panel: `#map-panel`, `#guess-map`, `#guess-btn`
- Status overlay: `#streetview-status`
- **Script load order** at bottom: `leaflet → mapillary → config → lib → locations → game` — do not reorder

### Styles — [public/style.css](public/style.css)

- `.screen` / `.hidden` — screen container + show/hide utility
- `.card` — start/result/end card visual
- `#hud`, `.hud-item` — top-left HUD
- `#map-panel`, `#map-panel:hover` — mini-map hover-to-expand (CSS transitions on `width`/`height` — paired with `invalidateSize` on `transitionend` in `initGuessMap`)
- `.result-card` — overlay on result screen
- `#mapillary-viewer`, `#result-map` — full-bleed canvases

### Unit tests — [tests/test.js](tests/test.js)

- Top of file: `lib.js` `require` + `locations.js` load via a `new Function` shim (because `locations.js` only declares `const LOCATIONS` for the browser, no module export)
- `group('haversineDistance', ...)` — zero, Paris↔London, NYC↔LA, antipodes, symmetry
- `group('calculateScore', ...)` — exact hit, monotonicity, ~1000km ≈ 3000pts, huge→0, null/NaN/negative
- `group('formatDistance', ...)` — sub-km, ≥1 km, null/undefined
- `group('ratingFor', ...)` — bucket boundary cases
- `group('LOCATIONS dataset', ...)` — shape, lat/lng ranges, no duplicate coords

### E2E tests — [tests/e2e/](tests/e2e/)

Playwright + Chromium. Server is auto-started via `webServer` config; pre-existing servers are reused.

- [tests/e2e/smoke.spec.js](tests/e2e/smoke.spec.js) — start screen UX: title, button enable/disable, localStorage token persistence (no Mapillary calls)
- [tests/e2e/game-flow.spec.js](tests/e2e/game-flow.spec.js) — full game flow with mocked Mapillary: Start → drop pin → Submit → result; plus timer-toggle HUD test
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

Append `{ lat, lng, name }` to [public/locations.js](public/locations.js). No heading needed — Mapillary picks the panorama and orientation. Pick spots in cities/regions with known Mapillary coverage (most major cities NA/EU/JP/AU; sparser elsewhere). Tight rural locations cause more city-retry loops. Tests check lat/lng ranges and coord uniqueness.

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
- **Mapillary coverage is patchier than Google Street View.** The retry loop in `prepareRound` exists because some city centers have no panoramas inside the bbox. New tight rural locations → more retries.
- **Esri tile order matters.** Labels overlay must be added _after_ imagery in `buildSatelliteLayers` or labels disappear behind imagery. If satellite goes blank, Esri may have rate-limited briefly.
- **Hover-to-expand map** needs `invalidateSize` on `transitionend` (in `initGuessMap`). Leaflet doesn't auto-detect container resize; without this the expanded half renders grey.
- **Bbox API rejects too-large queries.** `SEARCH_DELTA_DEG` is 0.04° as a balance: wide enough to find coverage in most cities, tight enough that Mapillary doesn't return "reduce the amount of data" in dense downtowns. If you increase it, expect the error in places like central Tokyo or Manhattan.
- **Slow Mapillary responses** would otherwise hang the entire prefetch — the `FETCH_TIMEOUT_MS` (5 s) abort + `prepareRound` retry loop ensures one slow city doesn't block the game.

## What this project is _not_

- No backend persistence, auth, or leaderboard.
- No multiplayer.
- No country-only or difficulty modes.

Listed as stretch goals in the original spec; intentionally not implemented.
