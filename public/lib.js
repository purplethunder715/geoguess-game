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
  };
}
