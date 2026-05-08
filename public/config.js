// =====================================================================
// Public demo config — yes, this file IS committed to git on purpose.
// =====================================================================
//
// The Mapillary access token below is shared so the deployed/cloned game
// shows real panoramas to anyone, not just people who sign up for their
// own. The token is base64-encoded only as a thin defense against the
// automated bots that grep public repos for raw `MLY|` prefixes — it is
// NOT actually private. Anyone running the page sees it in their
// browser's Network tab the moment a panorama loads.
//
// If this token ever gets abused (sudden quota spike on the Mapillary
// dashboard), the recovery is: log into mapillary.com/dashboard/developers,
// generate a new token, replace the encoded string below, and push.
//
// The Google Maps key is intentionally NOT bundled here — it's per-user
// (entered via the in-app settings panel and stored in localStorage), so
// each player's usage stays on their own billing.
//
// eslint-disable-next-line no-unused-vars -- consumed by game.js as a global
const MAPILLARY_TOKEN = atob(
  'TUxZfDM1NDc0MDkyMDA1NTcwODcyfGRiOGVhMWZhMDlkZDQzY2RmZDgwY2FlNmNkNTYyMmZj',
);
