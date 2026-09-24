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
//     columns: [...],       // display column headers
//     summary: "...",       // e.g. "3 / 20 players online"
//     players: [
//       { cells: [...values matching columns...],
//         id: "...",        // identifier passed to kick()/ban()
//         isAdmin: false,   // true suppresses the kick/ban buttons
//         rank: null },     // shown instead, when isAdmin is true
//       ...
//     ],
//   }
//
// kick(player)/ban(player) return an RCON command string, or null if this
// game/identifier doesn't support that action (e.g. no stable ID was
// available to target).
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
        columns: ["Name"],
        summary: m[1] + " / " + m[2] + " players online",
        players: names.map(function (n) { return { cells: [n], id: n, isAdmin: false, rank: null }; }),
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
        columns: ["Name", "SteamID", "Ping", "Address", "Connected (s)"],
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
            rank: isAdmin ? "Admin" : null,
          };
        }),
      };
    },
    kick: function (player) { return player.id ? "kick " + player.id : null; },
    ban: function (player) { return player.id ? "ban " + player.id + " \"Banned by admin\"" : null; },
  },

  ark: {
    label: "ARK: Survival Evolved",
    command: "ListPlayers",
    parse: function (text) {
      // Documented shape: "<index>. <PlayerName>, <SteamID>" per line.
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var players = [];
      lines.forEach(function (line) {
        var m = line.match(/^\d+\.\s*(.+?),\s*(\d{5,})\s*$/);
        if (m) players.push({ cells: [m[1], m[2]], id: m[2], isAdmin: false, rank: null });
      });
      if (!players.length) return null;
      return {
        columns: ["Name", "SteamID"],
        summary: players.length + " player" + (players.length === 1 ? "" : "s") + " online",
        players: players,
      };
    },
    kick: function (player) { return "KickPlayer " + player.id; },
    ban: function (player) { return "BanPlayer " + player.id; },
  },

  palworld: {
    label: "Palworld",
    command: "ShowPlayers",
    parse: function (text) {
      // Documented shape: CSV with header "name,playeruid,steamid".
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      if (lines.length < 1) return null;
      var header = lines[0].split(",").map(function (h) { return h.trim(); });
      if (header[0].toLowerCase() !== "name") return null;
      var uidIndex = header.findIndex(function (h) { return h.toLowerCase() === "playeruid"; });
      var rows = lines.slice(1)
        .filter(function (l) { return l.length > 0; })
        .map(function (l) { return l.split(","); });
      return {
        columns: header,
        summary: rows.length + " player" + (rows.length === 1 ? "" : "s") + " online",
        players: rows.map(function (cells) {
          return { cells: cells, id: uidIndex !== -1 ? cells[uidIndex] : null, isAdmin: false, rank: null };
        }),
      };
    },
    // Only possible when the response actually included a playeruid column.
    kick: function (player) { return player.id ? "KickPlayer " + player.id : null; },
    ban: function (player) { return player.id ? "BanPlayer " + player.id : null; },
  },
};

// Best-effort mapping from a Nitrado "game" string (e.g. "Minecraft
// Vanilla") to one of the keys above, for auto-selecting the parser.
window.NICON_GUESS_GAME = function (gameLabel) {
  if (!gameLabel) return "";
  var lower = gameLabel.toLowerCase();
  var keys = Object.keys(window.NICON_GAMES);
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i]) !== -1) return keys[i];
  }
  if (lower.indexOf("ark") !== -1) return "ark";
  return "";
};
