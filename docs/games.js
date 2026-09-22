// Per-game "player list" command + parser. Best-effort, based on publicly
// documented RCON command formats — not verified against a live server for
// each game, since RCON text output isn't formally specified anywhere and
// can vary by version. A parser returning null (couldn't make sense of the
// response) is expected and handled gracefully by the caller; it is never
// treated as an error.
//
// Each parser gets the raw RCON response string and returns either:
//   { columns: [...], rows: [[...], ...], summary: "..." }
// or null if the response didn't match the expected shape.
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
        rows: names.map(function (n) { return [n]; }),
        summary: m[1] + " / " + m[2] + " players online",
      };
    },
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
        rows: data.map(function (p) {
          return [p.DisplayName, p.SteamID, p.Ping, p.Address, p.ConnectedSeconds];
        }),
        summary: data.length + " player" + (data.length === 1 ? "" : "s") + " online",
      };
    },
  },

  ark: {
    label: "ARK: Survival Evolved",
    command: "ListPlayers",
    parse: function (text) {
      // Documented shape: "<index>. <PlayerName>, <SteamID>" per line.
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var rows = [];
      lines.forEach(function (line) {
        var m = line.match(/^\d+\.\s*(.+?),\s*(\d{5,})\s*$/);
        if (m) rows.push([m[1], m[2]]);
      });
      if (!rows.length) return null;
      return {
        columns: ["Name", "SteamID"],
        rows: rows,
        summary: rows.length + " player" + (rows.length === 1 ? "" : "s") + " online",
      };
    },
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
      var rows = lines.slice(1)
        .filter(function (l) { return l.length > 0; })
        .map(function (l) { return l.split(","); });
      return {
        columns: header,
        rows: rows,
        summary: rows.length + " player" + (rows.length === 1 ? "" : "s") + " online",
      };
    },
  },
};

// Best-effort mapping from a Nitrado "game" string (e.g. "Minecraft
// Vanilla") to one of the keys above, for pre-selecting the dropdown.
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
