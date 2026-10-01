// The players card next to the console: refresh, actions and Steam profiles.
import { apiFetch } from "./api.js";
import { appendConsoleLine, refreshIfActive } from "./console.js";
import { playerContextMenu, playerMessageClose, playerMessageForm, playerMessageInput, playerMessageModal, playersPanel, serverPlayersList } from "./dom.js";
import { I18N, state } from "./state.js";
import { showConfirm } from "./ui.js";

// --- players card (inline, next to the console) ---
// Auto-detected from the server's game, auto-fetched on connect/select,
// and kept fresh with a background poll while that server is the one
// being viewed — no manual game picker or refresh button.

var PLAYERS_REFRESH_MS = 10000;
state.activePlayersTimer = null;

export function stopPlayersAutoRefresh() {
  if (state.activePlayersTimer) {
    clearInterval(state.activePlayersTimer);
    state.activePlayersTimer = null;
  }
}

export function startPlayersAutoRefresh(c) {
  stopPlayersAutoRefresh();
  if (!c) return;
  requestPlayers(c);
  state.activePlayersTimer = setInterval(function () { requestPlayers(c); }, PLAYERS_REFRESH_MS);
}

// sendConsoleCommand is the one path every command actually goes out
// through: manual command-bar input, the players-card's per-player
// kick/ban buttons, the auto-refresh player-list poll, and the Quick
// Commands bar all call this instead of touching c.socket directly, so
// there's exactly one place that logs the outgoing line, refreshes the
// console if it's the one on screen, and does the actual send. Returns
// false (and sends nothing) if there's no live game connection right
// now, so every caller shares the same "not connected" guard.
export function sendConsoleCommand(c, command, audit) {
  if (!c || !command || !c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return false;
  appendConsoleLine(c, "sent", "> " + command);
  refreshIfActive(c);
  var message = { type: "command", command: command };
  if (audit) {
    message.audit_origin = audit.origin || "manual";
    message.audit_action = audit.action || "command";
    if (audit.targetPlayer) message.target_player = String(audit.targetPlayer);
  }
  c.socket.send(JSON.stringify(message));
  return true;
}

function requestPlayers(c) {
  if (!c.gameKey) {
    if (state.selectedServerId === c.server.id) {
      renderPlayersPanel(c);
      renderPlayersInto(serverPlayersList, c);
    }
    return;
  }
  if (!c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
  var game = window.NICON_GAMES[c.gameKey];
  c.pendingPlayersRequest = true;
  c.playersRequestSentAt = Date.now();
  sendConsoleCommand(c, game.command, { origin: "system", action: "player_poll" });
}

// Column identifiers from games.js are canonical lowercase keys (e.g.
// "steamid", "connectedSeconds"), not display text, so every game's
// table header goes through i18n — including Palworld's, whose columns
// come from the server's own CSV response and fall back to the raw
// header text when it's not one of the well-known ones.
function columnLabel(key) {
  var label = I18N.t("players.col." + key);
  return label === "players.col." + key ? key : label;
}

function playersHint(container, text) {
  container.innerHTML = "";
  var notice = document.createElement("p");
  notice.className = "hint";
  notice.textContent = text;
  container.appendChild(notice);
}

export function renderPlayersPanel(c) {
  renderPlayersInto(playersPanel, c);
}

export function renderPlayersInto(container, c) {
  container.innerHTML = "";
  if (!c) return;
  if (!c.gameKey) {
    playersHint(container, I18N.t("info.genericOption"));
    return;
  }
  if (!c.lastParsed) return; // waiting on the first response

  var game = window.NICON_GAMES[c.gameKey];
  if (!c.lastParsed.ok) {
    playersHint(container, I18N.t("info.couldNotParse", { game: game.label }));
    return;
  }

  var summary = document.createElement("p");
  summary.className = "hint";
  summary.textContent = c.lastParsed.summary;
  container.appendChild(summary);

  var players = c.lastParsed.players;
  if (!players.length) return;

  // columns[0] is always the display name (every games.js entry puts it
  // first) — that plus kick/ban is what actually matters at a glance,
  // so only those sit in the main row; every other column (SteamID,
  // ping, address, …) is real but rarely needed, so it's tucked behind
  // a <details> instead of squeezing a wide table into the sidebar.
  var columns = c.lastParsed.columns;
  var list = document.createElement("div");
  list.className = "players-list";

  players.forEach(function (player) {
    var row = document.createElement("div");
    row.className = "player-row";
    row.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      openPlayerContextMenu(event.clientX, event.clientY, c, game, player);
    });

    var main = document.createElement("div");
    main.className = "player-row-main";

    var name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.cells[0] || player.id;
    main.appendChild(name);

    if (player.isAdmin) {
      var rank = document.createElement("span");
      rank.className = "tag tag-rank";
      rank.textContent = I18N.t("admin.roleAdmin");
      main.appendChild(rank);
    } else {
      var kickCmd = game.kick ? game.kick(player) : null;
      var banCmd = game.ban ? game.ban(player) : null;
      if (kickCmd || banCmd) {
        var actions = document.createElement("div");
        actions.className = "player-actions-row";
        var label = player.cells[0] || player.id;
        if (kickCmd) actions.appendChild(playerActionButton(I18N.t("players.kick"), false, function () {
          sendPlayerAction(c, kickCmd, I18N.t("players.kickConfirm", { name: label }), "kick", label);
        }));
        if (banCmd) actions.appendChild(playerActionButton(I18N.t("players.ban"), true, function () {
          sendPlayerAction(c, banCmd, I18N.t("players.banConfirm", { name: label }), "ban", label);
        }));
        main.appendChild(actions);
      }
    }
    row.appendChild(main);

    if (columns.length > 1) {
      var details = document.createElement("details");
      details.className = "player-details";
      var summaryEl = document.createElement("summary");
      summaryEl.textContent = I18N.t("players.details");
      details.appendChild(summaryEl);

      var dl = document.createElement("dl");
      for (var i = 1; i < columns.length; i++) {
        var dt = document.createElement("dt");
        dt.textContent = columnLabel(columns[i]);
        var dd = document.createElement("dd");
        dd.textContent = player.cells[i];
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      details.appendChild(dl);
      var steamIndex = columns.indexOf("steamid");
      if (steamIndex !== -1) appendSteamProfile(details, c.steamProfiles[String(player.cells[steamIndex] || "")]);
      row.appendChild(details);
    }

    list.appendChild(row);
  });
  container.appendChild(list);
}

export function requestSteamProfiles(c, columns, players) {
  var index = columns.indexOf("steamid");
  if (index === -1) return;
  var ids = players.map(function (player) { return String(player.cells[index] || ""); })
    .filter(function (id) { return /^7656119\d{10}$/.test(id) && !c.steamRequested[id]; });
  if (!ids.length) return;
  ids.forEach(function (id) { c.steamRequested[id] = true; });
  apiFetch("/api/steam/players", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steamids: ids.slice(0, 100) }),
  }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("Steam unavailable")); })
    .then(function (data) {
      (data.players || []).forEach(function (profile) { c.steamProfiles[profile.steamid] = profile; });
      if (state.selectedServerId === c.server.id) {
        renderPlayersPanel(c);
        renderPlayersInto(serverPlayersList, c);
      }
    }).catch(function () { /* optional integration */ });
}

function appendSteamProfile(container, profile) {
  if (!profile) return;
  var line = document.createElement("div"); line.className = "steam-profile";
  if (profile.profile_url) {
    var link = document.createElement("a"); link.href = profile.profile_url; link.target = "_blank"; link.rel = "noopener";
    link.textContent = profile.name || "Steam profile"; line.appendChild(link);
  }
  if (profile.vac_banned || profile.community_banned || profile.game_bans > 0) {
    var risk = document.createElement("span"); risk.className = "steam-risk";
    risk.textContent = "VAC " + (profile.vac_bans || 0) + " · Game bans " + (profile.game_bans || 0); line.appendChild(risk);
  }
  if (profile.created_at && Date.now() / 1000 - profile.created_at < 30 * 86400) {
    var fresh = document.createElement("span"); fresh.className = "steam-fresh"; fresh.textContent = "New account"; line.appendChild(fresh);
  }
  container.appendChild(line);
}

state.contextPlayerAction = null;
function openPlayerContextMenu(x, y, c, game, player) {
  state.contextPlayerAction = { c: c, game: game, player: player };
  ["kick", "ban", "mute", "whisper"].forEach(function (action) {
    var button = playerContextMenu.querySelector('[data-player-action="' + action + '"]');
    button.disabled = !game[action] || player.isAdmin;
  });
  playerContextMenu.hidden = false;
  playerContextMenu.style.left = Math.min(x, window.innerWidth - 170) + "px";
  playerContextMenu.style.top = Math.min(y, window.innerHeight - 170) + "px";
}

document.addEventListener("click", function (event) {
  if (!playerContextMenu.contains(event.target)) playerContextMenu.hidden = true;
});
playerContextMenu.addEventListener("click", function (event) {
  var action = event.target.dataset.playerAction;
  var target = state.contextPlayerAction;
  playerContextMenu.hidden = true;
  if (!action || !target || !target.game[action]) return;
  if (action === "whisper") {
    playerMessageInput.value = ""; playerMessageModal.showModal(); playerMessageInput.focus(); return;
  }
  var command = target.game[action](target.player);
  if (command) {
    var targetLabel = target.player.cells[0] || target.player.id;
    sendPlayerAction(target.c, command, action + " " + targetLabel + "?", action, targetLabel);
  }
});
playerMessageClose.addEventListener("click", function () { playerMessageModal.close(); });
playerMessageForm.addEventListener("submit", function (event) {
  event.preventDefault();
  var target = state.contextPlayerAction;
  if (target && target.game.whisper) sendConsoleCommand(
    target.c,
    target.game.whisper(target.player, playerMessageInput.value.trim()),
    { origin: "player_action", action: "whisper", targetPlayer: target.player.cells[0] || target.player.id }
  );
  playerMessageModal.close();
});

function playerActionButton(text, danger, onClick) {
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-xs" + (danger ? " btn-xs-danger" : "");
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

function sendPlayerAction(c, command, confirmMessage, action, targetPlayer) {
  showConfirm(confirmMessage).then(function (ok) {
    if (!ok) return;
    if (!sendConsoleCommand(c, command, { origin: "player_action", action: action, targetPlayer: targetPlayer })) return;
    setTimeout(function () { requestPlayers(c); }, 1200);
  });
}
