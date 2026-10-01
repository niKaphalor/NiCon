// Server health dashboard: samples, history charts and the per-server health record.
import { apiFetch } from "./api.js";
import { renderContent, renderServerOverview } from "./detail.js";
import { addServerBtn, authShell, healthBody, healthRangeSelect, navHealthBtn, viewAdmin, viewApp, viewHealth, viewLogin, viewRegister, viewSettings } from "./dom.js";
import { stopPlayersAutoRefresh } from "./players.js";
import { findServer, renderServers, serverStatusClass, serverStatusTooltip } from "./servers.js";
import { I18N, state } from "./state.js";
import { leaveFaqView, setActiveNav } from "./views.js";

// --- server health dashboard ---

function showHealthView() {
  leaveFaqView();
  stopPlayersAutoRefresh();
  authShell.hidden = true;
  viewLogin.hidden = true;
  viewRegister.hidden = true;
  viewApp.hidden = true;
  viewSettings.hidden = true;
  viewAdmin.hidden = true;
  viewHealth.hidden = false;
  addServerBtn.hidden = true;
  setActiveNav(navHealthBtn);
  renderHealth();
}

navHealthBtn.addEventListener("click", showHealthView);

// --- server health dashboard: data ---
// Per-server connection telemetry for the Health view: the last time
// its game connection came up, the last error seen (from the relay or
// the WebSocket itself), and the browser round-trip of its most recent
// player-list poll. Command responses split that total into game/protocol
// time and relay-local overhead, so the relay's <=50 ms objective is not
// confused with Internet distance or a slow game server. The console's
// existing 10s auto-refresh
// (startPlayersAutoRefresh above), re-used rather than adding a new
// relay message type just to measure this. That poll only runs for
// whichever server's console is currently open, so latency is only
// ever known for that one at a time, same limitation the player count
// itself already has.
//
// Kept in localStorage, not the account's own server-side database
// (unlike Command Templates): it's throwaway telemetry about this one
// browser's connections, not something that should follow the user to
// another device, so it doesn't warrant a new API table. It does
// survive a page reload, though, which a plain in-memory variable
// wouldn't.
var HEALTH_STORAGE_KEY = "nicon_health";
state.serverHealth = {}; // { [serverId]: { lastConnectedAt, lastError, lastErrorAt, latencyMs, relayOverheadMs, upstreamMs } }
export var healthHistoryCache = {};
healthRangeSelect.addEventListener("change", function () { renderHealth(); });

(function loadServerHealth() {
  try {
    var raw = localStorage.getItem(HEALTH_STORAGE_KEY);
    state.serverHealth = raw ? JSON.parse(raw) : {};
  } catch (e) {
    state.serverHealth = {};
  }
})();

export function saveServerHealth() {
  try {
    localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(state.serverHealth));
  } catch (e) {
    // Storage full or unavailable (private browsing) — health just
    // won't survive a reload; nothing else in the app depends on it.
  }
}

function healthFor(serverId) {
  if (!state.serverHealth[serverId]) state.serverHealth[serverId] = {};
  return state.serverHealth[serverId];
}

export function recordConnected(serverId) {
  var h = healthFor(serverId);
  h.lastConnectedAt = Date.now();
  h.lastError = null;
  h.lastErrorAt = null;
  saveServerHealth();
  if (!viewHealth.hidden) renderHealth();
  if (state.selectedServerId === serverId && state.activeServerTab === "overview") renderServerOverview(findServer(serverId));
}

export function recordHealthError(serverId, message) {
  var h = healthFor(serverId);
  h.lastError = message;
  h.lastErrorAt = Date.now();
  saveServerHealth();
  if (!viewHealth.hidden) renderHealth();
  if (state.selectedServerId === serverId && state.activeServerTab === "overview") renderServerOverview(findServer(serverId));
}

export function recordLatency(serverId, ms, relayOverheadMs, upstreamMs) {
  var h = healthFor(serverId);
  h.latencyMs = ms;
  h.relayOverheadMs = typeof relayOverheadMs === "number" ? relayOverheadMs : null;
  h.upstreamMs = typeof upstreamMs === "number" ? upstreamMs : null;
  saveServerHealth();
  if (!viewHealth.hidden) renderHealth();
  if (state.selectedServerId === serverId && state.activeServerTab === "overview") renderServerOverview(findServer(serverId));
}

export function formatHealthTimestamp(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString();
}

function renderHealth() {
  healthBody.innerHTML = "";
  state.servers.forEach(function (server) {
    var h = state.serverHealth[server.id] || {};
    var tr = document.createElement("tr");

    var nameTd = document.createElement("td");
    nameTd.className = "health-server-name";
    nameTd.textContent = server.name;
    tr.appendChild(nameTd);

    var statusTd = document.createElement("td");
    var statusWrap = document.createElement("span");
    statusWrap.className = "health-status";
    var dot = document.createElement("span");
    dot.className = "dot " + serverStatusClass(server);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", serverStatusTooltip(server));
    statusWrap.appendChild(dot);
    statusWrap.appendChild(document.createTextNode(serverStatusTooltip(server)));
    statusTd.appendChild(statusWrap);
    tr.appendChild(statusTd);

    var autoCheckTd = document.createElement("td");
    if (server.health_checked_at == null) {
      autoCheckTd.className = "health-muted";
      autoCheckTd.textContent = I18N.t("health.autoCheckNeverRun");
    } else {
      var autoCheckWrap = document.createElement("span");
      autoCheckWrap.className = "health-status";
      var autoDot = document.createElement("span");
      autoDot.className = "dot " + (server.health_ok ? "ok" : "error");
      autoDot.setAttribute("role", "img");
      autoDot.setAttribute("aria-label", server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed"));
      autoCheckWrap.appendChild(autoDot);
      autoCheckWrap.appendChild(document.createTextNode(server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed")));
      autoCheckTd.appendChild(autoCheckWrap);

      var autoCheckWhen = document.createElement("span");
      autoCheckWhen.className = "health-timestamp";
      autoCheckWhen.textContent = new Date(server.health_checked_at).toLocaleString();
      autoCheckTd.appendChild(autoCheckWhen);

      if (!server.health_ok && server.health_error) {
        var autoCheckError = document.createElement("span");
        autoCheckError.className = "health-timestamp health-error";
        autoCheckError.textContent = server.health_error;
        autoCheckTd.appendChild(autoCheckError);
      } else if (server.health_ok && server.health_latency_ms != null) {
        var autoCheckLatency = document.createElement("span");
        autoCheckLatency.className = "health-timestamp";
        autoCheckLatency.textContent = server.health_latency_ms + " ms";
        autoCheckTd.appendChild(autoCheckLatency);
      }
    }
    tr.appendChild(autoCheckTd);

    var range = healthRangeSelect.value;
    var historyKey = server.id + ":" + range;
    var historyEntry = healthHistoryCache[historyKey];
    var uptimeTd = document.createElement("td");
    var playersTd = document.createElement("td");
    if (!historyEntry || !historyEntry.data) {
      uptimeTd.className = playersTd.className = "health-muted";
      uptimeTd.textContent = playersTd.textContent = historyEntry && historyEntry.failed ? "—" : "Loading…";
      if (!historyEntry) {
        healthHistoryCache[historyKey] = { loading: true };
        apiFetch("/api/servers/" + server.id + "/health-history?range=" + encodeURIComponent(range))
          .then(function (response) { if (!response.ok) throw new Error("history unavailable"); return response.json(); })
          .then(function (data) { healthHistoryCache[historyKey] = { data: data, fetchedAt: Date.now() }; if (!viewHealth.hidden) renderHealth(); })
          .catch(function () { healthHistoryCache[historyKey] = { data: null, failed: true }; if (!viewHealth.hidden) renderHealth(); });
      }
    } else {
      var history = historyEntry.data;
      var uptimeSummary = document.createElement("span");
      uptimeSummary.className = "health-summary";
      uptimeSummary.textContent = history.uptime_percent == null ? "—" : history.uptime_percent.toFixed(2) + "%";
      uptimeTd.appendChild(uptimeSummary);
      var completeness = document.createElement("span");
      completeness.className = "health-completeness";
      completeness.textContent = I18N.t("health.samples", { value: history.sample_completeness_percent });
      uptimeTd.appendChild(completeness);
      uptimeTd.appendChild(buildHealthChart(history.samples, false, history.range));

      var playersSummary = document.createElement("span");
      playersSummary.className = "health-summary";
      playersSummary.textContent = history.players_peak == null ? "—" : I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak });
      playersTd.appendChild(playersSummary);
      playersTd.appendChild(buildHealthChart(history.samples, true, history.range));
    }
    tr.appendChild(uptimeTd);
    tr.appendChild(playersTd);

    var connectedTd = document.createElement("td");
    var connectedText = formatHealthTimestamp(h.lastConnectedAt);
    connectedTd.className = connectedText ? "" : "health-muted";
    connectedTd.textContent = connectedText || I18N.t("health.never");
    tr.appendChild(connectedTd);

    var latencyTd = document.createElement("td");
    if (h.latencyMs != null) {
      latencyTd.textContent = h.latencyMs + " ms";
      var latencyHint = document.createElement("span");
      latencyHint.className = "health-timestamp";
      latencyHint.textContent = I18N.t("health.latencyHint", {
        relay: h.relayOverheadMs == null ? "—" : h.relayOverheadMs.toFixed(1),
        upstream: h.upstreamMs == null ? "—" : h.upstreamMs.toFixed(1),
      });
      latencyTd.appendChild(latencyHint);
    } else {
      latencyTd.className = "health-muted";
      latencyTd.textContent = "—";
    }
    tr.appendChild(latencyTd);

    var errorTd = document.createElement("td");
    if (h.lastError) {
      errorTd.className = "health-error";
      errorTd.textContent = h.lastError;
      var errorWhen = document.createElement("span");
      errorWhen.className = "health-timestamp";
      errorWhen.textContent = formatHealthTimestamp(h.lastErrorAt);
      errorTd.appendChild(errorWhen);
    } else {
      errorTd.className = "health-muted";
      errorTd.textContent = I18N.t("health.noError");
    }
    tr.appendChild(errorTd);

    healthBody.appendChild(tr);
  });
}

export function buildHealthChart(samples, players, range) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "health-chart");
  svg.setAttribute("viewBox", "0 0 150 34");
  svg.setAttribute("aria-hidden", "true");
  if (!samples || !samples.length) return svg;
  if (!players) {
    var availability = samples.filter(function (sample) { return sample.source !== "client"; });
    if (!availability.length) return svg;
    var background = document.createElementNS(svg.namespaceURI, "rect");
    background.setAttribute("x", "0"); background.setAttribute("y", "3");
    background.setAttribute("width", "150"); background.setAttribute("height", "28");
    background.setAttribute("class", "unknown-bg"); svg.appendChild(background);
    var rangeMs = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "90d": 7776000000 }[range] || 86400000;
    var end = Date.now(); var start = end - rangeMs;
    availability.forEach(function (sample) {
      var rect = document.createElementNS(svg.namespaceURI, "rect");
      var x = Math.max(0, Math.min(149, (Date.parse(sample.at) - start) * 150 / rangeMs));
      rect.setAttribute("x", String(x)); rect.setAttribute("y", "3");
      rect.setAttribute("width", "1.5"); rect.setAttribute("height", "28");
      // Condensed (hourly/daily) samples carry the share of the bucket that
      // was online; a bucket that was only partly online gets its own colour.
      var ratio = typeof sample.online_ratio === "number" ? sample.online_ratio : (sample.online ? 1 : 0);
      rect.setAttribute("class", ratio >= 0.999 ? "online" : (ratio <= 0.001 ? "offline" : "partial")); svg.appendChild(rect);
    });
    return svg;
  }
  var values = samples.filter(function (sample) { return sample.players != null; });
  if (!values.length) return svg;
  var max = Math.max(1, values.reduce(function (peak, sample) { return Math.max(peak, sample.players_max || sample.players); }, 0));
  var points = values.map(function (sample, index) {
    var x = values.length === 1 ? 0 : index * 150 / (values.length - 1);
    return x.toFixed(1) + "," + (32 - sample.players * 29 / max).toFixed(1);
  }).join(" ");
  var line = document.createElementNS(svg.namespaceURI, "polyline");
  line.setAttribute("class", "player-line"); line.setAttribute("points", points); svg.appendChild(line);
  return svg;
}

// Called whenever the relay's game-server connection is known to be
// gone (a command error, or the WebSocket itself closing) — updates
// state once, in one place, instead of duplicating the same cleanup at
// every call site that can discover a dead connection.
export function markDisconnected(c) {
  c.gameConnected = false;
  renderServers();
  if (state.selectedServerId === c.server.id) {
    stopPlayersAutoRefresh();
    renderContent();
  }
}
