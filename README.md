# GeoGuess

A small GeoGuessr-style web game. You're dropped into a 360° street-level
panorama at a random city, you can pan, zoom, **and walk between connected
images** via the blue navigation arrows. Then drop a pin on a satellite map
and score based on how close you got.

## Run locally

```bash
cd geoguess-game
npm install
npm start
```

Open <http://localhost:3000>.

## Mapillary token (one-time setup)

Street-level imagery comes from [Mapillary](https://www.mapillary.com/), a
free open-source alternative to Google Street View. You need a free access
token — **no billing card required**, just an email signup.

1. Go to <https://www.mapillary.com/dashboard/developers> and sign up.
2. Click "Register Application", give it any name.
3. Copy the **Client Token** (starts with `MLY|...`).
4. Either paste it into `public/config.js`:
   ```js
   const MAPILLARY_TOKEN = 'MLY|your|token';
   ```
   …or just paste it into the start screen on first visit (it'll save to
   `localStorage` and you won't be asked again).

## File structure

```
geoguess-game/
├── package.json
├── server.js              # tiny Express server, serves /public on :3000
├── CLAUDE.md              # project notes for AI/devs
├── README.md
├── public/
│   ├── index.html
│   ├── style.css
│   ├── config.js          # paste your Mapillary token here
│   ├── lib.js             # pure helpers: haversine, scoring, formatting
│   ├── locations.js       # curated city/area coords
│   └── game.js            # game loop + Leaflet + Mapillary wiring
└── tests/
    └── test.js            # plain-node assertions
```

## Tests

```bash
npm test
```

Covers Haversine distance, scoring decay, distance formatting, rating
buckets, and dataset shape. Plain `node` + `assert`, no test framework.

## Game rules

- 5 rounds per game, max 5,000 points each (25,000 total).
- Optional 60-second timer per round (toggle on the start screen). On
  timeout your current pin auto-submits; no pin = 0 points.
- The guessing map sits in the bottom-right of the panorama — **hover it
  to expand**.
- The map uses Esri's free satellite imagery + a labels overlay so cities
  and country borders are visible while you guess.

## Tech notes

- **Panorama**: `mapillary-js` v4 from CDN. The viewer handles pan/zoom and
  draws blue arrows for connected images so you can walk down streets.
- **Map**: Leaflet + Esri "World Imagery" satellite tiles + Esri "World
  Boundaries and Places" labels. No keys.
- **Mapillary lookup**: each round queries the Graph API for any image in
  a ~4–5 km bbox around the chosen city center, prefers true 360° panoramas,
  retries with another city if nothing's there.
- **Scoring**: Haversine distance from your guess to the *actual* photo
  position (not the dataset center), then `5000 * exp(-km / 2000)` capped
  at 5,000 points.
