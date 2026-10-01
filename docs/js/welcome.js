// The supported-games overview on the welcome screen.
import { supportedGamesCount, supportedGamesList } from "./dom.js";
import { I18N } from "./state.js";

// --- welcome screen: supported games list ---
// Driven by NICON_GAMES itself (docs/games.js) rather than a hand-kept
// duplicate list here, so it can't drift when a game is added/removed.

// The "tested" flag (data/games.json) deliberately means a real game-server
// verification, not merely a passing parser fixture or protocol mock. The
// detailed and more granular evidence lives in docs/compatibility.md.

export function renderSupportedGamesList() {
  supportedGamesList.innerHTML = "";
  supportedGamesCount.textContent = I18N.t("welcome.gamesCount", { count: Object.keys(window.NICON_GAMES).length });
  Object.keys(window.NICON_GAMES).forEach(function (key) {
    var game = window.NICON_GAMES[key];
    var tested = game.tested;
    var li = document.createElement("li");
    var integrationType = game.integrationType || "native";
    var integrationLabel = I18N.t("welcome.integration." + integrationType);
    li.setAttribute("aria-label", game.label);
    li.title = game.label + " — " + integrationLabel;

    var image = document.createElement("img");
    image.className = "supported-game-header";
    image.alt = game.label;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    var fallback = document.createElement("span");
    fallback.className = "supported-game-fallback";
    fallback.textContent = game.label;
    // A game with no header art (e.g. Minecraft — not on Steam, so no
    // steamAssets entry) skips the image outright rather than relying on
    // an empty src to reliably fire "error" in every browser.
    if (game.headerImage) {
      image.src = game.headerImage;
      fallback.hidden = true;
    } else {
      image.hidden = true;
    }
    image.addEventListener("error", function () {
      image.hidden = true;
      fallback.hidden = false;
    });
    // The art sits alone in its own box; the name and both badges live in
    // a caption below it, so nothing covers the game's key art.
    var art = document.createElement("div");
    art.className = "game-tile-art";
    art.appendChild(image);
    art.appendChild(fallback);

    // Optional wordmark overlay for a game whose header art doesn't
    // already have its own logo baked in (Minecraft's key art doesn't —
    // see games.js). Purely decorative: the header image and the <li>
    // itself already carry the game's name for assistive tech.
    if (game.logoImage) {
      var logo = document.createElement("img");
      logo.className = "supported-game-logo-overlay";
      logo.src = game.logoImage;
      logo.alt = "";
      logo.loading = "lazy";
      logo.referrerPolicy = "no-referrer";
      art.appendChild(logo);
    }
    li.appendChild(art);

    var body = document.createElement("div");
    body.className = "game-tile-body";
    var name = document.createElement("span");
    name.className = "game-tile-name";
    name.textContent = game.label;
    body.appendChild(name);

    var badges = document.createElement("div");
    badges.className = "game-tile-badges";
    var integrationTag = document.createElement("span");
    integrationTag.className = "supported-game-integration integration-" + integrationType;
    integrationTag.textContent = integrationLabel;
    badges.appendChild(integrationTag);

    var tag = document.createElement("span");
    tag.className = "tag " + (tested ? "tag-tested" : "tag-untested");
    tag.textContent = I18N.t(tested ? "welcome.tested" : "welcome.untested");
    badges.appendChild(tag);
    body.appendChild(badges);
    li.appendChild(body);
    supportedGamesList.appendChild(li);
  });
}
