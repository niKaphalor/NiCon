const { test, expect } = require("@playwright/test");

const API_ORIGIN = "https://nicon.mylss.de";
const RELAY_SOCKET = "wss://relay.130.61.8.150.sslip.io/ws/rcon";

function server(overrides) {
  return {
    id: 1,
    name: "GMod Alpha",
    host: "127.0.0.1",
    port: 28016,
    protocol: "source",
    query_protocol: "auto",
    query_port: null,
    game: "Garry's Mod",
    source: "manual",
    nitrado_game_code: "",
    game_icon_url: null,
    has_password: true,
    health_ok: true,
    health_checked_at: "2026-09-28T10:00:00Z",
    health_latency_ms: 12,
    health_error: null,
    ...overrides,
  };
}

async function installBackend(page, initialServers = []) {
  const state = {
    servers: initialServers.map((item) => ({ ...item })),
    templates: [],
    rules: [],
    commands: [],
    commandAudits: [],
    connectedServerIds: [],
    sockets: [],
    nextServerId: 100,
  };

  await page.addInitScript(() => localStorage.setItem("nicon_lang", "en"));

  await page.route("https://assets.nitrado.net/**", async (route) => {
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    });
  });
  await page.route(/https:\/\/(shared|store)\.fastly\.steamstatic\.com\/.*/, async (route) => {
    await route.fulfill({
      contentType: "image/jpeg",
      body: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64"),
    });
  });

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let body = {};
    if (request.postData()) {
      try { body = request.postDataJSON(); } catch (_) { body = {}; }
    }

    const json = (value, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });

    if (method === "GET" && (path === "/api/healthz" || path === "/healthz")) return json({ ok: true });
    if (method === "POST" && path === "/api/login") {
      if (body.username === "operator" && body.password === "correct horse") return json({ token: "browser-token", is_admin: false });
      return json({ error: "invalid username or password" }, 401);
    }
    if (method === "POST" && path === "/api/logout") return route.fulfill({ status: 204 });
    if (method === "GET" && path === "/api/servers") return json(state.servers);
    if (method === "GET" && /^\/api\/servers\/\d+\/health-history$/.test(path)) return json({
      range: url.searchParams.get("range") || "24h", uptime_percent: 100, sample_completeness_percent: 1,
      players_average: 1, players_peak: 1,
      samples: [{ at: "2026-09-28T10:00:00Z", online: true, latency_ms: 12, players: 1, players_max: 16, source: "relay" }],
    });
    if (method === "POST" && path === "/api/servers") {
      const created = server({ ...body, id: state.nextServerId++, source: "manual", has_password: !!body.password });
      delete created.password;
      state.servers.push(created);
      return json(created);
    }
    const updateMatch = path.match(/^\/api\/servers\/(\d+)$/);
    if (method === "PUT" && updateMatch) {
      const id = Number(updateMatch[1]);
      const index = state.servers.findIndex((item) => item.id === id);
      state.servers[index] = { ...state.servers[index], ...body };
      return json(state.servers[index]);
    }
    if (method === "PUT" && /^\/api\/servers\/\d+\/password$/.test(path)) return route.fulfill({ status: 204 });
    if (method === "GET" && path === "/api/account") return json({ username: "operator", nitrado_token_saved: false });
    if (method === "GET" && path === "/api/audit-log") return json(state.commandAudits.map((entry, index) => ({
      kind: "rcon",
      action: "rcon_command",
      rcon_action: entry.action,
      origin: entry.origin,
      command: entry.command,
      target_player: entry.targetPlayer || null,
      result: "ok",
      success: true,
      upstream_ms: 5.2,
      relay_overhead_ms: 0.8,
      actor_username: "operator",
      server_id: entry.serverId,
      server_name: state.servers.find((item) => item.id === entry.serverId)?.name || "Server",
      created_at: new Date(Date.now() + index).toISOString(),
    })));
    if (method === "GET" && path === "/api/faq") {
      return json(url.searchParams.get("lang") === "de"
        ? [{ question: "Frage eins", answer: "Antwort eins" }, { question: "Frage zwei", answer: "Antwort zwei" }]
        : [{ question: "Question one", answer: "Answer one" }, { question: "Question two", answer: "Answer two" }]);
    }
    if (method === "GET" && path === "/api/notifications") return json([]);
    if (method === "GET" && path === "/api/command-templates") return json(state.templates);
    if (method === "POST" && path === "/api/command-templates") {
      const template = { id: state.templates.length + 1, name: body.name, command: body.command };
      state.templates.push(template);
      return json(template, 201);
    }
    if (method === "GET" && path === "/api/moderation-rules") return json(state.rules);
    if (method === "POST" && path === "/api/moderation-rules") {
      const rule = { id: state.rules.length + 1, pattern: body.pattern, action: body.action, enabled: true };
      state.rules.push(rule);
      return json(rule, 201);
    }
    if (method === "POST" && path === "/api/steam/players") return json({ players: [] });
    if (method === "POST" && path === "/api/nitrado/sync") {
      const nitrado = server({
        id: 9001,
        name: "Nitrado GMod",
        source: "nitrado",
        nitrado_game_code: "gmod",
        game_icon_url: "https://assets.nitrado.net/gmod-64.png",
      });
      state.servers = state.servers.filter((item) => item.id !== nitrado.id).concat(nitrado);
      return json(state.servers);
    }
    if (method === "GET" && /^\/api\/servers\/\d+\/nitrado-status$/.test(path)) {
      return json({ status: "started", players: 1, players_max: 50, map: "Procedural Map", version: "test", memory_mb: 8192, settings: [{ key: "config.pvp", value: true }] });
    }
    return json({ error: `unmocked ${method} ${path}` }, 404);
  });

  await page.routeWebSocket(RELAY_SOCKET, (socket) => {
    const connection = { socket, serverId: null };
    state.sockets.push(connection);
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "authenticated" }));
      } else if (message.type === "connect") {
        connection.serverId = message.server_id;
        state.connectedServerIds.push(message.server_id);
        socket.send(JSON.stringify({ type: "connected" }));
      } else if (message.type === "test") {
        socket.send(JSON.stringify({ type: "test_result", ok: true }));
      } else if (message.type === "query_test") {
        socket.send(JSON.stringify({ type: "query_test_result", ok: true, players: 3, players_max: 20 }));
      } else if (message.type === "command") {
        state.commands.push({ serverId: connection.serverId, command: message.command });
        state.commandAudits.push({
          serverId: connection.serverId,
          command: message.command,
          origin: message.audit_origin,
          action: message.audit_action,
          targetPlayer: message.target_player,
        });
        let output = `ok: ${message.command}`;
        if (message.command === "status") {
          output = '# 2 "Alice" STEAM_0:1:12345678 05:23 24 0 active';
        } else if (message.command === "list") {
          output = "There are 1 of a max of 20 players online: Steve";
        }
        socket.send(JSON.stringify({ type: "response", output, upstream_ms: 5.2, relay_overhead_ms: 0.8 }));
      }
    });
  });

  return state;
}

async function login(page) {
  await page.goto("/index.html");
  await page.locator("#login-username").fill("operator");
  await page.locator("#login-password").fill("correct horse");
  await page.locator("#login-form button[type=submit]").click();
  await expect(page.locator("#view-app")).toBeVisible();
  await expect(page.locator("#username-label")).toHaveText("operator");
}

test("login, manual game selection, profile editing, and Nitrado sync", async ({ page }) => {
  const state = await installBackend(page, []);
  await login(page);
  // Counts come from the game catalog itself, so adding a game doesn't
  // break the suite.
  const catalogSize = await page.evaluate(() => Object.keys(window.NICON_GAMES).length);
  await expect(page.locator("#supported-games-list .supported-game-header")).toHaveCount(catalogSize);
  await expect(page.locator('#supported-games-list li[aria-label="Rust"] img')).toHaveAttribute("src", /apps\/252490\/header\.jpg/);
  await expect(page.locator('#supported-games-list li[aria-label="7 Days to Die"] .tag')).toHaveClass(/tag-tested/);
  await expect(page.locator('#supported-games-list li[aria-label="DayZ"] .tag')).toHaveClass(/tag-tested/);
  await expect(page.locator('#supported-games-list li[aria-label="ARK: Survival Ascended"] .tag')).toHaveClass(/tag-tested/);
  await expect(page.locator('#supported-games-list li[aria-label="Minecraft"] .tag')).toHaveClass(/tag-tested/);
  await expect(page.locator('#supported-games-list li[aria-label="Palworld"] .tag')).toHaveClass(/tag-tested/);
  await expect(page.locator('#supported-games-list li[aria-label="Valheim"] .supported-game-integration')).toContainText("Server mod required");
  await expect(page.locator('#supported-games-list li[aria-label="Rust"] .supported-game-integration')).toContainText("No server mod");
  await expect(page.locator('#supported-games-list li[aria-label="DayZ"] .supported-game-integration')).toContainText("Dedicated server protocol");
  // Minecraft isn't on Steam — official key art hotlinked from Mojang's
  // own CDN instead (see games.js), not the Steam header path every other
  // game above uses, plus a wordmark overlay since that key art has no
  // logo baked in the way a Steam header does.
  await expect(page.locator('#supported-games-list li[aria-label="Minecraft"] .supported-game-header')).toHaveAttribute("src", /minecraft\.net.*key-art/);
  await expect(page.locator('#supported-games-list li[aria-label="Minecraft"] .supported-game-logo-overlay')).toHaveAttribute("src", /wikimedia\.org.*Minecraft_game_logo/);
  const overviewLayout = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
    const panel = document.querySelector(".supported-games").getBoundingClientRect();
    const footer = document.querySelector(".site-footer").getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll("#supported-games-list li"));
    const columns = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)));
    return {
      sidebarWidth: sidebar.width,
      panelRight: panel.right,
      panelBottom: panel.bottom,
      footerTop: footer.top,
      columns: columns.size,
      viewportWidth: window.innerWidth,
    };
  });
  expect(overviewLayout.sidebarWidth).toBe(286);
  expect(overviewLayout.columns).toBeGreaterThanOrEqual(6);
  expect(overviewLayout.panelRight).toBeLessThanOrEqual(overviewLayout.viewportWidth);
  expect(overviewLayout.panelBottom).toBeLessThanOrEqual(overviewLayout.footerTop);

  await page.locator("#add-server-btn").click();
  await page.locator('[data-tab="manual"]').click();
  await expect(page.locator("#manual-game option")).toHaveCount(catalogSize + 1); // + the "Generic (no parsing)" entry
  await expect(page.locator("#manual-game")).toContainText("Counter-Strike 2");
  await expect(page.locator("#manual-game")).toContainText("Minecraft");
  await page.locator("#manual-game").selectOption("Rust");
  await expect(page.locator("#manual-protocol")).toHaveValue("webrcon");
  await expect(page.locator("#manual-query-protocol")).toHaveValue("a2s");
  await page.locator("#manual-game").selectOption("Palworld");
  await expect(page.locator("#manual-protocol")).toHaveValue("palworld_rest");
  await page.locator("#manual-game").selectOption("Minecraft");
  await expect(page.locator("#manual-protocol")).toHaveValue("source");
  await expect(page.locator("#manual-query-protocol")).toHaveValue("minecraft");
  await page.locator("#manual-name").fill("Manual 7DTD");
  await page.locator("#manual-host").fill("127.0.0.1");
  await page.locator("#manual-port").fill("2302");
  await page.locator("#manual-password").fill("secret");
  await page.locator("#manual-game").selectOption("7 Days to Die");
  await expect(page.locator("#manual-protocol")).toHaveValue("telnet");
  await page.locator("#manual-query-protocol").selectOption("a2s");
  await page.locator("#manual-query-port").fill("26900");
  await page.locator("#manual-query-test-btn").click();
  await expect(page.locator("#manual-query-test-status")).toContainText("3 / 20");
  await page.locator("#manual-form button[type=submit]").click();
  await expect(page.locator(".server-row", { hasText: "Manual 7DTD" })).toBeVisible();
  expect(state.servers.find((item) => item.name === "Manual 7DTD")).toMatchObject({ game: "7 Days to Die", protocol: "telnet", query_protocol: "a2s", query_port: 26900 });

  await page.locator(".server-row", { hasText: "Manual 7DTD" }).click();
  await expect(page.locator("#content")).toHaveAttribute("style", /apps\/251570\/page_bg_raw\.jpg/);
  await expect.poll(() => page.locator("#head").evaluate((element) => getComputedStyle(element, "::before").backgroundImage)).toContain("apps/251570/page_bg_raw.jpg");
  await expect(page.locator('[data-server-tab="console"]')).toHaveAttribute("aria-selected", "true");
  await page.locator("#head .server-actions-menu summary").click();
  await page.locator("#head .server-menu-action", { hasText: "Edit" }).click();
  await page.locator("#edit-server-name").fill("Edited Reforger");
  await page.locator("#edit-server-game").selectOption("Arma Reforger");
  await expect(page.locator("#edit-server-query-protocol")).toHaveValue("a2s");
  await page.locator('#edit-server-form button[type="submit"]').click();
  await expect(page.locator(".server-row", { hasText: "Edited Reforger" })).toBeVisible();
  expect(state.servers.find((item) => item.name === "Edited Reforger")).toMatchObject({ game: "Arma Reforger", protocol: "battleye", query_protocol: "a2s" });

  await page.locator("#add-server-btn").click();
  await page.locator('[data-tab="nitrado"]').click();
  await page.locator("#nitrado-token").fill("test-token");
  await page.locator("#nitrado-form button[type=submit]").click();
  const nitradoRow = page.locator(".server-row", { hasText: "Nitrado GMod" });
  await expect(nitradoRow).toBeVisible();
  await expect(nitradoRow.locator(".server-game-icon")).toHaveAttribute("src", "https://assets.nitrado.net/gmod-64.png");
  const rowBox = await nitradoRow.boundingBox();
  const iconBox = await nitradoRow.locator(".server-game-icon").boundingBox();
  expect(iconBox.height).toBeGreaterThanOrEqual(rowBox.height - 12);
  await nitradoRow.click();
  await expect(page.locator("#nitrado-resources-card")).toBeVisible();
  await expect(page.locator("#nitrado-resources .resource-item")).toHaveCount(4);
  await expect(page.locator("#nitrado-resources")).toContainText("Started");
  await expect(page.locator("#nitrado-resources")).toContainText("1 / 50");
  await expect(page.locator("#nitrado-resources")).toContainText("Procedural Map");
  await expect(page.locator("#nitrado-resources")).toContainText("test");
  await expect(page.locator("#nitrado-resources")).not.toContainText("8192");
  await expect(page.locator("#nitrado-resources")).not.toContainText("config.pvp");
});

test("two consoles stay connected and player actions reach the selected server", async ({ page }) => {
  const state = await installBackend(page, [
    server({ id: 1, name: "GMod Alpha" }),
    server({ id: 2, name: "GMod Beta", port: 27016 }),
  ]);
  await login(page);

  await page.locator(".server-row", { hasText: "GMod Alpha" }).click();
  // Garry's Mod is one of the games with a Nitrado header logo (games.js's
  // nitradoBackgroundSlugs) — confirms renderHead() actually renders it,
  // distinct from the supported-games tile logo overlay (Minecraft-only).
  await expect(page.locator("#head .head-game-logo")).toHaveAttribute("src", /garrysmod-logo\.png/);
  await expect(page.locator("#players-panel .player-name")).toHaveText("Alice");
  await page.locator('[data-server-tab="overview"]').click();
  await expect(page.locator("#server-overview-content")).toContainText("100.00%");
  await expect(page.locator("#server-overview-content")).toContainText("0.8 ms");
  await page.locator('[data-server-tab="console"]').click();
  await page.locator(".server-row", { hasText: "GMod Beta" }).click();
  await expect.poll(() => state.connectedServerIds).toEqual(expect.arrayContaining([1, 2]));

  await page.locator("#players-panel .player-actions-row button", { hasText: "Kick" }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog-ok").click();
  await expect.poll(() => state.commands).toContainEqual({ serverId: 2, command: "kickid 2" });
  await expect.poll(() => state.commandAudits).toContainEqual({ serverId: 2, command: "kickid 2", origin: "player_action", action: "kick", targetPlayer: "Alice" });
  await page.locator('[data-server-tab="audit"]').click();
  await expect(page.locator("#server-audit-list")).toContainText("kickid 2");
  await expect(page.locator("#server-audit-list")).not.toContainText("GMod Alpha");

  await page.locator(".server-row", { hasText: "GMod Alpha" }).click();
  await page.locator("#cmd-input").fill("status");
  await page.locator("#cmd-form button[type=submit]").click();
  await expect.poll(() => state.commands).toContainEqual({ serverId: 1, command: "status" });
  await page.locator("#nav-health-btn").click();
  await expect(page.locator("#health-body tr", { hasText: "GMod Alpha" })).toContainText("relay 0.8 ms");
});

test("macros and moderation rules execute through the live console", async ({ page }) => {
  const state = await installBackend(page, [server({ id: 1 })]);
  await login(page);
  await page.locator(".server-row", { hasText: "GMod Alpha" }).click();
  await expect(page.locator("#players-panel .player-name")).toHaveText("Alice");

  await page.locator("#cmd-templates-btn").click();
  await page.locator("#cmd-template-name-input").fill("Save and announce");
  await page.locator("#cmd-template-command-input").fill("server.save\nsay maintenance soon");
  await page.locator('#cmd-template-add-form button[type="submit"]').click();
  await expect(page.locator("#cmd-templates-list", { hasText: "Save and announce" })).toBeVisible();
  await page.locator("#cmd-templates-list .cmd-template-row", { hasText: "Save and announce" }).locator("button", { hasText: "Send" }).click();
  await expect.poll(() => state.commands, { timeout: 3000 }).toEqual(expect.arrayContaining([
    { serverId: 1, command: "server.save" },
    { serverId: 1, command: "say maintenance soon" },
  ]));
  await expect.poll(() => state.commandAudits).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: "server.save", origin: "macro", action: "macro" }),
    expect.objectContaining({ command: "say maintenance soon", origin: "macro", action: "macro" }),
  ]));

  await page.locator("#moderation-rules-btn").click();
  await page.locator("#moderation-pattern-input").fill("badword");
  await page.locator("#moderation-action-select").selectOption("kick");
  await page.locator('#moderation-rule-form button[type="submit"]').click();
  await expect(page.locator("#moderation-rules-list", { hasText: "badword" })).toBeVisible();

  const gameSocket = state.sockets.find((connection) => connection.serverId === 1);
  gameSocket.socket.send(JSON.stringify({ type: "broadcast", output: "Alice: badword" }));
  await expect.poll(() => state.commands).toContainEqual({ serverId: 1, command: "kickid 2" });
  await expect.poll(() => state.commandAudits).toContainEqual({ serverId: 1, command: "kickid 2", origin: "automatic_moderation", action: "kick", targetPlayer: "Alice" });
});

test("all public pages share the same responsive design shell", async ({ page }) => {
  const pages = [
    ["contact.html", "Contact"], ["contact.de.html", "Kontakt"],
    ["imprint.html", "Imprint"], ["imprint.de.html", "Impressum"],
    ["privacy.html", "Privacy"], ["privacy.de.html", "Datenschutz"],
  ];
  for (const [path, activeLabel] of pages) {
    await page.goto(`/${path}`);
    await expect(page.locator("body")).toHaveClass(/legal-shell/);
    await expect(page.locator(".public-topbar .wordmark")).toBeVisible();
    await expect(page.locator(".public-nav a[aria-current=page]")).toHaveText(activeLabel);
    await expect(page.locator(".legal-card")).toBeVisible();
    await expect(page.locator(".legal-page-toolbar .lang-switch")).toBeVisible();
    await expect(page.locator(".site-footer a[aria-current=page]")).toHaveText(activeLabel);
    // The FAQ is part of the app, not of the legal/support pages.
    await expect(page.locator('.public-nav a[href*="faq"], .site-footer a[href*="faq"]')).toHaveCount(0);
  }

  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/privacy.de.html");
  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    cardRight: document.querySelector(".legal-card").getBoundingClientRect().right,
  }));
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth);
});

test("FAQ is a main-navigation view of the app, not a legal page", async ({ page }) => {
  await installBackend(page, []);

  // Signed out: the FAQ is public, reachable from the main navigation, and
  // the footer only carries the legal pages.
  await page.goto("/index.html");
  await expect(page.locator(".site-footer a[href*='faq']")).toHaveCount(0);
  await expect(page.locator(".topbar-nav #nav-faq-btn")).toBeVisible();
  await page.locator("#nav-faq-btn").click();
  await expect(page.locator("#view-faq")).toBeVisible();
  await expect(page.locator("#view-login")).toBeHidden();
  await expect(page.locator("#nav-faq-btn")).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/#faq$/);
  await expect(page.locator("#faq-list .faq-item")).toHaveCount(2);
  await expect(page.locator("#faq-list .faq-item").first()).toContainText("Question one");
  await expect(page.locator("#faq-list .faq-item").first()).toHaveAttribute("open", "");

  // Switching language reloads the entries in that language.
  await page.evaluate(() => window.NICON_I18N.setLang("de"));
  await expect(page.locator("#faq-list .faq-item").first()).toContainText("Frage eins");
  await expect(page.locator("#view-faq h1")).toHaveText("Häufig gestellte Fragen");
  await page.evaluate(() => window.NICON_I18N.setLang("en"));

  // The wordmark leaves the FAQ again and clears the #faq hash.
  await page.locator(".wordmark").click();
  await expect(page.locator("#view-faq")).toBeHidden();
  await expect(page.locator("#view-login")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");

  // Deep link.
  await page.goto("/index.html#faq");
  await expect(page.locator("#view-faq")).toBeVisible();
  await expect(page.locator("#faq-list .faq-item")).toHaveCount(2);

  // The old standalone pages redirect into the app, keeping the language.
  await page.goto("/faq.html");
  await expect(page).toHaveURL(/index\.html#faq$/);
  await expect(page.locator("#view-faq")).toBeVisible();
  await page.goto("/faq.de.html");
  await expect(page).toHaveURL(/index\.html\?lang=de#faq$/);
  await expect(page.locator("#view-faq h1")).toHaveText("Häufig gestellte Fragen");
  await expect(page.locator("#faq-list .faq-item").first()).toContainText("Frage eins");
});

test("signed in, FAQ sits between Settings and Admin and Servers returns to the console", async ({ page }) => {
  await installBackend(page, []);
  await login(page);
  const labels = await page.locator(".topbar-nav .navlink:visible").allTextContents();
  expect(labels.indexOf("FAQ")).toBe(labels.indexOf("Settings") + 1);
  await page.locator("#nav-faq-btn").click();
  await expect(page.locator("#view-faq")).toBeVisible();
  await expect(page.locator("#view-app")).toBeHidden();
  await page.locator("#nav-servers-btn").click();
  await expect(page.locator("#view-app")).toBeVisible();
  await expect(page.locator("#view-faq")).toBeHidden();
  expect(new URL(page.url()).hash).toBe("");
});

test("7 Days to Die player parser ignores the total summary", async ({ page }) => {
  await page.goto("/index.html");
  const empty = await page.evaluate(() => window.NICON_GAMES.sevendaystodie.parse("Total of 0 in the game\n"));
  expect(empty).toMatchObject({ summary: "0 players online", players: [] });

  const populated = await page.evaluate(() => window.NICON_GAMES.sevendaystodie.parse(
    "0. id=171, Alice, pos=(1, 2, 3), remote=True\nTotal of 1 in the game\n"
  ));
  expect(populated).toMatchObject({
    summary: "1 player online",
    players: [{ cells: ["Alice"], id: "Alice", isAdmin: false }],
  });
});

test("PWA is installable and its app shell works offline", async ({ page, context }) => {
  const googleFontRequests = [];
  page.on("request", (request) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) googleFontRequests.push(request.url());
  });
  await installBackend(page, []);
  await page.goto("/index.html");
  expect(googleFontRequests).toEqual([]);

  const manifest = await page.evaluate(async () => fetch("site.webmanifest").then((response) => response.json()));
  expect(manifest).toMatchObject({
    name: "NiCon",
    short_name: "NiCon",
    id: "./",
    start_url: "./index.html",
    scope: "./",
    display: "standalone",
    prefer_related_applications: false,
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: "192x192" }),
    expect.objectContaining({ sizes: "512x512" }),
  ]));

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain("/sw.js");
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Inter"'))).toBe(true);
  const devtools = await context.newCDPSession(page);
  const installability = await devtools.send("Page.getInstallabilityErrors");
  expect(installability.installabilityErrors).toEqual([]);
  await devtools.detach();

  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.defineProperty(event, "prompt", { value: () => { window.__niconInstallPrompted = true; } });
    Object.defineProperty(event, "userChoice", { value: Promise.resolve({ outcome: "accepted" }) });
    window.dispatchEvent(event);
  });
  await expect(page.locator("#pwa-install-btn")).toBeVisible();
  await page.locator("#pwa-install-btn").click();
  await expect.poll(() => page.evaluate(() => window.__niconInstallPrompted)).toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("NiCon");
  await expect(page.locator("#view-login")).toBeVisible();
  await context.setOffline(false);
});

test("public status panel shows a distinct message when query checks are disabled", async ({ page }) => {
  // Regression test for a real support case: before this, a server with
  // query_protocol="disabled" (e.g. ARK: Survival Ascended, which doesn't
  // reliably answer A2S — see docs/compatibility.md) showed the exact same
  // "no data yet" text as a server that just hadn't been sampled, which
  // made a real timeout confusing to diagnose. It must also not fetch
  // health-history at all for a disabled server — the value is already
  // known client-side.
  let healthHistoryRequested = false;
  await installBackend(page, [server({ id: 1, has_password: false, query_protocol: "disabled" })]);
  await page.route("**/api/servers/1/health-history**", (route) => {
    healthHistoryRequested = true;
    route.continue();
  });
  await login(page);
  await page.locator(".server-row", { hasText: "GMod Alpha" }).click();
  await expect(page.locator("#password-public-status-values")).toHaveText("Public status checks are turned off for this server.");
  expect(healthHistoryRequested).toBe(false);
});
