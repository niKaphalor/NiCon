(function () {
  "use strict";

  // All state lives in memory only, for the lifetime of this page. Nothing
  // is written to localStorage, cookies, or anywhere else — reload the page
  // and it's gone, by design.
  var servers = [];

  // One entry per currently-open console: serverId -> { server, socket,
  // lines: [{kind, text}], pendingPlayersRequest }. Multiple can be open at
  // once — switching the view back to Servers doesn't close any of them.
  var consoles = {};
  var activeConsoleId = null;

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
  var addTabs = document.querySelectorAll(".tab");
  var addTabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var manualForm = document.getElementById("manual-form");

  var backBtn = document.getElementById("back-btn");
  var consoleTitle = document.getElementById("console-title");
  var consoleBadge = document.getElementById("console-badge");
  var consoleTabs = document.getElementById("console-tabs");
  var filterInput = document.getElementById("filter-input");
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
    if (consoles[id]) closeConsoleFor(id);
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
      if (consoles[server.id]) {
        var dot = document.createElement("span");
        dot.className = "connected-dot";
        dot.title = "Connected";
        h3.appendChild(dot);
      }
      h3.appendChild(document.createTextNode(server.name));
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
        connectBtn.textContent = consoles[server.id] ? "Open console" : "Connect";
        connectBtn.addEventListener("click", function () { openOrFocusConsole(server); });
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
  // Going back to the server list never closes any open console — it just
  // switches which view is visible. Multiple consoles can stay connected
  // in the background at once.

  function showServersView() {
    if (infoModal.open) infoModal.close();
    viewConsole.hidden = true;
    viewServers.hidden = false;
    renderServers();
  }

  backBtn.addEventListener("click", showServersView);

  // --- console (multiple, tabbed) ---

  function openOrFocusConsole(server) {
    if (!consoles[server.id]) createConsole(server);
    activeConsoleId = server.id;
    viewServers.hidden = true;
    viewConsole.hidden = false;
    renderConsoleTabs();
    renderActiveConsole();
  }

  function createConsole(server) {
    var c = {
      server: server,
      socket: null,
      lines: [],
      pendingPlayersRequest: false,
    };
    consoles[server.id] = c;
    appendConsoleLine(c, "system", "(connecting…)");

    var socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    c.socket = socket;

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
        appendConsoleLine(c, "error", "could not parse relay message");
        refreshIfActive(c);
        return;
      }

      if (msg.type === "connected") {
        appendConsoleLine(c, "system", "(connected)");
      } else if (msg.type === "response") {
        appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : "(no output)");
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          renderPlayersPanel(msg.output || "");
        }
      } else if (msg.type === "broadcast") {
        // WebRCON servers (Rust) push chat/log lines unsolicited.
        appendConsoleLine(c, "broadcast", msg.output || "");
      } else if (msg.type === "error") {
        appendConsoleLine(c, "error", msg.message);
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          if (activeConsoleId === server.id) playersPanel.innerHTML = "";
        }
      }
      refreshIfActive(c);
    });

    socket.addEventListener("close", function () {
      appendConsoleLine(c, "system", "(disconnected)");
      refreshIfActive(c);
      if (viewServers.hidden === false) renderServers();
    });

    socket.addEventListener("error", function () {
      appendConsoleLine(c, "error", "relay connection failed — is the relay running at " + relayHttpUrl() + "?");
      refreshIfActive(c);
    });
  }

  function closeConsoleFor(id) {
    var c = consoles[id];
    if (!c) return;
    if (c.socket) c.socket.close();
    delete consoles[id];
    renderConsoleTabs();

    if (activeConsoleId === id) {
      var remaining = Object.keys(consoles);
      if (remaining.length) {
        activeConsoleId = remaining[0];
        renderConsoleTabs();
        renderActiveConsole();
      } else {
        activeConsoleId = null;
        showServersView();
      }
    }
  }

  function appendConsoleLine(c, kind, text) {
    c.lines.push({ kind: kind, text: text });
  }

  function refreshIfActive(c) {
    if (activeConsoleId === c.server.id) renderActiveConsole();
  }

  function renderConsoleTabs() {
    consoleTabs.innerHTML = "";
    Object.keys(consoles).forEach(function (id) {
      var c = consoles[id];
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "console-tab" + (id === activeConsoleId ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", id === activeConsoleId ? "true" : "false");
      tab.addEventListener("click", function () {
        activeConsoleId = id;
        renderConsoleTabs();
        renderActiveConsole();
      });

      tab.appendChild(document.createTextNode(c.server.name));

      var closeBtn = document.createElement("span");
      closeBtn.className = "tab-close";
      closeBtn.textContent = "×";
      closeBtn.setAttribute("role", "button");
      closeBtn.setAttribute("aria-label", "Disconnect " + c.server.name);
      closeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        closeConsoleFor(id);
      });
      tab.appendChild(closeBtn);

      consoleTabs.appendChild(tab);
    });
  }

  function renderActiveConsole() {
    var c = consoles[activeConsoleId];
    if (!c) return;
    consoleTitle.textContent = c.server.name;
    consoleBadge.textContent = serverMeta(c.server);
    gameSelect.value = window.NICON_GUESS_GAME(c.server.game);
    renderLog(c);
  }

  // --- console log: filtering + highlighting ---

  function activeFilterRegex() {
    var text = filterInput.value.trim();
    if (!text) return null;
    try {
      return new RegExp(text, "i");
    } catch (e) {
      return null; // invalid regex mid-typing — just show everything
    }
  }

  function renderLog(c) {
    log.innerHTML = "";
    var regex = activeFilterRegex();

    c.lines.forEach(function (line) {
      if (regex && !regex.test(line.text)) return;
      var div = document.createElement("div");
      div.className = "log-line kind-" + line.kind;
      appendHighlighted(div, line.text, regex);
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }

  // Appends text to container as plain text, except for regex matches,
  // which are wrapped in <mark>. Built with DOM nodes (never innerHTML
  // with raw content) so console output can never be interpreted as HTML.
  function appendHighlighted(container, text, regex) {
    if (!regex) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    var global = new RegExp(regex.source, "gi");
    var lastIndex = 0;
    var match;
    while ((match = global.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var mark = document.createElement("mark");
      mark.textContent = match[0];
      container.appendChild(mark);
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) global.lastIndex++; // guard against zero-length match loops
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  filterInput.addEventListener("input", function () {
    var c = consoles[activeConsoleId];
    if (c) renderLog(c);
  });

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
    var c = consoles[activeConsoleId];
    if (!c || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    var key = gameSelect.value;
    if (!key) return;
    var command = window.NICON_GAMES[key].command;
    c.pendingPlayersRequest = true;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
  });

  // --- command bar ---

  cmdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var c = consoles[activeConsoleId];
    var command = cmdInput.value.trim();
    if (!command || !c || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
    cmdInput.value = "";
  });

  renderServers();
  checkRelay();
})();
