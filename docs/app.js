(function () {
  "use strict";

  var I18N = window.NICON_I18N;

  // The session token lives in sessionStorage (cleared when the tab
  // closes, unlike localStorage) so a reload doesn't force a re-login but
  // nothing survives beyond this browser session. Everything else —
  // server list, console state — is fetched fresh from the relay/database
  // each time, never cached to disk.
  var TOKEN_KEY = "nicon_token";
  var USERNAME_KEY = "nicon_username";
  var IS_ADMIN_KEY = "nicon_is_admin";
  var authToken = null;
  var currentUsername = "";
  var currentIsAdmin = false;
  try {
    authToken = sessionStorage.getItem(TOKEN_KEY);
    currentUsername = sessionStorage.getItem(USERNAME_KEY) || "";
    currentIsAdmin = sessionStorage.getItem(IS_ADMIN_KEY) === "1";
  } catch (e) {
    // Some browser contexts (e.g. a private window with storage blocked)
    // throw on access; fall back to session-memory-only auth.
  }

  function setAuthState(token, username, isAdmin) {
    authToken = token;
    currentUsername = username;
    currentIsAdmin = !!isAdmin;
    try {
      sessionStorage.setItem(TOKEN_KEY, authToken);
      sessionStorage.setItem(USERNAME_KEY, currentUsername);
      sessionStorage.setItem(IS_ADMIN_KEY, currentIsAdmin ? "1" : "0");
    } catch (e) { /* ignore */ }
  }

  function clearAuthState() {
    authToken = null;
    currentIsAdmin = false;
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(USERNAME_KEY);
      sessionStorage.removeItem(IS_ADMIN_KEY);
    } catch (e) { /* ignore */ }
  }

  var servers = [];

  // One entry per currently-open console: serverId -> { server, socket,
  // lines: [{kind, text}], pendingPlayersRequest, authenticated }.
  var consoles = {};
  var activeConsoleId = null;

  // --- element refs ---

  var apiPill = document.getElementById("api-pill");
  var apiBanner = document.getElementById("api-banner");
  var apiBannerSettingsBtn = document.getElementById("api-banner-settings-btn");
  var apiForm = document.getElementById("api-form");
  var apiUrlInput = document.getElementById("api-url");

  var relayPill = document.getElementById("relay-pill");
  var relayBanner = document.getElementById("relay-banner");
  var settingsBtn = document.getElementById("settings-btn");
  var bannerSettingsBtn = document.getElementById("banner-settings-btn");
  var settingsModal = document.getElementById("settings-modal");
  var settingsClose = document.getElementById("settings-close");
  var relayForm = document.getElementById("relay-form");
  var relayUrlInput = document.getElementById("relay-url");

  var usernameLabel = document.getElementById("username-label");
  var logoutBtn = document.getElementById("logout-btn");
  var langSelect = document.getElementById("lang-select");

  var adminNavBtn = document.getElementById("admin-nav-btn");
  var viewAdmin = document.getElementById("view-admin");
  var adminBackBtn = document.getElementById("admin-back-btn");
  var adminUsersBody = document.getElementById("admin-users-body");

  var viewLogin = document.getElementById("view-login");
  var loginForm = document.getElementById("login-form");
  var loginError = document.getElementById("login-error");
  var showRegisterBtn = document.getElementById("show-register-btn");

  var viewRegister = document.getElementById("view-register");
  var registerForm = document.getElementById("register-form");
  var registerError = document.getElementById("register-error");
  var showLoginBtn = document.getElementById("show-login-btn");

  var showResetBtn = document.getElementById("show-reset-btn");
  var resetModal = document.getElementById("reset-modal");
  var resetClose = document.getElementById("reset-close");
  var resetForm = document.getElementById("reset-form");
  var resetError = document.getElementById("reset-error");

  var recoveryModal = document.getElementById("recovery-modal");
  var recoveryCodeEl = document.getElementById("recovery-code");
  var recoveryCopyBtn = document.getElementById("recovery-copy-btn");
  var recoveryAckCheckbox = document.getElementById("recovery-ack");
  var recoveryContinueBtn = document.getElementById("recovery-continue-btn");

  var viewServers = document.getElementById("view-servers");
  var viewConsole = document.getElementById("view-console");
  var serverGrid = document.getElementById("server-grid");
  var emptyState = document.getElementById("empty-state");
  var addServerBtn = document.getElementById("add-server-btn");
  var emptyAddBtn = document.getElementById("empty-add-btn");
  var openSettingsFromSubhead = document.getElementById("open-settings-from-subhead");

  var accountDangerZone = document.getElementById("account-danger-zone");
  var deleteAccountBtn = document.getElementById("delete-account-btn");

  var addModal = document.getElementById("add-modal");
  var addClose = document.getElementById("add-close");
  var addTabs = document.querySelectorAll(".tab");
  var addTabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var manualForm = document.getElementById("manual-form");

  var backBtn = document.getElementById("back-btn");
  var consoleTitle = document.getElementById("console-title");
  var consoleBadge = document.getElementById("console-badge");
  var consoleTabs = document.getElementById("console-tabs");
  var filterInput = document.getElementById("filter-input");
  var infoBtn = document.getElementById("info-btn");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");

  var gameSelect = document.getElementById("game-select");
  var playersBtn = document.getElementById("players-btn");
  var playersPanel = document.getElementById("players-panel");
  var infoModal = document.getElementById("info-modal");
  var infoClose = document.getElementById("info-close");

  // --- cloud API address + status ---
  // Handles everything except the actual RCON connection: sign-in,
  // account, server list. A normal HTTPS address, expected to be
  // reachable at all times regardless of whether the local relay is
  // running.

  function apiHttpUrl() {
    return apiUrlInput.value.replace(/\/+$/, "");
  }

  function setApiStatus(ok) {
    apiPill.className = "relay-pill " + (ok ? "status-ok" : "status-error");
    apiBanner.hidden = ok;
  }

  function checkApi() {
    fetch(apiHttpUrl() + "/api/healthz")
      .then(function (r) { setApiStatus(r.ok); })
      .catch(function () { setApiStatus(false); });
  }

  apiForm.addEventListener("submit", function (e) {
    e.preventDefault();
    checkApi();
    settingsModal.close();
  });

  // --- relay address + status ---
  // Only used for the actual WebSocket<->RCON bridge (openOrFocusConsole
  // below) — everything else goes through the cloud API.

  function relayHttpUrl() {
    return relayUrlInput.value.replace(/\/+$/, "");
  }

  function relayWsUrl() {
    return relayHttpUrl().replace(/^http/, "ws");
  }

  function setRelayStatus(ok) {
    relayPill.className = "relay-pill " + (ok ? "status-ok" : "status-error");
    relayBanner.hidden = ok;
  }

  function checkRelay() {
    fetch(relayHttpUrl() + "/healthz")
      .then(function (r) { setRelayStatus(r.ok); })
      .catch(function () { setRelayStatus(false); });
  }

  relayForm.addEventListener("submit", function (e) {
    e.preventDefault();
    checkRelay();
    settingsModal.close();
  });

  // --- language ---

  langSelect.value = I18N.getLang();
  langSelect.addEventListener("change", function () {
    I18N.setLang(langSelect.value);
  });
  document.addEventListener("nicon:langchange", function () {
    // Static text re-renders itself via data-i18n attributes; anything
    // built from JS strings (server cards, console status lines already on
    // screen) needs an explicit re-render.
    renderServers();
    if (activeConsoleId !== null) renderActiveConsole();
  });

  settingsBtn.addEventListener("click", function () { settingsModal.showModal(); });
  bannerSettingsBtn.addEventListener("click", function () { settingsModal.showModal(); });
  apiBannerSettingsBtn.addEventListener("click", function () { settingsModal.showModal(); });
  apiPill.addEventListener("click", function () { settingsModal.showModal(); });
  relayPill.addEventListener("click", function () { settingsModal.showModal(); });
  openSettingsFromSubhead.addEventListener("click", function () { settingsModal.showModal(); });
  settingsClose.addEventListener("click", function () { settingsModal.close(); });
  settingsModal.addEventListener("click", function (e) {
    if (e.target === settingsModal) settingsModal.close();
  });

  // --- authenticated API calls ---

  // Wraps fetch() with the Authorization header and central 401 handling:
  // any authenticated call that comes back unauthorized (expired/invalid
  // session) drops the user back to the login screen instead of failing
  // silently or looping.
  function apiFetch(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (authToken) headers["Authorization"] = "Bearer " + authToken;
    options.headers = headers;

    return fetch(apiHttpUrl() + path, options).then(function (r) {
      if (r.status === 401) {
        sessionExpired();
        throw new Error("session expired");
      }
      return r;
    });
  }

  function sessionExpired() {
    clearAuthState();
    disconnectAllConsoles();
    servers = [];
    showLoginView();
    loginError.textContent = I18N.t("errors.sessionExpired");
    loginError.hidden = false;
  }

  function disconnectAllConsoles() {
    Object.keys(consoles).forEach(function (id) {
      if (consoles[id].socket) consoles[id].socket.close();
    });
    consoles = {};
    activeConsoleId = null;
  }

  // --- login / logout ---

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("login-username").value;
    var password = document.getElementById("login-password").value;
    loginError.hidden = true;

    fetch(apiHttpUrl() + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || "sign in failed"); });
        return r.json();
      })
      .then(function (data) {
        setAuthState(data.token, username, data.is_admin);
        return loadServers();
      })
      .then(function () {
        loginForm.reset();
        showServersView();
      })
      .catch(function (err) {
        loginError.textContent = err.message || I18N.t("errors.signInFailed");
        loginError.hidden = false;
      });
  });

  logoutBtn.addEventListener("click", function () {
    apiFetch("/api/logout", { method: "POST" }).catch(function () { /* logging out regardless */ });
    clearAuthState();
    disconnectAllConsoles();
    servers = [];
    showLoginView();
  });

  // --- registration ---

  showRegisterBtn.addEventListener("click", function () { showRegisterView(); });
  showLoginBtn.addEventListener("click", function () { showLoginView(); });

  registerForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("register-username").value.trim();
    var password = document.getElementById("register-password").value;
    var passwordConfirm = document.getElementById("register-password-confirm").value;
    var consent = document.getElementById("register-consent").checked;
    registerError.hidden = true;

    if (password !== passwordConfirm) {
      registerError.textContent = I18N.t("errors.passwordMismatch");
      registerError.hidden = false;
      return;
    }
    if (!consent) {
      registerError.textContent = I18N.t("errors.mustAcceptPrivacy");
      registerError.hidden = false;
      return;
    }

    fetch(apiHttpUrl() + "/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password, consent_accepted: consent }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || "registration failed"); });
        return r.json();
      })
      .then(function (data) {
        setAuthState(data.token, username, data.is_admin);
        registerForm.reset();
        showRecoveryCodeModal(data.recovery_code, function () {
          loadServers()
            .then(showServersView)
            .catch(function () { /* apiFetch already routes 401s to sessionExpired() */ });
        });
      })
      .catch(function (err) {
        registerError.textContent = err.message || I18N.t("errors.registrationFailed");
        registerError.hidden = false;
      });
  });

  // --- password reset (self-service, no email — a saved recovery code) ---

  showResetBtn.addEventListener("click", function () {
    resetForm.reset();
    resetError.hidden = true;
    resetModal.showModal();
  });
  resetClose.addEventListener("click", function () { resetModal.close(); });
  resetModal.addEventListener("click", function (e) {
    if (e.target === resetModal) resetModal.close();
  });

  resetForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("reset-username").value.trim();
    var code = document.getElementById("reset-code").value;
    var newPassword = document.getElementById("reset-new-password").value;
    var newPasswordConfirm = document.getElementById("reset-new-password-confirm").value;
    resetError.hidden = true;

    if (newPassword !== newPasswordConfirm) {
      resetError.textContent = I18N.t("errors.passwordMismatch");
      resetError.hidden = false;
      return;
    }

    fetch(apiHttpUrl() + "/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, recovery_code: code, new_password: newPassword }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || "reset failed"); });
        return r.json();
      })
      .then(function (data) {
        resetModal.close();
        showRecoveryCodeModal(data.new_recovery_code, function () { /* stays on the login view */ });
      })
      .catch(function (err) {
        resetError.textContent = err.message || I18N.t("errors.resetFailed");
        resetError.hidden = false;
      });
  });

  // --- recovery code modal: shown once at registration and again after any
  // reset, since the old code is single-use. Not dismissible except via the
  // explicit "I've saved it" acknowledgment — there's no way to see the
  // code again afterward, so a stray Escape/backdrop-click can't lose it.

  var pendingRecoveryContinue = null;

  function showRecoveryCodeModal(code, onContinue) {
    recoveryCodeEl.textContent = code;
    recoveryAckCheckbox.checked = false;
    recoveryContinueBtn.disabled = true;
    recoveryCopyBtn.textContent = I18N.t("recovery.copy");
    pendingRecoveryContinue = onContinue;
    recoveryModal.showModal();
  }

  recoveryModal.addEventListener("cancel", function (e) { e.preventDefault(); });

  recoveryAckCheckbox.addEventListener("change", function () {
    recoveryContinueBtn.disabled = !recoveryAckCheckbox.checked;
  });

  recoveryCopyBtn.addEventListener("click", function () {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(recoveryCodeEl.textContent)
      .then(function () { recoveryCopyBtn.textContent = I18N.t("recovery.copied"); })
      .catch(function () { /* clipboard denied — the code is still selectable text */ });
  });

  recoveryContinueBtn.addEventListener("click", function () {
    recoveryModal.close();
    var cb = pendingRecoveryContinue;
    pendingRecoveryContinue = null;
    if (cb) cb();
  });

  // --- account deletion (self-service, Art. 17 GDPR) ---

  deleteAccountBtn.addEventListener("click", function () {
    if (!confirm(I18N.t("settings.deleteAccountConfirm"))) return;

    apiFetch("/api/account", { method: "DELETE" })
      .then(function (r) {
        if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.failedToDeleteAccount"));
        settingsModal.close();
        clearAuthState();
        disconnectAllConsoles();
        servers = [];
        showLoginView();
      })
      .catch(function (err) { alert(err.message); });
  });

  // --- add-server modal + tabs ---

  function openAddModal() {
    addModal.showModal();
  }

  addServerBtn.addEventListener("click", openAddModal);
  emptyAddBtn.addEventListener("click", openAddModal);
  addClose.addEventListener("click", function () { addModal.close(); });
  addModal.addEventListener("click", function (e) {
    if (e.target === addModal) addModal.close();
  });

  addTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      addTabs.forEach(function (t) {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      addTabPanels.forEach(function (panel) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      });
    });
  });

  // --- server state ---

  function loadServers() {
    return apiFetch("/api/servers", { method: "GET" })
      .then(function (r) {
        if (!r.ok) throw new Error(I18N.t("errors.failedToLoadServers"));
        return r.json();
      })
      .then(function (list) {
        servers = list || [];
        renderServers();
      });
  }

  function findServer(id) {
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].id === id) return servers[i];
    }
    return null;
  }

  function removeServer(id) {
    apiFetch("/api/servers/" + id, { method: "DELETE" })
      .then(function (r) {
        if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.failedToRemoveServer"));
        servers = servers.filter(function (s) { return s.id !== id; });
        if (consoles[id]) closeConsoleFor(id);
        renderServers();
      })
      .catch(function (err) { alert(err.message); });
  }

  function serverMeta(server) {
    var parts = [];
    if (server.game) parts.push(server.game);
    if (server.protocol === "webrcon") parts.push("WebRCON");
    parts.push(server.host + ":" + server.port);
    return parts.join(" · ");
  }

  function renderServers() {
    serverGrid.innerHTML = "";
    emptyState.hidden = servers.length > 0;
    serverGrid.hidden = servers.length === 0;

    servers.forEach(function (server) {
      var card = document.createElement("article");
      card.className = "server-card";

      var main = document.createElement("div");
      var h3 = document.createElement("h3");
      if (consoles[server.id]) {
        var dot = document.createElement("span");
        dot.className = "connected-dot";
        dot.title = I18N.t("servers.connectedTooltip");
        h3.appendChild(dot);
      }
      h3.appendChild(document.createTextNode(server.name));
      main.appendChild(h3);
      var meta = document.createElement("p");
      meta.className = "server-meta";
      meta.textContent = serverMeta(server);
      main.appendChild(meta);
      card.appendChild(main);

      var actions = document.createElement("div");
      actions.className = "server-card-actions";

      if (!server.has_password) {
        var pwInput = document.createElement("input");
        pwInput.type = "password";
        pwInput.placeholder = I18N.t("common.rconPassword");
        pwInput.autocomplete = "off";
        pwInput.setAttribute("aria-label", I18N.t("servers.rconPasswordAriaLabel", { name: server.name }));
        actions.appendChild(pwInput);

        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.className = "btn-primary";
        saveBtn.textContent = I18N.t("common.save");
        saveBtn.addEventListener("click", function () {
          apiFetch("/api/servers/" + server.id + "/password", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pwInput.value }),
          })
            .then(function (r) {
              if (!r.ok) throw new Error(I18N.t("errors.failedToSavePassword"));
              server.has_password = true;
              renderServers();
            })
            .catch(function (err) { alert(err.message); });
        });
        actions.appendChild(saveBtn);
      } else {
        var connectBtn = document.createElement("button");
        connectBtn.type = "button";
        connectBtn.className = "btn-primary";
        connectBtn.textContent = consoles[server.id] ? I18N.t("servers.openConsole") : I18N.t("servers.connect");
        connectBtn.addEventListener("click", function () { openOrFocusConsole(server); });
        actions.appendChild(connectBtn);
      }

      var removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "icon-btn small";
      removeBtn.title = I18N.t("common.remove");
      removeBtn.setAttribute("aria-label", I18N.t("servers.removeAriaLabel", { name: server.name }));
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () { removeServer(server.id); });
      actions.appendChild(removeBtn);

      card.appendChild(actions);
      serverGrid.appendChild(card);
    });
  }

  // --- Nitrado sync ---

  nitradoForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var token = nitradoTokenInput.value.trim();
    if (!token) return;

    apiFetch("/api/nitrado/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
        return r.json();
      })
      .then(function (list) {
        servers = list || [];
        renderServers();
        addModal.close();
      })
      .catch(function (err) {
        alert(I18N.t("errors.nitradoSyncFailed", { message: err.message }));
      })
      .finally(function () {
        // The token was only ever needed for this one request.
        nitradoTokenInput.value = "";
      });
  });

  // --- manual add ---

  manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = document.getElementById("manual-name").value;
    var host = document.getElementById("manual-host").value;
    var port = parseInt(document.getElementById("manual-port").value, 10);
    var password = document.getElementById("manual-password").value;
    var protocol = document.getElementById("manual-protocol").value;

    apiFetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, host: host, port: port, password: password, protocol: protocol }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t); });
        return r.json();
      })
      .then(function (srv) {
        servers.push(srv);
        renderServers();
        manualForm.reset();
        addModal.close();
      })
      .catch(function (err) { alert(I18N.t("errors.couldNotAddServer", { message: err.message })); });
  });

  // --- view switching ---
  // Going back to the server list never closes any open console — it just
  // switches which view is visible. Multiple consoles can stay connected
  // in the background at once.

  function showLoginView() {
    if (infoModal.open) infoModal.close();
    viewConsole.hidden = true;
    viewServers.hidden = true;
    viewRegister.hidden = true;
    viewAdmin.hidden = true;
    viewLogin.hidden = false;
    usernameLabel.hidden = true;
    logoutBtn.hidden = true;
    adminNavBtn.hidden = true;
    accountDangerZone.hidden = true;
  }

  function showRegisterView() {
    if (infoModal.open) infoModal.close();
    viewConsole.hidden = true;
    viewServers.hidden = true;
    viewLogin.hidden = true;
    registerError.hidden = true;
    viewRegister.hidden = false;
  }

  function showServersView() {
    if (infoModal.open) infoModal.close();
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewConsole.hidden = true;
    viewAdmin.hidden = true;
    viewServers.hidden = false;
    usernameLabel.hidden = false;
    usernameLabel.textContent = currentUsername;
    logoutBtn.hidden = false;
    adminNavBtn.hidden = !currentIsAdmin;
    accountDangerZone.hidden = false;
    renderServers();
  }

  backBtn.addEventListener("click", showServersView);

  // --- admin panel ---

  function showAdminView() {
    if (infoModal.open) infoModal.close();
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewServers.hidden = true;
    viewConsole.hidden = true;
    viewAdmin.hidden = false;
  }

  adminBackBtn.addEventListener("click", showServersView);

  adminNavBtn.addEventListener("click", function () {
    loadAdminUsers();
    showAdminView();
  });

  function loadAdminUsers() {
    return apiFetch("/api/admin/users", { method: "GET" })
      .then(function (r) {
        if (!r.ok) throw new Error(I18N.t("errors.adminLoadFailed"));
        return r.json();
      })
      .then(function (users) {
        renderAdminUsers(users || []);
      })
      .catch(function (err) { alert(err.message); });
  }

  function renderAdminUsers(users) {
    adminUsersBody.innerHTML = "";
    users.forEach(function (u) {
      var tr = document.createElement("tr");

      var usernameTd = document.createElement("td");
      usernameTd.textContent = u.username;
      tr.appendChild(usernameTd);

      var createdTd = document.createElement("td");
      createdTd.textContent = new Date(u.created_at).toLocaleDateString();
      tr.appendChild(createdTd);

      var serversTd = document.createElement("td");
      serversTd.textContent = String(u.server_count);
      tr.appendChild(serversTd);

      var roleTd = document.createElement("td");
      if (u.is_admin) {
        var badge = document.createElement("span");
        badge.className = "admin-badge";
        badge.textContent = I18N.t("admin.roleAdmin");
        roleTd.appendChild(badge);
      }
      tr.appendChild(roleTd);

      var actionsTd = document.createElement("td");
      actionsTd.className = "admin-actions";

      var regenBtn = document.createElement("button");
      regenBtn.type = "button";
      regenBtn.className = "btn-secondary";
      regenBtn.textContent = I18N.t("admin.regenerateCode");
      regenBtn.addEventListener("click", function () {
        apiFetch("/api/admin/users/" + u.id + "/recovery-code", { method: "POST" })
          .then(function (r) {
            if (!r.ok) throw new Error(I18N.t("errors.adminRegenerateFailed"));
            return r.json();
          })
          .then(function (data) {
            showRecoveryCodeModal(data.recovery_code, function () { /* stays on the admin view */ });
          })
          .catch(function (err) { alert(err.message); });
      });
      actionsTd.appendChild(regenBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-secondary btn-danger";
      deleteBtn.textContent = I18N.t("admin.delete");
      deleteBtn.addEventListener("click", function () {
        if (!confirm(I18N.t("admin.confirmDelete", { username: u.username }))) return;
        apiFetch("/api/admin/users/" + u.id, { method: "DELETE" })
          .then(function (r) {
            if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.adminDeleteFailed"));
            loadAdminUsers();
          })
          .catch(function (err) { alert(err.message); });
      });
      actionsTd.appendChild(deleteBtn);

      tr.appendChild(actionsTd);
      adminUsersBody.appendChild(tr);
    });
  }

  // --- console (multiple, tabbed) ---

  function openOrFocusConsole(server) {
    if (!consoles[server.id]) createConsole(server);
    activeConsoleId = server.id;
    viewServers.hidden = true;
    viewConsole.hidden = false;
    renderConsoleTabs();
    renderActiveConsole();
  }

  function createConsole(server) {
    var c = {
      server: server,
      socket: null,
      lines: [],
      pendingPlayersRequest: false,
      authenticated: false,
    };
    consoles[server.id] = c;
    appendConsoleLine(c, "system", I18N.t("console.connecting"));

    var socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    c.socket = socket;

    socket.addEventListener("open", function () {
      socket.send(JSON.stringify({ type: "auth", token: authToken }));
    });

    socket.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        appendConsoleLine(c, "error", I18N.t("console.couldNotParseMessage"));
        refreshIfActive(c);
        return;
      }

      if (msg.type === "authenticated") {
        c.authenticated = true;
        socket.send(JSON.stringify({ type: "connect", server_id: server.id }));
      } else if (msg.type === "connected") {
        appendConsoleLine(c, "system", I18N.t("console.connected"));
      } else if (msg.type === "response") {
        appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : I18N.t("console.noOutput"));
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          renderPlayersPanel(msg.output || "");
        }
      } else if (msg.type === "broadcast") {
        // WebRCON servers (Rust) push chat/log lines unsolicited.
        appendConsoleLine(c, "broadcast", msg.output || "");
      } else if (msg.type === "error") {
        appendConsoleLine(c, "error", msg.message);
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          if (activeConsoleId === server.id) playersPanel.innerHTML = "";
        }
      }
      refreshIfActive(c);
    });

    socket.addEventListener("close", function () {
      appendConsoleLine(c, "system", I18N.t("console.disconnected"));
      refreshIfActive(c);
      if (viewServers.hidden === false) renderServers();
    });

    socket.addEventListener("error", function () {
      appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      refreshIfActive(c);
    });
  }

  function closeConsoleFor(id) {
    var c = consoles[id];
    if (!c) return;
    if (c.socket) c.socket.close();
    delete consoles[id];
    renderConsoleTabs();

    if (activeConsoleId === id) {
      var remaining = Object.keys(consoles);
      if (remaining.length) {
        activeConsoleId = remaining[0];
        renderConsoleTabs();
        renderActiveConsole();
      } else {
        activeConsoleId = null;
        showServersView();
      }
    }
  }

  function appendConsoleLine(c, kind, text) {
    c.lines.push({ kind: kind, text: text });
  }

  function refreshIfActive(c) {
    if (activeConsoleId === c.server.id) renderActiveConsole();
  }

  function renderConsoleTabs() {
    consoleTabs.innerHTML = "";
    Object.keys(consoles).forEach(function (id) {
      var c = consoles[id];
      var tab = document.createElement("button");
      tab.type = "button";
      tab.className = "console-tab" + (id === String(activeConsoleId) ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", id === String(activeConsoleId) ? "true" : "false");
      tab.addEventListener("click", function () {
        activeConsoleId = c.server.id;
        renderConsoleTabs();
        renderActiveConsole();
      });

      tab.appendChild(document.createTextNode(c.server.name));

      var closeBtn = document.createElement("span");
      closeBtn.className = "tab-close";
      closeBtn.textContent = "×";
      closeBtn.setAttribute("role", "button");
      closeBtn.setAttribute("aria-label", "Disconnect " + c.server.name);
      closeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        closeConsoleFor(c.server.id);
      });
      tab.appendChild(closeBtn);

      consoleTabs.appendChild(tab);
    });
  }

  function renderActiveConsole() {
    var c = consoles[activeConsoleId];
    if (!c) return;
    consoleTitle.textContent = c.server.name;
    consoleBadge.textContent = serverMeta(c.server);
    gameSelect.value = window.NICON_GUESS_GAME(c.server.game);
    renderLog(c);
  }

  // --- console log: filtering + highlighting ---

  function activeFilterRegex() {
    var text = filterInput.value.trim();
    if (!text) return null;
    try {
      return new RegExp(text, "i");
    } catch (e) {
      return null; // invalid regex mid-typing — just show everything
    }
  }

  function renderLog(c) {
    log.innerHTML = "";
    var regex = activeFilterRegex();

    c.lines.forEach(function (line) {
      if (regex && !regex.test(line.text)) return;
      var div = document.createElement("div");
      div.className = "log-line kind-" + line.kind;
      appendHighlighted(div, line.text, regex);
      log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
  }

  // Appends text to container as plain text, except for regex matches,
  // which are wrapped in <mark>. Built with DOM nodes (never innerHTML
  // with raw content) so console output can never be interpreted as HTML.
  function appendHighlighted(container, text, regex) {
    if (!regex) {
      container.appendChild(document.createTextNode(text));
      return;
    }
    var global = new RegExp(regex.source, "gi");
    var lastIndex = 0;
    var match;
    while ((match = global.exec(text)) !== null) {
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      var mark = document.createElement("mark");
      mark.textContent = match[0];
      container.appendChild(mark);
      lastIndex = match.index + match[0].length;
      if (match[0].length === 0) global.lastIndex++; // guard against zero-length match loops
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  filterInput.addEventListener("input", function () {
    var c = consoles[activeConsoleId];
    if (c) renderLog(c);
  });

  // --- players info modal ---

  infoBtn.addEventListener("click", function () { infoModal.showModal(); });
  infoClose.addEventListener("click", function () { infoModal.close(); });
  infoModal.addEventListener("click", function (e) {
    if (e.target === infoModal) infoModal.close();
  });

  function renderPlayersPanel(rawOutput) {
    playersPanel.innerHTML = "";
    var key = gameSelect.value;
    if (!key) return;

    var game = window.NICON_GAMES[key];
    var parsed = game.parse(rawOutput);
    if (!parsed) {
      var notice = document.createElement("p");
      notice.className = "hint";
      notice.textContent = I18N.t("info.couldNotParse", { game: game.label });
      playersPanel.appendChild(notice);
      return;
    }

    var summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = parsed.summary;
    playersPanel.appendChild(summary);

    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    parsed.columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    parsed.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell) {
        var td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    playersPanel.appendChild(table);
  }

  playersBtn.addEventListener("click", function () {
    var c = consoles[activeConsoleId];
    if (!c || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    var key = gameSelect.value;
    if (!key) return;
    var command = window.NICON_GAMES[key].command;
    c.pendingPlayersRequest = true;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
  });

  // --- command bar ---

  cmdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var c = consoles[activeConsoleId];
    var command = cmdInput.value.trim();
    if (!command || !c || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
    cmdInput.value = "";
  });

  // --- boot ---

  I18N.applyStatic(document);
  checkApi();
  checkRelay();
  if (authToken) {
    loadServers()
      .then(function () { showServersView(); })
      .catch(function () { /* apiFetch already routes 401s to sessionExpired() */ });
  } else {
    showLoginView();
  }
})();
