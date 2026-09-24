// Per-game player-list support: the RCON command to run, a parser for its
// response, and (where the game's protocol allows it) how to build a kick
// and a ban command for one parsed player. Best-effort, based on publicly
// documented RCON command formats — not verified against a live server for
// each game, since RCON text output isn't formally specified anywhere and
// can vary by version. A parser returning null (couldn't make sense of the
// response) is expected and handled gracefully by the caller; it is never
// treated as an error.
//
// parse(text) returns either null, or:
//   {
//     columns: [...],       // canonical lowercase column keys (e.g.
//                            // "steamid", "connectedSeconds") — display
//                            // labels are looked up via i18n in app.js,
//                            // not decided here
//     summary: "...",       // e.g. "3 / 20 players online"
//     players: [
//       { cells: [...values matching columns...],
//         id: "...",        // identifier passed to kick()/ban()
//         isAdmin: false },  // true suppresses the kick/ban buttons,
//                            // shows a rank badge instead
//       ...
//     ],
//   }
//
// kick(player)/ban(player) return an RCON command string, or null if this
// game/identifier doesn't support that action (e.g. no stable ID was
// available to target).

// Arma 3 and DayZ are both BattlEye-protected (relay protocol "battleye",
// see internal/relay/battleye.go) rather than Source RCON, but share the
// same `players` command and response shape documented at
// https://www.battleye.com/downloads/BERConProtocol.txt's tooling docs:
//   Players on server:
//   [#] [IP Address]:[Port] [Ping] [GUID] [Name]
//   --------------------------------------------------
//   0   127.0.0.1:2304        43    bec7c...(OK) PlayerName
//   (1 players in total)
// kick/ban both address the player by that leading "#" (their current
// session slot, not a stable id — it's what BE itself requires).
function parseBattleyePlayers(text) {
  var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  var players = [];
  lines.forEach(function (line) {
    var m = line.match(/^(\d+)\s+([\d.]+):(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return;
    var guid = m[5].replace(/\(.*\)$/, "");
    players.push({ cells: [m[6], guid, m[4], m[2] + ":" + m[3]], id: m[1], isAdmin: false });
  });
  if (!players.length) return null;
  return {
    columns: ["name", "guid", "ping", "address"],
    summary: players.length + " player" + (players.length === 1 ? "" : "s") + " online",
    players: players,
  };
}
function battleyeKick(player) { return "kick " + player.id; }
// "ban <#> [minutes] [reason]" — 0 (or omitted) minutes is permanent.
function battleyeBan(player) { return "ban " + player.id + " 0 Banned by admin"; }

window.NICON_GAMES = {
  minecraft: {
    label: "Minecraft",
    command: "list",
    parse: function (text) {
      // Known phrasings across versions:
      //   "There are 2 of a max of 20 players online: Steve, Alex"
      //   "There are 2 of 20 players online: Steve, Alex"
      //   "There are 2/20 players online: Steve, Alex"
      var m = text.match(/There are (\d+)(?:\/|\s+of\s+(?:a max of\s+)?)(\d+)\s+players?\s+online:?\s*(.*)/i);
      if (!m) return null;
      var names = m[3]
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      return {
        columns: ["name"],
        summary: m[1] + " / " + m[2] + " players online",
        players: names.map(function (n) { return { cells: [n], id: n, isAdmin: false }; }),
      };
    },
    // The `list` command doesn't expose op status, so there's nothing to
    // suppress on — kick/ban are always offered for Minecraft.
    kick: function (player) { return "kick " + player.id; },
    ban: function (player) { return "ban " + player.id; },
  },

  rust: {
    label: "Rust",
    command: "playerlist",
    parse: function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return null;
      }
      if (!Array.isArray(data)) return null;
      return {
        columns: ["name", "steamid", "ping", "address", "connectedSeconds"],
        summary: data.length + " player" + (data.length === 1 ? "" : "s") + " online",
        players: data.map(function (p) {
          // Some server/plugin combinations (e.g. Oxide/uMod) add an admin
          // flag to the playerlist entry under one of a few names — honor
          // whichever is present, since the base game protocol doesn't
          // document one.
          var isAdmin = !!(p.IsAdmin || p.isAdmin || p.Admin || p.IsModerator || p.isModerator);
          return {
            cells: [p.DisplayName, p.SteamID, p.Ping, p.Address, p.ConnectedSeconds],
            id: p.SteamID,
            isAdmin: isAdmin,
          };
        }),
      };
    },
    kick: function (player) { return player.id ? "kick " + player.id : null; },
    ban: function (player) { return player.id ? "ban " + player.id + " \"Banned by admin\"" : null; },
  },

  ark: {
    // Survival Ascended reuses the same Source RCON commands as Evolved
    // (same studio, same server tooling) — no separate entry needed.
    label: "ARK: Survival Evolved / Ascended",
    command: "ListPlayers",
    parse: function (text) {
      // Documented shape: "<index>. <PlayerName>, <SteamID>" per line.
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var players = [];
      lines.forEach(function (line) {
        var m = line.match(/^\d+\.\s*(.+?),\s*(\d{5,})\s*$/);
        if (m) players.push({ cells: [m[1], m[2]], id: m[2], isAdmin: false });
      });
      if (!players.length) return null;
      return {
        columns: ["name", "steamid"],
        summary: players.length + " player" + (players.length === 1 ? "" : "s") + " online",
        players: players,
      };
    },
    kick: function (player) { return "KickPlayer " + player.id; },
    ban: function (player) { return "BanPlayer " + player.id; },
  },

  // Palworld's RCON support is deprecated by Pocketpair in favor of a
  // first-party REST API (see the relay's internal/relay/palworld_rest.go
  // — a "protocol": "palworld_rest" server talks HTTP+JSON there instead
  // of opening a socket). "players" isn't a real RCON command; it's the
  // verb the relay maps to GET /v1/api/players, whose JSON is what's
  // parsed below.
  palworld: {
    label: "Palworld",
    command: "players",
    parse: function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return null;
      }
      var list = data && Array.isArray(data.players) ? data.players : null;
      if (!list) return null;
      return {
        columns: ["name", "userid", "ping", "level"],
        summary: list.length + " player" + (list.length === 1 ? "" : "s") + " online",
        players: list.map(function (p) {
          return { cells: [p.name, p.userId, p.ping, p.level], id: p.userId, isAdmin: false };
        }),
      };
    },
    kick: function (player) { return player.id ? "kick " + player.id : null; },
    ban: function (player) { return player.id ? "ban " + player.id + " Banned by admin" : null; },
  },

  arma3: {
    label: "Arma 3",
    command: "players",
    parse: parseBattleyePlayers,
    kick: battleyeKick,
    ban: battleyeBan,
  },

  dayz: {
    label: "DayZ",
    command: "players",
    parse: parseBattleyePlayers,
    kick: battleyeKick,
    ban: battleyeBan,
  },

  // Garry's Mod is plain Source RCON (protocol "source") — the generic
  // `status` command every Source-engine game answers, not a GMod-specific
  // one. Typical shape:
  //   # userid name uniqueid connected ping loss state
  //   #    2 "PlayerName" STEAM_0:1:12345678 05:23 45 0 active
  gmod: {
    label: "Garry's Mod",
    command: "status",
    parse: function (text) {
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var players = [];
      lines.forEach(function (line) {
        var m = line.match(/^#\s*(\d+)\s+"(.*)"\s+(\S+)\s+([\d:]+)\s+(\d+)\s+\d+\s+\S+/);
        if (m) players.push({ cells: [m[2], m[3], m[5], m[1]], id: m[1], isAdmin: false });
      });
      if (!players.length) return null;
      return {
        columns: ["name", "steamid", "ping", "userid"],
        summary: players.length + " player" + (players.length === 1 ? "" : "s") + " online",
        players: players,
      };
    },
    // kickid/banid (by userid, from `status`) rather than kick/ban by
    // name — a name can be ambiguous (duplicates, quoting), userid can't.
    kick: function (player) { return "kickid " + player.id; },
    // "banid <minutes> <userid> [kick]" — 0 minutes is permanent; kick
    // removes them immediately instead of waiting for their next connect.
    ban: function (player) { return "banid 0 " + player.id + " kick"; },
  },
};

// Best-effort mapping from a Nitrado "game" string (e.g. "Minecraft
// Vanilla") to one of the keys above, for auto-selecting the parser. Most
// keys already are the substring to look for; a few games' key names
// don't literally appear in Nitrado's label (a space, an abbreviation, an
// apostrophe), so those get an explicit alias list instead.
window.NICON_GUESS_GAME_ALIASES = {
  arma3: ["arma 3", "arma3"],
  dayz: ["dayz", "day z"],
  gmod: ["garry's mod", "garrys mod", "gmod"],
};
window.NICON_GUESS_GAME = function (gameLabel) {
  if (!gameLabel) return "";
  var lower = gameLabel.toLowerCase();
  var keys = Object.keys(window.NICON_GAMES);
  for (var i = 0; i < keys.length; i++) {
    var aliases = window.NICON_GUESS_GAME_ALIASES[keys[i]] || [keys[i]];
    for (var j = 0; j < aliases.length; j++) {
      if (lower.indexOf(aliases[j]) !== -1) return keys[i];
    }
  }
  return "";
};
