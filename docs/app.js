(function () {
  "use strict";

  // All state lives in memory only, for the lifetime of this page. Nothing
  // is written to localStorage, cookies, or anywhere else — reload the page
  // and it's gone, by design.
  var servers = [];
  var activeServerId = null;
  var socket = null;
  var pendingPlayersRequest = false;

  // --- element refs ---

  var relayPill = document.getElementById("relay-pill");
  var relayBanner = document.getElementById("relay-banner");
  var settingsBtn = document.getElementById("settings-btn");
  var bannerSettingsBtn = document.getElementById("banner-settings-btn");
  var settingsModal = document.getElementById("settings-modal");
  var settingsClose = document.getElementById("settings-close");
  var relayForm = document.getElementById("relay-form");
  var relayUrlInput = document.getElementById("relay-url");

  var viewServers = document.getElementById("view-servers");
  var viewConsole = document.getElementById("view-console");
  var serverGrid = document.getElementById("server-grid");
  var emptyState = document.getElementById("empty-state");
  var addServerBtn = document.getElementById("add-server-btn");
  var emptyAddBtn = document.getElementById("empty-add-btn");

  var addModal = document.getElementById("add-modal");
  var addClose = document.getElementById("add-close");
  var tabs = document.querySelectorAll(".tab");
  var tabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var manualForm = document.getElementById("manual-form");

  var backBtn = document.getElementById("back-btn");
  var consoleTitle = document.getElementById("console-title");
  var consoleBadge = document.getElementById("console-badge");
  var infoBtn = document.getElementById("info-btn");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");

  var gameSelect = document.getElementById("game-select");
  var playersBtn = document.getElementById("players-btn");
  var playersPanel = document.getElementById("players-panel");
  var infoModal = document.getElementById("info-modal");
  var infoClose = document.getElementById("info-close");

  // --- relay address + status ---

  function relayHttpUrl() {
    return relayUrlInput.value.replace(/\/+$/, "");
  }

  function relayWsUrl() {
    return relayHttpUrl().replace(/^http/, "ws");
  }

  function setRelayStatus(ok) {
    relayPill.className = "relay-pill " + (ok ? "status-ok" : "status-error");
    relayBanner.hidden = ok;
  }

  function checkRelay() {
    fetch(relayHttpUrl() + "/healthz")
      .then(function (r) { setRelayStatus(r.ok); })
      .catch(function () { setRelayStatus(false); });
  }

  relayForm.addEventListener("submit", function (e) {
    e.preventDefault();
    checkRelay();
    settingsModal.close();
  });

  settingsBtn.addEventListener("click", function () { settingsModal.showModal(); });
  bannerSettingsBtn.addEventListener("click", function () { settingsModal.showModal(); });
  relayPill.addEventListener("click", function () { settingsModal.showModal(); });
  settingsClose.addEventListener("click", function () { settingsModal.close(); });
  settingsModal.addEventListener("click", function (e) {
    if (e.target === settingsModal) settingsModal.close();
  });

  // --- add-server modal + tabs ---

  function openAddModal() {
    addModal.showModal();
  }

  addServerBtn.addEventListener("click", openAddModal);
  emptyAddBtn.addEventListener("click", openAddModal);
  addClose.addEventListener("click", function () { addModal.close(); });
  addModal.addEventListener("click", function (e) {
    if (e.target === addModal) addModal.close();
  });

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (t) {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      tabPanels.forEach(function (panel) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    });
  });

  // --- server state ---

  function findServer(id) {
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].id === id) return servers[i];
    }
    return null;
  }

  function upsertServer(server) {
    var existing = findServer(server.id);
    if (existing) {
      Object.assign(existing, server);
    } else {
      servers.push(server);
    }
  }

  function removeServer(id) {
    servers = servers.filter(function (s) { return s.id !== id; });
    if (activeServerId === id) showServersView();
    renderServers();
  }

  function serverMeta(server) {
    var parts = [];
    if (server.game) parts.push(server.game);
    if (server.protocol === "webrcon") parts.push("WebRCON");
    parts.push(server.host + ":" + server.port);
    return parts.join(" · ");
  }

  function renderServers() {
    serverGrid.innerHTML = "";
    emptyState.hidden = servers.length > 0;
    serverGrid.hidden = servers.length === 0;

    servers.forEach(function (server) {
      var card = document.createElement("article");
      card.className = "server-card";

      var main = document.createElement("div");
      var h3 = document.createElement("h3");
      h3.textContent = server.name;
      main.appendChild(h3);
      var meta = document.createElement("p");
      meta.className = "server-meta";
      meta.textContent = serverMeta(server);
      main.appendChild(meta);
      card.appendChild(main);

      var actions = document.createElement("div");
      actions.className = "server-card-actions";

      if (!server.password) {
        var pwInput = document.createElement("input");
        pwInput.type = "password";
        pwInput.placeholder = "RCON password";
        pwInput.autocomplete = "off";
        pwInput.setAttribute("aria-label", "RCON password for " + server.name);
        actions.appendChild(pwInput);

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn-primary";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", function () {
          server.password = pwInput.value;
          renderServers();
        });
        actions.appendChild(saveBtn);
      } else {
        var connectBtn = document.createElement("button");
        connectBtn.type = "button";
        connectBtn.className = "btn-primary";
        connectBtn.textContent = "Connect";
        connectBtn.addEventListener("click", function () { openConsole(server); });
        actions.appendChild(connectBtn);
      }

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "icon-btn small";
      removeBtn.title = "Remove";
      removeBtn.setAttribute("aria-label", "Remove " + server.name);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () { removeServer(server.id); });
      actions.appendChild(removeBtn);

      card.appendChild(actions);
      serverGrid.appendChild(card);
    });
  }

  // --- Nitrado sync ---

  nitradoForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var token = nitradoTokenInput.value.trim();
    if (!token) return;

    fetch(relayHttpUrl() + "/api/nitrado/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
        return r.json();
      })
      .then(function (list) {
        (list || []).forEach(function (item) {
          upsertServer({
            id: "nitrado-" + item.service_id,
            name: item.name,
            game: item.game,
            host: item.host,
            port: item.port,
            password: null,
            protocol: item.protocol || "source",
            source: "nitrado",
          });
        });
        renderServers();
        addModal.close();
      })
      .catch(function (err) {
        alert("Nitrado sync failed: " + err.message);
      })
      .finally(function () {
        // The token was only ever needed for this one request.
        nitradoTokenInput.value = "";
      });
  });

  // --- manual add ---

  manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("manual-name");
    var host = document.getElementById("manual-host");
    var port = document.getElementById("manual-port");
    var password = document.getElementById("manual-password");
    var protocol = document.getElementById("manual-protocol");

    upsertServer({
      id: "manual-" + crypto.randomUUID(),
      name: name.value,
      host: host.value,
      port: parseInt(port.value, 10),
      password: password.value,
      protocol: protocol.value,
      source: "manual",
    });
    renderServers();
    manualForm.reset();
    addModal.close();
  });

  // --- view switching ---

  function showServersView() {
    closeSocket();
    activeServerId = null;
    if (infoModal.open) infoModal.close();
    viewConsole.hidden = true;
    viewServers.hidden = false;
  }

  backBtn.addEventListener("click", showServersView);

  // --- console ---

  function appendLog(line) {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  }

  function openConsole(server) {
    closeSocket();
    activeServerId = server.id;
    log.textContent = "";
    playersPanel.innerHTML = "";
    pendingPlayersRequest = false;
    gameSelect.value = window.NICON_GUESS_GAME(server.game);
    consoleTitle.textContent = server.name;
    consoleBadge.textContent = serverMeta(server);
    viewServers.hidden = true;
    viewConsole.hidden = false;

    socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    socket.addEventListener("open", function () {
      socket.send(JSON.stringify({
        type: "connect",
        host: server.host,
        port: server.port,
        password: server.password,
        protocol: server.protocol || "source",
      }));
    });
    socket.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        appendLog("error: could not parse relay message");
        return;
      }
      if (msg.type === "connected") {
        appendLog("(connected)");
      } else if (msg.type === "response") {
        appendLog(msg.output && msg.output.length ? msg.output : "(no output)");
        if (pendingPlayersRequest) {
          pendingPlayersRequest = false;
          renderPlayersPanel(msg.output || "");
        }
      } else if (msg.type === "error") {
        appendLog("error: " + msg.message);
        if (pendingPlayersRequest) {
          pendingPlayersRequest = false;
          playersPanel.innerHTML = "";
        }
      }
    });
    socket.addEventListener("close", function () {
      appendLog("(disconnected)");
    });
    socket.addEventListener("error", function () {
      appendLog("error: relay connection failed — is the relay running at " + relayHttpUrl() + "?");
    });
  }

  function closeSocket() {
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  // --- players info modal ---

  infoBtn.addEventListener("click", function () { infoModal.showModal(); });
  infoClose.addEventListener("click", function () { infoModal.close(); });
  infoModal.addEventListener("click", function (e) {
    if (e.target === infoModal) infoModal.close();
  });

  function renderPlayersPanel(rawOutput) {
    playersPanel.innerHTML = "";
    var key = gameSelect.value;
    if (!key) return;

    var game = window.NICON_GAMES[key];
    var parsed = game.parse(rawOutput);
    if (!parsed) {
      var notice = document.createElement("p");
      notice.className = "hint";
      notice.textContent = "Could not parse the " + game.label + " response — see the raw output in the console.";
      playersPanel.appendChild(notice);
      return;
    }

    var summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = parsed.summary;
    playersPanel.appendChild(summary);

    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    parsed.columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    parsed.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell) {
        var td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    playersPanel.appendChild(table);
  }

  playersBtn.addEventListener("click", function () {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog("error: not connected");
      return;
    }
    var key = gameSelect.value;
    if (!key) {
      appendLog("error: select a game above first");
      return;
    }
    var command = window.NICON_GAMES[key].command;
    pendingPlayersRequest = true;
    appendLog("> " + command);
    socket.send(JSON.stringify({ type: "command", command: command }));
  });

  cmdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var command = cmdInput.value.trim();
    if (!command || !socket || socket.readyState !== WebSocket.OPEN) return;
    appendLog("> " + command);
    socket.send(JSON.stringify({ type: "command", command: command }));
    cmdInput.value = "";
  });

  renderServers();
  checkRelay();
})();
