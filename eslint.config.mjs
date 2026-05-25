import js from '@eslint/js';

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  console: 'readonly',
  navigator: 'readonly',
};

const nodeGlobals = {
  require: 'readonly',
  module: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  Buffer: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'public/config.local.js', 'package-lock.json'],
  },
  js.configs.recommended,
  {
    // Default for public/*.js — browser globals only. Functions declared in
    // these files (lib.js helpers, locations.js LOCATIONS) become page-wide
    // globals via script-mode hoisting; consumers list them per-file below.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        // CJS dual-export shim guard in lib.js
        module: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // game.js consumes globals defined by lib.js / locations.js / config.js
    // plus the 3rd-party Leaflet (`L`) and Mapillary (`mapillary`) libs.
    files: ['public/game.js'],
    languageOptions: {
      globals: {
        L: 'readonly',
        mapillary: 'readonly',
        google: 'readonly',
        Sounds: 'readonly',
        Image: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        MAPILLARY_TOKEN: 'readonly',
        GOOGLE_MAPS_API_KEY: 'readonly',
        GOOGLE_OAUTH_CLIENT_ID: 'readonly',
        location: 'readonly',
        escape: 'readonly',
        LOCATIONS: 'readonly',
        CURATED_LOCATIONS: 'readonly',
        REGIONS: 'readonly',
        haversineDistance: 'readonly',
        calculateScore: 'readonly',
        formatDistance: 'readonly',
        ratingFor: 'readonly',
        applyCountryBonus: 'readonly',
      },
    },
  },
  {
    // locations.js declares `const LOCATIONS` for cross-file consumption.
    // ESLint can't see that usage in script-mode, so silence the warning here.
    files: ['public/locations.js'],
    rules: { 'no-unused-vars': 'off' },
  },
  {
    files: ['server.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
  {
    // Playwright specs run in Node, but `addInitScript` / `page.evaluate`
    // callbacks execute in the browser — give them browser globals too.
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        ...browserGlobals,
      },
    },
  },
];
