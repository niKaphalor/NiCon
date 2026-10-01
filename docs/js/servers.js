// Server list and sidebar, add/edit server, Nitrado sync, connection tests and server selection.
import { apiErrorMessage, apiFetch, relayWsUrl } from "./api.js";
import { loadAccountInfo } from "./auth.js";
import { disposeConsole, ensureConsole } from "./console.js";
import { renderContent } from "./detail.js";
import { addClose, addModal, addServerBtn, addTabPanels, addTabs, editServerClose, editServerError, editServerForm, editServerGame, editServerHost, editServerModal, editServerName, editServerNitradoHint, editServerPassword, editServerPort, editServerProtocol, editServerQueryPort, editServerQueryProtocol, editServerQueryTestBtn, editServerQueryTestStatus, emptyAddBtn, manualForm, manualGameSelect, manualQueryPort, manualQueryProtocol, manualQueryTestBtn, manualQueryTestStatus, manualTestBtn, manualTestStatus, nitradoForm, nitradoTokenInput, passwordEditServerBtn, passwordForm, passwordInput, serverList, serverSearch, settingsNitradoForm, settingsNitradoTokenInput } from "./dom.js";
import { saveServerHealth } from "./health.js";
import { startPlayersAutoRefresh, stopPlayersAutoRefresh } from "./players.js";
import { I18N, state } from "./state.js";
import { showToast } from "./ui.js";

// --- add-server modal + tabs ---

// The game choices come from the shared catalog (data/games.json), not from
// a hand-kept <option> list in index.html.
[manualGameSelect, editServerGame].forEach(function (select) {
  window.NICON_GAME_CATALOG.forEach(function (entry) {
    var option = document.createElement("option");
    option.value = entry.label;
    option.textContent = entry.label;
    select.appendChild(option);
  });
});

function openAddModal() {
  loadAccountInfo();
  manualTestStatus.hidden = true;
  manualQueryTestStatus.hidden = true;
  addModal.showModal();
}

addServerBtn.addEventListener("click", openAddModal);
emptyAddBtn.addEventListener("click", openAddModal);
addClose.addEventListener("click", function () { addModal.close(); });
addModal.addEventListener("click", function (e) {
  if (e.target === addModal) addModal.close();
});

addTabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    addTabs.forEach(function (t) {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    addTabPanels.forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  });
});

// --- server state ---

export function loadServers() {
  return apiFetch("/api/servers", { method: "GET" })
    .then(function (r) {
      if (!r.ok) throw new Error(I18N.t("errors.failedToLoadServers"));
      return r.json();
    })
    .then(function (list) {
      state.servers = list || [];
      renderServers();
      renderContent();
    });
}

export function findServer(id) {
  for (var i = 0; i < state.servers.length; i++) {
    if (state.servers[i].id === id) return state.servers[i];
  }
  return null;
}

export function removeServer(id) {
  apiFetch("/api/servers/" + id, { method: "DELETE" })
    .then(function (r) {
      if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.failedToRemoveServer"));
      state.servers = state.servers.filter(function (s) { return s.id !== id; });
      if (state.consoles[id]) {
        disposeConsole(state.consoles[id]);
        delete state.consoles[id];
      }
      if (state.selectedServerId === id) {
        state.selectedServerId = null;
        stopPlayersAutoRefresh();
      }
      if (state.serverHealth[id]) {
        delete state.serverHealth[id]; // no point keeping health history for a server that no longer exists
        saveServerHealth();
      }
      renderServers();
      renderContent();
    })
    .catch(function (err) { showToast(err.message); });
}

// The full protocol name shown as a tag in the console head — mirrors
// the "Add server" protocol dropdown's own option text.
export function protocolLabel(protocol) {
  if (protocol === "webrcon") return I18N.t("addModal.protocolWebrcon");
  if (protocol === "palworld_rest") return I18N.t("addModal.protocolPalworldRest");
  if (protocol === "battleye") return I18N.t("addModal.protocolBattleye");
  if (protocol === "telnet") return "Telnet";
  if (protocol === "battlebit") return "BattleBit WebRCON";
  return I18N.t("common.protocolSource");
}

// A short badge for the sidebar row's meta line — omitted for plain
// Source RCON, since that's the common default and doesn't need calling
// out the way the less-common protocols do.
function protocolBadge(protocol) {
  if (protocol === "webrcon") return I18N.t("common.webrcon");
  if (protocol === "palworld_rest") return I18N.t("common.restApi");
  if (protocol === "battleye") return I18N.t("common.battleye");
  if (protocol === "telnet") return "Telnet";
  if (protocol === "battlebit") return "BattleBit";
  return null;
}

// Both come from the shared game catalog (data/games.json).
function suggestedProtocolForGame(game) {
  var key = window.NICON_GUESS_GAME(game);
  return key ? window.NICON_GAMES[key].protocol : "source";
}

function suggestedQueryProtocolForGame(game) {
  var key = window.NICON_GUESS_GAME(game);
  var mode = key ? window.NICON_GAMES[key].autoQuery : "";
  return mode === "a2s" || mode === "minecraft" ? mode : "auto";
}

function optionalPort(input) {
  if (!input.value) return null;
  var value = parseInt(input.value, 10);
  return value >= 1 && value <= 65535 ? value : null;
}

// TLS (wss / https) exists only for the HTTP/WebSocket based protocols. The
// checkbox is shown for those and cleared when it is hidden, so a stale tick
// can never be sent along with, say, a Source RCON server.
var TLS_PROTOCOLS = ["webrcon", "battlebit", "palworld_rest"];
var manualProtocolSelect = document.getElementById("manual-protocol");
var manualTlsRow = document.getElementById("manual-tls-row");
var manualTls = document.getElementById("manual-tls");
var editServerTlsRow = document.getElementById("edit-server-tls-row");
var editServerTls = document.getElementById("edit-server-tls");

function syncTlsRow(protocolSelect, row, checkbox) {
  var supported = TLS_PROTOCOLS.indexOf(protocolSelect.value) !== -1;
  row.hidden = !supported;
  if (!supported) checkbox.checked = false;
}

function syncManualTls() { syncTlsRow(manualProtocolSelect, manualTlsRow, manualTls); }
function syncEditTls() { syncTlsRow(editServerProtocol, editServerTlsRow, editServerTls); }
manualProtocolSelect.addEventListener("change", syncManualTls);
editServerProtocol.addEventListener("change", syncEditTls);

manualGameSelect.addEventListener("change", function () {
  document.getElementById("manual-protocol").value = suggestedProtocolForGame(manualGameSelect.value);
  manualQueryProtocol.value = suggestedQueryProtocolForGame(manualGameSelect.value);
  syncManualTls();
});

function setGameSelectValue(select, game) {
  var value = game || "";
  var custom = select.querySelector("option[data-custom-game]");
  if (custom) custom.remove();
  var exists = Array.prototype.some.call(select.options, function (option) { return option.value === value; });
  if (value && !exists) {
    custom = document.createElement("option");
    custom.value = value;
    custom.textContent = value;
    custom.dataset.customGame = "true";
    select.appendChild(custom);
  }
  select.value = value;
}

export function openEditServerModal(server) {
  state.editingServerId = server.id;
  editServerName.value = server.name;
  editServerHost.value = server.host;
  editServerPort.value = server.port;
  editServerProtocol.value = server.protocol || "source";
  editServerTls.checked = !!server.use_tls;
  syncEditTls();
  editServerQueryProtocol.value = server.query_protocol || "auto";
  editServerQueryPort.value = server.query_port || "";
  setGameSelectValue(editServerGame, server.game);
  editServerPassword.value = "";
  editServerError.hidden = true;
  editServerQueryTestStatus.hidden = true;
  editServerNitradoHint.hidden = server.source !== "nitrado";
  editServerModal.showModal();
}

editServerClose.addEventListener("click", function () { editServerModal.close(); });
editServerModal.addEventListener("click", function (event) {
  if (event.target === editServerModal) editServerModal.close();
});
editServerGame.addEventListener("change", function () {
  editServerProtocol.value = suggestedProtocolForGame(editServerGame.value);
  editServerQueryProtocol.value = suggestedQueryProtocolForGame(editServerGame.value);
  syncEditTls();
});
passwordEditServerBtn.addEventListener("click", function () {
  var server = findServer(state.selectedServerId);
  if (server) openEditServerModal(server);
});

editServerForm.addEventListener("submit", function (event) {
  event.preventDefault();
  var server = findServer(state.editingServerId);
  if (!server) return;
  editServerError.hidden = true;
  var password = editServerPassword.value;
  var payload = {
    name: editServerName.value.trim(),
    host: editServerHost.value.trim(),
    port: parseInt(editServerPort.value, 10),
    protocol: editServerProtocol.value,
    use_tls: editServerTls.checked,
    query_protocol: editServerQueryProtocol.value,
    query_port: optionalPort(editServerQueryPort),
    game: editServerGame.value,
  };

  apiFetch("/api/servers/" + server.id, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(function (response) {
    if (!response.ok) return response.text().then(function (text) { throw new Error(apiErrorMessage(text) || I18N.t("editServer.updateFailed")); });
    return response.json();
  }).then(function (updated) {
    if (!password) return updated;
    return apiFetch("/api/servers/" + server.id + "/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    }).then(function (response) {
      if (!response.ok) throw new Error(I18N.t("errors.failedToSavePassword"));
      updated.has_password = true;
      return updated;
    });
  }).then(function (updated) {
    var index = state.servers.findIndex(function (item) { return item.id === updated.id; });
    if (index !== -1) state.servers[index] = updated;
    if (state.consoles[updated.id]) {
      disposeConsole(state.consoles[updated.id]);
      delete state.consoles[updated.id];
    }
    stopPlayersAutoRefresh();
    editServerModal.close();
    renderServers();
    renderContent();
  }).catch(function (error) {
    editServerError.textContent = error.message;
    editServerError.hidden = false;
  });
});

function serverMeta(server) {
  var parts = [];
  if (server.game) parts.push(server.game);
  var badge = protocolBadge(server.protocol);
  if (badge) parts.push(badge);
  parts.push(server.host + ":" + server.port);
  return parts.join(" · ");
}

// --- sidebar: search + server list ---

serverSearch.addEventListener("input", function () {
  state.searchQuery = serverSearch.value;
  renderServers();
});

function filteredServers() {
  var q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.servers;
  return state.servers.filter(function (s) {
    return s.name.toLowerCase().indexOf(q) !== -1 || (s.game || "").toLowerCase().indexOf(q) !== -1;
  });
}

export function renderServers() {
  serverList.innerHTML = "";
  var list = filteredServers();

  if (!list.length) {
    var empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.servers.length ? I18N.t("servers.noSearchResults") : I18N.t("servers.emptyTitle");
    serverList.appendChild(empty);
    return;
  }

  list.forEach(function (server) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "server-row";
    row.setAttribute("aria-current", String(server.id === state.selectedServerId));

    var content = document.createElement("span");
    content.className = "server-row-content";

    var nameLine = document.createElement("span");
    nameLine.className = "name";
    if (server.game_icon_url) {
      row.classList.add("has-game-icon");
      var gameIcon = document.createElement("img");
      gameIcon.className = "server-game-icon";
      gameIcon.loading = "lazy";
      gameIcon.referrerPolicy = "no-referrer";
      gameIcon.src = server.game_icon_url;
      gameIcon.alt = "";
      gameIcon.addEventListener("error", function () {
        gameIcon.remove();
        row.classList.remove("has-game-icon");
      });
      row.appendChild(gameIcon);
    }
    var dot = document.createElement("span");
    dot.className = "dot " + serverStatusClass(server);
    dot.title = serverStatusTooltip(server);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", serverStatusTooltip(server));
    nameLine.appendChild(dot);
    nameLine.appendChild(document.createTextNode(server.name));
    content.appendChild(nameLine);

    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = serverMeta(server);
    content.appendChild(meta);
    row.appendChild(content);

    row.addEventListener("click", function () { selectServer(server.id); });
    serverList.appendChild(row);
  });
}

// --- Nitrado sync ---

// performNitradoSync is shared by the Add Server modal's "From Nitrado"
// tab and the Settings → Nitrado card — same request, same server-list
// side effect, different only in what each caller does on success/error
// (close the modal vs. just toast) and which input field to clear after.
function performNitradoSync(token) {
  return apiFetch("/api/nitrado/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token ? { token: token } : {}),
  })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
      return r.json();
    })
    .then(function (list) {
      state.servers = list || [];
      renderServers();
      renderContent();
      if (token) loadAccountInfo(); // a new token was just saved
    });
}

nitradoForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var token = nitradoTokenInput.value.trim();
  if (!token && !state.hasNitradoToken) return; // required attribute already blocks this, belt and suspenders

  performNitradoSync(token)
    .then(function () { addModal.close(); })
    .catch(function (err) {
      showToast(I18N.t("errors.nitradoSyncFailed", { message: err.message }));
    })
    .finally(function () {
      // The token was only ever needed for this one request.
      nitradoTokenInput.value = "";
    });
});

settingsNitradoForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var token = settingsNitradoTokenInput.value.trim();
  if (!token && !state.hasNitradoToken) return;

  performNitradoSync(token)
    .then(function () { showToast(I18N.t("settings.nitradoSyncSuccess")); })
    .catch(function (err) {
      showToast(I18N.t("errors.nitradoSyncFailed", { message: err.message }));
    })
    .finally(function () {
      settingsNitradoTokenInput.value = "";
    });
});

// --- manual add: test connection ---
// Opens its own short-lived WebSocket (auth + a "test" message carrying
// the form's current host/port/password/protocol directly, since there's
// no saved server_id yet to test against) and closes it again as soon as
// a result comes back — never leaves a connection open.

function setManualTestStatus(text, isError) {
  manualTestStatus.textContent = text;
  manualTestStatus.classList.toggle("is-error", !!isError);
  manualTestStatus.classList.toggle("is-success", !isError);
  manualTestStatus.hidden = false;
}

// Its own status line, not shared with setManualTestStatus above — "Test
// connection" and "Test status query" are two unrelated checks (RCON vs.
// public query), and sharing one line made a stale result briefly read as
// belonging to the wrong test (the Edit-Server modal already gives its
// own query test a dedicated line; this matches that).
function setManualQueryTestStatus(text, isError) {
  manualQueryTestStatus.textContent = text;
  manualQueryTestStatus.classList.toggle("is-error", !!isError);
  manualQueryTestStatus.classList.toggle("is-success", !isError);
  manualQueryTestStatus.hidden = false;
}

function runQueryTest(options) {
  var host = options.host.value.trim();
  var port = optionalPort(options.queryPort) || parseInt(options.rconPort.value, 10);
  var protocol = options.queryProtocol.value;
  if (protocol === "auto") {
    protocol = options.game.value === "Minecraft" ? "minecraft" : (options.rconProtocol.value === "source" ? "a2s" : "disabled");
  }
  if (!host || !port || protocol === "disabled") {
    options.setStatus(I18N.t("addModal.queryNeedsConfig"), true);
    return;
  }
  options.button.disabled = true;
  options.setStatus(I18N.t("addModal.testing"), false);
  var socket;
  var settled = false;
  var timer = setTimeout(function () { finish(I18N.t("addModal.testTimedOut"), true); }, 10000);
  function finish(message, isError) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.setStatus(message, isError);
    options.button.disabled = false;
    if (socket) socket.close();
  }
  try { socket = new WebSocket(relayWsUrl() + "/ws/rcon"); }
  catch (e) { finish(I18N.t("addModal.testRelayUnreachable"), true); return; }
  socket.addEventListener("open", function () { socket.send(JSON.stringify({ type: "auth", token: state.authToken })); });
  socket.addEventListener("error", function () { finish(I18N.t("addModal.testRelayUnreachable"), true); });
  socket.addEventListener("close", function () { finish(I18N.t("addModal.testRelayUnreachable"), true); });
  socket.addEventListener("message", function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === "authenticated") {
      socket.send(JSON.stringify({ type: "query_test", host: host, port: port, query_protocol: protocol }));
    } else if (msg.type === "query_test_result") {
      var success = I18N.t("addModal.queryTestOk", { players: msg.players == null ? "–" : msg.players, max: msg.players_max == null ? "–" : msg.players_max });
      finish(msg.ok ? success : I18N.t("addModal.testFailed", { message: msg.message || "" }), !msg.ok);
    } else if (msg.type === "error") {
      finish(I18N.t("addModal.testFailed", { message: msg.message || "" }), true);
    }
  });
}

manualQueryTestBtn.addEventListener("click", function () {
  runQueryTest({
    host: document.getElementById("manual-host"), rconPort: document.getElementById("manual-port"),
    rconProtocol: document.getElementById("manual-protocol"), game: manualGameSelect,
    queryProtocol: manualQueryProtocol, queryPort: manualQueryPort, button: manualQueryTestBtn,
    setStatus: setManualQueryTestStatus,
  });
});

editServerQueryTestBtn.addEventListener("click", function () {
  runQueryTest({
    host: editServerHost, rconPort: editServerPort, rconProtocol: editServerProtocol, game: editServerGame,
    queryProtocol: editServerQueryProtocol, queryPort: editServerQueryPort, button: editServerQueryTestBtn,
    setStatus: function (text, isError) {
      editServerQueryTestStatus.textContent = text;
      editServerQueryTestStatus.classList.toggle("is-error", !!isError);
      editServerQueryTestStatus.classList.toggle("is-success", !isError);
      editServerQueryTestStatus.hidden = false;
    },
  });
});

manualTestBtn.addEventListener("click", function () {
  var host = document.getElementById("manual-host").value.trim();
  var port = parseInt(document.getElementById("manual-port").value, 10);
  var password = document.getElementById("manual-password").value;
  var protocol = document.getElementById("manual-protocol").value;

  if (!host || !port) {
    setManualTestStatus(I18N.t("addModal.testNeedsHostPort"), true);
    return;
  }

  manualTestBtn.disabled = true;
  setManualTestStatus(I18N.t("addModal.testing"), false);

  var socket;
  var settled = false;
  var timer = setTimeout(function () { finish(I18N.t("addModal.testTimedOut"), true); }, 10000);

  function finish(text, isError) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setManualTestStatus(text, isError);
    manualTestBtn.disabled = false;
    if (socket) socket.close();
  }

  try {
    socket = new WebSocket(relayWsUrl() + "/ws/rcon");
  } catch (e) {
    finish(I18N.t("addModal.testRelayUnreachable"), true);
    return;
  }

  socket.addEventListener("open", function () {
    socket.send(JSON.stringify({ type: "auth", token: state.authToken }));
  });
  socket.addEventListener("error", function () {
    finish(I18N.t("addModal.testRelayUnreachable"), true);
  });
  socket.addEventListener("close", function () {
    finish(I18N.t("addModal.testRelayUnreachable"), true);
  });
  socket.addEventListener("message", function (event) {
    var msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (msg.type === "authenticated") {
      socket.send(JSON.stringify({ type: "test", host: host, port: port, password: password, protocol: protocol, use_tls: manualTls.checked }));
    } else if (msg.type === "test_result") {
      finish(msg.ok ? I18N.t("addModal.testOk") : I18N.t("addModal.testFailed", { message: msg.message || "" }), !msg.ok);
    } else if (msg.type === "error") {
      finish(I18N.t("addModal.testFailed", { message: msg.message || "" }), true);
    }
  });
});

// --- manual add ---

manualForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var name = document.getElementById("manual-name").value;
  var host = document.getElementById("manual-host").value;
  var port = parseInt(document.getElementById("manual-port").value, 10);
  var password = document.getElementById("manual-password").value;
  var protocol = document.getElementById("manual-protocol").value;
  var game = manualGameSelect.value;
  var queryProtocol = manualQueryProtocol.value;
  var queryPort = optionalPort(manualQueryPort);

  apiFetch("/api/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, host: host, port: port, password: password, protocol: protocol, use_tls: manualTls.checked, query_protocol: queryProtocol, query_port: queryPort, game: game }),
  })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
      return r.json();
    })
    .then(function (srv) {
      state.servers.push(srv);
      renderServers();
      renderContent();
      manualForm.reset();
      syncManualTls();
      manualTestStatus.hidden = true;
      manualQueryTestStatus.hidden = true;
      addModal.close();
    })
    .catch(function (err) { showToast(I18N.t("errors.couldNotAddServer", { message: err.message })); });
});

// --- server selection + detail pane ---

// A console entry, once created, stays around for the session (so its
// log history survives a manual disconnect) — "connected" tracks
// whether the relay currently has a live connection to the game server
// itself, not just whether the browser's WebSocket to the relay is
// open. Those aren't the same thing: the relay tears down the game
// connection on any command error (e.g. a WebRCON timeout) without
// closing the browser's WebSocket, and if "connected" were based on
// the WebSocket alone, the UI would keep believing it's live — and the
// players auto-refresh would keep polling into "not connected" errors
// forever instead of stopping.
export function isConnected(id) {
  var c = state.consoles[id];
  return !!(c && c.gameConnected);
}

// Three-state status dot: hollow red (credentials still missing), solid
// red (offline), green (a live console).
export function serverStatusClass(server) {
  if (!server.has_password) return "status-missing";
  return isConnected(server.id) ? "status-connected" : "status-ready";
}

export function serverStatusTooltip(server) {
  if (!server.has_password) return I18N.t("servers.statusMissing");
  return isConnected(server.id) ? I18N.t("servers.connectedTooltip") : I18N.t("servers.statusReady");
}

function selectServer(id) {
  stopPlayersAutoRefresh();
  state.selectedServerId = id;
  state.activeServerTab = "console";
  var server = findServer(id);
  if (server && server.has_password) {
    if (!isConnected(id)) {
      ensureConsole(server); // players auto-refresh starts once "connected" arrives
    } else {
      startPlayersAutoRefresh(state.consoles[id]);
    }
  }
  renderServers();
  renderContent();
}

// --- password entry (server has no saved RCON password yet) ---

passwordForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var server = findServer(state.selectedServerId);
  if (!server) return;
  apiFetch("/api/servers/" + server.id + "/password", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: passwordInput.value }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error(I18N.t("errors.failedToSavePassword"));
      server.has_password = true;
      passwordInput.value = "";
      ensureConsole(server);
      renderServers();
      renderContent();
    })
    .catch(function (err) { showToast(err.message); });
});
