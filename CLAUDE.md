# GeoGuess — project notes for Claude

## ⚙️ Standing rule: commit + push + keep this file current

After **every meaningful user prompt** (a feature added, a bug fixed, an
architectural decision made):

1. **Update this CLAUDE.md** if anything in here is now stale or missing —
   new files, changed conventions, new gotchas, the why behind a decision.
2. **Commit** the work locally with a focused message describing the *why*.
3. **Push** to `origin/master` (`git push`). The repo lives at
   <https://github.com/purplethunder715/geoguess-game>.

A "meaningful" prompt is anything that produces a code change, a config
change, or a documented decision. Pure clarifying-question turns don't
need a commit. When in doubt, commit.

`public/config.js` stays out of every commit (see warning below).



A small GeoGuessr clone. Static frontend served by a tiny Express app on
`http://localhost:3000`. The whole game runs in the browser; the server
only exists because some browsers/tools dislike `file://`.

## Stack

- **Server**: Express, static files only ([server.js](server.js), port 3000).
- **Street view (panorama)**: [Mapillary](https://www.mapillary.com/) JS
  viewer (`mapillary-js` v4). Free token from
  <https://www.mapillary.com/dashboard/developers> (no billing card). The
  viewer supports pan/zoom AND walking between connected images via blue
  navigation arrows.
- **Map (guessing + result)**: Leaflet + Esri "World Imagery" satellite
  tiles + Esri "World Boundaries and Places" labels overlay. No key needed.
- **History**: tried Google's legacy `?output=embed` URL (no longer works for
  Street View), then official Google Maps Embed API (needs billing card).
  Mapillary won out for the no-billing-card requirement.

## File layout

```
geoguess-game/
├── package.json
├── server.js                # Express, serves /public on :3000
├── CLAUDE.md                # this file
├── README.md
├── public/
│   ├── index.html           # all four screens (start / game / result / end)
│   ├── style.css            # dark theme, layout, responsive map panel
│   ├── config.js            # MAPILLARY_TOKEN constant — user fills in
│   ├── lib.js               # PURE helpers: haversine, scoring, formatting
│   ├── locations.js         # curated city/area coords for Mapillary lookup
│   └── game.js              # state machine, screens, Leaflet + Mapillary
└── tests/
    └── test.js              # plain Node assertions over lib.js + locations
```

## How a round works

1. `pickRandomLocation()` returns a city from `LOCATIONS` (no repeats per game).
2. `findMapillaryImage(lat, lng, token)` queries Mapillary's Graph API for any
   image inside a `SEARCH_DELTA_DEG` (~4–5 km) bbox around the city center.
   Prefers `is_pano=true` images, falls back to flat ones.
3. If nothing found, retry with another city up to `MAX_LOCATION_TRIES`.
4. The actual photo's coords are stored in `state.actualPoint` — scoring
   compares the user's guess against *the photo*, not the dataset entry's
   center, since they may be a few hundred meters apart.
5. The Mapillary viewer handles pan/zoom; blue arrows let the player walk
   between connected images.

## Token resolution order (in `game.js`)

1. `MAPILLARY_TOKEN` from `public/config.js` (preferred — auto path).
2. `localStorage["geoguess.mapillaryToken"]`.
3. Input field on the start screen.

If 1 or 2 returns a token, the start-screen input is hidden so the flow is
just "Start Game".

## Running

```
npm install     # one-time
npm start       # http://localhost:3000
npm test        # plain-node test runner
```

## Conventions

- **Pure logic lives in [public/lib.js](public/lib.js)** with a CommonJS
  export shim, so [tests/test.js](tests/test.js) can `require()` it and
  the browser can use the same functions as globals. Add new pure helpers
  here.
- **`game.js` owns DOM + state.** Depends on `lib.js` and `locations.js` but
  never the other way around.
- **Defer Leaflet/Mapillary init** until after `showScreen()` — both libraries
  need their container to be visible and sized to render correctly. The
  existing pattern is `setTimeout(..., 50)` after the screen swap.
- **Don't repeat locations within a game**: `state.usedIndices` enforces this.
- **Comments**: explain *why*, not *what*.

## Adding more locations

Append to `public/locations.js`. Each entry is just `{ lat, lng, name }`
(no heading needed — Mapillary picks the panorama and orientation). Pick
spots in cities/regions known to have Mapillary coverage (most major cities
in NA/EU/JP/AU; sparser elsewhere). Tests check lat/lng ranges and uniqueness.

## Tests

`npm test` runs `tests/test.js` against `lib.js` and the dataset:

- haversine: known distances (Paris↔London, NYC↔LA, antipodes), symmetry
- calculateScore: 0 km hit, monotonic decay, null/NaN/negative inputs
- formatDistance, ratingFor
- LOCATIONS: shape, lat/lng ranges, no duplicate coords

No test framework — just `node` + `assert`. Don't add Jest/Mocha just to
bump the count; the cost isn't worth it for a project this size.

## Common pitfalls when editing

- **Script load order matters**: index.html loads
  `leaflet → mapillary → config → lib → locations → game`. Globals from
  earlier files are available in later ones; don't reorder casually.
- **Mapillary moveTo() rejects on bad image IDs** — the catch in
  `showImageInViewer` swallows the error and logs. If a round looks frozen,
  check the console.
- **Mapillary coverage is patchier than Google Street View** — the retry
  loop in `loadRandomRound` exists because some city centers have no
  panoramas inside the bbox. If you add tight rural locations, expect more
  retries.
- **Leaflet + Esri tiles**: if the satellite layer goes blank, Esri may have
  rate-limited or had a brief outage. The labels overlay is loaded on top of
  the imagery layer — if you re-order, labels disappear behind imagery.
- **Token leakage**: `config.js` is committed-style; warn the user before
  helping them push a key to a public repo. Mapillary tokens are easier to
  rotate than Google keys but still shouldn't be in public history.

## ⚠️ Never commit `public/config.js`

`public/config.js` holds a personal Mapillary access token. It is listed in
`.gitignore` and **must stay out of every commit, push, PR, gist, paste, or
upload** unless the user has *explicitly* said "yes, include the token
alongside the rest". The default answer is always *don't include it*.

If the user asks you to push or share the project:
- Confirm `public/config.js` is gitignored (`git check-ignore public/config.js`).
- If it's somehow already staged or committed, stop and tell the user before
  pushing — do not silently push secrets.
- If they want a teammate to be able to run the project, suggest committing a
  `public/config.example.js` (with an empty token) and leaving the real one
  local — don't volunteer to bake the live token into shared code.

This rule applies even if the user has previously shared the token in chat:
sharing with you ≠ sharing publicly.

## What this project is *not*

- No backend persistence, no auth, no leaderboard.
- No multiplayer.
- No country-only or difficulty modes (yet).

Listed as stretch goals in the original spec; intentionally not implemented.
