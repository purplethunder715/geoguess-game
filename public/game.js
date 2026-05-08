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
// one to succeed wins; the others are abandoned. NOTE: the bottleneck is
// Mapillary's free-tier rate limit, NOT Brady's machine. Setting this too
// high (was 8 for one painful afternoon) makes Mapillary 500 every request
// and cascades into a CORS-error-looking failure across every round. 3 is
// the sweet spot: still fast, doesn't trigger throttling.
const PARALLEL_ATTEMPTS = 3;

// prepareRound retries forever. We only show an error if EVERY attempt
// across this many consecutive batches failed with an HTTP/network error
// (not a coverage miss). Set high so coverage-miss streaks never trip it,
// but not absurd — once we hit ~20 batches in a row of pure HTTP errors,
// we're either rate-limited or genuinely down and should stop hammering.
const MAX_CONSECUTIVE_HTTP_BATCHES = 20;

// Keep this many extra prefetched rounds in the pool beyond what's strictly
// needed. Was 10 — combined with PARALLEL_ATTEMPTS=8 that's 80+ requests
// in flight per game and Mapillary's free tier rate-limits well below that.
const POOL_BUFFER = 3;

// Exponential backoff after an HTTP failure batch. Starts at this many ms,
// doubles each time, caps at BACKOFF_MAX_MS. Reset on any successful batch.
// Without this, a transient rate-limit turns into an unbreakable loop:
// every retry adds to Mapillary's anger, prolonging the limit window.
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30000;

// We only accept a panorama if its sequence has at least this many panos
// inside the bbox — that guarantees the player can press the navigation
// arrow ~3 times before running out. Single isolated panos are rejected.
const MIN_SEQUENCE_SIZE = 4;

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
  // Set true while a game is in progress. Background prefetches loop
  // forever and bail out via this flag when the game ends, so reset/restart
  // doesn't leave zombie API calls running.
  gameRunning: false,
  // Set true when the user clicks Start without a Mapillary token. The game
  // screen renders without panoramas (placeholder card) so the layout is
  // visible. Submit stays disabled — there's no actual location to score.
  guestMode: false,
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
    // - thumb_1024_url: preloaded into browser cache for warm CDN connection
    // - sequence: lets us require multiple panos in the same sequence so
    //   the player has at least a few navigation arrows to walk down.
    fields: 'id,geometry,computed_geometry,thumb_1024_url,sequence',
    bbox: bbox,
    // Bumped from 30 to 50 — we now group by sequence and need enough
    // imagery in the bbox for ≥4 to share a sequence ID.
    limit: '50',
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

// Pick a panorama from the result that the player can actually walk down.
// We group images by sequence ID and only consider sequences with enough
// panos in the bbox to support ≥3 navigation steps. Returns null if no
// such walkable sequence exists — caller picks a different location.
function pickAndExtractCoords(imgs) {
  const bySeq = new Map();
  for (const img of imgs) {
    const seq = img.sequence;
    if (!seq) continue; // images without a sequence ID are isolated
    const arr = bySeq.get(seq) || [];
    arr.push(img);
    bySeq.set(seq, arr);
  }
  const walkable = [...bySeq.values()].filter((s) => s.length >= MIN_SEQUENCE_SIZE);
  if (walkable.length === 0) return null;

  const seqImgs = walkable[Math.floor(Math.random() * walkable.length)];
  const img = seqImgs[Math.floor(Math.random() * seqImgs.length)];
  // Mapillary sometimes omits one of the geometry fields — prefer `geometry`,
  // fall back to `computed_geometry`.
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

// Tells whether an error from attemptOneLocation looks like an HTTP/network
// problem (vs. a "no imagery here" coverage miss). Used to decide whether
// to count toward the consecutive-failures threshold.
function isHttpFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = err.message || '';
  return msg.includes('Mapillary HTTP') || msg.includes('Mapillary API');
}

// Resolve one round's data. Loops *forever* until either a walkable panorama
// is found or the API's been down for many consecutive batches. Coverage
// misses don't count toward the failure threshold — only HTTP/network
// errors do, so "no panos in this random rural spot" never produces an
// error to the user, just another retry with a different location.
//
// Exponential backoff between HTTP-error batches: stops us from amplifying
// a Mapillary rate-limit by spamming retries while they're already mad.
async function prepareRound(token) {
  let httpErrorBatches = 0;

  while (state.gameRunning) {
    try {
      const result = await Promise.any(
        Array.from({ length: PARALLEL_ATTEMPTS }, () => attemptOneLocation(token)),
      );
      preloadImage(result.image.thumbUrl);
      return result;
    } catch (aggregate) {
      // AggregateError carries the inner rejections in `errors`.
      const errs = (aggregate && aggregate.errors) || [];
      const allHttp = errs.length > 0 && errs.every(isHttpFailure);
      if (allHttp) {
        httpErrorBatches++;
        if (httpErrorBatches >= MAX_CONSECUTIVE_HTTP_BATCHES) {
          // Preserve the underlying AggregateError as `cause` so the dev
          // console keeps the original HTTP failures for debugging.
          throw new Error('Mapillary API appears unreachable', { cause: aggregate });
        }
        // Back off exponentially before the next batch: 1.5s, 3s, 6s, 12s,
        // capped at BACKOFF_MAX_MS. Gives Mapillary's rate-limit window time
        // to expire instead of compounding the throttle.
        const wait = Math.min(
          BACKOFF_MAX_MS,
          BACKOFF_BASE_MS * 2 ** (httpErrorBatches - 1),
        );
        await new Promise((r) => setTimeout(r, wait));
      } else {
        // At least one attempt was just a coverage miss — server is fine.
        httpErrorBatches = 0;
      }
    }
  }
  throw new Error('Game ended');
}

// Race-based pool: round N takes whichever prefetch resolved first, NOT
// whichever was queued first. Eliminates the case where round 1 waits for
// a slow lookup while later prefetches already finished.
//
// `onSettled` fires after every task resolves OR rejects so the caller can
// top the pool back up immediately — that keeps background search density
// high even when individual prefetches reject (e.g. transient HTTP blips).
function createRoundPool(onSettled = () => {}) {
  const pending = new Set();
  const ready = [];

  return {
    add(promise) {
      pending.add(promise);
      promise.then(
        (result) => {
          ready.push(result);
          pending.delete(promise);
          onSettled();
        },
        (err) => {
          console.warn('Pool task rejected:', err);
          pending.delete(promise);
          onSettled();
        },
      );
    },
    async take() {
      // Spin until something is ready. With infinite-retry prepareRound,
      // pool tasks only reject if the API is genuinely down — in that case
      // we eventually hit "pool exhausted" and the caller surfaces an error.
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

// Top off the prefetch pool so it always has at least
// `(rounds remaining) + POOL_BUFFER` lookups in flight or ready. Called at
// game start, after every round consumed, and after every prefetch
// resolution. Runs every prefetch through the same prepareRound (which
// loops forever), so a coverage-miss here never surfaces to the user.
function ensurePoolFull() {
  if (!state.roundPool || !state.gameRunning) return;
  const remaining = Math.max(0, ROUNDS_PER_GAME - state.round);
  const target = remaining + POOL_BUFFER;
  const sizes = state.roundPool.sizes();
  const have = sizes.ready + sizes.pending;
  const need = Math.max(0, target - have);
  for (let i = 0; i < need; i++) {
    state.roundPool.add(prepareRound(resolveToken()));
  }
}

// Prime the pool at game start. Continuous topping-off happens via
// ensurePoolFull() called after each round consumed.
function primeRoundQueue() {
  state.gameRunning = true;
  state.roundPool = createRoundPool(() => ensurePoolFull());
  ensurePoolFull();
}

// Pull whichever prefetched round is ready first. Shows a brief overlay
// only if no round is ready inside 200 ms (avoids a one-frame flash).
// We never show "Could not load round: <coverage miss>" anymore — prepareRound
// loops forever until either it succeeds or the API is genuinely unreachable.
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
    // Only reachable if every pool task hit the HTTP-error threshold.
    // Most common cause is Mapillary's free-tier rate limit kicking in
    // after sustained burst traffic; the limit window is usually
    // a few minutes. Outright outages are rare.
    clearTimeout(overlayTimer);
    status.classList.remove('hidden');
    status.textContent =
      `Mapillary stopped responding (likely rate-limited). ` +
      `Wait a few minutes and refresh, or generate a new token. (${err.message})`;
    return;
  }
  clearTimeout(overlayTimer);
  status.classList.add('hidden');

  // Top off the pool now that we've consumed one — keeps the background
  // search running at full POOL_BUFFER even mid-game.
  ensurePoolFull();

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
  btn.textContent = state.guestMode
    ? 'Demo only — add a token in Settings'
    : 'Place a pin to guess';

  state.guessMap.on('click', (e) => {
    state.guessLatLng = e.latlng;
    if (state.guessMarker) state.guessMarker.setLatLng(e.latlng);
    else state.guessMarker = L.marker(e.latlng).addTo(state.guessMap);
    // Submit stays disabled in guest mode — there's no actual panorama to
    // compare against, so a "guess" can't be scored.
    if (!state.guestMode) {
      btn.disabled = false;
      btn.textContent = 'Submit Guess';
    }
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

  const placeholder = document.getElementById('guest-placeholder');
  if (state.guestMode) {
    placeholder.classList.remove('hidden');
    // Hide the timer HUD entry — no countdown when there's nothing to time.
    document.getElementById('timer-hud').style.display = 'none';
    // Still init the guess map so the user can see / interact with it; just
    // skip Mapillary prefetch and the timer.
    setTimeout(() => initGuessMap(), 50);
    return;
  }

  placeholder.classList.add('hidden');
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
  // Stop background prefetch loops as soon as the last round is scored.
  state.gameRunning = false;
  showScreen('end');
  document.getElementById('final-score').textContent =
    `${state.score.toLocaleString()} / 25,000`;
  document.getElementById('final-rating').textContent = ratingFor(state.score);
}

function resetGame() {
  // Flip the kill switch BEFORE clearing the pool so any in-flight
  // prepareRound loops bail out on their next iteration instead of
  // continuing to run against a discarded pool.
  state.gameRunning = false;
  state.round = 0;
  state.score = 0;
  state.currentLocation = null;
  state.actualPoint = null;
  state.guessLatLng = null;
  state.guessMarker = null;
  state.usedIndices = [];
  state.roundPool = null;
  state.guestMode = false;
  document.getElementById('guest-placeholder').classList.add('hidden');
  // Restore the timer HUD slot in case guest mode hid it.
  document.getElementById('timer-hud').style.display = '';
}

// --- Start screen wiring (token + Start button) ----------------------------

const apiKeyInput = document.getElementById('api-key-input');
const apiKeySection = document.getElementById('api-key-section');
const startBtn = document.getElementById('start-btn');

// Always enabled — a missing token routes through guest mode rather than
// blocking entry. Label tells the user what they'll get.
function refreshStartButton() {
  const key = (apiKeyInput.value || '').trim() || resolveToken();
  startBtn.disabled = false;
  startBtn.textContent = key.length >= 10 ? 'Start Game' : 'Start as guest';
}

// Pre-fill the input from any saved/preset token so the user sees what's
// configured when they open Settings.
const presetToken = resolveToken();
if (presetToken) apiKeyInput.value = presetToken;
apiKeyInput.addEventListener('input', refreshStartButton);
refreshStartButton();

// Settings panel toggle. Hidden by default; the API key + future
// per-user settings live behind it.
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

startBtn.addEventListener('click', () => {
  const typed = (apiKeyInput.value || '').trim();
  // Save typed token so the next session resolves it without reopening Settings.
  if (typed && typed !== resolveToken()) {
    localStorage.setItem(TOKEN_STORAGE, typed);
  }

  state.timerEnabled = document.getElementById('timer-toggle').checked;
  resetGame();

  const key = resolveToken();
  if (key.length >= 10) {
    primeRoundQueue();
  } else {
    // No token → enter as guest. startRound branches on this.
    state.guestMode = true;
  }
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
  refreshStartButton();
});

// Guest-mode "Back to start" — exits the game screen without going through
// result/end (which would need a real round to be meaningful).
document.getElementById('back-to-start-btn').addEventListener('click', () => {
  resetGame();
  showScreen('start');
  refreshStartButton();
});
