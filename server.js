// Minimal Express server: serves the static frontend on http://localhost:3000.
// All game logic (random location pick, distance, scoring) runs client-side
// because the dataset is tiny and there's no auth/persistence to protect.
const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`GeoGuess running at http://localhost:${PORT}`);
});
