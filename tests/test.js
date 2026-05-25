// Plain-Node test runner — no framework, just `assert`. Run with `npm test`.
// Tests cover the pure helpers in public/lib.js and the location dataset.

const assert = require('assert');
const path = require('path');

const {
  haversineDistance,
  calculateScore,
  formatDistance,
  ratingFor,
  applyCountryBonus,
  emptyStats,
  updateStats,
} = require(path.join('..', 'public', 'lib.js'));

// Load locations.js by reading + evaluating it. It defines `const LOCATIONS`,
// which we surface via a wrapping `module.exports = LOCATIONS` shim.
const fs = require('fs');
const locSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'locations.js'),
  'utf8',
);
let LOCATIONS, REGIONS;
{
  // Evaluate in a function scope so the `const` doesn't leak globally.
  const exported = new Function(locSrc + '\nreturn { LOCATIONS, REGIONS };')();
  LOCATIONS = exported.LOCATIONS;
  REGIONS = exported.REGIONS;
}

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}
function group(name, body) {
  console.log(`\n${name}`);
  body();
}

// ---------------- haversineDistance ----------------------------------------

group('haversineDistance', () => {
  test('zero distance for the same point', () => {
    assert.strictEqual(haversineDistance(0, 0, 0, 0), 0);
    assert.strictEqual(haversineDistance(40.7, -74, 40.7, -74), 0);
  });

  test('Paris -> London is ~344 km (within 5 km)', () => {
    const d = haversineDistance(48.8566, 2.3522, 51.5074, -0.1278);
    assert.ok(Math.abs(d - 344) < 5, `expected ~344, got ${d.toFixed(1)}`);
  });

  test('NYC -> LA is ~3936 km (within 20 km)', () => {
    const d = haversineDistance(40.7128, -74.006, 34.0522, -118.2437);
    assert.ok(Math.abs(d - 3936) < 20, `expected ~3936, got ${d.toFixed(1)}`);
  });

  test('antipodes are ~half Earth circumference (~20015 km)', () => {
    const d = haversineDistance(0, 0, 0, 180);
    assert.ok(Math.abs(d - 20015) < 5, `expected ~20015, got ${d.toFixed(1)}`);
  });

  test('symmetric: d(a,b) === d(b,a)', () => {
    const a = haversineDistance(35.6, 139.7, -33.8, 151.2);
    const b = haversineDistance(-33.8, 151.2, 35.6, 139.7);
    assert.ok(Math.abs(a - b) < 1e-9);
  });
});

// ---------------- calculateScore -------------------------------------------

group('calculateScore', () => {
  test('exact hit (0 km) gives 5000', () => {
    assert.strictEqual(calculateScore(0), 5000);
  });

  test('decreases monotonically as distance grows', () => {
    let prev = Infinity;
    for (const km of [10, 100, 500, 1000, 2000, 5000, 10000]) {
      const s = calculateScore(km);
      assert.ok(s < prev, `score should drop: ${km} km -> ${s} (prev ${prev})`);
      prev = s;
    }
  });

  test('1000 km is roughly half points (~3000)', () => {
    const s = calculateScore(1000);
    assert.ok(s > 2900 && s < 3100, `expected ~3000, got ${s}`);
  });

  test('huge distance bottoms out at 0', () => {
    assert.strictEqual(calculateScore(1e9), 0);
  });

  test('null / negative / NaN distances score 0 (no crash)', () => {
    assert.strictEqual(calculateScore(null), 0);
    assert.strictEqual(calculateScore(undefined), 0);
    assert.strictEqual(calculateScore(-50), 0);
    assert.strictEqual(calculateScore(NaN), 0);
  });
});

// ---------------- formatDistance -------------------------------------------

group('formatDistance', () => {
  test('sub-kilometer renders as meters', () => {
    assert.strictEqual(formatDistance(0.05), '50 m');
    assert.strictEqual(formatDistance(0.999), '999 m');
  });

  test('1 km and above renders as km, rounded', () => {
    assert.strictEqual(formatDistance(1.4), '1 km');
    assert.strictEqual(formatDistance(1234.56), (1235).toLocaleString() + ' km');
  });

  test('null / undefined render as empty string', () => {
    assert.strictEqual(formatDistance(null), '');
    assert.strictEqual(formatDistance(undefined), '');
  });
});

// ---------------- ratingFor ------------------------------------------------

group('ratingFor', () => {
  test('hits each bucket boundary at default 25000-max', () => {
    assert.strictEqual(ratingFor(25000), 'World traveler!');
    assert.strictEqual(ratingFor(22500), 'World traveler!');
    assert.strictEqual(ratingFor(22499), 'Geography buff');
    assert.strictEqual(ratingFor(17500), 'Geography buff');
    assert.strictEqual(ratingFor(12500), 'Decent navigator');
    assert.strictEqual(ratingFor(7500), 'Getting there...');
    assert.strictEqual(ratingFor(0), 'Keep exploring!');
  });

  test('scales with custom maxScore (configurable round count)', () => {
    // 10-round game → max 50000. Same percentages as the default suite.
    assert.strictEqual(ratingFor(50000, 50000), 'World traveler!');
    assert.strictEqual(ratingFor(45000, 50000), 'World traveler!'); // 90%
    assert.strictEqual(ratingFor(34999, 50000), 'Decent navigator'); // <70%
    assert.strictEqual(ratingFor(25000, 50000), 'Decent navigator'); // 50%
    assert.strictEqual(ratingFor(15000, 50000), 'Getting there...'); // 30%
    assert.strictEqual(ratingFor(0, 50000), 'Keep exploring!');
  });

  test('zero or negative max defaults to lowest bucket', () => {
    assert.strictEqual(ratingFor(100, 0), 'Keep exploring!');
    assert.strictEqual(ratingFor(100, -1), 'Keep exploring!');
  });
});

// ---------------- applyCountryBonus ----------------------------------------

group('applyCountryBonus', () => {
  test('zero when countries differ', () => {
    assert.strictEqual(applyCountryBonus(3000, false), 0);
    assert.strictEqual(applyCountryBonus(0, false), 0);
  });

  test('full bonus when score has headroom under cap', () => {
    assert.strictEqual(applyCountryBonus(3000, true), 50);
    assert.strictEqual(applyCountryBonus(0, true), 50);
    assert.strictEqual(applyCountryBonus(4949, true), 50);
  });

  test('clamps so total never exceeds 5000', () => {
    assert.strictEqual(applyCountryBonus(4990, true), 10);
    assert.strictEqual(applyCountryBonus(5000, true), 0);
    // calculateScore can return at most 5000, but be defensive against
    // future caller bugs that pass something higher.
    assert.strictEqual(applyCountryBonus(5500, true), 0);
  });

  test('honours custom bonus + maxPerRound parameters', () => {
    // 100-point bonus capped at 6000-per-round.
    assert.strictEqual(applyCountryBonus(5000, true, 100, 6000), 100);
    assert.strictEqual(applyCountryBonus(5950, true, 100, 6000), 50);
  });
});

// ---------------- updateStats ----------------------------------------------

group('updateStats', () => {
  test('first game seeds counts from an empty/undefined prev', () => {
    const { stats, isBestEver, isBestForLength } = updateStats(undefined, {
      score: 12000,
      maxScore: 25000,
      rounds: 5,
      mode: 'random',
      streak: 2,
      at: 1000,
    });
    assert.strictEqual(stats.gamesPlayed, 1);
    assert.strictEqual(stats.totalScore, 12000);
    assert.strictEqual(stats.bestScore, 12000);
    assert.strictEqual(stats.bestByRounds['5'], 12000);
    assert.strictEqual(stats.bestStreak, 2);
    assert.strictEqual(stats.history.length, 1);
    assert.ok(isBestEver && isBestForLength);
  });

  test('accumulates and tracks best-ever vs best-for-length separately', () => {
    let { stats } = updateStats(undefined, {
      score: 20000,
      maxScore: 25000,
      rounds: 5,
      streak: 3,
    });
    // A lower-scoring 10-round game: not best-ever, but best for 10 rounds.
    const r = updateStats(stats, { score: 18000, maxScore: 50000, rounds: 10, streak: 1 });
    assert.strictEqual(r.stats.gamesPlayed, 2);
    assert.strictEqual(r.stats.totalScore, 38000);
    assert.strictEqual(r.stats.bestScore, 20000); // unchanged
    assert.strictEqual(r.stats.bestByRounds['10'], 18000);
    assert.strictEqual(r.stats.bestStreak, 3); // max(3,1)
    assert.strictEqual(r.isBestEver, false);
    assert.strictEqual(r.isBestForLength, true);
  });

  test('does not mutate the previous object (pure)', () => {
    const prev = emptyStats();
    const frozen = JSON.stringify(prev);
    updateStats(prev, { score: 5000, maxScore: 25000, rounds: 5 });
    assert.strictEqual(JSON.stringify(prev), frozen);
  });

  test('history is newest-first and capped at 10', () => {
    let stats = emptyStats();
    for (let i = 1; i <= 12; i++) {
      stats = updateStats(stats, { score: i * 100, maxScore: 25000, rounds: 5, at: i }).stats;
    }
    assert.strictEqual(stats.history.length, 10);
    assert.strictEqual(stats.history[0].at, 12); // newest first
    assert.strictEqual(stats.gamesPlayed, 12);
  });
});

// ---------------- locations.js dataset --------------------------------------

group('LOCATIONS dataset', () => {
  test('has at least 5 entries (one full game without repeats)', () => {
    assert.ok(Array.isArray(LOCATIONS));
    assert.ok(LOCATIONS.length >= 5, `only ${LOCATIONS.length} entries`);
  });

  test('every entry has valid lat/lng/name', () => {
    for (const loc of LOCATIONS) {
      assert.ok(
        typeof loc.name === 'string' && loc.name.length > 0,
        `bad name: ${JSON.stringify(loc)}`,
      );
      assert.ok(loc.lat >= -90 && loc.lat <= 90, `bad lat in ${loc.name}: ${loc.lat}`);
      assert.ok(loc.lng >= -180 && loc.lng <= 180, `bad lng in ${loc.name}: ${loc.lng}`);
    }
  });

  test('no two entries share identical coords', () => {
    const seen = new Set();
    for (const loc of LOCATIONS) {
      const k = `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
      assert.ok(!seen.has(k), `duplicate coords near ${loc.name}`);
      seen.add(k);
    }
  });
});

// ---------------- REGIONS dataset ------------------------------------------

group('REGIONS dataset', () => {
  test('has at least one region', () => {
    assert.ok(Array.isArray(REGIONS));
    assert.ok(REGIONS.length >= 1, `only ${REGIONS.length} regions`);
  });

  test('every region has valid name and bbox', () => {
    for (const r of REGIONS) {
      assert.ok(
        typeof r.name === 'string' && r.name.length > 0,
        `bad name: ${JSON.stringify(r)}`,
      );
      assert.ok(
        r.latMin >= -90 && r.latMin <= 90,
        `bad latMin in ${r.name}: ${r.latMin}`,
      );
      assert.ok(
        r.latMax >= -90 && r.latMax <= 90,
        `bad latMax in ${r.name}: ${r.latMax}`,
      );
      assert.ok(
        r.lngMin >= -180 && r.lngMin <= 180,
        `bad lngMin in ${r.name}: ${r.lngMin}`,
      );
      assert.ok(
        r.lngMax >= -180 && r.lngMax <= 180,
        `bad lngMax in ${r.name}: ${r.lngMax}`,
      );
      // pickFromRegions samples uniformly inside; an inverted bbox would
      // generate points outside the named region.
      assert.ok(r.latMin < r.latMax, `latMin >= latMax in ${r.name}`);
      assert.ok(r.lngMin < r.lngMax, `lngMin >= lngMax in ${r.name}`);
    }
  });
});

// ---------------- summary --------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
