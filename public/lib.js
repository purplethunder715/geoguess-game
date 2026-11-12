// Pure helpers shared by the browser game and the Node test runner.
// No DOM, no globals — safe to require() from tests.

// Great-circle distance between two lat/lng points, in kilometers.
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Score for one round: 5000 at 0 km, decays exponentially.
// 5000 * exp(-distance_km / 2000): ~3000 at 1000 km, ~410 at 5000 km, 0 floor.
function calculateScore(distanceKm) {
  if (distanceKm == null || !isFinite(distanceKm) || distanceKm < 0) return 0;
  return Math.max(0, Math.round(5000 * Math.exp(-distanceKm / 2000)));
}

// Format a distance for display: meters under 1 km, else rounded km.
function formatDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

// Country-match bonus added on top of the haversine score when the user's
// guess lands in the same country as the actual photo. Capped so
// `distancePoints + bonus` never exceeds `maxPerRound` (default 5000).
function applyCountryBonus(distancePoints, sameCountry, bonus = 50, maxPerRound = 5000) {
  if (!sameCountry) return 0;
  return Math.max(0, Math.min(bonus, maxPerRound - distancePoints));
}

// Final-game rating buckets keyed off the score-as-fraction-of-max so the
// thresholds scale with `roundsPerGame`. Default `maxScore` of 25000 keeps
// the legacy 5-round numbers intact for the existing unit tests.
function ratingFor(totalScore, maxScore = 25000) {
  if (maxScore <= 0) return 'Keep exploring!';
  const pct = totalScore / maxScore;
  if (pct >= 0.9) return 'World traveler!';
  if (pct >= 0.7) return 'Geography buff';
  if (pct >= 0.5) return 'Decent navigator';
  if (pct >= 0.3) return 'Getting there...';
  return 'Keep exploring!';
}

// ---------------------------------------------------------------------
// Player stats — pure reducer over a localStorage-persisted object.
// ---------------------------------------------------------------------

// Shape of a fresh stats object. Kept here so both the reducer and any
// reader agree on the schema.
function emptyStats() {
  return {
    gamesPlayed: 0,
    totalScore: 0,
    bestScore: 0,
    bestByRounds: {}, // { "5": 21000, "10": 38000, ... }
    bestStreak: 0, // longest run of same-country guesses across all games
    history: [], // most-recent-first list of { score, maxScore, rounds, mode, at }
  };
}

// Merge one finished game into a stats object. Pure — returns a NEW object,
// never mutates `prev`. `game` is { score, maxScore, rounds, mode, streak, at }.
// Returns { stats, isBestEver, isBestForLength } so the caller can show a
// "new personal best" badge.
function updateStats(prev, game) {
  const s = prev && typeof prev === 'object' ? prev : emptyStats();
  const next = {
    gamesPlayed: (s.gamesPlayed || 0) + 1,
    totalScore: (s.totalScore || 0) + (game.score || 0),
    bestScore: Math.max(s.bestScore || 0, game.score || 0),
    bestByRounds: { ...(s.bestByRounds || {}) },
    bestStreak: Math.max(s.bestStreak || 0, game.streak || 0),
    history: [],
  };
  const key = String(game.rounds);
  const prevForLength = (s.bestByRounds || {})[key] || 0;
  next.bestByRounds[key] = Math.max(prevForLength, game.score || 0);

  const entry = {
    score: game.score || 0,
    maxScore: game.maxScore || 0,
    rounds: game.rounds || 0,
    mode: game.mode || 'random',
    at: game.at || Date.now(),
  };
  // Keep the 10 most recent games, newest first.
  next.history = [entry, ...(Array.isArray(s.history) ? s.history : [])].slice(0, 10);

  return {
    stats: next,
    isBestEver: (game.score || 0) > (s.bestScore || 0),
    isBestForLength: (game.score || 0) > prevForLength,
  };
}

// Fraction of One-country picks that jitter around the capital instead of
// sampling the whole bbox. Capitals almost always have street-level
// coverage; uniform bbox samples give variety but miss often in big,
// sparsely-covered countries.
const COUNTRY_CAPITAL_BIAS = 0.5;
// Max jitter (degrees, each axis) for capital-biased picks — ~25 km.
const COUNTRY_CAPITAL_JITTER_DEG = 0.25;

// Random point for "One country" mode. `country` is a COUNTRIES entry
// (countries.js); `rng` is injectable so tests can make it deterministic.
// Capital-biased picks are clamped to the bbox so tiny states (Vatican,
// Monaco) never sample outside their own borders.
function samplePointInCountry(country, rng = Math.random) {
  let lat, lng;
  if (rng() < COUNTRY_CAPITAL_BIAS) {
    lat = country.lat + (rng() * 2 - 1) * COUNTRY_CAPITAL_JITTER_DEG;
    lng = country.lng + (rng() * 2 - 1) * COUNTRY_CAPITAL_JITTER_DEG;
    lat = Math.min(country.latMax, Math.max(country.latMin, lat));
    lng = Math.min(country.lngMax, Math.max(country.lngMin, lng));
  } else {
    lat = country.latMin + rng() * (country.latMax - country.latMin);
    lng = country.lngMin + rng() * (country.lngMax - country.lngMin);
  }
  return { lat, lng, name: `Somewhere in ${country.name}` };
}

// Random point in a ring (annulus) between minKm and maxKm from a center,
// uniform by AREA — r = sqrt(u·(max²−min²)+min²) — so picks don't bunch
// up at the inner edge. Flat-earth offset is fine at these distances
// (<1% error under ~50 km). Used by Capitals mode to start rounds near,
// but not exactly on, each capital.
const KM_PER_DEG_LAT = 111.32;
function randomPointInRing(lat, lng, minKm, maxKm, rng = Math.random) {
  const r = Math.sqrt(rng() * (maxKm * maxKm - minKm * minKm) + minKm * minKm);
  const theta = rng() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / KM_PER_DEG_LAT;
  const dLng = (r * Math.sin(theta)) / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  let outLng = lng + dLng;
  if (outLng > 180) outLng -= 360;
  if (outLng < -180) outLng += 360;
  return { lat: lat + dLat, lng: outLng };
}

// Capitals mode: radius (km) to treat as "inside the city" when a
// COUNTRIES entry has no explicit cityKm.
const DEFAULT_CITY_KM = 5;
function cityRadiusKm(country) {
  return country && country.cityKm > 0 ? country.cityKm : DEFAULT_CITY_KM;
}

// Dual export: CommonJS for Node tests, window globals for the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversineDistance,
    calculateScore,
    formatDistance,
    ratingFor,
    applyCountryBonus,
    emptyStats,
    updateStats,
    samplePointInCountry,
    randomPointInRing,
    cityRadiusKm,
  };
}
