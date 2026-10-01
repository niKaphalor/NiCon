// Background console sockets per server (connect, reconnect, relay protocol).
import { apiFetch, relayHttpUrl, relayWsUrl } from "./api.js";
import { activeFilterRegex, appendHighlighted, renderLog, updateConsoleFollowButton } from "./consolelog.js";
import { renderHead, renderServerOverview, updateCmdBarState, updateServerPlayerCount } from "./detail.js";
import { log, serverPlayersList } from "./dom.js";
import { healthHistoryCache, markDisconnected, recordConnected, recordHealthError, recordLatency } from "./health.js";
import { renderPlayersInto, renderPlayersPanel, requestSteamProfiles, sendConsoleCommand, startPlayersAutoRefresh } from "./players.js";
import { renderServers } from "./servers.js";
import { I18N, state } from "./state.js";
import { sessionExpired } from "./ui.js";

// --- console (background sockets keyed by server id) ---
// An entry, once created, is kept around for the whole session so its
// log history survives a manual disconnect — reconnecting reuses the
// same entry and appends to the same log instead of starting fresh.

var RECONNECT_BASE_DELAY_MS = 1000;
var RECONNECT_MAX_DELAY_MS = 30000;

export function ensureConsole(server) {
  var c = state.consoles[server.id];
  if (!c) {
    c = {
      server: server,
      socket: null,
      lines: [],
      pendingPlayersRequest: false,
      authenticated: false,
      gameConnected: false,
      gameKey: window.NICON_GUESS_GAME(server.game),
      lastParsed: null,
      manualDisconnect: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      followTail: true,
      scrollTop: 0,
      steamProfiles: {},
      steamRequested: {},
      moderationCooldowns: {},
    };
    state.consoles[server.id] = c;
  }
  c.server = server;
  c.manualDisconnect = false;
  c.reconnectAttempts = 0;
  clearConsoleReconnect(c);
  openConsoleSocket(c);
}

function clearConsoleReconnect(c) {
  if (!c.reconnectTimer) return;
  clearTimeout(c.reconnectTimer);
  c.reconnectTimer = null;
}

export function disposeConsole(c) {
  c.manualDisconnect = true;
  clearConsoleReconnect(c);
  var socket = c.socket;
  c.socket = null;
  c.authenticated = false;
  c.gameConnected = false;
  c.pendingPlayersRequest = false;
  if (socket) socket.close();
}

export function disconnectConsole(c) {
  var wasActive = !!(c.socket || c.reconnectTimer || c.gameConnected);
  disposeConsole(c);
  if (wasActive) appendConsoleLine(c, "system", I18N.t("console.disconnected"));
  markDisconnected(c);
  refreshIfActive(c);
}

function isFatalConsoleError(message) {
  return /unauthorized|must authenticate|server not found|no RCON password|invalid password|authentication failed/i.test(message || "");
}

function scheduleConsoleReconnect(c) {
  if (c.manualDisconnect || c.reconnectTimer || !state.authToken || state.consoles[c.server.id] !== c) return;
  var delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, c.reconnectAttempts));
  c.reconnectAttempts += 1;
  appendConsoleLine(c, "system", I18N.t("console.reconnectingIn", { seconds: Math.ceil(delay / 1000) }));
  refreshIfActive(c);
  c.reconnectTimer = setTimeout(function () {
    c.reconnectTimer = null;
    if (c.manualDisconnect || !state.authToken || state.consoles[c.server.id] !== c) return;
    openConsoleSocket(c);
  }, delay);
}

function openConsoleSocket(c) {
  if (c.manualDisconnect || !state.authToken || state.consoles[c.server.id] !== c) return;
  clearConsoleReconnect(c);

  var previousSocket = c.socket;
  c.socket = null;
  if (previousSocket) previousSocket.close();
  c.authenticated = false;
  c.gameConnected = false;
  c.pendingPlayersRequest = false;
  appendConsoleLine(c, "system", I18N.t("console.connecting"));
  refreshIfActive(c);

  var socket;
  try {
    socket = new WebSocket(relayWsUrl() + "/ws/rcon");
  } catch (err) {
    appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
    recordHealthError(c.server.id, err.message || I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
    scheduleConsoleReconnect(c);
    return;
  }
  c.socket = socket;

  socket.addEventListener("open", function () {
    if (c.socket !== socket) return;
    socket.send(JSON.stringify({ type: "auth", token: state.authToken }));
  });

  socket.addEventListener("message", function (event) {
    if (c.socket !== socket) return;
    var msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      appendConsoleLine(c, "error", I18N.t("console.couldNotParseMessage"));
      refreshIfActive(c);
      return;
    }

    if (msg.type === "authenticated") {
      c.authenticated = true;
      socket.send(JSON.stringify({ type: "connect", server_id: c.server.id }));
    } else if (msg.type === "connected") {
      c.gameConnected = true;
      c.reconnectAttempts = 0;
      appendConsoleLine(c, "system", I18N.t("console.connected"));
      recordConnected(c.server.id);
      renderServers();
      if (state.selectedServerId === c.server.id) {
        renderHead(c.server);
        startPlayersAutoRefresh(c);
      }
    } else if (msg.type === "response") {
      appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : I18N.t("console.noOutput"));
      if (c.pendingPlayersRequest) {
        c.pendingPlayersRequest = false;
        if (c.playersRequestSentAt) recordLatency(c.server.id, Date.now() - c.playersRequestSentAt, msg.relay_overhead_ms, msg.upstream_ms);
        var game = window.NICON_GAMES[c.gameKey];
        var parsed = game.parse(msg.output || "");
        c.lastParsed = parsed
          ? { ok: true, summary: parsed.summary, columns: parsed.columns, players: parsed.players }
          : { ok: false };
        if (parsed) {
          requestSteamProfiles(c, parsed.columns, parsed.players);
          apiFetch("/api/servers/" + c.server.id + "/player-sample", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ players: parsed.players.length }),
          }).then(function () {
            Object.keys(healthHistoryCache).forEach(function (key) {
              if (key.indexOf(c.server.id + ":") === 0) delete healthHistoryCache[key];
            });
          }).catch(function () { /* telemetry must never interrupt the console */ });
        }
        if (state.selectedServerId === c.server.id) {
          renderPlayersPanel(c);
          renderPlayersInto(serverPlayersList, c);
          updateServerPlayerCount(c.server);
          if (state.activeServerTab === "overview") renderServerOverview(c.server);
        }
      }
    } else if (msg.type === "broadcast") {
      // WebRCON servers (Rust) push chat/log lines unsolicited.
      handleBroadcastLine(c, msg.output || "");
    } else if (msg.type === "error") {
      var message = msg.message || "unknown relay error";
      appendConsoleLine(c, "error", message);
      c.pendingPlayersRequest = false;
      recordHealthError(c.server.id, message);
      // The relay tears down the game connection on any command error
      // (not just connect-time failures), so this always means "no
      // longer connected" — see the isConnected()/markDisconnected()
      // comment above.
      if (message === "unauthorized") {
        sessionExpired();
        return;
      }
      if (isFatalConsoleError(message)) c.manualDisconnect = true;
      markDisconnected(c);
      socket.close(); // close event schedules a retry for recoverable failures
    }
    refreshIfActive(c);
  });

  socket.addEventListener("close", function () {
    if (c.socket !== socket) return;
    c.socket = null;
    c.authenticated = false;
    appendConsoleLine(c, "system", I18N.t("console.disconnected"));
    markDisconnected(c);
    scheduleConsoleReconnect(c);
  });

  socket.addEventListener("error", function () {
    if (c.socket !== socket) return;
    appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
    recordHealthError(c.server.id, I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
    refreshIfActive(c);
  });
}

// Caps how many lines a single console keeps in memory (and therefore
// how many renderLog() ever has to rebuild) — a long-running console on
// a chatty server (WebRCON/BattlEye broadcast lines arrive continuously,
// not just on command) would otherwise grow both without bound. Oldest
// lines are dropped first, same as scrolling a real terminal's
// scrollback off the top.
var MAX_CONSOLE_LOG_LINES = 2000;

export function appendConsoleLine(c, kind, text) {
  if (kind === "broadcast") kind = "chat";
  if (kind === "response" && /\b(warn(?:ing)?|caution)\b/i.test(text)) kind = "warning";
  if (kind === "response" && /\b(error|exception|fatal|failed)\b/i.test(text)) kind = "error";
  c.lines.push({ kind: kind, text: text });
  if (c.lines.length > MAX_CONSOLE_LOG_LINES) {
    c.lines.splice(0, c.lines.length - MAX_CONSOLE_LOG_LINES);
    // Tracked so appendNewLogLines can tell a trim happened since its
    // last render and fall back to a full rebuild instead of appending
    // onto a DOM that's now missing the lines at the front.
    c.trimGen = (c.trimGen || 0) + 1;
  }
}

function playerForLogLine(c, text) {
  if (!c.lastParsed || !c.lastParsed.ok) return null;
  var best = null;
  c.lastParsed.players.forEach(function (player) {
    var name = String(player.cells[0] || "");
    if (name && text.toLowerCase().indexOf(name.toLowerCase()) !== -1 && (!best || name.length > String(best.cells[0]).length)) best = player;
  });
  return best;
}

function handleBroadcastLine(c, text) {
  var matched = state.moderationRules.filter(function (rule) {
    return rule.enabled && text.toLowerCase().indexOf(rule.pattern.toLowerCase()) !== -1;
  });
  appendConsoleLine(c, matched.length ? "warning" : "chat", text);
  if (!matched.length) return;
  var player = playerForLogLine(c, text);
  var game = window.NICON_GAMES[c.gameKey];
  matched.forEach(function (rule) {
    if (rule.action === "highlight" || !player || !game) return;
    var build = rule.action === "kick" ? game.kick : game.mute;
    var command = build ? build(player) : null;
    var cooldownKey = rule.id + ":" + player.id;
    if ((c.moderationCooldowns[cooldownKey] || 0) > Date.now()) return;
    if (!command) {
      c.moderationCooldowns[cooldownKey] = Date.now() + 60000;
      appendConsoleLine(c, "system", "Moderation: " + rule.action + " is not supported for " + (game.label || c.gameKey));
      return;
    }
    c.moderationCooldowns[cooldownKey] = Date.now() + 60000;
    sendConsoleCommand(c, command, {
      origin: "automatic_moderation",
      action: rule.action,
      targetPlayer: player.cells[0] || player.id,
    });
    appendConsoleLine(c, "system", "Moderation: " + rule.action + " → " + (player.cells[0] || player.id));
  });
}

// renderLog does a full rebuild (log.innerHTML = "" + re-append every
// line) rather than an incremental append, so it can re-run the filter
// regex over the whole log; that's fine for a single command's
// response, or any of the explicit UI actions that call it directly
// (filter changed, console switched/cleared, follow-tail clicked) — all
// of those need every line re-evaluated anyway. A burst of broadcast
// lines arriving back-to-back (WebRCON/BattlEye chat, kill feed) is a
// different case: nothing about the filter or existing lines changed,
// only new ones were appended, so appendNewLogLines below handles that
// path by appending just the new lines instead of rebuilding all 2000.
// Coalescing same-frame calls into one (regardless of which path runs)
// still keeps a burst to one DOM update per animation frame rather than
// one per line.
state.logRenderScheduled = false;
function scheduleLogRender() {
  if (state.logRenderScheduled) return;
  state.logRenderScheduled = true;
  window.requestAnimationFrame(function () {
    state.logRenderScheduled = false;
    appendNewLogLines(state.consoles[state.selectedServerId]);
  });
}

// appendNewLogLines is renderLog's incremental fast path for the one
// caller (scheduleLogRender) whose trigger — new lines were pushed onto
// c.lines — can never itself invalidate what's already in the DOM. It
// falls back to the always-correct full renderLog whenever an
// assumption that would make appending unsafe doesn't hold: the console
// changed, a filter is active (this path never evaluates one), or old
// lines were trimmed off the front since the last render (tracked via
// trimGen). renderLog itself records the bookkeeping this checks
// against, so every code path — direct renderLog calls and this one —
// stays consistent with whatever's actually in the DOM.
function appendNewLogLines(c) {
  if (!c ||
      state.lastRenderedLogConsole !== c ||
      c._logRenderedFiltered !== false ||
      activeFilterRegex() !== null ||
      c._logRenderedTrimGen !== (c.trimGen || 0) ||
      typeof c._logRenderedCount !== "number" ||
      c._logRenderedCount > c.lines.length) {
    renderLog(c);
    return;
  }
  var newLines = c.lines.slice(c._logRenderedCount);
  if (!newLines.length) return;
  state.renderingConsoleLog = true;
  var previousScrollTop = c.scrollTop;
  newLines.forEach(function (line) {
    var div = document.createElement("div");
    div.className = "log-line kind-" + line.kind;
    appendHighlighted(div, line.text, null);
    log.appendChild(div);
  });
  c._logRenderedCount = c.lines.length;
  if (c.followTail !== false) {
    log.scrollTop = log.scrollHeight;
  } else {
    log.scrollTop = previousScrollTop;
  }
  c.scrollTop = log.scrollTop;
  state.renderingConsoleLog = false;
  updateConsoleFollowButton(c);
}

export function refreshIfActive(c) {
  if (state.selectedServerId === c.server.id) {
    scheduleLogRender();
    updateCmdBarState();
  }
}
