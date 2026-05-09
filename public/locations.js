// Two location sources:
//
//  1. CURATED_LOCATIONS — hand-picked cities with strong Mapillary coverage.
//     Each entry has a recognizable `name` that's shown on the result screen.
//     Entries with `isCapital: true` are surfaced through CAPITAL_LOCATIONS
//     and used by the start-screen "Capitals only" mode.
//
//  2. REGIONS — country-level bounding boxes. We generate random lat/lng
//     points inside them on demand, giving an effectively unlimited pool
//     of starting spots while keeping picks inside Mapillary-friendly areas.
//
// pickRandomLocation() (in game.js) blends both: ~15% curated for name
// recognition, ~85% region-random for variety. "Capitals only" mode skips
// the region path entirely and pulls only from the capitals subset.

const CURATED_LOCATIONS = [
  // --- Europe ---
  { lat: 48.8584, lng: 2.2945,   name: 'Paris, France',                isCapital: true },
  { lat: 45.764,  lng: 4.8357,   name: 'Lyon, France' },
  { lat: 43.7102, lng: 7.262,    name: 'Nice, France' },
  { lat: 43.2965, lng: 5.3698,   name: 'Marseille, France' },
  { lat: 47.2184, lng: -1.5536,  name: 'Nantes, France' },
  { lat: 51.5007, lng: -0.1246,  name: 'London, UK',                   isCapital: true },
  { lat: 53.4808, lng: -2.2426,  name: 'Manchester, UK' },
  { lat: 55.9533, lng: -3.1883,  name: 'Edinburgh, UK' },
  { lat: 51.4816, lng: -3.1791,  name: 'Cardiff, UK' },
  { lat: 53.3498, lng: -6.2603,  name: 'Dublin, Ireland',              isCapital: true },
  { lat: 52.52,   lng: 13.405,   name: 'Berlin, Germany',              isCapital: true },
  { lat: 48.1351, lng: 11.582,   name: 'Munich, Germany' },
  { lat: 53.5511, lng: 9.9937,   name: 'Hamburg, Germany' },
  { lat: 50.9375, lng: 6.9603,   name: 'Cologne, Germany' },
  { lat: 50.1109, lng: 8.6821,   name: 'Frankfurt, Germany' },
  { lat: 41.8902, lng: 12.4922,  name: 'Rome, Italy',                  isCapital: true },
  { lat: 45.4642, lng: 9.19,     name: 'Milan, Italy' },
  { lat: 43.7696, lng: 11.2558,  name: 'Florence, Italy' },
  { lat: 45.4408, lng: 12.3155,  name: 'Venice, Italy' },
  { lat: 40.8518, lng: 14.2681,  name: 'Naples, Italy' },
  { lat: 40.4168, lng: -3.7038,  name: 'Madrid, Spain',                isCapital: true },
  { lat: 41.3851, lng: 2.1734,   name: 'Barcelona, Spain' },
  { lat: 37.3891, lng: -5.9845,  name: 'Seville, Spain' },
  { lat: 39.4699, lng: -0.3763,  name: 'Valencia, Spain' },
  { lat: 38.7223, lng: -9.1393,  name: 'Lisbon, Portugal',             isCapital: true },
  { lat: 41.1579, lng: -8.6291,  name: 'Porto, Portugal' },
  { lat: 52.3676, lng: 4.9041,   name: 'Amsterdam, Netherlands',       isCapital: true },
  { lat: 51.9244, lng: 4.4777,   name: 'Rotterdam, Netherlands' },
  { lat: 50.8503, lng: 4.3517,   name: 'Brussels, Belgium',            isCapital: true },
  { lat: 51.2194, lng: 4.4025,   name: 'Antwerp, Belgium' },
  { lat: 47.3769, lng: 8.5417,   name: 'Zurich, Switzerland' },
  { lat: 46.2044, lng: 6.1432,   name: 'Geneva, Switzerland' },
  { lat: 48.2082, lng: 16.3738,  name: 'Vienna, Austria',              isCapital: true },
  { lat: 47.8095, lng: 13.055,   name: 'Salzburg, Austria' },
  { lat: 50.0875, lng: 14.4213,  name: 'Prague, Czech Republic',       isCapital: true },
  { lat: 52.2297, lng: 21.0122,  name: 'Warsaw, Poland',               isCapital: true },
  { lat: 50.0647, lng: 19.945,   name: 'Krakow, Poland' },
  { lat: 47.4979, lng: 19.0402,  name: 'Budapest, Hungary',            isCapital: true },
  { lat: 59.3293, lng: 18.0686,  name: 'Stockholm, Sweden',            isCapital: true },
  { lat: 57.7089, lng: 11.9746,  name: 'Gothenburg, Sweden' },
  { lat: 59.9139, lng: 10.7522,  name: 'Oslo, Norway',                 isCapital: true },
  { lat: 60.3913, lng: 5.3221,   name: 'Bergen, Norway' },
  { lat: 55.6761, lng: 12.5683,  name: 'Copenhagen, Denmark',          isCapital: true },
  { lat: 60.1699, lng: 24.9384,  name: 'Helsinki, Finland',            isCapital: true },
  { lat: 64.1466, lng: -21.9426, name: 'Reykjavik, Iceland',           isCapital: true },
  { lat: 37.9838, lng: 23.7275,  name: 'Athens, Greece',               isCapital: true },
  { lat: 41.0082, lng: 28.9784,  name: 'Istanbul, Turkey' },
  // --- North America ---
  { lat: 40.758,  lng: -73.9855, name: 'New York, USA' },
  { lat: 34.0522, lng: -118.2437,name: 'Los Angeles, USA' },
  { lat: 37.7749, lng: -122.4194,name: 'San Francisco, USA' },
  { lat: 41.8781, lng: -87.6298, name: 'Chicago, USA' },
  { lat: 38.9072, lng: -77.0369, name: 'Washington DC, USA',           isCapital: true },
  { lat: 42.3601, lng: -71.0589, name: 'Boston, USA' },
  { lat: 47.6062, lng: -122.3321,name: 'Seattle, USA' },
  { lat: 45.5152, lng: -122.6784,name: 'Portland OR, USA' },
  { lat: 39.7392, lng: -104.9903,name: 'Denver, USA' },
  { lat: 25.7617, lng: -80.1918, name: 'Miami, USA' },
  { lat: 29.7604, lng: -95.3698, name: 'Houston, USA' },
  { lat: 30.2672, lng: -97.7431, name: 'Austin, USA' },
  { lat: 36.1699, lng: -115.1398,name: 'Las Vegas, USA' },
  { lat: 33.4484, lng: -112.074, name: 'Phoenix, USA' },
  { lat: 32.7157, lng: -117.1611,name: 'San Diego, USA' },
  { lat: 39.9526, lng: -75.1652, name: 'Philadelphia, USA' },
  { lat: 33.749,  lng: -84.388,  name: 'Atlanta, USA' },
  { lat: 36.1627, lng: -86.7816, name: 'Nashville, USA' },
  { lat: 29.9511, lng: -90.0715, name: 'New Orleans, USA' },
  { lat: 43.6532, lng: -79.3832, name: 'Toronto, Canada' },
  { lat: 45.5017, lng: -73.5673, name: 'Montreal, Canada' },
  { lat: 49.2827, lng: -123.1207,name: 'Vancouver, Canada' },
  { lat: 51.0447, lng: -114.0719,name: 'Calgary, Canada' },
  { lat: 19.4326, lng: -99.1332, name: 'Mexico City, Mexico',          isCapital: true },
  // --- South America ---
  { lat: -22.9519,lng: -43.2105, name: 'Rio de Janeiro, Brazil' },
  { lat: -23.5505,lng: -46.6333, name: 'São Paulo, Brazil' },
  { lat: -34.6037,lng: -58.3816, name: 'Buenos Aires, Argentina',      isCapital: true },
  { lat: -33.4489,lng: -70.6693, name: 'Santiago, Chile',              isCapital: true },
  { lat: 4.711,   lng: -74.0721, name: 'Bogotá, Colombia',             isCapital: true },
  { lat: -12.0464,lng: -77.0428, name: 'Lima, Peru',                   isCapital: true },
  // --- Asia / Pacific ---
  { lat: 35.6595, lng: 139.7006, name: 'Tokyo, Japan',                 isCapital: true },
  { lat: 34.6937, lng: 135.5023, name: 'Osaka, Japan' },
  { lat: 35.0116, lng: 135.7681, name: 'Kyoto, Japan' },
  { lat: 35.1815, lng: 136.9066, name: 'Nagoya, Japan' },
  { lat: 43.0618, lng: 141.3545, name: 'Sapporo, Japan' },
  { lat: 37.5665, lng: 126.978,  name: 'Seoul, South Korea',           isCapital: true },
  { lat: 35.1796, lng: 129.0756, name: 'Busan, South Korea' },
  { lat: 1.3521,  lng: 103.8198, name: 'Singapore',                    isCapital: true },
  { lat: 13.7563, lng: 100.5018, name: 'Bangkok, Thailand',            isCapital: true },
  { lat: 22.3193, lng: 114.1694, name: 'Hong Kong' },
  { lat: 25.0330, lng: 121.5654, name: 'Taipei, Taiwan',               isCapital: true },
  { lat: 14.5995, lng: 120.9842, name: 'Manila, Philippines',          isCapital: true },
  { lat: -6.2088, lng: 106.8456, name: 'Jakarta, Indonesia',           isCapital: true },
  { lat: 25.2048, lng: 55.2708,  name: 'Dubai, UAE' },
  { lat: 32.0853, lng: 34.7818,  name: 'Tel Aviv, Israel' },
  { lat: -33.8568,lng: 151.2153, name: 'Sydney, Australia' },
  { lat: -37.8136,lng: 144.9631, name: 'Melbourne, Australia' },
  { lat: -27.4698,lng: 153.0251, name: 'Brisbane, Australia' },
  { lat: -31.9505,lng: 115.8605, name: 'Perth, Australia' },
  { lat: -36.8485,lng: 174.7633, name: 'Auckland, New Zealand' },
  { lat: -41.2865,lng: 174.7762, name: 'Wellington, New Zealand',      isCapital: true },
  // --- Africa ---
  { lat: -33.9249,lng: 18.4241,  name: 'Cape Town, South Africa' },
  { lat: -26.2041,lng: 28.0473,  name: 'Johannesburg, South Africa' },
  { lat: -1.2921, lng: 36.8219,  name: 'Nairobi, Kenya',               isCapital: true },
  { lat: 30.0444, lng: 31.2357,  name: 'Cairo, Egypt',                 isCapital: true },
  { lat: 33.5731, lng: -7.5898,  name: 'Casablanca, Morocco' },
];

// Country bounding boxes — picked to keep random samples inside reasonably
// well-covered Mapillary regions. Wider than a single city; tighter than a
// whole country's outline so we mostly avoid oceans / deserts / tundra.
const REGIONS = [
  { name: 'France',         latMin: 43.5, latMax: 50.5, lngMin: -1.0, lngMax:  7.0 },
  { name: 'Germany',        latMin: 47.5, latMax: 54.5, lngMin:  6.5, lngMax: 14.0 },
  { name: 'United Kingdom', latMin: 50.5, latMax: 56.5, lngMin: -4.5, lngMax:  1.5 },
  { name: 'Italy',          latMin: 41.0, latMax: 46.0, lngMin:  7.0, lngMax: 14.0 },
  { name: 'Spain',          latMin: 37.0, latMax: 43.0, lngMin: -7.5, lngMax:  2.5 },
  { name: 'Netherlands',    latMin: 51.5, latMax: 53.0, lngMin:  4.0, lngMax:  6.7 },
  { name: 'Belgium',        latMin: 50.0, latMax: 51.3, lngMin:  3.0, lngMax:  5.5 },
  { name: 'Switzerland',    latMin: 46.0, latMax: 47.7, lngMin:  6.5, lngMax: 10.0 },
  { name: 'Austria',        latMin: 47.0, latMax: 48.7, lngMin:  10.0,lngMax: 16.5 },
  { name: 'Poland',         latMin: 50.0, latMax: 54.0, lngMin:  15.0,lngMax: 22.5 },
  { name: 'Sweden',         latMin: 55.5, latMax: 60.5, lngMin:  12.5,lngMax: 18.5 },
  { name: 'Norway',         latMin: 58.5, latMax: 64.0, lngMin:  5.0, lngMax: 12.0 },
  { name: 'Denmark',        latMin: 55.0, latMax: 57.5, lngMin:  8.5, lngMax: 12.5 },
  { name: 'Finland',        latMin: 60.0, latMax: 64.0, lngMin:  22.0,lngMax: 29.0 },
  { name: 'Portugal',       latMin: 37.0, latMax: 41.5, lngMin: -9.0, lngMax: -7.0 },
  { name: 'Czech Republic', latMin: 49.0, latMax: 50.5, lngMin:  13.0,lngMax: 18.0 },
  { name: 'Ireland',        latMin: 51.5, latMax: 54.5, lngMin: -10.0,lngMax: -6.0 },
  { name: 'Japan',          latMin: 33.0, latMax: 38.0, lngMin: 130.0,lngMax: 141.0 },
  { name: 'United States',  latMin: 33.0, latMax: 45.0, lngMin: -122.5,lngMax: -71.0 },
  { name: 'Canada',         latMin: 43.0, latMax: 50.0, lngMin: -123.5,lngMax: -73.0 },
  { name: 'Australia',      latMin: -38.0,latMax: -27.0,lngMin: 115.0, lngMax: 153.5 },
  { name: 'Brazil',         latMin: -25.0,latMax: -10.0,lngMin: -49.0, lngMax: -38.0 },
  { name: 'Mexico',         latMin: 17.0, latMax: 23.0, lngMin: -103.5,lngMax: -88.0 },
];

// Back-compat for tests that look at a global `LOCATIONS` array.
const LOCATIONS = CURATED_LOCATIONS;
