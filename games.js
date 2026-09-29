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
//
// quickCommands (optional) backs the console's Quick Commands bar —
// one-click buttons for actions that aren't tied to a specific player (a
// per-player kick/ban already has its own button in the players table
// above, via kick()/ban()). Each entry:
//   {
//     id: "...",              // canonical id; app.js looks up its label
//                              // and (for "high") its confirmation text
//                              // as i18n keys "quickCommands.<id>" /
//                              // "quickCommands.<id>Confirm"
//     risk: "low"|"medium"|"high",
//       // low: sent immediately, no dialog.
//       // medium: needs one text parameter (currently always a
//       //   broadcast message) — app.js opens a small dialog to collect
//       //   it, no separate confirmation on top.
//       // high: no parameter, but disruptive enough (stops/restarts the
//       //   server, disconnecting every player) to require an explicit
//       //   confirm dialog first.
//     param: "message" | undefined,  // set iff risk === "medium"
//     build: function(message) { ... }  // returns the RCON/API command
//       // string to send (message is passed for risk:"medium" entries,
//       // omitted otherwise).
//   }
//
// Deliberately not every game has every action: only commands verified
// against that game/protocol's own documented command set are included.
// A shutdown/restart command in particular varies a lot by game (some
// have none at all as a plain RCON command) — where there's no
// well-documented one, it's left out rather than guessed, since sending
// the wrong command to a live game server console isn't something to
// speculate about. Likewise BattlEye (Arma 3, DayZ) only gets a
// broadcast — its RCon protocol has no standard save/shutdown command
// the way the Source-derived games below do.

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
    whisper: function (player, message) { return "tell " + player.id + " " + message; },
    commands: ["list", "say", "tell", "kick", "ban", "pardon", "save-all", "stop", "whitelist"],
    quickCommands: [
      { id: "save", risk: "low", build: function () { return "save-all"; } },
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "say " + message; } },
      // Vanilla Minecraft has no "restart" console command, only "stop" —
      // whether the server comes back up afterwards depends entirely on
      // the hosting setup (Nitrado and most wrapper scripts do restart
      // it; a bare `java -jar server.jar` does not), hence "stop" (not
      // "restart") plus a confirmation that says so.
      { id: "stop", risk: "high", build: function () { return "stop"; } },
    ],
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
    mute: function (player) { return player.id ? "mute " + player.id : null; },
    commands: ["playerlist", "status", "say", "kick", "ban", "mute", "unmute", "server.save", "restart"],
    quickCommands: [
      { id: "save", risk: "low", build: function () { return "server.save"; } },
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "say " + message; } },
      // Rust's actual console command: restarts after a countdown (in
      // seconds) that's broadcast to connected players first, rather than
      // dropping them with no warning.
      { id: "restart", risk: "high", build: function () { return "restart 60"; } },
    ],
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
    commands: ["ListPlayers", "KickPlayer", "BanPlayer", "UnBanPlayer", "SaveWorld", "Broadcast", "DoExit"],
    quickCommands: [
      { id: "save", risk: "low", build: function () { return "SaveWorld"; } },
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "Broadcast " + message; } },
      // ARK's own admin command for an immediate server exit — whether
      // that comes back up as a restart depends on the hosting setup
      // (Nitrado and most process supervisors do relaunch it), same
      // caveat as Minecraft's "stop" above.
      { id: "shutdown", risk: "high", build: function () { return "DoExit"; } },
    ],
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
    commands: ["players", "kick", "ban", "save", "announce", "shutdown"],
    // Matches internal/relay/palworld_rest.go's Execute() verbs exactly —
    // "announce" and "shutdown" are real REST endpoints there, not raw
    // RCON text. shutdown with no argument uses the relay's own default
    // (30-second wait, no message) rather than this guessing one.
    quickCommands: [
      { id: "save", risk: "low", build: function () { return "save"; } },
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "announce " + message; } },
      { id: "shutdown", risk: "high", build: function () { return "shutdown"; } },
    ],
  },

  arma3: {
    label: "Arma 3",
    command: "players",
    parse: parseBattleyePlayers,
    kick: battleyeKick,
    ban: battleyeBan,
    whisper: function (player, message) { return "say " + player.id + " " + message; },
    commands: ["players", "kick", "ban", "say", "loadEvents", "writeBans"],
    // "say -1 <message>" is BattlEye's own broadcast-to-everyone syntax
    // (-1 targets "no single player id", i.e. all of them). No standard
    // save/shutdown command exists at the BE RCon protocol level (that's
    // mission/server-config territory, not something this can assume).
    quickCommands: [
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "say -1 " + message; } },
    ],
  },

  dayz: {
    label: "DayZ",
    command: "players",
    parse: parseBattleyePlayers,
    kick: battleyeKick,
    ban: battleyeBan,
    whisper: function (player, message) { return "say " + player.id + " " + message; },
    commands: ["players", "kick", "ban", "say", "loadEvents", "writeBans"],
    quickCommands: [
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "say -1 " + message; } },
    ],
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
    commands: ["status", "say", "kickid", "banid", "removeid", "writeid", "quit"],
    // No universal "save" concept in the base Source engine (unlike the
    // survival-game titles above) — only broadcast and a plain "quit" are
    // included, both real, documented Source console commands. Whether
    // "quit" comes back up as a restart depends on the hosting setup,
    // same caveat as ARK's DoExit and Minecraft's stop above.
    quickCommands: [
      { id: "broadcast", risk: "medium", param: "message", build: function (message) { return "say " + message; } },
      { id: "shutdown", risk: "high", build: function () { return "quit"; } },
    ],
  },
};

// NiCon's supported-game list is deliberately explicit. Some protocols expose only a basic
// command response, so parsers are conservative and return null instead of
// inventing player rows when output differs between game versions.
function parseLoosePlayerLines(text) {
  var lines = text.split("\n").map(function (line) { return line.trim(); }).filter(Boolean);
  var players = [];
  lines.forEach(function (line) {
    var m = line.match(/^(?:\d+[.)#]?\s+)?["']?([^,"']{1,64})["']?(?:\s*,|\s{2,}|$)/);
    if (m && !/^(players?|name|id|steam|connected|server)/i.test(m[1])) {
      players.push({ cells: [m[1]], id: m[1], isAdmin: false });
    }
  });
  return players.length ? { columns: ["name"], summary: players.length + " players online", players: players } : null;
}

// 7 Days to Die's `lp` response ends with a summary such as
// "Total of 0 in the game". It is not a player row. Actual rows start
// with an ordinal and expose the entity id followed by the display name:
//   0. id=171, PlayerName, pos=(...), ...
// A dedicated parser also lets a valid empty result stay a successful
// zero-player response instead of looking like an unknown output format.
function parseSevenDaysPlayers(text) {
  var totalMatch = text.match(/(?:^|\n)\s*Total of\s+(\d+)\s+in the game\.?\s*(?:\n|$)/i);
  var players = [];
  text.split("\n").forEach(function (rawLine) {
    var line = rawLine.trim();
    var match = line.match(/^\d+[.)]\s*id=(\d+)\s*,\s*([^,]+?)\s*,/i);
    if (!match) return;
    var name = match[2].replace(/^name=/i, "").trim();
    if (!name) return;
    players.push({ cells: [name], id: name, isAdmin: false });
  });
  if (!totalMatch && !players.length) return null;
  var total = totalMatch ? Number(totalMatch[1]) : players.length;
  return {
    columns: ["name"],
    summary: total + " player" + (total === 1 ? "" : "s") + " online",
    players: players,
  };
}

Object.assign(window.NICON_GAMES, {
  sevendaystodie: { label: "7 Days to Die", protocol: "telnet", command: "lp", parse: parseSevenDaysPlayers,
    kick: function (p) { return "kick " + p.id; }, ban: function (p) { return "ban add " + p.id + " 100 years Banned by admin"; },
    commands: ["lp", "say", "kick", "ban", "saveworld", "shutdown", "getgamepref"] },
  eightythree: { label: "83", protocol: "source", command: "status", parse: parseLoosePlayerLines, commands: ["status"] },
  arksurvivalascended: Object.assign({}, window.NICON_GAMES.ark, { label: "ARK: Survival Ascended" }),
  arksurvivalevolved: Object.assign({}, window.NICON_GAMES.ark, { label: "ARK: Survival Evolved" }),
  arma2: Object.assign({}, window.NICON_GAMES.arma3, { label: "Arma 2" }),
  armareforger: Object.assign({}, window.NICON_GAMES.arma3, { label: "Arma Reforger" }),
  atlas: { label: "ATLAS", protocol: "source", command: "ListPlayers", parse: parseLoosePlayerLines, commands: ["ListPlayers", "Broadcast", "SaveWorld", "DoExit"] },
  battlebit: { label: "BattleBit Remastered", protocol: "battlebit", command: "playerlist", parse: function (text) {
    try {
      var data = JSON.parse(text); var list = Array.isArray(data.players) ? data.players : [];
      return { columns: ["name", "steamid", "ping"], summary: list.length + " players online", players: list.map(function (p) {
        return { cells: [p.name || p.Name, p.steamID || p.SteamID, p.ping || p.Ping], id: p.steamID || p.SteamID, isAdmin: false };
      }) };
    } catch (_) { return null; }
  }, kick: function (p) { return "kick " + p.id; }, commands: ["playerlist", "state", "say", "kick"] },
  beyondthewire: { label: "Beyond the Wire", protocol: "source", command: "ListPlayers", parse: parseLoosePlayerLines, commands: ["ListPlayers", "AdminKick", "AdminBan", "AdminBroadcast"] },
  conanexiles: { label: "Conan Exiles", protocol: "source", command: "listplayers", parse: parseLoosePlayerLines, commands: ["listplayers", "broadcast", "kick", "ban"] },
  counterstrike2: { label: "Counter-Strike 2", protocol: "source", command: "status", parse: parseLoosePlayerLines, commands: ["status", "say", "kickid", "banid", "changelevel"] },
  darkandlight: { label: "Dark and Light", protocol: "source", command: "ListPlayers", parse: parseLoosePlayerLines, commands: ["ListPlayers", "Broadcast", "SaveWorld", "DoExit"] },
  hellletloose: { label: "Hell Let Loose", protocol: "source", command: "get playerids", parse: parseLoosePlayerLines, commands: ["get playerids", "kick", "punish", "broadcast"] },
  hellletloosevietnam: { label: "Hell Let Loose: Vietnam", protocol: "source", command: "get playerids", parse: parseLoosePlayerLines, commands: ["get playerids", "kick", "punish", "broadcast"] },
  insurgency: { label: "Insurgency", protocol: "source", command: "status", parse: parseLoosePlayerLines, commands: ["status", "say", "kickid", "banid"] },
  mordhau: { label: "MORDHAU", protocol: "source", command: "playerlist", parse: parseLoosePlayerLines, commands: ["playerlist", "say", "kick", "ban"] },
  projectzomboid: { label: "Project Zomboid", protocol: "source", command: "players", parse: parseLoosePlayerLines, commands: ["players", "servermsg", "kickuser", "banuser", "save", "quit"] },
  risingstorm2: { label: "Rising Storm 2: Vietnam", protocol: "source", command: "get playerlist", parse: parseLoosePlayerLines, commands: ["get playerlist", "broadcast", "kick", "ban"] },
  squad: { label: "Squad", protocol: "source", command: "ListPlayers", parse: parseLoosePlayerLines, commands: ["ListPlayers", "AdminKick", "AdminBan", "AdminBroadcast"] },
  squad44: { label: "Squad 44", protocol: "source", command: "ListPlayers", parse: parseLoosePlayerLines, commands: ["ListPlayers", "AdminKick", "AdminBan", "AdminBroadcast"] },
  soulmask: { label: "Soulmask", protocol: "source", command: "listplayers", parse: parseLoosePlayerLines, commands: ["listplayers", "say", "kick", "ban"] },
  vrising: { label: "V Rising", protocol: "source", command: "status", parse: parseLoosePlayerLines, commands: ["status", "announce", "announcerestart"] },
  wardogs: { label: "WARDOGS", protocol: "source", command: "status", parse: parseLoosePlayerLines, commands: ["status"] },
});

// Keep shared parser templates in this file, but do not expose games absent
// from NiCon's supported-game list as selectable integrations. "ark" is
// only a shared template for arksurvivalascended/arksurvivalevolved below,
// never a standalone selectable entry itself.
["ark"].forEach(function (key) {
  delete window.NICON_GAMES[key];
});

// Steam artwork used by the supported-games overview and the selected-server
// backdrop. Most titles use Steam's stable app-scoped paths; newer titles use
// the hash-qualified URLs returned by Steam's own app-details API.
var steamAssets = {
  sevendaystodie: { appId: 251570 },
  eightythree: { appId: 1059220, header: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1059220/b7ccd7a2b80ef91a8aa93d8cef2755b01aebe8a6/header.jpg" },
  arksurvivalascended: { appId: 2399830 },
  arksurvivalevolved: { appId: 346110 },
  arma2: { appId: 33900 },
  arma3: { appId: 107410 },
  armareforger: { appId: 1874880 },
  atlas: { appId: 834910 },
  battlebit: { appId: 671860 },
  beyondthewire: { appId: 1058650 },
  conanexiles: { appId: 440900 },
  counterstrike2: { appId: 730 },
  darkandlight: { appId: 529180 },
  dayz: { appId: 221100 },
  gmod: { appId: 4000 },
  hellletloose: { appId: 686810 },
  hellletloosevietnam: {
    appId: 3079210,
    header: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3079210/2e52f99e70e827b57a2205469dc5d529e8e0490a/header.jpg",
    background: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3079210/11f2f56dd8945194aed2ee44376b54b1bee6c122/page_bg_raw.jpg",
  },
  insurgency: { appId: 222880 },
  mordhau: { appId: 629760 },
  palworld: { appId: 1623730 },
  projectzomboid: { appId: 108600 },
  risingstorm2: { appId: 418460 },
  rust: { appId: 252490 },
  squad: { appId: 393380 },
  squad44: { appId: 736220 },
  soulmask: { appId: 2646460 },
  vrising: { appId: 1604030 },
  wardogs: {
    appId: 1867240,
    header: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1867240/59d4daf753bd5d982e6675f7eee363bc817c574e/header.jpg",
    background: "https://store.fastly.steamstatic.com/images/storepagebackground/app/1867240",
  },
};
Object.keys(steamAssets).forEach(function (key) {
  var game = window.NICON_GAMES[key];
  var asset = steamAssets[key];
  if (!game || !asset) return;
  game.steamAppId = asset.appId;
  game.headerImage = asset.header || "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/" + asset.appId + "/header.jpg";
  game.backgroundImage = asset.background || "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/" + asset.appId + "/page_bg_generated_v6b.jpg";
});

// Best-effort mapping from a Nitrado "game" string (e.g. "Minecraft
// Vanilla") to one of the keys above, for auto-selecting the parser. Most
// keys already are the substring to look for; a few games' key names
// don't literally appear in Nitrado's label (a space, an abbreviation, an
// apostrophe), so those get an explicit alias list instead.
window.NICON_GUESS_GAME_ALIASES = {
  sevendaystodie: ["7 days to die", "7dtd", "seven days to die"],
  eightythree: ["83"],
  arksurvivalascended: ["ark: survival ascended", "ark survival ascended", "arksa"],
  arksurvivalevolved: ["ark: survival evolved", "ark survival evolved", "arkse"],
  arma2: ["arma 2", "arma2"],
  arma3: ["arma 3", "arma3"],
  armareforger: ["arma reforger", "reforger"],
  atlas: ["atlas"],
  battlebit: ["battlebit remastered", "battlebit"],
  beyondthewire: ["beyond the wire"],
  conanexiles: ["conan exiles"],
  counterstrike2: ["counter-strike 2", "counter strike 2", "cs2"],
  darkandlight: ["dark and light"],
  dayz: ["dayz", "day z"],
  gmod: ["garry's mod", "garrys mod", "gmod"],
  hellletloosevietnam: ["hell let loose: vietnam", "hell let loose vietnam"],
  hellletloose: ["hell let loose"],
  insurgency: ["insurgency"],
  mordhau: ["mordhau"],
  palworld: ["palworld"],
  projectzomboid: ["project zomboid"],
  risingstorm2: ["rising storm 2", "rising storm ii"],
  rust: ["rust"],
  squad44: ["squad 44", "post scriptum"],
  squad: ["squad"],
  soulmask: ["soulmask"],
  vrising: ["v rising", "vrising"],
  wardogs: ["wardogs", "war dogs"],
};
window.NICON_GUESS_GAME = function (gameLabel) {
  if (!gameLabel) return "";
  var lower = gameLabel.toLowerCase();
  var keys = Object.keys(window.NICON_GAMES);
  var bestKey = "";
  var bestLength = -1;
  for (var i = 0; i < keys.length; i++) {
    var aliases = window.NICON_GUESS_GAME_ALIASES[keys[i]] || [keys[i]];
    for (var j = 0; j < aliases.length; j++) {
      if (lower.indexOf(aliases[j]) !== -1 && aliases[j].length > bestLength) {
        bestKey = keys[i];
        bestLength = aliases[j].length;
      }
    }
  }
  return bestKey;
};
