// Full game-flow e2e with every external dep mocked. We never hit
// graph.mapillary.com, never load mapillary-js from CDN, never load Esri
// tiles. Mapillary token quota is finite — keep this true.
const { test, expect } = require('@playwright/test');

const PARIS = [2.2945, 48.8584]; // [lng, lat] — Mapillary's coordinate order

async function mockExternalsAndStubViewer(page) {
  // Block the mapillary-js library + CSS — we provide our own stub Viewer.
  await page.route('**/unpkg.com/mapillary-js@**', (route) =>
    route.fulfill({ status: 200, body: '' }),
  );
  // Block Esri tile + label requests — Leaflet still handles clicks without tiles.
  await page.route('**/server.arcgisonline.com/**', (route) =>
    route.fulfill({ status: 200, body: '' }),
  );
  // Neuter public/config.local.js: on the dev's machine it sets a real
  // GOOGLE_MAPS_API_KEY, which would route the test through the Google
  // Street View path. We don't mock google.maps here, so let the test
  // stay on the Mapillary path by stubbing the file empty.
  await page.route('**/config.local.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'const GOOGLE_MAPS_API_KEY = "";',
    }),
  );
  // Mock Mapillary Graph API: return ≥4 panos in the same `sequence`,
  // matching the production filter that requires walkable sequences (so the
  // user gets ≥3 navigation arrows). Same coords for all — coords don't
  // matter to scoring here, only that the round actually advances.
  await page.route('**/graph.mapillary.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'mock-1', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
          { id: 'mock-2', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
          { id: 'mock-3', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
          { id: 'mock-4', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
        ],
      }),
    }),
  );
  // Stub `window.mapillary.Viewer` before any page script runs.
  await page.addInitScript(() => {
    window.mapillary = {
      Viewer: class {
        constructor() {}
        moveTo() {
          return Promise.resolve();
        }
        remove() {}
      },
    };
    // Preset a token so the Start screen skips the input.
    localStorage.setItem('geoguess.mapillaryToken', 'MLY|fake-test-token');
  });
}

test.describe('Game flow (mocked Mapillary)', () => {
  test('Start → drop pin → Submit shows result with score', async ({ page }) => {
    await mockExternalsAndStubViewer(page);
    await page.goto('/');

    await expect(page.locator('#start-btn')).toBeEnabled();
    await page.locator('#start-btn').click();

    // Game screen visible, round 1 of 5
    await expect(page.locator('#game-screen')).toBeVisible();
    await expect(page.locator('#round-num')).toHaveText('1');

    // Click on the guess map — Leaflet's click handler enables Submit.
    // Wait for initGuessMap's setTimeout(50) to fire by syncing on the
    // button text it sets, otherwise the click can race the handler
    // attachment on slower runners.
    const guessMap = page.locator('#guess-map');
    await expect(guessMap).toBeVisible();
    await expect(page.locator('#guess-btn')).toHaveText('Place a pin to guess');
    await guessMap.click({ position: { x: 80, y: 80 } });

    const guessBtn = page.locator('#guess-btn');
    await expect(guessBtn).toBeEnabled();
    await expect(guessBtn).toHaveText('Submit Guess');
    await guessBtn.click();

    // Result screen with a points line + distance
    await expect(page.locator('#result-screen')).toBeVisible();
    await expect(page.locator('#result-title')).toContainText('points');
    await expect(page.locator('#result-distance')).toContainText('away');
  });

  test('timer toggle adds the timer HUD when enabled', async ({ page }) => {
    await mockExternalsAndStubViewer(page);
    await page.goto('/');

    await page.locator('#timer-toggle').check();
    await page.locator('#start-btn').click();

    await expect(page.locator('#game-screen')).toBeVisible();
    const timerHud = page.locator('#timer-hud');
    await expect(timerHud).toBeVisible();
    // Should start at ROUND_SECONDS = 60
    await expect(page.locator('#timer')).toHaveText('60');
  });

  test('Guest can save a token in-place and the real game starts', async ({ page }) => {
    // Same mocks as the happy path, but DO NOT preset a token. The user
    // arrives as a guest, sees the placeholder, then upgrades from there.
    await page.route('**/unpkg.com/mapillary-js@**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );
    await page.route('**/graph.mapillary.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'mock-1', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
            { id: 'mock-2', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
            { id: 'mock-3', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
            { id: 'mock-4', geometry: { coordinates: PARIS }, sequence: 'mock-seq' },
          ],
        }),
      }),
    );
    await page.route('**/config.js', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: 'const MAPILLARY_TOKEN = "";',
      }),
    );
    await page.addInitScript(() => {
      window.mapillary = {
        Viewer: class {
          constructor() {}
          moveTo() {
            return Promise.resolve();
          }
          remove() {}
        },
      };
    });

    await page.goto('/');
    await expect(page.locator('#start-btn')).toHaveText('Start as guest');
    await page.locator('#start-btn').click();

    // Land in guest mode
    await expect(page.locator('#guest-placeholder')).toBeVisible();

    // Paste a token + save → real game starts, placeholder hides
    await page.locator('#guest-token-input').fill('MLY|guest-paste-token');
    await page.locator('#guest-save-btn').click();

    await expect(page.locator('#guest-placeholder')).toBeHidden();
    await expect(page.locator('#round-num')).toHaveText('1');

    // Submit becomes available after a pin drop (no longer "Demo only").
    // Sync on initGuessMap's setTimeout(50) via the button text it sets.
    await expect(page.locator('#guess-btn')).toHaveText('Place a pin to guess');
    await page.locator('#guess-map').click({ position: { x: 80, y: 80 } });
    const guessBtn = page.locator('#guess-btn');
    await expect(guessBtn).toBeEnabled();
    await expect(guessBtn).toHaveText('Submit Guess');

    // Token persisted to localStorage for next session
    const stored = await page.evaluate(() =>
      localStorage.getItem('geoguess.mapillaryToken'),
    );
    expect(stored).toBe('MLY|guest-paste-token');
  });
});
