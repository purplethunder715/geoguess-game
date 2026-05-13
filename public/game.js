// game.js — orchestrates screens, rounds, the Mapillary panorama viewer,
// and the two Leaflet maps (guess + result).

const SCREENS = {
  start: document.getElementById('start-screen'),
  game: document.getElementById('game-screen'),
  result: document.getElementById('result-screen'),
  end: document.getElementById('end-screen'),
};

// Default round count if the user doesn't change the start-screen input.
// The actual value used at runtime lives on `state.roundsPerGame`, set when
// the user clicks Start.
const DEFAULT_ROUNDS_PER_GAME = 5;
const MIN_ROUNDS_PER_GAME = 1;
const MAX_ROUNDS_PER_GAME = 20;
const ROUND_SECONDS = 60;
const TOKEN_STORAGE = 'geoguess.mapillaryToken';

// Per-user Google Maps API key for the Google-Street-View primary path.
// Stored in localStorage (entered via the settings panel) instead of bundled
// in config.js so each player's usage bills against their own Google Cloud
// account, not Brady's. If empty, the game falls back to Mapillary-only.
const GOOGLE_KEY_STORAGE = 'geoguess.googleMapsApiKey';

// Radius (meters) for Google's StreetViewService.getPanorama lookup. Matches
// the order-of-magnitude of Mapillary's SEARCH_DELTA_DEG bbox so the two
// providers see similar coverage windows around each curated/random point.
const GOOGLE_SEARCH_RADIUS_M = 4000;

// Sanity cap (meters): if Google ever returns a panorama farther than this
// from the requested point, treat it as a coverage miss instead of using it.
// Google's `radius` param is supposed to limit results but with the OUTDOOR
// source filter it gets sloppy — we've seen panoramas come back hundreds of
// kilometers away (e.g. asked for a point in Austria, got a Berlin pano).
// 50 km gives plenty of slack for normal "nearest road" snapping while
// rejecting the pathological cross-country jumps.
const GOOGLE_RESULT_MAX_KM = 50;

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
// Mapillary's free-tier rate limit, NOT Brady's machine — going high makes
// Mapillary 500 every request and cascades into a CORS-error-looking
// failure across every round. With Google Street View as primary (better
// coverage = fewer ZERO_RESULTS), 2 is plenty: a single retry covers most
// dead spots, and the worst-case latency is still under a second.
const PARALLEL_ATTEMPTS = 2;

// prepareRound retries forever. We only show an error if EVERY attempt
// across this many consecutive batches failed with an HTTP/network error
// (not a coverage miss). Set high so coverage-miss streaks never trip it,
// but not absurd — once we hit ~20 batches in a row of pure HTTP errors,
// we're either rate-limited or genuinely down and should stop hammering.
const MAX_CONSECUTIVE_HTTP_BATCHES = 20;

// Keep this many extra prefetched rounds in the pool beyond what's strictly
// needed. With Google's better coverage we don't need a deep buffer — 2 is
// enough that a single dead spot doesn't make the next round wait.
const POOL_BUFFER = 2;

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

// Hardcoded rounds for guest mode. The Mapillary SDK can't render without
// a real token, so the panorama area stays a placeholder card — but every
// other code path (guess map, timer, scoring, result, end) runs through
// the production flow with these as the "actual point". Each round carries
// a textual hint so the user has something to guess from in the absence
// of a panorama. Hints are evocative but should NOT contain the city or
// country name (otherwise it's not a guess).
const DEMO_ROUNDS = [
  {
    lat: 48.8584,
    lng: 2.2945,
    name: 'Eiffel Tower, Paris, France',
    hint: "The world's most-visited paid monument, a wrought-iron lattice tower built for an 1889 World's Fair.",
  },
  {
    lat: 40.6892,
    lng: -74.0445,
    name: 'Statue of Liberty, New York, USA',
    hint: 'A copper-clad gift from one country to another, standing on an island in a major harbor on the East Coast of North America.',
  },
  {
    lat: -33.8568,
    lng: 151.2153,
    name: 'Sydney Opera House, Australia',
    hint: 'A sail-shaped performing-arts venue on a harbor in the Southern Hemisphere — designed by a Danish architect, completed in 1973.',
  },
  {
    lat: 35.6586,
    lng: 139.7454,
    name: 'Tokyo Tower, Japan',
    hint: 'An orange-and-white lattice tower in East Asia, finished in 1958 and modelled on the Eiffel Tower but slightly taller.',
  },
  {
    lat: 51.5007,
    lng: -0.1246,
    name: 'Big Ben, London, UK',
    hint: "Technically the name of the great bell inside, not the clock tower itself — but everyone calls the whole landmark by it. Sits beside a famous river in Britain's capital.",
  },
];

// Esri's free satellite tile layer + a labels overlay (looks like Google
// satellite). No API key required; usage is permitted for non-commercial use.
const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const state = {
  round: 0,
  score: 0,
  // Set when the user clicks Start, from the start-screen rounds input
  // (clamped to MIN..MAX). Drives prefetch sizing, round-end transitions,
  // and final-score display. Default until then is DEFAULT_ROUNDS_PER_GAME.
  roundsPerGame: DEFAULT_ROUNDS_PER_GAME,
  // Selected location-pool mode: 'random' (default — region-random with a
  // 15% curated sprinkle) or 'capitals' (only world capitals, from the
  // CAPITAL_LOCATIONS subset). Set on Start click from #mode-select.
  gameMode: 'random',
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
  // ISO 3166-1 alpha-2 country code of the current round's actual photo,
  // populated when a Google key is available (via reverseGeocode). Used
  // by submitGuess to award the country-bonus when the user's pin is in
  // the same country. Null if Geocoding isn't enabled or failed.
  actualCountryCode: null,
  // Set true while a game is in progress. Background prefetches loop
  // forever and bail out via this flag when the game ends, so reset/restart
  // doesn't leave zombie API calls running.
  gameRunning: false,
  // Which provider built `state.viewer`: 'google', 'mapillary', or null.
  // Drives the source-switch teardown in showImageInViewer — if a round's
  // image came from a different provider than the last one, we have to
  // destroy the old viewer and create a fresh one of the new type.
  viewerSource: null,
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
// inside a country bbox in `random` mode. Was 0.4 — Brady reported every
// round felt like a capital, since curated leans heavily on famous /
// capital cities and 40% was enough to dominate. 0.15 keeps the curated
// path as a sprinkle of recognizable spots without monopolizing.
const CURATED_PROBABILITY = 0.15;

// Pick from a list of curated entries with no-repeat tracking against
// `state.usedIndices`. Used for both "all curated" (random mode's curated
// branch) and "capitals only" (capitals mode).
function pickFromList(list) {
  if (state.usedIndices.length >= list.length) state.usedIndices = [];
  let idx;
  do {
    idx = Math.floor(Math.random() * list.length);
  } while (state.usedIndices.includes(idx));
  state.usedIndices.push(idx);
  return list[idx];
}

function pickFromRegions() {
  const r = REGIONS[Math.floor(Math.random() * REGIONS.length)];
  return {
    lat: r.latMin + Math.random() * (r.latMax - r.latMin),
    lng: r.lngMin + Math.random() * (r.lngMax - r.lngMin),
    name: `Somewhere in ${r.name}`,
  };
}

// Pre-compute the capitals subset once so 'capitals' mode doesn't filter
// the full curated list every pick.
const CAPITAL_LOCATIONS = CURATED_LOCATIONS.filter((l) => l.isCapital);

function pickRandomLocation() {
  if (state.gameMode === 'capitals') {
    return pickFromList(CAPITAL_LOCATIONS);
  }
  // 'random' mode (default): mostly region-random, occasional curated.
  return Math.random() < CURATED_PROBABILITY
    ? pickFromList(CURATED_LOCATIONS)
    : pickFromRegions();
}

// --- Mapillary token resolution --------------------------------------------

function resolveToken() {
  if (typeof MAPILLARY_TOKEN === 'string' && MAPILLARY_TOKEN.trim()) {
    return MAPILLARY_TOKEN.trim();
  }
  return (localStorage.getItem(TOKEN_STORAGE) || '').trim();
}

// --- Google Maps lazy-loader + Street View lookup --------------------------

function resolveGoogleKey() {
  // Priority order:
  //   1. GOOGLE_MAPS_API_KEY global from public/config.local.js (gitignored,
  //      per-developer convenience so Brady doesn't have to re-paste).
  //   2. localStorage entry (set via the in-app settings panel).
  // Returns '' when neither is set; the caller short-circuits to Mapillary.
  if (typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.trim()) {
    return GOOGLE_MAPS_API_KEY.trim();
  }
  return (localStorage.getItem(GOOGLE_KEY_STORAGE) || '').trim();
}

// Lazy-loaded singleton — first call inserts the Maps JS script tag and
// returns a Promise that resolves once `window.google.maps` is ready.
// Subsequent calls return the same promise. We never reload, even if the
// caller passes a different key — Google's JS API only respects the first
// key it was loaded with per page.
let _gmapsPromise = null;
function loadGoogleMaps(key) {
  if (_gmapsPromise) return _gmapsPromise;
  _gmapsPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve();
      return;
    }
    const cb = '__gmapsReady_' + Date.now();
    window[cb] = () => {
      delete window[cb];
      resolve();
    };
    const script = document.createElement('script');
    script.src =
      `https://maps.googleapis.com/maps/api/js` +
      `?key=${encodeURIComponent(key)}&callback=${cb}&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      _gmapsPromise = null; // allow retry after a transient failure
      reject(new Error('Google API: failed to load Maps JS bundle'));
    };
    document.head.appendChild(script);
  });
  return _gmapsPromise;
}

// Find the closest Google Street View panorama within GOOGLE_SEARCH_RADIUS_M
// of (lat, lng). Returns {id, lat, lng} or null on coverage miss; throws on
// real API errors (bad key, rate limit) so prepareRound counts it toward
// the HTTP-failure budget. `source: OUTDOOR` excludes user-uploaded
// photospheres so we get only road-network panoramas — Google's equivalent
// of Mapillary's `is_pano=true` filter.
async function findGoogleStreetView(lat, lng, key) {
  await loadGoogleMaps(key);
  return new Promise((resolve, reject) => {
    const sv = new google.maps.StreetViewService();
    sv.getPanorama(
      {
        location: { lat, lng },
        radius: GOOGLE_SEARCH_RADIUS_M,
        source: google.maps.StreetViewSource.OUTDOOR,
      },
      (data, status) => {
        if (status === 'OK' && data && data.location) {
          const resultLat = data.location.latLng.lat();
          const resultLng = data.location.latLng.lng();
          // Sanity check: Google sometimes ignores the radius param with
          // OUTDOOR and snaps to a panorama hundreds of km away. Reject
          // anything farther than GOOGLE_RESULT_MAX_KM and let the caller
          // pick another spot — keeps the displayed location ~match the
          // actual photo's region.
          const distKm = haversineDistance(lat, lng, resultLat, resultLng);
          if (distKm > GOOGLE_RESULT_MAX_KM) {
            resolve(null);
            return;
          }
          resolve({
            id: data.location.pano,
            lat: resultLat,
            lng: resultLng,
          });
        } else if (status === 'ZERO_RESULTS') {
          // No coverage here — let the caller fall back to Mapillary.
          resolve(null);
        } else {
          // OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR.
          reject(new Error(`Google API: ${status}`));
        }
      },
    );
  });
}

// Reverse-geocode a lat/lng using Google's Geocoder. Returns
//   { display: '<place>, <country>' | '<country>', countryCode: 'DE', ... }
// or null if the Geocoding API isn't enabled / the request fails / no
// usable components. The countryCode (ISO 3166-1 alpha-2) is the stable
// match key for the country bonus — country `long_name` strings drift
// (e.g. "Czech Republic" vs "Czechia") but country codes don't.
//
// For the display label we walk a priority list of place types from most
// specific (a small village's `locality` or `sublocality`) up to broader
// administrative areas. Without this, rural results that lack a
// `locality` component would silently fall through to Google's next
// returned result — typically the nearest *major* city — making every
// rural French round read as "Paris, France" etc.
const PLACE_TYPE_PRIORITY = [
  'locality',
  'postal_town', // UK uses this in place of `locality`
  'sublocality_level_1',
  'sublocality',
  'administrative_area_level_3',
  'administrative_area_level_2',
  'administrative_area_level_1',
];

async function reverseGeocode(lat, lng, key) {
  if (!key) return null;
  try {
    await loadGoogleMaps(key);
  } catch (_) {
    return null;
  }
  return new Promise((resolve) => {
    const geo = new google.maps.Geocoder();
    geo.geocode({ location: { lat, lng } }, (results, status) => {
      if (status !== 'OK' || !Array.isArray(results) || results.length === 0) {
        // REQUEST_DENIED most commonly means the Geocoding API isn't
        // enabled on the project. Gracefully give up.
        resolve(null);
        return;
      }
      // Collect components by type from across the result list, keeping
      // only the first occurrence of each type. results[0] is the most
      // specific, so this naturally favours the closest place.
      const components = {};
      for (const r of results) {
        for (const c of r.address_components || []) {
          for (const type of c.types) {
            if (!components[type]) components[type] = c;
          }
        }
      }
      const country = components.country?.long_name || null;
      const countryCode = components.country?.short_name || null;
      if (!country) {
        resolve(null);
        return;
      }
      let placeName = null;
      for (const type of PLACE_TYPE_PRIORITY) {
        if (components[type]) {
          placeName = components[type].long_name;
          break;
        }
      }
      resolve({
        display: placeName ? `${placeName}, ${country}` : country,
        country,
        countryCode,
      });
    });
  });
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

// Dispatcher: route to Google or Mapillary depending on which provider
// resolved the round's image. The container `#mapillary-viewer` (kept that
// id for backwards-compat with CSS / e2e) is reused; if the source flips
// between rounds we destroy the old viewer first because Google's
// StreetViewPanorama and Mapillary's Viewer can't share the same DOM.
function showImageInViewer(image, source, mapillaryToken) {
  if (state.viewerSource && state.viewerSource !== source) {
    teardownViewer();
  }
  if (source === 'google') {
    showGoogleViewer(image);
  } else {
    showMapillaryViewer(image, mapillaryToken);
  }
  state.viewerSource = source;
}

function teardownViewer() {
  if (state.viewer && state.viewerSource === 'mapillary') {
    try {
      state.viewer.remove();
    } catch (_) {
      /* ignore */
    }
  }
  // Google's StreetViewPanorama has no destroy method; clearing the
  // container's children is enough — the JS instance is GC'd once we drop
  // our reference.
  document.getElementById('mapillary-viewer').innerHTML = '';
  state.viewer = null;
  state.viewerSource = null;
}

// Mapillary path. If `moveTo` fails (bad image ID, network blip, internal
// viewer state corruption) we tear it down and rebuild — without that
// fallback the player gets stuck staring at the previous round's image.
function showMapillaryViewer(image, token) {
  const create = () => {
    state.viewer = new mapillary.Viewer({
      accessToken: token,
      container: 'mapillary-viewer',
      imageId: image.id,
      component: { cover: false },
    });
  };

  if (!state.viewer) {
    create();
    return;
  }

  state.viewer.moveTo(image.id).catch((err) => {
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

// Google path. StreetViewPanorama supports setPano() to move between
// images, so we reuse the same instance across same-source rounds.
function showGoogleViewer(image) {
  if (!state.viewer) {
    state.viewer = new google.maps.StreetViewPanorama(
      document.getElementById('mapillary-viewer'),
      {
        position: { lat: image.lat, lng: image.lng },
        pano: image.id,
        addressControl: false,
        showRoadLabels: false,
        fullscreenControl: false,
        motionTrackingControl: false,
        zoomControl: true,
      },
    );
  } else {
    state.viewer.setPano(image.id);
  }
}

// One single attempt: pick a random location and look up imagery there.
// Try Google Street View first if the user has set a Google key (better
// global coverage, walkable everywhere). Fall back to Mapillary either on
// a coverage miss (Google's `ZERO_RESULTS`, the most common case) or
// transparently when no Google key is set.
async function attemptOneLocation(mapillaryToken) {
  const loc = pickRandomLocation();
  const googleKey = resolveGoogleKey();

  if (googleKey) {
    const googleImage = await findGoogleStreetView(loc.lat, loc.lng, googleKey);
    if (googleImage) {
      // Reverse-geocode the actual panorama coords (which may differ from
      // the requested point) so the result screen shows the city the
      // photo's actually in, not the random region we queried from. The
      // countryCode is the match key for the country bonus on submit.
      const geocoded = await reverseGeocode(googleImage.lat, googleImage.lng, googleKey);
      const labeled = geocoded
        ? { ...loc, name: geocoded.display, countryCode: geocoded.countryCode }
        : loc;
      return { loc: labeled, image: googleImage, source: 'google' };
    }
    // No Google coverage at this point; fall through to Mapillary. Real
    // Google API errors (bad key, rate limit, etc.) are NOT caught — they
    // throw "Google API: <STATUS>" which prepareRound counts as an HTTP
    // failure.
  }

  const mapillaryImage = await findMapillaryImage(loc.lat, loc.lng, mapillaryToken);
  if (!mapillaryImage) throw new Error(`No imagery near ${loc.name}`);
  // If a Google key is available, also geocode the Mapillary result so the
  // country bonus + nicer label still work on the fallback path.
  let labeled = loc;
  if (googleKey) {
    const geocoded = await reverseGeocode(
      mapillaryImage.lat,
      mapillaryImage.lng,
      googleKey,
    );
    if (geocoded) {
      labeled = { ...loc, name: geocoded.display, countryCode: geocoded.countryCode };
    }
  }
  return { loc: labeled, image: mapillaryImage, source: 'mapillary' };
}

// Tells whether an error from attemptOneLocation looks like an HTTP/network
// problem (vs. a "no imagery here" coverage miss). Used to decide whether
// to count toward the consecutive-failures threshold.
function isHttpFailure(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = err.message || '';
  return (
    msg.includes('Mapillary HTTP') ||
    msg.includes('Mapillary API') ||
    msg.includes('Google API')
  );
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
  const remaining = Math.max(0, state.roundsPerGame - state.round);
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
  state.actualCountryCode = result.loc.countryCode || null;
  showImageInViewer(result.image, result.source, resolveToken());
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

  // If the screen just transitioned in, the container's layout might not
  // be computed yet — Leaflet would then cache 0x0 bounds and clicks would
  // miss its internal hit-test. Re-invalidate on the next animation frame
  // (after the browser has done at least one layout pass) and once more
  // after that to cover slow CI runners. Cheap and idempotent.
  requestAnimationFrame(() => {
    if (state.guessMap) state.guessMap.invalidateSize();
    requestAnimationFrame(() => {
      if (state.guessMap) state.guessMap.invalidateSize();
    });
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

// Wait until the named element has non-zero offsetWidth/offsetHeight, then
// run `cb`. Polls via requestAnimationFrame up to `maxFrames` times before
// giving up and running `cb` anyway. Replaces the brittle setTimeout(50)
// we used to guess "layout has probably finished by now" — on slow CI
// runners 50 ms wasn't enough and Leaflet would cache 0x0 click bounds.
function whenContainerSized(elementId, cb, maxFrames = 60) {
  const el = document.getElementById(elementId);
  if (!el) {
    cb();
    return;
  }
  if (el.offsetWidth > 0 && el.offsetHeight > 0) {
    cb();
    return;
  }
  if (maxFrames <= 0) {
    cb();
    return;
  }
  requestAnimationFrame(() => whenContainerSized(elementId, cb, maxFrames - 1));
}

async function startRound() {
  state.round++;
  document.getElementById('round-num').textContent = state.round;
  document.getElementById('score').textContent = state.score.toLocaleString();
  showScreen('game');

  const placeholder = document.getElementById('guest-placeholder');
  if (state.guestMode) {
    // Demo round: pull canned location data, skip Mapillary entirely. The
    // placeholder card stands in for the panorama; everything else (guess
    // map, scoring, result, end game) runs the normal flow.
    placeholder.classList.remove('hidden');
    document.getElementById('demo-round-num').textContent = state.round;
    const demo = DEMO_ROUNDS[state.round - 1];
    document.getElementById('demo-hint').textContent = demo.hint;
    state.currentLocation = demo;
    state.actualPoint = { lat: demo.lat, lng: demo.lng };
    whenContainerSized('guess-map', () => {
      initGuessMap();
      startTimer();
    });
    return;
  }

  placeholder.classList.add('hidden');
  // Wait for the guess-map container to have layout dimensions before
  // initializing Leaflet — without this, on slow runners the click
  // hit-test cache is set against a 0x0 bounds and pin drops silently
  // miss until a resize event fires.
  whenContainerSized('guess-map', async () => {
    initGuessMap();
    await showPrefetchedRound();
    startTimer();
  });
}

async function submitGuess(timedOut = false) {
  stopTimer();
  let distance = null;
  let distancePoints = 0;
  let countryBonus = 0;
  if (state.guessLatLng && state.actualPoint) {
    distance = haversineDistance(
      state.guessLatLng.lat,
      state.guessLatLng.lng,
      state.actualPoint.lat,
      state.actualPoint.lng,
    );
    distancePoints = calculateScore(distance);

    // Country bonus: only when we have an actual-side country code (set by
    // reverseGeocode in attemptOneLocation when a Google key is available)
    // AND the Geocoder is reachable to resolve the guess's country.
    if (state.actualCountryCode) {
      const googleKey = resolveGoogleKey();
      if (googleKey) {
        try {
          const guessGeo = await reverseGeocode(
            state.guessLatLng.lat,
            state.guessLatLng.lng,
            googleKey,
          );
          const sameCountry =
            !!guessGeo && guessGeo.countryCode === state.actualCountryCode;
          countryBonus = applyCountryBonus(distancePoints, sameCountry);
        } catch (_) {
          // Geocoder failure → no bonus, fall through silently.
        }
      }
    }
  }
  const points = distancePoints + countryBonus;
  state.score += points;
  showResult(distance, points, timedOut, countryBonus);
}

function showResult(distance, points, timedOut, countryBonus = 0) {
  showScreen('result');

  setTimeout(() => {
    if (state.resultMap) state.resultMap.remove();
    state.resultMap = L.map('result-map', {
      worldCopyJump: true,
      minZoom: 1,
      attributionControl: false,
    });
    buildSatelliteLayers(state.resultMap);

    // Actual location: classic red map pin. iconAnchor at the tip so the
    // point of the pin sits exactly on the photo's lat/lng; popupAnchor
    // raises the bound popup above the pin head.
    const actualIcon = L.divIcon({
      className: 'geo-actual-marker',
      html:
        '<svg viewBox="0 0 32 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M16 2C8 2 2 8 2 16c0 10 14 26 14 26s14-16 14-26c0-8-6-14-14-14z" ' +
        'fill="#ef4444" stroke="#7f1d1d" stroke-width="1.5"/>' +
        '<circle cx="16" cy="15" r="5.5" fill="#fff"/></svg>',
      iconSize: [32, 44],
      iconAnchor: [16, 42],
      popupAnchor: [0, -38],
    });

    // Player's guess: Google-account-style circular avatar. Anchored at
    // its center so it sits centered on the pin location.
    const guessIcon = L.divIcon({
      className: 'geo-guess-marker',
      html:
        '<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<circle cx="18" cy="18" r="16" fill="#4ade80" stroke="#06190d" stroke-width="2"/>' +
        '<circle cx="18" cy="15" r="5" fill="#06190d"/>' +
        '<path d="M7 30c2-6 7-8 11-8s9 2 11 8z" fill="#06190d"/></svg>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const actual = [state.actualPoint.lat, state.actualPoint.lng];
    L.marker(actual, { icon: actualIcon })
      .addTo(state.resultMap)
      .bindPopup(state.currentLocation.name)
      .openPopup();

    if (state.guessLatLng) {
      const guess = [state.guessLatLng.lat, state.guessLatLng.lng];
      L.marker(guess, { icon: guessIcon }).addTo(state.resultMap);

      // Faint base line keeps the connection visible even at zoom levels
      // where the arrows are sparse; arrows ride on top to show direction
      // from the guess toward the actual location.
      const line = L.polyline([guess, actual], {
        color: '#4ade80',
        weight: 1.5,
        opacity: 0.45,
      }).addTo(state.resultMap);

      L.polylineDecorator(line, {
        patterns: [
          {
            // Skip the first/last few pixels so arrows don't crowd the
            // markers. `repeat` is the gap between consecutive arrows.
            offset: 24,
            endOffset: 28,
            repeat: 40,
            symbol: L.Symbol.arrowHead({
              pixelSize: 11,
              polygon: false,
              pathOptions: {
                color: '#4ade80',
                weight: 2.5,
                opacity: 0.95,
              },
            }),
          },
        ],
      }).addTo(state.resultMap);

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

  // Country-bonus indicator. Shown only when a non-zero bonus was awarded;
  // otherwise hidden so the result card stays compact.
  const bonusEl = document.getElementById('result-bonus');
  if (bonusEl) {
    if (countryBonus > 0) {
      bonusEl.textContent = `🌍 +${countryBonus} country bonus`;
      bonusEl.classList.remove('hidden');
    } else {
      bonusEl.classList.add('hidden');
    }
  }

  document.getElementById('next-btn').textContent =
    state.round >= state.roundsPerGame ? 'See Final Score' : 'Next Round';
}

function endGame() {
  // Stop background prefetch loops as soon as the last round is scored.
  state.gameRunning = false;
  showScreen('end');
  const maxScore = state.roundsPerGame * 5000;
  document.getElementById('final-score').textContent =
    `${state.score.toLocaleString()} / ${maxScore.toLocaleString()}`;
  document.getElementById('final-rating').textContent = ratingFor(state.score, maxScore);
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
  state.actualCountryCode = null;
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

// Google Maps key field — opt-in upgrade from the bundled-Mapillary demo
// path. Stored in localStorage on input so the user doesn't have to click
// anything to save it; takes effect on the next round (and across reloads).
const googleKeyInput = document.getElementById('google-key-input');
if (googleKeyInput) {
  googleKeyInput.value = resolveGoogleKey();
  googleKeyInput.addEventListener('input', () => {
    const trimmed = googleKeyInput.value.trim();
    if (trimmed) localStorage.setItem(GOOGLE_KEY_STORAGE, trimmed);
    else localStorage.removeItem(GOOGLE_KEY_STORAGE);
  });
}

startBtn.addEventListener('click', () => {
  const typed = (apiKeyInput.value || '').trim();
  // Save typed token so the next session resolves it without reopening Settings.
  if (typed && typed !== resolveToken()) {
    localStorage.setItem(TOKEN_STORAGE, typed);
  }

  state.timerEnabled = document.getElementById('timer-toggle').checked;

  // Read + clamp the rounds input. Default falls through if the input is
  // missing, blank, or non-numeric. Demo / guest mode also respects this
  // so the user can preview a 3-round game without a real token.
  const roundsInput = document.getElementById('rounds-input');
  const rawRounds = roundsInput ? Number.parseInt(roundsInput.value, 10) : NaN;
  const clamped = Math.min(
    MAX_ROUNDS_PER_GAME,
    Math.max(
      MIN_ROUNDS_PER_GAME,
      Number.isFinite(rawRounds) ? rawRounds : DEFAULT_ROUNDS_PER_GAME,
    ),
  );
  // Read game-mode select. Falls through to 'random' on any unknown value.
  const modeSelect = document.getElementById('mode-select');
  const mode = modeSelect && modeSelect.value === 'capitals' ? 'capitals' : 'random';

  resetGame();
  state.roundsPerGame = clamped;
  state.gameMode = mode;
  // Reflect in the HUD (Round X/<total>) and demo placeholder.
  const roundTotalEl = document.getElementById('round-total');
  if (roundTotalEl) roundTotalEl.textContent = clamped;
  const demoTotalEl = document.getElementById('demo-round-total');
  if (demoTotalEl) demoTotalEl.textContent = clamped;

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
  if (state.round >= state.roundsPerGame) endGame();
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

// Guest-mode "Save & play" — the upgrade path from guest to real player
// without bouncing back to the start screen. Saves the typed token to
// localStorage, syncs the start-screen Settings input so the two views
// agree, then kicks off a fresh game with full Mapillary prefetch.
const guestTokenInput = document.getElementById('guest-token-input');
const guestSaveBtn = document.getElementById('guest-save-btn');
guestTokenInput.addEventListener('input', () => {
  guestSaveBtn.disabled = guestTokenInput.value.trim().length < 10;
});
guestSaveBtn.addEventListener('click', () => {
  const typed = guestTokenInput.value.trim();
  if (typed.length < 10) return;
  localStorage.setItem(TOKEN_STORAGE, typed);
  apiKeyInput.value = typed; // keep the start-screen Settings input in sync

  state.timerEnabled = document.getElementById('timer-toggle').checked;
  resetGame();
  primeRoundQueue();
  startRound();
});
