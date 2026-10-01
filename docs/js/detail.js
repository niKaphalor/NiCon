// The selected server's detail pane: header, overview, tabs and the password prompt.
import { renderAuditLogList } from "./admin.js";
import { apiErrorMessage, apiFetch } from "./api.js";
import { renderQuickCommands, updateQuickCommandsEnabled } from "./commands.js";
import { disconnectConsole, ensureConsole } from "./console.js";
import { renderLog } from "./consolelog.js";
import { cmdHistoryPanel, cmdSendBtn, cmdTemplatesPanel, contentConsole, contentEmpty, contentEmptyText, contentPane, contentPassword, emptyAddBtn, head, moderationRulesPanel, nitradoResources, nitradoResourcesCard, passwordPowerActions, passwordPublicStatus, passwordPublicStatusValues, passwordServerName, serverAuditList, serverAuditPanel, serverConsolePanel, serverOverviewContent, serverOverviewPanel, serverOverviewRange, serverPlayerCount, serverPlayersList, serverPlayersPanel, serverTabButtons, serverTabs } from "./dom.js";
import { buildHealthChart, formatHealthTimestamp, healthHistoryCache } from "./health.js";
import { fetchPagedList, pagerHostFor, renderPager } from "./lists.js";
import { renderPlayersInto, renderPlayersPanel } from "./players.js";
import { findServer, isConnected, openEditServerModal, protocolLabel, removeServer, renderServers, serverStatusClass, serverStatusTooltip } from "./servers.js";
import { ACTIVITY_PER_PAGE, I18N, nitradoPowerPending, state } from "./state.js";
import { showConfirm, showToast } from "./ui.js";

// --- content pane rendering ---

// Nitrado's own panel hides "Start" while a server is running (and
// "Stop"/"Restart" while it's stopped) — calling games/start on an
// already-running server gets a confusing "game not found" error back
// instead of a clear "already running" one. Mirror that gating here so
// the same mistake isn't possible from NiCon's menu. "unknown" (status
// not loaded yet) keeps every action available rather than guessing.
function nitradoStatusKind(status) {
  var normalized = String(status || "").toLowerCase();
  if (["started", "running", "online"].indexOf(normalized) !== -1) return "online";
  if (["stopped", "offline"].indexOf(normalized) !== -1) return "offline";
  if (["restarting", "restart"].indexOf(normalized) !== -1) return "restarting";
  return "unknown";
}

function nitradoActionLabel(action) {
  if (action === "start") return I18N.t("content.nitradoStart");
  if (action === "stop") return I18N.t("content.nitradoStop");
  return I18N.t("content.nitradoRestart");
}

function nitradoActionConfirm(action) {
  if (action === "start") return I18N.t("content.nitradoStartConfirm");
  if (action === "stop") return I18N.t("content.nitradoStopConfirm");
  return I18N.t("content.nitradoRestartConfirm");
}

function appendNitradoPowerButtons(container, server, includeLabel) {
  if (server.source !== "nitrado") return;
  if (includeLabel) {
    var label = document.createElement("span");
    label.className = "nitrado-power-label";
    label.textContent = I18N.t("content.nitradoPower");
    container.appendChild(label);
  }
  ["start", "stop", "restart"].forEach(function (action) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn-secondary nitrado-power-btn";
    button.dataset.nitradoAction = action;
    button.textContent = nitradoActionLabel(action);
    button.disabled = !!nitradoPowerPending[server.id];
    button.addEventListener("click", function () {
      requestNitradoPower(server, action);
    });
    container.appendChild(button);
  });
}

function requestNitradoPower(server, action) {
  if (nitradoPowerPending[server.id]) return;
  showConfirm(nitradoActionConfirm(action)).then(function (confirmed) {
    if (!confirmed || nitradoPowerPending[server.id]) return;
    nitradoPowerPending[server.id] = true;
    renderContent();

    apiFetch("/api/servers/" + server.id + "/nitrado-power", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action }),
    })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.text().then(function (body) {
          throw new Error(apiErrorMessage(body) || ("HTTP " + r.status));
        });
      })
      .then(function () {
        if (action === "stop" && state.consoles[server.id]) {
          disconnectConsole(state.consoles[server.id]);
        }
        showToast(I18N.t("content.nitradoActionSent", { action: nitradoActionLabel(action) }), "success");
      })
      .catch(function (err) {
        showToast(I18N.t("errors.nitradoPowerFailed", { message: err.message || "unknown error" }));
      })
      .finally(function () {
        delete nitradoPowerPending[server.id];
        if (state.selectedServerId === server.id) renderContent();
      });
  });
}

export function renderContent() {
  var server = findServer(state.selectedServerId);
  if (!server) state.selectedServerId = null;
  setServerBackground(server);

  contentEmpty.hidden = !!server;
  contentPassword.hidden = true;
  contentConsole.hidden = true;
  nitradoResourcesCard.hidden = true;
  passwordPublicStatus.hidden = true;
  passwordPublicStatusValues.innerHTML = "";
  passwordPowerActions.hidden = true;
  passwordPowerActions.innerHTML = "";

  if (!server) {
    contentEmptyText.textContent = state.servers.length ? I18N.t("content.selectPrompt") : I18N.t("servers.emptyTitle");
    emptyAddBtn.hidden = state.servers.length > 0;
    return;
  }

  if (!server.has_password) {
    contentPassword.hidden = false;
    passwordServerName.textContent = server.name;
    // The relay's A2S/Minecraft-Query sampling (see README's Relay
    // section) needs no RCON password at all, so a server can already
    // have real player/uptime history before one is ever entered here.
    renderPublicStatus(server);
    if (server.source === "nitrado") {
      passwordPowerActions.hidden = false;
      appendNitradoPowerButtons(passwordPowerActions, server, true);
    }
    return;
  }

  contentConsole.hidden = false;
  renderHead(server);
  renderServerWorkspace(server);
  renderLog(state.consoles[server.id]);
  renderQuickCommands(state.consoles[server.id]);
  cmdHistoryPanel.hidden = true; // a switch to a different server's console starts closed, not showing the old one's history
  cmdTemplatesPanel.hidden = true;
  moderationRulesPanel.hidden = true;
  renderPlayersPanel(state.consoles[server.id]);
  renderPlayersInto(serverPlayersList, state.consoles[server.id]);
  updateServerPlayerCount(server);
  renderNitradoResources(server);
  updateCmdBarState();
}

function setActiveServerTab(tab) {
  if (["overview", "console", "players", "audit"].indexOf(tab) === -1) tab = "console";
  state.activeServerTab = tab;
  var server = findServer(state.selectedServerId);
  if (server) renderServerWorkspace(server);
}

function renderServerWorkspace(server) {
  var panels = {
    overview: serverOverviewPanel,
    console: serverConsolePanel,
    players: serverPlayersPanel,
    audit: serverAuditPanel,
  };
  serverTabButtons.forEach(function (button) {
    var selected = button.dataset.serverTab === state.activeServerTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== state.activeServerTab; });
  if (state.activeServerTab === "overview") renderServerOverview(server);
  if (state.activeServerTab === "players") renderPlayersInto(serverPlayersList, state.consoles[server.id]);
  if (state.activeServerTab === "audit") loadServerAudit(server);
}

serverTabs.addEventListener("click", function (event) {
  var button = event.target.closest("[data-server-tab]");
  if (button) setActiveServerTab(button.dataset.serverTab);
});

serverTabs.addEventListener("keydown", function (event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  var buttons = Array.prototype.slice.call(serverTabButtons);
  var index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  var next = (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
  setActiveServerTab(buttons[next].dataset.serverTab);
});

serverOverviewRange.addEventListener("change", function () {
  var server = findServer(state.selectedServerId);
  if (server) renderServerOverview(server);
});

function currentPlayerCount(server) {
  var c = state.consoles[server.id];
  if (c && c.lastParsed && c.lastParsed.ok) return c.lastParsed.players.length;
  if (server.nitrado_resources && server.nitrado_resources.players != null) return Number(server.nitrado_resources.players);
  return null;
}

export function updateServerPlayerCount(server) {
  var count = currentPlayerCount(server);
  serverPlayerCount.textContent = count == null ? "—" : String(count);
  var headerCount = head.querySelector(".server-current-player-count");
  if (headerCount) headerCount.textContent = I18N.t("workspace.playersNow") + ": " + (count == null ? "—" : count);
}

function appendOverviewMetric(container, labelText, valueText, detailText, stateClass) {
  var card = document.createElement("div");
  card.className = "overview-metric" + (stateClass ? " " + stateClass : "");
  var label = document.createElement("span"); label.textContent = labelText;
  var value = document.createElement("strong"); value.textContent = valueText;
  card.appendChild(label); card.appendChild(value);
  if (detailText) {
    var detail = document.createElement("small"); detail.textContent = detailText; card.appendChild(detail);
  }
  container.appendChild(card);
}

export function renderServerOverview(server) {
  serverOverviewContent.innerHTML = "";
  var h = state.serverHealth[server.id] || {};
  var range = serverOverviewRange.value;
  var historyKey = server.id + ":" + range;
  var historyEntry = healthHistoryCache[historyKey];
  var history = historyEntry && historyEntry.data;

  var metrics = document.createElement("div"); metrics.className = "overview-metrics";
  appendOverviewMetric(metrics, I18N.t("health.colUptime"), history && history.uptime_percent != null ? history.uptime_percent.toFixed(2) + "%" : "—", history ? I18N.t("health.samples", { value: history.sample_completeness_percent }) : "", server.health_ok ? "is-good" : "");
  var playerCount = currentPlayerCount(server);
  appendOverviewMetric(metrics, I18N.t("workspace.playersNow"), playerCount == null ? "—" : String(playerCount), history && history.players_peak != null ? I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak }) : "");
  appendOverviewMetric(metrics, I18N.t("workspace.relayOverhead"), h.relayOverheadMs == null ? "—" : h.relayOverheadMs.toFixed(1) + " ms", I18N.t("workspace.relayTarget"), h.relayOverheadMs != null && h.relayOverheadMs <= 50 ? "is-good" : "");
  appendOverviewMetric(metrics, I18N.t("workspace.lastCheck"), server.health_checked_at ? new Date(server.health_checked_at).toLocaleString() : I18N.t("health.autoCheckNeverRun"), server.health_latency_ms == null ? "" : server.health_latency_ms + " ms", server.health_ok ? "is-good" : (server.health_checked_at ? "is-bad" : ""));
  serverOverviewContent.appendChild(metrics);

  if (!historyEntry) {
    healthHistoryCache[historyKey] = { loading: true };
    apiFetch("/api/servers/" + server.id + "/health-history?range=" + encodeURIComponent(range))
      .then(function (response) { if (!response.ok) throw new Error("history unavailable"); return response.json(); })
      .then(function (data) { healthHistoryCache[historyKey] = { data: data, fetchedAt: Date.now() }; if (state.selectedServerId === server.id && state.activeServerTab === "overview") renderServerOverview(server); })
      .catch(function () { healthHistoryCache[historyKey] = { data: null, failed: true }; if (state.selectedServerId === server.id && state.activeServerTab === "overview") renderServerOverview(server); });
  }

  var charts = document.createElement("div"); charts.className = "overview-charts";
  [[I18N.t("workspace.chartUptime"), false], [I18N.t("workspace.chartPlayers"), true]].forEach(function (item) {
    var figure = document.createElement("figure"); figure.className = "overview-chart-card";
    var caption = document.createElement("figcaption"); caption.textContent = item[0]; figure.appendChild(caption);
    if (history) {
      var chart = buildHealthChart(history.samples, item[1], history.range || range);
      chart.removeAttribute("aria-hidden");
      chart.setAttribute("role", "img");
      chart.setAttribute("aria-label", item[0]);
      figure.appendChild(chart);
    } else {
      var placeholder = document.createElement("p"); placeholder.className = "hint";
      placeholder.textContent = historyEntry && historyEntry.failed ? I18N.t("workspace.unavailable") : I18N.t("workspace.loading");
      figure.appendChild(placeholder);
    }
    charts.appendChild(figure);
  });
  serverOverviewContent.appendChild(charts);

  var signals = document.createElement("div"); signals.className = "card overview-signals";
  var title = document.createElement("div"); title.className = "card-kicker"; title.textContent = I18N.t("workspace.recentSignals"); signals.appendChild(title);
  var list = document.createElement("dl");
  function signal(labelText, valueText, error) {
    var dt = document.createElement("dt"); dt.textContent = labelText;
    var dd = document.createElement("dd"); dd.textContent = valueText; if (error) dd.className = "health-error";
    list.appendChild(dt); list.appendChild(dd);
  }
  signal(I18N.t("workspace.status"), serverStatusTooltip(server));
  signal(I18N.t("workspace.autoCheck"), server.health_checked_at ? (server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed")) : I18N.t("health.autoCheckNeverRun"), !!server.health_checked_at && !server.health_ok);
  signal(I18N.t("workspace.lastConnected"), formatHealthTimestamp(h.lastConnectedAt) || I18N.t("health.never"));
  signal(I18N.t("workspace.lastError"), h.lastError || server.health_error || I18N.t("health.noError"), !!(h.lastError || server.health_error));
  signals.appendChild(list); serverOverviewContent.appendChild(signals);
}

function loadServerAudit(server, page) {
  if (state.serverAuditServerId !== server.id) { state.serverAuditServerId = server.id; state.serverAuditPage = 1; }
  if (page) state.serverAuditPage = page;
  // Only used when the API predates ?server_id= and sent everything.
  var sameServer = function (entry) {
    return entry.kind === "rcon" && (Number(entry.server_id) === Number(server.id) || (!entry.server_id && entry.server_name === server.name));
  };
  return fetchPagedList("/api/audit-log", state.serverAuditPage, ACTIVITY_PER_PAGE, "server_id=" + encodeURIComponent(server.id), sameServer)
    .then(function (data) {
      if (state.serverAuditServerId !== server.id) return; // the user switched servers meanwhile
      if (!data.items.length && data.page > 1) return loadServerAudit(server, Math.max(1, data.total_pages));
      state.serverAuditPage = data.page;
      renderAuditLogList(serverAuditList, data.items, "workspace.auditEmpty");
      renderPager(pagerHostFor(serverAuditList), data, function (p) { loadServerAudit(server, p); });
    })
    .catch(function () { /* the audit tab simply stays as it was */ });
}

function renderServerAudit(server) {
  loadServerAudit(server);
}

function setServerBackground(server) {
  var key = server ? window.NICON_GUESS_GAME(server.game) : "";
  var game = key ? window.NICON_GAMES[key] : null;
  var image = game && game.backgroundImage ? game.backgroundImage : "";
  contentPane.classList.toggle("has-game-background", !!image);
  if (image) {
    contentPane.style.setProperty("--game-background-image", 'url("' + image + '")');
  } else {
    contentPane.style.removeProperty("--game-background-image");
  }
}

function setDashboardLayout(layout) {
  if (["balanced", "wide", "stacked", "compact"].indexOf(layout) === -1) layout = "balanced";
  localStorage.setItem("nicon_dashboard_layout", layout);
  var work = document.querySelector(".work");
  work.classList.toggle("layout-wide", layout === "wide");
  work.classList.toggle("layout-stacked", layout === "stacked");
  work.classList.toggle("layout-compact", layout === "compact");
}

// Shown on the "enter RCON password" screen, for any server (not just
// Nitrado-sourced ones) — reads whatever the relay's passive A2S/
// Minecraft-Query sampling has already recorded (see README's Relay
// section), since that never needed a password in the first place. A
// server this has no data for yet (wrong protocol, unreachable query
// port, or just too soon after being added) degrades to a plain
// "unavailable" line rather than an empty box.
function renderPublicStatus(server) {
  passwordPublicStatus.hidden = false;
  // "disabled" is known client-side already (it's on the server object
  // itself) — no need to fetch just to say so, and it avoids this
  // collapsing into the same "no data yet" text as a server that simply
  // hasn't been sampled yet, which is exactly the ambiguity that made a
  // real ARK: Survival Ascended timeout confusing to diagnose.
  if (server.query_protocol === "disabled") {
    passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusDisabled");
    return;
  }
  passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusLoading");
  apiFetch("/api/servers/" + server.id + "/health-history?range=24h")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status unavailable")); })
    .then(function (history) {
      if (state.selectedServerId !== server.id || server.has_password) return;
      var samples = history.samples || [];
      var latest = samples.length ? samples[samples.length - 1] : null;
      passwordPublicStatusValues.innerHTML = "";
      if (!latest) {
        passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusUnavailable");
        return;
      }
      var items = [
        [I18N.t("phase2.status"), latest.online ? I18N.t("phase2.statusStarted") : I18N.t("phase2.statusStopped"),
          "is-status " + (latest.online ? "is-online" : "is-offline")],
        [I18N.t("console.players"), latest.players == null ? "—" : latest.players + (latest.players_max != null ? " / " + latest.players_max : "")],
      ];
      if (history.players_peak != null) {
        items.push([I18N.t("health.range24h"), I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak })]);
      }
      items.forEach(function (item) {
        var box = document.createElement("div"); box.className = "resource-item" + (item[2] ? " " + item[2] : "");
        var label = document.createElement("span"); label.textContent = item[0];
        var value = document.createElement("strong"); value.textContent = item[1];
        box.appendChild(label); box.appendChild(value); passwordPublicStatusValues.appendChild(box);
      });
    })
    .catch(function () {
      if (state.selectedServerId === server.id && !server.has_password) passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusFetchFailed");
    });
}

function renderNitradoResources(server) {
  setDashboardLayout(localStorage.getItem("nicon_dashboard_layout") || "balanced");
  nitradoResourcesCard.hidden = server.source !== "nitrado";
  if (server.source !== "nitrado") return;
  nitradoResources.innerHTML = "";
  var cached = server.nitrado_resources;
  function statusLabel(status) {
    var kind = nitradoStatusKind(status);
    if (kind === "online") return I18N.t("phase2.statusStarted");
    if (kind === "offline") return I18N.t("phase2.statusStopped");
    if (kind === "restarting") return I18N.t("phase2.statusRestarting");
    return status || I18N.t("phase2.statusUnknown");
  }
  function statusClass(status) {
    var kind = nitradoStatusKind(status);
    if (kind === "online") return "is-status is-online";
    if (kind === "offline") return "is-status is-offline";
    if (kind === "restarting") return "is-status is-restarting";
    return "is-status";
  }
  function draw(data) {
    nitradoResources.innerHTML = "";
    var items = [
      [I18N.t("phase2.status"), statusLabel(data.status), statusClass(data.status)],
      [I18N.t("console.players"), (data.players || 0) + " / " + (data.players_max || 0)],
      [I18N.t("phase2.map"), data.map || "—"],
      [I18N.t("phase2.version"), data.version || "—"],
    ];
    items.forEach(function (item) {
      var box = document.createElement("div"); box.className = "resource-item" + (item[2] ? " " + item[2] : "");
      var label = document.createElement("span"); label.textContent = item[0];
      var value = document.createElement("strong"); value.textContent = item[1];
      box.appendChild(label); box.appendChild(value); nitradoResources.appendChild(box);
    });
  }
  if (cached) draw(cached); else nitradoResources.textContent = I18N.t("phase2.resourcesLoading");
  if (server.nitradoResourcesLoading || (server.nitradoResourcesFetchedAt && Date.now() - server.nitradoResourcesFetchedAt < 60000)) return;
  server.nitradoResourcesLoading = true;
  apiFetch("/api/servers/" + server.id + "/nitrado-status")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status unavailable")); })
    .then(function (data) {
      server.nitrado_resources = data;
      server.nitradoResourcesFetchedAt = Date.now();
      if (state.selectedServerId === server.id) {
        draw(data);
        updateServerPlayerCount(server);
        renderHead(server); // refresh Start/Stop gating now that the real status is known
        if (state.activeServerTab === "overview") renderServerOverview(server);
      }
    })
    .catch(function () { if (!cached && state.selectedServerId === server.id) nitradoResources.textContent = I18N.t("phase2.resourcesUnavailable"); })
    .finally(function () { server.nitradoResourcesLoading = false; });
}

export function renderHead(server) {
  head.innerHTML = "";

  var identity = document.createElement("div");
  identity.className = "server-identity";
  var gameKey = window.NICON_GUESS_GAME(server.game);
  var game = gameKey ? window.NICON_GAMES[gameKey] : null;
  var eyebrow = document.createElement("div");
  eyebrow.className = "server-eyebrow";
  eyebrow.textContent = (game ? game.label : server.game || I18N.t("info.genericOption")) + " · " + protocolLabel(server.protocol) + (server.use_tls ? " · TLS" : "");
  identity.appendChild(eyebrow);

  var h1 = document.createElement("h1");
  if (server.game_icon_url) {
    var gameIcon = document.createElement("img");
    gameIcon.className = "server-game-icon";
    gameIcon.loading = "lazy";
    gameIcon.referrerPolicy = "no-referrer";
    gameIcon.src = server.game_icon_url;
    gameIcon.alt = "";
    gameIcon.addEventListener("error", function () { gameIcon.remove(); });
    h1.appendChild(gameIcon);
  }
  var dot = document.createElement("span");
  dot.className = "dot " + serverStatusClass(server);
  dot.title = serverStatusTooltip(server);
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", serverStatusTooltip(server));
  h1.appendChild(dot);
  h1.appendChild(document.createTextNode(server.name));
  identity.appendChild(h1);

  var meta = document.createElement("div");
  meta.className = "server-meta";
  var status = document.createElement("span"); status.textContent = serverStatusTooltip(server); meta.appendChild(status);
  var playerCount = currentPlayerCount(server);
  var players = document.createElement("span"); players.className = "server-current-player-count"; players.textContent = I18N.t("workspace.playersNow") + ": " + (playerCount == null ? "—" : playerCount); meta.appendChild(players);
  var endpoint = document.createElement("span"); endpoint.className = "mono"; endpoint.textContent = server.host + ":" + server.port; meta.appendChild(endpoint);
  if (server.source === "nitrado") {
    var nitradoTag = document.createElement("span"); nitradoTag.className = "tag tag-nitrado"; nitradoTag.textContent = I18N.t("common.nitrado"); meta.appendChild(nitradoTag);
  }
  identity.appendChild(meta);
  head.appendChild(identity);

  // Top-right corner, deliberately separate from game.logoImage (the
  // supported-games *tile* overlay, Minecraft-only) — see games.js's
  // nitradoBackgroundSlugs comment. .head-game-logo's CSS keeps this
  // clear of .head-actions below, which is where the buttons always
  // render (.head is align-items:flex-end).
  if (game && game.headerLogoImage) {
    var headLogo = document.createElement("img");
    headLogo.className = "head-game-logo";
    headLogo.src = game.headerLogoImage;
    headLogo.alt = "";
    headLogo.loading = "lazy";
    headLogo.referrerPolicy = "no-referrer";
    headLogo.addEventListener("error", function () { headLogo.remove(); });
    head.appendChild(headLogo);
  }

  var actions = document.createElement("div");
  actions.className = "head-actions";

  var toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = isConnected(server.id) ? "btn-secondary" : "btn-primary";
  if (isConnected(server.id)) {
    toggleBtn.textContent = I18N.t("content.disconnect");
    toggleBtn.addEventListener("click", function () {
      var c = state.consoles[server.id];
      if (c) disconnectConsole(c);
    });
  } else {
    toggleBtn.textContent = I18N.t("servers.connect");
    toggleBtn.addEventListener("click", function () {
      ensureConsole(server);
      renderServers();
      renderContent();
    });
  }
  actions.appendChild(toggleBtn);

  var nitradoStatus = nitradoStatusKind(server.nitrado_resources && server.nitrado_resources.status);

  if (server.source === "nitrado" && nitradoStatus !== "offline") {
    var restartBtn = document.createElement("button");
    restartBtn.type = "button"; restartBtn.className = "btn-secondary"; restartBtn.textContent = I18N.t("content.nitradoRestart");
    restartBtn.disabled = !!nitradoPowerPending[server.id];
    restartBtn.addEventListener("click", function () { requestNitradoPower(server, "restart"); });
    actions.appendChild(restartBtn);
  }

  var menu = document.createElement("details"); menu.className = "server-actions-menu";
  var menuSummary = document.createElement("summary"); menuSummary.className = "icon-btn"; menuSummary.textContent = "•••"; menuSummary.setAttribute("aria-label", I18N.t("workspace.moreActions")); menu.appendChild(menuSummary);
  var menuBody = document.createElement("div"); menuBody.className = "server-actions-menu-body";

  if (server.source === "nitrado") {
    // Mirror Nitrado's own panel: Start only when known to be stopped
    // (or not yet loaded), Stop only when known to be running (or not
    // yet loaded) — calling either against the wrong state is what
    // produced Nitrado's misleading "game not found" 500 on start.
    ["start", "stop"].filter(function (action) {
      if (action === "start") return nitradoStatus !== "online";
      return nitradoStatus !== "offline";
    }).forEach(function (action) {
      var powerButton = document.createElement("button"); powerButton.type = "button"; powerButton.className = "server-menu-action"; powerButton.textContent = nitradoActionLabel(action); powerButton.disabled = !!nitradoPowerPending[server.id];
      powerButton.addEventListener("click", function () { menu.open = false; requestNitradoPower(server, action); }); menuBody.appendChild(powerButton);
    });
  }

  var editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "server-menu-action"; editBtn.textContent = I18N.t("common.edit");
  editBtn.addEventListener("click", function () { menu.open = false; openEditServerModal(server); }); menuBody.appendChild(editBtn);

  var layoutLabel = document.createElement("span"); layoutLabel.className = "server-menu-label"; layoutLabel.textContent = I18N.t("workspace.layout"); menuBody.appendChild(layoutLabel);
  var layout = localStorage.getItem("nicon_dashboard_layout") || "balanced";
  [["balanced", I18N.t("workspace.balanced")], ["wide", I18N.t("phase2.wide")], ["stacked", I18N.t("phase2.stack")], ["compact", I18N.t("workspace.compact")]].forEach(function (item) {
    var layoutButton = document.createElement("button"); layoutButton.type = "button"; layoutButton.className = "server-menu-action"; layoutButton.textContent = item[1]; layoutButton.setAttribute("aria-pressed", String(layout === item[0]));
    layoutButton.addEventListener("click", function () { menu.open = false; setDashboardLayout(item[0]); renderContent(); }); menuBody.appendChild(layoutButton);
  });

  var removeBtn = document.createElement("button"); removeBtn.type = "button"; removeBtn.className = "server-menu-action danger"; removeBtn.textContent = I18N.t("common.remove");
  removeBtn.setAttribute("aria-label", I18N.t("servers.removeAriaLabel", { name: server.name })); removeBtn.addEventListener("click", function () { menu.open = false; removeServer(server.id); }); menuBody.appendChild(removeBtn);
  menu.appendChild(menuBody); actions.appendChild(menu);

  head.appendChild(actions);
}

export function updateCmdBarState() {
  var c = state.consoles[state.selectedServerId];
  var ready = !!(c && c.gameConnected && c.socket && c.socket.readyState === WebSocket.OPEN);
  cmdSendBtn.disabled = !ready;
  updateQuickCommandsEnabled(c);
}
