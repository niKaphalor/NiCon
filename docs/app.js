(function () {
  "use strict";

  // All state lives in memory only, for the lifetime of this page. Nothing
  // is written to localStorage, cookies, or anywhere else — reload the page
  // and it's gone, by design.
  var servers = [];
  var activeServerId = null;
  var socket = null;

  var relayStatus = document.getElementById("relay-status");
  var relayForm = document.getElementById("relay-form");
  var relayUrlInput = document.getElementById("relay-url");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var manualForm = document.getElementById("manual-form");
  var serverList = document.getElementById("server-list");
  var consoleSection = document.getElementById("console-section");
  var consoleTitle = document.getElementById("console-title");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");
  var gameSelect = document.getElementById("game-select");
  var playersBtn = document.getElementById("players-btn");
  var playersPanel = document.getElementById("players-panel");
  var pendingPlayersRequest = false;

  function relayHttpUrl() {
    return relayUrlInput.value.replace(/\/+$/, "");
  }

  function relayWsUrl() {
    return relayHttpUrl().replace(/^http/, "ws");
  }

  function setRelayStatus(ok) {
    relayStatus.textContent = "relay: " + (ok ? "connected" : "unreachable");
    relayStatus.className = "status " + (ok ? "status-ok" : "status-error");
  }

  function checkRelay() {
    fetch(relayHttpUrl() + "/healthz")
      .then(function (r) { setRelayStatus(r.ok); })
      .catch(function () { setRelayStatus(false); });
  }

  relayForm.addEventListener("submit", function (e) {
    e.preventDefault();
    checkRelay();
  });

  // --- server list rendering ---

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
    if (activeServerId === id) closeConsole();
    renderServers();
  }

  function renderServers() {
    serverList.innerHTML = "";
    servers.forEach(function (server) {
      var li = document.createElement("li");
      li.className = "server-row";

      var label = document.createElement("span");
      label.textContent = server.name + " — " + server.host + ":" + server.port +
        (server.game ? " (" + server.game + ")" : "");
      li.appendChild(label);

      var actions = document.createElement("span");
      actions.className = "server-actions";

      if (!server.password) {
        var pwInput = document.createElement("input");
        pwInput.type = "password";
        pwInput.placeholder = "RCON password";
        pwInput.autocomplete = "off";
        actions.appendChild(pwInput);

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = "Save";
        saveBtn.addEventListener("click", function () {
          server.password = pwInput.value;
          renderServers();
        });
        actions.appendChild(saveBtn);
      } else {
        var connectBtn = document.createElement("button");
        connectBtn.type = "button";
        connectBtn.textContent = "Connect";
        connectBtn.addEventListener("click", function () { openConsole(server); });
        actions.appendChild(connectBtn);
      }

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "link-button";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", function () { removeServer(server.id); });
      actions.appendChild(removeBtn);

      li.appendChild(actions);
      serverList.appendChild(li);
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
            source: "nitrado",
          });
        });
        renderServers();
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

    upsertServer({
      id: "manual-" + crypto.randomUUID(),
      name: name.value,
      host: host.value,
      port: parseInt(port.value, 10),
      password: password.value,
      source: "manual",
    });
    renderServers();
    manualForm.reset();
  });

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
    consoleTitle.textContent = server.name + " (" + server.host + ":" + server.port + ")";
    consoleSection.hidden = false;
    consoleSection.scrollIntoView({ behavior: "smooth" });

    socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    socket.addEventListener("open", function () {
      socket.send(JSON.stringify({
        type: "connect",
        host: server.host,
        port: server.port,
        password: server.password,
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

  function closeConsole() {
    closeSocket();
    activeServerId = null;
    consoleSection.hidden = true;
  }

  function renderPlayersPanel(rawOutput) {
    playersPanel.innerHTML = "";
    var key = gameSelect.value;
    if (!key) return;

    var game = window.NICON_GAMES[key];
    var parsed = game.parse(rawOutput);
    if (!parsed) {
      var notice = document.createElement("p");
      notice.className = "hint";
      notice.textContent = "Could not parse the " + game.label + " response — see the raw output above.";
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

  checkRelay();
})();
