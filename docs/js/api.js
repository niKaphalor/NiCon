// Cloud API and relay addresses, authenticated API calls and the health pills.
import { apiBanner, apiPill, relayBanner, relayPill } from "./dom.js";
import { state } from "./state.js";
import { sessionExpired } from "./ui.js";

// --- cloud API + relay addresses ---
// Both fixed to this instance's own infrastructure — not user-
// configurable. Handles sign-in/account/server list (API, HTTPS,
// always-on) and the actual WebSocket<->RCON bridge (relay) separately;
// see checkApi()/checkRelay() below for why each gets its own status
// pill even though neither address can be changed from the UI anymore.

var API_URL = "https://nicon.mylss.de";
var RELAY_URL = "https://relay.130.61.8.150.sslip.io";

export function apiHttpUrl() {
  return API_URL;
}

function setApiStatus(ok) {
  apiPill.className = "relay-pill " + (ok ? "status-ok" : "status-error");
  apiBanner.hidden = ok;
}

export function checkApi() {
  fetch(apiHttpUrl() + "/api/healthz")
    .then(function (r) { setApiStatus(r.ok); })
    .catch(function () { setApiStatus(false); });
}

export function relayHttpUrl() {
  return RELAY_URL;
}

export function relayWsUrl() {
  return relayHttpUrl().replace(/^http/, "ws");
}

function setRelayStatus(ok) {
  relayPill.className = "relay-pill " + (ok ? "status-ok" : "status-error");
  relayBanner.hidden = ok;
}

export function checkRelay() {
  fetch(relayHttpUrl() + "/healthz")
    .then(function (r) { setRelayStatus(r.ok); })
    .catch(function () { setRelayStatus(false); });
}

// --- authenticated API calls ---

// Wraps fetch() with the Authorization header and central 401 handling:
// any authenticated call that comes back unauthorized (expired/invalid
// session) drops the user back to the login screen instead of failing
// silently or looping.
export function apiFetch(path, options) {
  options = options || {};
  var headers = options.headers || {};
  if (state.authToken) headers["Authorization"] = "Bearer " + state.authToken;
  options.headers = headers;

  return fetch(apiHttpUrl() + path, options).then(function (r) {
    if (r.status === 401) {
      sessionExpired();
      throw new Error("session expired");
    }
    return r;
  });
}

// Every handler on the PHP/Go side that fails a request sends
// {"error": "..."} as the JSON body (see webspace/lib/http.php's
// nicon_send_error / internal/relay's equivalent) — but the call sites
// below read the body with r.text() (they need the raw string for the
// non-JSON-error case, e.g. a proxy's own HTML error page) and used to
// pass it straight into `new Error(...)`, so a failure surfaced the
// literal `{"error":"invalid username or password"}` to the user
// instead of the message inside it. This unwraps that shape when
// present and otherwise falls back to the raw text unchanged, so a
// non-JSON error body still displays exactly as before.
export function apiErrorMessage(text) {
  if (!text) return text;
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch (e) { /* not JSON — fall through to the raw text */ }
  return text;
}
