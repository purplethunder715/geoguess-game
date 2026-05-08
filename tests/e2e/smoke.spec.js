// Smoke tests: page load, token UX, settings panel, guest-mode entry,
// localStorage persistence. No real Mapillary or Esri calls anywhere.
const { test, expect } = require('@playwright/test');

// public/config.js is gitignored and may hold a real token on a developer's
// machine. For "no preset token" tests we neuter it so the start screen
// behaves as it would for a guest who hasn't configured anything.
async function blockConfigJs(page) {
  await page.route('**/config.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'const MAPILLARY_TOKEN = "";',
    }),
  );
}

test.describe('Start screen', () => {
  test('loads with title and an always-enabled Start button', async ({ page }) => {
    await blockConfigJs(page);
    await page.goto('/');
    await expect(page).toHaveTitle('GeoGuess');
    await expect(page.locator('h1').first()).toContainText('GeoGuess');

    const startBtn = page.locator('#start-btn');
    await expect(startBtn).toBeEnabled();
    // No token configured → guest-entry label.
    await expect(startBtn).toHaveText('Start as guest');
  });

  test('Start button label flips to "Start Game" once token is 10+ chars', async ({
    page,
  }) => {
    await blockConfigJs(page);
    await page.goto('/');
    const startBtn = page.locator('#start-btn');

    // Open settings to reach the input.
    await page.locator('#settings-toggle').click();
    const input = page.locator('#api-key-input');

    await input.fill('short');
    await expect(startBtn).toHaveText('Start as guest');
    await expect(startBtn).toBeEnabled();

    await input.fill('MLY|abc123def456');
    await expect(startBtn).toHaveText('Start Game');
    await expect(startBtn).toBeEnabled();
  });

  test('Settings toggle shows/hides the token panel', async ({ page }) => {
    await blockConfigJs(page);
    await page.goto('/');

    const panel = page.locator('#settings-panel');
    await expect(panel).toBeHidden();

    await page.locator('#settings-toggle').click();
    await expect(panel).toBeVisible();
    await expect(page.locator('#api-key-input')).toBeVisible();

    await page.locator('#settings-toggle').click();
    await expect(panel).toBeHidden();
  });

  test('preset token pre-fills the Settings input and gives "Start Game" label', async ({
    page,
  }) => {
    // The committed config.js holds a real demo token; for "what does
    // localStorage do" coverage we have to neuter it so the resolveToken
    // priority order falls through to localStorage.
    await blockConfigJs(page);
    await page.addInitScript(() => {
      localStorage.setItem('geoguess.mapillaryToken', 'MLY|preset-token-here');
    });
    await page.goto('/');

    await expect(page.locator('#start-btn')).toHaveText('Start Game');
    // Settings stays collapsed by default — token is just available to use.
    await expect(page.locator('#settings-panel')).toBeHidden();

    // When the user opens Settings, the input is pre-filled with the token.
    await page.locator('#settings-toggle').click();
    await expect(page.locator('#api-key-input')).toHaveValue('MLY|preset-token-here');
  });

  test('typed token persists to localStorage on Start', async ({ page }) => {
    await blockConfigJs(page);
    // Block Mapillary so Start doesn't actually try to fetch (we abort early).
    await page.route('**/graph.mapillary.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"data":[]}',
      }),
    );
    await page.route('**/unpkg.com/mapillary-js@**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );
    await page.addInitScript(() => {
      window.mapillary = { Viewer: class {} };
    });

    await page.goto('/');
    await page.locator('#settings-toggle').click();
    await page.locator('#api-key-input').fill('MLY|user-typed-token');
    await page.locator('#start-btn').click();

    const stored = await page.evaluate(() =>
      localStorage.getItem('geoguess.mapillaryToken'),
    );
    expect(stored).toBe('MLY|user-typed-token');
  });
});

test.describe('Guest mode', () => {
  test('Start without a token enters demo mode with a round indicator', async ({
    page,
  }) => {
    await blockConfigJs(page);
    // Block Esri so the guess map doesn't burn CDN bandwidth in CI; Leaflet
    // still handles the layout. (No Mapillary calls fire — guest/demo mode
    // skips primeRoundQueue entirely and uses DEMO_ROUNDS data.)
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await expect(page.locator('#start-btn')).toHaveText('Start as guest');
    await page.locator('#start-btn').click();

    await expect(page.locator('#game-screen')).toBeVisible();
    await expect(page.locator('#guest-placeholder')).toBeVisible();
    await expect(page.locator('#guest-placeholder h2')).toContainText('Demo round');
    await expect(page.locator('#demo-round-num')).toHaveText('1');

    // Hint must be populated — a guess without any clue isn't a game.
    const hint = await page.locator('#demo-hint').textContent();
    expect(hint && hint.trim().length).toBeGreaterThan(0);

    // Submit is initially "Place a pin" disabled, then enables after a pin
    // drop — same flow as a real round, just against canned demo data.
    const guessBtn = page.locator('#guess-btn');
    await expect(guessBtn).toBeDisabled();
    await expect(guessBtn).toHaveText('Place a pin to guess');
  });

  test('Back-to-start from guest placeholder returns to start screen', async ({
    page,
  }) => {
    await blockConfigJs(page);
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await page.locator('#start-btn').click();
    await expect(page.locator('#guest-placeholder')).toBeVisible();

    await page.locator('#back-to-start-btn').click();
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#game-screen')).toBeHidden();
    await expect(page.locator('#guest-placeholder')).toBeHidden();
  });

  test('Guest "Save & play" button stays disabled until token is 10+ chars', async ({
    page,
  }) => {
    await blockConfigJs(page);
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await page.locator('#start-btn').click();

    const input = page.locator('#guest-token-input');
    const save = page.locator('#guest-save-btn');

    await expect(save).toBeDisabled();

    await input.fill('short');
    await expect(save).toBeDisabled();

    await input.fill('MLY|abc123def456');
    await expect(save).toBeEnabled();
  });

  test('Demo round: drop pin → Submit → result shows distance + score', async ({
    page,
  }) => {
    await blockConfigJs(page);
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await page.locator('#start-btn').click();
    await expect(page.locator('#guest-placeholder')).toBeVisible();

    // Wait for initGuessMap's setTimeout(50) to fire — without this, on
    // slower runners (CI) the click can land before Leaflet's click
    // handler is attached, silently no-op'ing the pin drop.
    await expect(page.locator('#guess-btn')).toHaveText('Place a pin to guess');

    // Drop a pin and submit — same path as a real round, scored against
    // DEMO_ROUNDS[0] (Eiffel Tower) via Haversine.
    await page.locator('#guess-map').click({ position: { x: 80, y: 80 } });
    const guessBtn = page.locator('#guess-btn');
    await expect(guessBtn).toBeEnabled();
    await expect(guessBtn).toHaveText('Submit Guess');
    await guessBtn.click();

    // Result screen with a real score + distance line.
    await expect(page.locator('#result-screen')).toBeVisible();
    await expect(page.locator('#result-title')).toContainText('points');
    await expect(page.locator('#result-distance')).toContainText('away');
    await expect(page.locator('#result-location')).toContainText('Eiffel Tower');
  });

  test('Demo: full 5-round playthrough → end screen → Play Again resets', async ({
    page,
  }) => {
    await blockConfigJs(page);
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await page.locator('#start-btn').click();
    await expect(page.locator('#guest-placeholder')).toBeVisible();

    const hints = [];
    for (let round = 1; round <= 5; round++) {
      await expect(page.locator('#demo-round-num')).toHaveText(String(round));
      await expect(page.locator('#round-num')).toHaveText(String(round));

      const hint = (await page.locator('#demo-hint').textContent())?.trim();
      expect(hint && hint.length).toBeGreaterThan(0);
      hints.push(hint);

      // Wait for the round's guess map to be wired up — startRound defers
      // initGuessMap via setTimeout(50), and clicking #guess-map before
      // Leaflet's click handler is attached silently no-ops the pin drop.
      // The "Place a pin to guess" text is set inside initGuessMap, so
      // asserting it forces the test to sync with that timeout.
      await expect(page.locator('#guess-btn')).toHaveText('Place a pin to guess');

      // Drop pin → Submit → result screen
      await page.locator('#guess-map').click({ position: { x: 80, y: 80 } });
      await expect(page.locator('#guess-btn')).toBeEnabled();
      await page.locator('#guess-btn').click();
      await expect(page.locator('#result-screen')).toBeVisible();

      // Round 1-4: "Next Round". Round 5: "See Final Score".
      const nextBtn = page.locator('#next-btn');
      await expect(nextBtn).toHaveText(round < 5 ? 'Next Round' : 'See Final Score');
      await nextBtn.click();
    }

    // After round 5's "See Final Score" → end screen with bucket rating
    await expect(page.locator('#end-screen')).toBeVisible();
    await expect(page.locator('#final-score')).toContainText('/ 25,000');
    const rating = (await page.locator('#final-rating').textContent())?.trim();
    expect(rating && rating.length).toBeGreaterThan(0);

    // All 5 hints should be unique — proves DEMO_ROUNDS is iterated per round.
    expect(new Set(hints).size).toBe(5);

    // Play Again → start screen, back in guest state
    await page.locator('#restart-btn').click();
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#start-btn')).toHaveText('Start as guest');
  });

  test('Demo + timer toggle: timer HUD visible and starts at 60', async ({ page }) => {
    await blockConfigJs(page);
    await page.route('**/server.arcgisonline.com/**', (route) =>
      route.fulfill({ status: 200, body: '' }),
    );

    await page.goto('/');
    await page.locator('#timer-toggle').check();
    await page.locator('#start-btn').click();

    await expect(page.locator('#guest-placeholder')).toBeVisible();
    await expect(page.locator('#timer-hud')).toBeVisible();
    await expect(page.locator('#timer')).toHaveText('60');
  });
});
