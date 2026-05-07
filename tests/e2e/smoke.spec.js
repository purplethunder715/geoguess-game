// Smoke tests: page load, token UX, localStorage persistence.
// No Mapillary or Esri calls — these run before any "Start" click.
const { test, expect } = require('@playwright/test');

// public/config.js is gitignored and may hold a real token on a developer's
// machine. For the "no preset token" tests we have to neuter it so the
// start screen shows the input no matter who's running the suite.
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
  test('loads with title and disabled Start button', async ({ page }) => {
    await blockConfigJs(page);
    await page.goto('/');
    await expect(page).toHaveTitle('GeoGuess');
    await expect(page.locator('h1').first()).toContainText('GeoGuess');

    const startBtn = page.locator('#start-btn');
    await expect(startBtn).toBeDisabled();
    await expect(startBtn).toHaveText('Enter token to start');
  });

  test('Start button enables once token has 10+ chars', async ({ page }) => {
    await blockConfigJs(page);
    await page.goto('/');
    const input = page.locator('#api-key-input');
    const startBtn = page.locator('#start-btn');

    await input.fill('short');
    await expect(startBtn).toBeDisabled();

    await input.fill('MLY|abc123def456');
    await expect(startBtn).toBeEnabled();
    await expect(startBtn).toHaveText('Start Game');
  });

  test('preset token in localStorage hides the input section', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('geoguess.mapillaryToken', 'MLY|preset-token-here');
    });
    await page.goto('/');
    await expect(page.locator('#api-key-section')).toBeHidden();
    await expect(page.locator('#start-btn')).toBeEnabled();
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
    await page.locator('#api-key-input').fill('MLY|user-typed-token');
    await page.locator('#start-btn').click();

    const stored = await page.evaluate(() =>
      localStorage.getItem('geoguess.mapillaryToken'),
    );
    expect(stored).toBe('MLY|user-typed-token');
  });
});
