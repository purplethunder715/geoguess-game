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

// Dual export: CommonJS for Node tests, window globals for the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { haversineDistance, calculateScore, formatDistance, ratingFor };
}
