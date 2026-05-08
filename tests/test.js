// Plain-Node test runner — no framework, just `assert`. Run with `npm test`.
// Tests cover the pure helpers in public/lib.js and the location dataset.

const assert = require('assert');
const path = require('path');

const { haversineDistance, calculateScore, formatDistance, ratingFor } = require(
  path.join('..', 'public', 'lib.js'),
);

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
