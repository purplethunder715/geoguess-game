// game.js — orchestrates screens, rounds, the Mapillary panorama viewer,
// and the two Leaflet maps (guess + result).

const SCREENS = {
  start: document.getElementById('start-screen'),
  game: document.getElementById('game-screen'),
  result: document.getElementById('result-screen'),
  end: document.getElementById('end-screen'),
};

const ROUNDS_PER_GAME = 5;
const ROUND_SECONDS = 60;
const TOKEN_STORAGE = 'geoguess.mapillaryToken';

// Bbox half-size (degrees) for Mapillary lookups. ~0.04° ≈ 4 km — wide
// enough to find coverage in most major cities, tight enough that Mapillary
// won't reject the query for "too many results" in dense downtowns.
const SEARCH_DELTA_DEG = 0.04;

// Per-fetch timeout. If Mapillary takes longer than this we abort and treat
// the lookup as a miss — the prefetcher will retry with another location
// rather than letting the whole game hang.
const FETCH_TIMEOUT_MS = 5000;

// How many parallel location lookups to fire per prepareRound batch. First
// one to succeed wins; the others are abandoned (their HTTP responses just
// get dropped). Burns a few extra Mapillary requests per round in exchange
// for much lower worst-case latency when one location has slow coverage.
const PARALLEL_ATTEMPTS = 3;

// How many of those parallel batches to retry sequentially before giving up.
const MAX_BATCHES = 3;

// Esri's free satellite tile layer + a labels overlay (looks like Google
// satellite). No API key required; usage is permitted for non-commercial use.
const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const state = {
  round: 0,
  score: 0,
  currentLocation: null,
  actualPoint: null, // {lat, lng} of the panorama Mapillary actually returned
  guessLatLng: null,
  guessMarker: null,
  guessMap: null,
  resultMap: null,
  viewer: null,
  timerInterval: null,
  timeLeft: ROUND_SECONDS,
  timerEnabled: false,
  usedIndices: [],
  // Race-based pool of prefetched rounds. take() returns whichever lookup
  // resolves first, not whichever was queued first. See createRoundPool().
  roundPool: null,
};

function showScreen(name) {
  Object.values(SCREENS).forEach((s) => s.classList.add('hidden'));
  SCREENS[name].classList.remove('hidden');
}

// Probability of picking from the curated city list vs. a random point
// inside a country bbox. Curated picks are reliable (recognizable name,
// guaranteed Mapillary coverage); region picks add huge variety.
const CURATED_PROBABILITY = 0.4;

function pickFromCurated() {
  if (state.usedIndices.length >= CURATED_LOCATIONS.length) state.usedIndices = [];
  let idx;
  do {
    idx = Math.floor(Math.random() * CURATED_LOCATIONS.length);
  } while (state.usedIndices.includes(idx));
  state.usedIndices.push(idx);
  return CURATED_LOCATIONS[idx];
}

function pickFromRegions() {
  const r = REGIONS[Math.floor(Math.random() * REGIONS.length)];
  return {
    lat: r.latMin + Math.random() * (r.latMax - r.latMin),
    lng: r.lngMin + Math.random() * (r.lngMax - r.lngMin),
    name: `Somewhere in ${r.name}`,
  };
}

function pickRandomLocation() {
  return Math.random() < CURATED_PROBABILITY ? pickFromCurated() : pickFromRegions();
}

// --- Mapillary token resolution --------------------------------------------

function resolveToken() {
  if (typeof MAPILLARY_TOKEN === 'string' && MAPILLARY_TOKEN.trim()) {
    return MAPILLARY_TOKEN.trim();
  }
  return (localStorage.getItem(TOKEN_STORAGE) || '').trim();
}

// --- Mapillary imagery lookup ----------------------------------------------

// Single Graph API call with a hard timeout. Returns the parsed `data`
// array (possibly empty) or throws on HTTP / API / timeout error.
async function mapillaryQuery(lat, lng, token, panoOnly) {
  const bbox = [
    lng - SEARCH_DELTA_DEG,
    lat - SEARCH_DELTA_DEG,
    lng + SEARCH_DELTA_DEG,
    lat + SEARCH_DELTA_DEG,
  ].join(',');
  // Note: `is_pano` is a *filter param* (cheap), not a *field*. Requesting
  // it as a field errored out with "reduce the amount of data" — keep it
  // as a filter only.
  const params = new URLSearchParams({
    access_token: token,
    // Include thumb_1024_url so we can preload the image into browser cache
    // and use it as a backdrop while the Mapillary viewer streams its tiles.
    fields: 'id,geometry,computed_geometry,thumb_1024_url',
    bbox: bbox,
    limit: '30',
  });
  if (panoOnly) params.set('is_pano', 'true');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://graph.mapillary.com/images?${params}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Mapillary HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) {
      throw new Error(`Mapillary API: ${data.error.message || 'unknown'}`);
    }
    return data.data || [];
  } finally {
    clearTimeout(timer);
  }
}

// Find a true 360° panorama near a lat/lng. We deliberately do NOT fall
// back to flat dashcam-style images — the player has to be able to look
// around in 360°, and flat images would yield half a frozen photo. If
// no panorama is here, return null and let the caller pick another spot.
async function findMapillaryImage(lat, lng, token) {
  const panos = await mapillaryQuery(lat, lng, token, true);
  if (panos.length > 0) return pickAndExtractCoords(panos);
  return null;
}

// Pull a random image from the result and extract its coords. Mapillary
// sometimes omits one of the geometry fields, so prefer `geometry` and fall
// back to `computed_geometry`.
function pickAndExtractCoords(imgs) {
  const img = imgs[Math.floor(Math.random() * imgs.length)];
  const geom = img.geometry || img.computed_geometry;
  if (!geom || !geom.coordinates) return null;
  const [lng, lat] = geom.coordinates;
  return { id: img.id, lat, lng, thumbUrl: img.thumb_1024_url };
}

// Trigger a background image download so the browser caches it. Used to
// preload Mapillary thumbnails ahead of time.
function preloadImage(url) {
  if (!url) return;
  const img = new Image();
  img.src = url;
}

// Set up (or move) the Mapillary viewer to a specific image ID. The viewer
// itself draws blue arrows for connected images so the user can walk between
// panoramas. If `moveTo` fails (bad image ID, network blip, internal viewer
// state corruption) we tear the viewer down and rebuild it fresh — without
// this fallback the user gets stuck staring at the previous round's image.
function showImageInViewer(imageId, token) {
  const create = () => {
    state.viewer = new mapillary.Viewer({
      accessToken: token,
      container: 'mapillary-viewer',
      imageId: imageId,
      component: { cover: false },
    });
  };

  if (!state.viewer) {
    create();
    return;
  }

  state.viewer.moveTo(imageId).catch((err) => {
    console.warn('Mapillary moveTo failed; rebuilding viewer:', err);
    try {
      state.viewer.remove();
    } catch (_) {
      /* ignore */
    }
    state.viewer = null;
    create();
  });
}

// One single attempt: pick a random location and look up imagery there.
async function attemptOneLocation(token) {
  const loc = pickRandomLocation();
  const image = await findMapillaryImage(loc.lat, loc.lng, token);
  if (!image) throw new Error(`No imagery near ${loc.name}`);
  return { loc, image };
}

// Resolve one round's data. Fires PARALLEL_ATTEMPTS lookups simultaneously
// and takes the first one that succeeds — drastically cuts worst-case
// latency when one location has slow Mapillary coverage. Retries with
// fresh batches up to MAX_BATCHES times.
async function prepareRound(token) {
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    try {
      const result = await Promise.any(
        Array.from({ length: PARALLEL_ATTEMPTS }, () => attemptOneLocation(token)),
      );
      // Warm the browser cache with the thumbnail; the panorama viewer
      // tiles aren't the same URL but Mapillary's CDN connection gets reused.
      preloadImage(result.image.thumbUrl);
      return result;
    } catch (aggregate) {
      console.warn(`prepareRound batch ${batch + 1} all failed:`, aggregate);
    }
  }
  throw new Error('No Mapillary imagery found after several batches');
}

// Race-based pool: round N takes whichever prefetch resolved first, NOT
// whichever was queued first. Eliminates the case where round 1 waits for
// a slow lookup while later prefetches already finished.
function createRoundPool() {
  const pending = new Set();
  const ready = [];

  return {
    add(promise) {
      pending.add(promise);
      promise.then(
        (result) => {
          ready.push(result);
          pending.delete(promise);
        },
        (err) => {
          console.warn('Pool task rejected:', err);
          pending.delete(promise);
        },
      );
    },
    async take() {
      // Spin until something is ready (or pool is fully drained).
      while (true) {
        if (ready.length > 0) return ready.shift();
        if (pending.size === 0) throw new Error('Round pool exhausted');
        // Wait for ANY pending to settle. Catch each so one rejection
        // doesn't reject the whole race; we'll loop and re-check `ready`.
        await Promise.race([...pending].map((p) => p.catch(() => null)));
      }
    },
    sizes() {
      return { ready: ready.length, pending: pending.size };
    },
  };
}

// Kick off all upcoming rounds in parallel. Round transitions after the
// first should be instant because their lookups overlap with whatever
// round the user is currently playing.
function primeRoundQueue() {
  const token = resolveToken();
  state.roundPool = createRoundPool();
  for (let i = 0; i < ROUNDS_PER_GAME; i++) {
    state.roundPool.add(prepareRound(token));
  }
}

// Pull whichever prefetched round is ready first. Shows a brief overlay
// only if no round is ready inside 200 ms (avoids a one-frame flash).
async function showPrefetchedRound() {
  const status = document.getElementById('streetview-status');

  let overlayTimer = setTimeout(() => {
    status.classList.remove('hidden');
    status.textContent = 'Loading panorama...';
  }, 200);

  let result;
  try {
    result = await state.roundPool.take();
  } catch (err) {
    // Pool was empty AND every pending task failed. Last-ditch live lookup.
    console.warn('Round pool drained; running live prepareRound:', err);
    try {
      result = await prepareRound(resolveToken());
    } catch (err2) {
      clearTimeout(overlayTimer);
      status.classList.remove('hidden');
      status.textContent = `Could not load round: ${err2.message}`;
      return;
    }
  }
  clearTimeout(overlayTimer);
  status.classList.add('hidden');

  state.currentLocation = result.loc;
  // Use the actual photo coords for scoring — they may be a few hundred
  // meters off the city center we queried with.
  state.actualPoint = { lat: result.image.lat, lng: result.image.lng };
  showImageInViewer(result.image.id, resolveToken());
}

// --- Guess map -------------------------------------------------------------

function buildSatelliteLayers(map) {
  L.tileLayer(SATELLITE_TILES, { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map);
  // Labels overlay (city/country names) so guessing is actually feasible.
  L.tileLayer(LABELS_TILES, { maxZoom: 19, opacity: 0.9 }).addTo(map);
}

function initGuessMap() {
  if (state.guessMap) state.guessMap.remove();

  state.guessMap = L.map('guess-map', {
    center: [20, 0],
    zoom: 1,
    worldCopyJump: true,
    minZoom: 1,
    maxZoom: 18, // Esri imagery supports up to 19; cap at 18 so labels still load
    attributionControl: false,
  });
  buildSatelliteLayers(state.guessMap);

  state.guessMarker = null;
  state.guessLatLng = null;

  const btn = document.getElementById('guess-btn');
  btn.disabled = true;
  btn.textContent = 'Place a pin to guess';

  state.guessMap.on('click', (e) => {
    state.guessLatLng = e.latlng;
    if (state.guessMarker) state.guessMarker.setLatLng(e.latlng);
    else state.guessMarker = L.marker(e.latlng).addTo(state.guessMap);
    btn.disabled = false;
    btn.textContent = 'Submit Guess';
  });

  // The panel grows on hover via CSS transition. Leaflet doesn't notice
  // container resizes on its own, so without invalidateSize() the expanded
  // half of the map renders blank/grey tiles. Fire on every transition end
  // so it works for both expand and collapse.
  const panel = document.getElementById('map-panel');
  panel.addEventListener('transitionend', () => {
    if (state.guessMap) state.guessMap.invalidateSize();
  });
}

// --- Timer -----------------------------------------------------------------

function startTimer() {
  const hud = document.getElementById('timer-hud');
  if (!state.timerEnabled) {
    hud.style.display = 'none';
    return;
  }

  hud.style.display = '';
  state.timeLeft = ROUND_SECONDS;
  document.getElementById('timer').textContent = state.timeLeft;
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    document.getElementById('timer').textContent = state.timeLeft;
    if (state.timeLeft <= 0) {
      stopTimer();
      submitGuess(true);
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// --- Round lifecycle -------------------------------------------------------

async function startRound() {
  state.round++;
  document.getElementById('round-num').textContent = state.round;
  document.getElementById('score').textContent = state.score.toLocaleString();
  showScreen('game');
  // Defer until after layout — Leaflet and Mapillary both need their
  // containers to have non-zero size to render correctly.
  setTimeout(async () => {
    initGuessMap();
    await showPrefetchedRound();
    startTimer();
  }, 50);
}

function submitGuess(timedOut = false) {
  stopTimer();
  let distance = null;
  let points = 0;
  if (state.guessLatLng && state.actualPoint) {
    distance = haversineDistance(
      state.guessLatLng.lat,
      state.guessLatLng.lng,
      state.actualPoint.lat,
      state.actualPoint.lng,
    );
    points = calculateScore(distance);
  }
  state.score += points;
  showResult(distance, points, timedOut);
}

function showResult(distance, points, timedOut) {
  showScreen('result');

  setTimeout(() => {
    if (state.resultMap) state.resultMap.remove();
    state.resultMap = L.map('result-map', {
      worldCopyJump: true,
      minZoom: 1,
      attributionControl: false,
    });
    buildSatelliteLayers(state.resultMap);

    const actual = [state.actualPoint.lat, state.actualPoint.lng];
    L.marker(actual)
      .addTo(state.resultMap)
      .bindPopup(state.currentLocation.name)
      .openPopup();

    if (state.guessLatLng) {
      const guess = [state.guessLatLng.lat, state.guessLatLng.lng];
      L.marker(guess).addTo(state.resultMap);
      L.polyline([guess, actual], { color: '#4ade80', dashArray: '6,8' }).addTo(
        state.resultMap,
      );
      state.resultMap.fitBounds(L.latLngBounds([guess, actual]).pad(0.3));
    } else {
      state.resultMap.setView(actual, 4);
    }
  }, 50);

  document.getElementById('result-title').textContent =
    `+${points.toLocaleString()} points`;
  document.getElementById('result-distance').textContent =
    distance === null
      ? timedOut
        ? 'Time ran out — no guess submitted'
        : 'No guess made'
      : `You were ${formatDistance(distance)} away`;
  document.getElementById('result-location').textContent = state.currentLocation.name;

  document.getElementById('next-btn').textContent =
    state.round >= ROUNDS_PER_GAME ? 'See Final Score' : 'Next Round';
}

function endGame() {
  showScreen('end');
  document.getElementById('final-score').textContent =
    `${state.score.toLocaleString()} / 25,000`;
  document.getElementById('final-rating').textContent = ratingFor(state.score);
}

function resetGame() {
  state.round = 0;
  state.score = 0;
  state.currentLocation = null;
  state.actualPoint = null;
  state.guessLatLng = null;
  state.guessMarker = null;
  state.usedIndices = [];
  state.roundPool = null;
}

// --- Start screen wiring (token + Start button) ----------------------------

const apiKeyInput = document.getElementById('api-key-input');
const apiKeySection = document.getElementById('api-key-section');
const startBtn = document.getElementById('start-btn');

function refreshStartButton() {
  const typed = (apiKeyInput.value || '').trim();
  const key = typed || resolveToken();
  startBtn.disabled = key.length < 10;
  startBtn.textContent = key.length < 10 ? 'Enter token to start' : 'Start Game';
}

const presetToken = resolveToken();
if (presetToken) {
  apiKeySection.classList.add('hidden');
} else {
  apiKeyInput.value = '';
  apiKeyInput.addEventListener('input', refreshStartButton);
}
refreshStartButton();

startBtn.addEventListener('click', () => {
  const typed = (apiKeyInput.value || '').trim();
  const key = typed || resolveToken();
  if (!key) return;
  if (typed) localStorage.setItem(TOKEN_STORAGE, typed);

  state.timerEnabled = document.getElementById('timer-toggle').checked;
  resetGame();
  primeRoundQueue(); // fire all 5 lookups now, in parallel
  startRound();
});

document.getElementById('guess-btn').addEventListener('click', () => submitGuess(false));

document.getElementById('next-btn').addEventListener('click', () => {
  if (state.round >= ROUNDS_PER_GAME) endGame();
  else startRound();
});

document.getElementById('restart-btn').addEventListener('click', () => {
  resetGame();
  showScreen('start');
  apiKeySection.classList.add('hidden');
  refreshStartButton();
});
