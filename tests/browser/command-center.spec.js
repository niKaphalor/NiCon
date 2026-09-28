const { test, expect } = require("@playwright/test");

const API_ORIGIN = "https://nicon.mylss.de";
const RELAY_SOCKET = "wss://relay.130.61.8.150.sslip.io/ws/rcon";

function server(overrides) {
  return {
    id: 1,
    name: "Rust Alpha",
    host: "127.0.0.1",
    port: 28016,
    protocol: "webrcon",
    game: "Rust",
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
    if (method === "GET" && path === "/api/audit-log") return json([]);
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
        name: "Nitrado Rust",
        source: "nitrado",
        nitrado_game_code: "rust",
        game_icon_url: "https://assets.nitrado.net/rust-64.png",
      });
      state.servers = state.servers.filter((item) => item.id !== nitrado.id).concat(nitrado);
      return json(state.servers);
    }
    if (method === "GET" && /^\/api\/servers\/\d+\/nitrado-status$/.test(path)) {
      return json({ status: "started", players: 1, players_max: 50, map: "Procedural Map", version: "test" });
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
      } else if (message.type === "command") {
        state.commands.push({ serverId: connection.serverId, command: message.command });
        let output = `ok: ${message.command}`;
        if (message.command === "playerlist") {
          output = JSON.stringify([{
            DisplayName: "Alice",
            SteamID: "76561198000112233",
            Ping: 24,
            Address: "127.0.0.1:28015",
            ConnectedSeconds: 300,
          }]);
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

  await page.locator("#add-server-btn").click();
  await page.locator('[data-tab="manual"]').click();
  await page.locator("#manual-name").fill("Manual DayZ");
  await page.locator("#manual-host").fill("127.0.0.1");
  await page.locator("#manual-port").fill("2302");
  await page.locator("#manual-password").fill("secret");
  await page.locator("#manual-game").selectOption("DayZ");
  await expect(page.locator("#manual-protocol")).toHaveValue("battleye");
  await page.locator("#manual-form button[type=submit]").click();
  await expect(page.locator(".server-row", { hasText: "Manual DayZ" })).toBeVisible();
  expect(state.servers.find((item) => item.name === "Manual DayZ")).toMatchObject({ game: "DayZ", protocol: "battleye" });

  await page.locator(".server-row", { hasText: "Manual DayZ" }).click();
  await page.locator("#head .head-actions button", { hasText: "Edit" }).click();
  await page.locator("#edit-server-name").fill("Edited DayZ");
  await page.locator("#edit-server-game").selectOption("Arma 3");
  await page.locator('#edit-server-form button[type="submit"]').click();
  await expect(page.locator(".server-row", { hasText: "Edited DayZ" })).toBeVisible();
  expect(state.servers.find((item) => item.name === "Edited DayZ")).toMatchObject({ game: "Arma 3", protocol: "battleye" });

  await page.locator("#add-server-btn").click();
  await page.locator('[data-tab="nitrado"]').click();
  await page.locator("#nitrado-token").fill("test-token");
  await page.locator("#nitrado-form button[type=submit]").click();
  const nitradoRow = page.locator(".server-row", { hasText: "Nitrado Rust" });
  await expect(nitradoRow).toBeVisible();
  await expect(nitradoRow.locator(".server-game-icon")).toHaveAttribute("src", "https://assets.nitrado.net/rust-64.png");
  const rowBox = await nitradoRow.boundingBox();
  const iconBox = await nitradoRow.locator(".server-game-icon").boundingBox();
  expect(iconBox.height).toBeGreaterThanOrEqual(rowBox.height - 12);
});

test("two consoles stay connected and player actions reach the selected server", async ({ page }) => {
  const state = await installBackend(page, [
    server({ id: 1, name: "Rust Alpha" }),
    server({ id: 2, name: "Rust Beta", port: 28017 }),
  ]);
  await login(page);

  await page.locator(".server-row", { hasText: "Rust Alpha" }).click();
  await expect(page.locator("#players-panel .player-name")).toHaveText("Alice");
  await page.locator(".server-row", { hasText: "Rust Beta" }).click();
  await expect.poll(() => state.connectedServerIds).toEqual(expect.arrayContaining([1, 2]));

  await page.locator("#players-panel .player-actions-row button", { hasText: "Kick" }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-dialog-ok").click();
  await expect.poll(() => state.commands).toContainEqual({ serverId: 2, command: "kick 76561198000112233" });

  await page.locator(".server-row", { hasText: "Rust Alpha" }).click();
  await page.locator("#cmd-input").fill("status");
  await page.locator("#cmd-form button[type=submit]").click();
  await expect.poll(() => state.commands).toContainEqual({ serverId: 1, command: "status" });
  await page.locator("#nav-health-btn").click();
  await expect(page.locator("#health-body tr", { hasText: "Rust Alpha" })).toContainText("relay 0.8 ms");
});

test("macros and moderation rules execute through the live console", async ({ page }) => {
  const state = await installBackend(page, [server({ id: 1 })]);
  await login(page);
  await page.locator(".server-row", { hasText: "Rust Alpha" }).click();
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

  await page.locator("#moderation-rules-btn").click();
  await page.locator("#moderation-pattern-input").fill("badword");
  await page.locator("#moderation-action-select").selectOption("kick");
  await page.locator('#moderation-rule-form button[type="submit"]').click();
  await expect(page.locator("#moderation-rules-list", { hasText: "badword" })).toBeVisible();

  const rustSocket = state.sockets.find((connection) => connection.serverId === 1);
  rustSocket.socket.send(JSON.stringify({ type: "broadcast", output: "Alice: badword" }));
  await expect.poll(() => state.commands).toContainEqual({ serverId: 1, command: "kick 76561198000112233" });
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
