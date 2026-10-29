// Browser side of the relay's passive public query (A2S, Minecraft Query/Ping,
// Bedrock): which query a server uses, and the on-demand player list. The
// relay does the actual querying — a browser can't speak raw UDP.
import { relayWsUrl } from "./api.js";
import { state } from "./state.js";

// Mirrors the relay's EffectivePublicQueryProtocol for what the browser can
// know before saving: an explicit choice wins, then the game's autoQuery from
// the shared catalog (data/games.json), then A2S for Source-RCON servers.
// "disabled" means no passive query can be tried from here (Palworld's REST
// status needs the stored password and is probed by the relay itself).
export function resolveQueryProtocol(queryProtocol, gameLabel, rconProtocol) {
  if (queryProtocol && queryProtocol !== "auto") return queryProtocol;
  var catalog = window.NICON_GAME_CATALOG || [];
  var entry = catalog.find(function (g) { return g.label === gameLabel; });
  if (entry && entry.autoQuery) return entry.autoQuery;
  return rconProtocol === "source" ? "a2s" : "disabled";
}

// Whether the public query can list player names (A2S_PLAYER, Query Full Stat).
export function canListQueryPlayers(protocol) {
  return protocol === "a2s" || protocol === "minecraft";
}

// Asks the relay for the names of the players currently online.
// Resolves to { ok, players: [{name, score?, duration_s?}], message }.
export function fetchQueryPlayers(host, port, protocol) {
  return new Promise(function (resolve) {
    var socket;
    var settled = false;
    var timer = setTimeout(function () { finish({ ok: false, message: "timeout" }); }, 12000);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) socket.close();
      resolve(result);
    }
    try { socket = new WebSocket(relayWsUrl() + "/ws/rcon"); } catch (e) { finish({ ok: false, message: "relay unreachable" }); return; }
    socket.addEventListener("open", function () { socket.send(JSON.stringify({ type: "auth", token: state.authToken })); });
    socket.addEventListener("error", function () { finish({ ok: false, message: "relay unreachable" }); });
    socket.addEventListener("close", function () { finish({ ok: false, message: "relay unreachable" }); });
    socket.addEventListener("message", function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "authenticated") {
        socket.send(JSON.stringify({ type: "query_players", host: host, port: port, query_protocol: protocol }));
      } else if (msg.type === "query_players_result") {
        finish({ ok: !!msg.ok, players: msg.player_list || [], message: msg.message || "" });
      } else if (msg.type === "error") {
        finish({ ok: false, message: msg.message || "" });
      }
    });
  });
}

export function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  if (h >= 48) return Math.floor(h / 24) + " d " + (h % 24) + " h";
  return h ? h + " h " + m + " m" : m + " m";
}
