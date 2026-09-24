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
  var searchQuery = "";

  // One entry per currently-open console: serverId -> { server, socket,
  // lines: [{kind, text}], pendingPlayersRequest, authenticated }. A
  // server can be selected in the sidebar without a console entry (not
  // connected yet, or missing a saved password).
  var consoles = {};
  var selectedServerId = null;

  // --- element refs ---

  var apiPill = document.getElementById("api-pill");
  var apiBanner = document.getElementById("api-banner");
  var apiBannerSettingsBtn = document.getElementById("api-banner-settings-btn");
  var apiForm = document.getElementById("api-form");
  var apiUrlInput = document.getElementById("api-url");

  var relayPill = document.getElementById("relay-pill");
  var relayBanner = document.getElementById("relay-banner");
  var bannerSettingsBtn = document.getElementById("banner-settings-btn");
  var relayForm = document.getElementById("relay-form");
  var relayUrlInput = document.getElementById("relay-url");

  var usernameLabel = document.getElementById("username-label");
  var logoutBtn = document.getElementById("logout-btn");
  var langWidget = document.getElementById("lang-widget");
  var langCurrentBtn = document.getElementById("lang-current");
  var langCurrentFlag = document.getElementById("lang-current-flag");
  var langCurrentName = document.getElementById("lang-current-name");
  var langOptions = document.getElementById("lang-options");

  var navServersBtn = document.getElementById("nav-servers-btn");
  var navSettingsBtn = document.getElementById("nav-settings-btn");
  var adminNavBtn = document.getElementById("admin-nav-btn");
  var addServerBtn = document.getElementById("add-server-btn");

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

  var viewApp = document.getElementById("view-app");
  var serverSearch = document.getElementById("server-search");
  var serverList = document.getElementById("server-list");

  var contentEmpty = document.getElementById("content-empty");
  var contentEmptyText = document.getElementById("content-empty-text");
  var emptyAddBtn = document.getElementById("empty-add-btn");
  var contentPassword = document.getElementById("content-password");
  var passwordServerName = document.getElementById("password-server-name");
  var passwordForm = document.getElementById("password-form");
  var passwordInput = document.getElementById("password-input");
  var contentConsole = document.getElementById("content-console");
  var head = document.getElementById("head");

  var viewSettings = document.getElementById("view-settings");
  var accountCard = document.getElementById("account-card");
  var accountDangerZone = document.getElementById("account-danger-zone");
  var deleteAccountBtn = document.getElementById("delete-account-btn");

  var viewAdmin = document.getElementById("view-admin");
  var adminUsersBody = document.getElementById("admin-users-body");

  var addModal = document.getElementById("add-modal");
  var addClose = document.getElementById("add-close");
  var addTabs = document.querySelectorAll(".tab");
  var addTabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var manualForm = document.getElementById("manual-form");

  var filterInput = document.getElementById("filter-input");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");
  var cmdSendBtn = cmdForm.querySelector("button[type=submit]");

  var playersPanel = document.getElementById("players-panel");

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
  });

  // --- relay address + status ---
  // Only used for the actual WebSocket<->RCON bridge (createConsole
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
  });

  // --- language ---
  // A custom dropdown rather than a native <select> — the language name is
  // shown in full, in its own language, with a flag, none of which a plain
  // <option> can render (and native option-list styling doesn't reliably
  // pick up the page's dark theme either).

  function findLanguage(code) {
    for (var i = 0; i < I18N.LANGUAGES.length; i++) {
      if (I18N.LANGUAGES[i].code === code) return I18N.LANGUAGES[i];
    }
    return I18N.LANGUAGES[0];
  }

  function renderLangCurrent() {
    var lang = findLanguage(I18N.getLang());
    langCurrentFlag.textContent = lang.flag;
    langCurrentName.textContent = lang.name;
  }

  function renderLangOptions() {
    langOptions.innerHTML = "";
    I18N.LANGUAGES.forEach(function (lang) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(lang.code === I18N.getLang()));
      li.dataset.lang = lang.code;

      var flag = document.createElement("span");
      flag.className = "flag";
      flag.setAttribute("aria-hidden", "true");
      flag.textContent = lang.flag;
      li.appendChild(flag);
      li.appendChild(document.createTextNode(lang.name));

      li.addEventListener("click", function () {
        I18N.setLang(lang.code);
        closeLangOptions();
      });
      langOptions.appendChild(li);
    });
  }

  function openLangOptions() {
    renderLangOptions();
    langOptions.hidden = false;
    langCurrentBtn.setAttribute("aria-expanded", "true");
  }

  function closeLangOptions() {
    langOptions.hidden = true;
    langCurrentBtn.setAttribute("aria-expanded", "false");
  }

  langCurrentBtn.addEventListener("click", function () {
    if (langOptions.hidden) openLangOptions();
    else closeLangOptions();
  });
  document.addEventListener("click", function (e) {
    if (!langOptions.hidden && !langWidget.contains(e.target)) closeLangOptions();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !langOptions.hidden) closeLangOptions();
  });

  renderLangCurrent();

  document.addEventListener("nicon:langchange", function () {
    // Static text re-renders itself via data-i18n attributes; anything
    // built from JS strings (sidebar rows, console content already on
    // screen) needs an explicit re-render.
    renderLangCurrent();
    renderServers();
    renderContent();
  });

  apiPill.addEventListener("click", showSettingsView);
  relayPill.addEventListener("click", showSettingsView);
  bannerSettingsBtn.addEventListener("click", showSettingsView);
  apiBannerSettingsBtn.addEventListener("click", showSettingsView);
  navSettingsBtn.addEventListener("click", showSettingsView);

  // The brand mark doubles as a "home" link — the only way back from the
  // (always-reachable) settings page when signed out, and a quick way
  // back to the server list from anywhere when signed in.
  document.querySelector(".wordmark").addEventListener("click", function () {
    if (authToken) showAppView();
    else showLoginView();
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
    selectedServerId = null;
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
        showAppView();
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
            .then(showAppView)
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
        renderContent();
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
        if (consoles[id]) {
          if (consoles[id].socket) consoles[id].socket.close();
          delete consoles[id];
        }
        if (selectedServerId === id) {
          selectedServerId = null;
          stopPlayersAutoRefresh();
        }
        renderServers();
        renderContent();
      })
      .catch(function (err) { alert(err.message); });
  }

  function serverMeta(server) {
    var parts = [];
    if (server.game) parts.push(server.game);
    if (server.protocol === "webrcon") parts.push(I18N.t("common.webrcon"));
    parts.push(server.host + ":" + server.port);
    return parts.join(" · ");
  }

  // --- sidebar: search + server list ---

  serverSearch.addEventListener("input", function () {
    searchQuery = serverSearch.value;
    renderServers();
  });

  function filteredServers() {
    var q = searchQuery.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(function (s) {
      return s.name.toLowerCase().indexOf(q) !== -1 || (s.game || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderServers() {
    serverList.innerHTML = "";
    var list = filteredServers();

    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = servers.length ? I18N.t("servers.noSearchResults") : I18N.t("servers.emptyTitle");
      serverList.appendChild(empty);
      return;
    }

    list.forEach(function (server) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "server-row";
      row.setAttribute("aria-current", String(server.id === selectedServerId));

      var nameLine = document.createElement("span");
      nameLine.className = "name";
      var dot = document.createElement("span");
      dot.className = "dot " + (consoles[server.id] ? "on" : "off");
      if (consoles[server.id]) dot.title = I18N.t("servers.connectedTooltip");
      nameLine.appendChild(dot);
      nameLine.appendChild(document.createTextNode(server.name));
      row.appendChild(nameLine);

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = serverMeta(server);
      row.appendChild(meta);

      row.addEventListener("click", function () { selectServer(server.id); });
      serverList.appendChild(row);
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
        renderContent();
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
        renderContent();
        manualForm.reset();
        addModal.close();
      })
      .catch(function (err) { alert(I18N.t("errors.couldNotAddServer", { message: err.message })); });
  });

  // --- view switching ---
  // Selecting a server never closes any other open console — it just
  // changes which one is shown. Multiple consoles can stay connected in
  // the background at once; switching views (Servers/Settings/Admin)
  // doesn't touch them either.

  function setActiveNav(btn) {
    [navServersBtn, navSettingsBtn, adminNavBtn].forEach(function (b) {
      if (b === btn) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
  }

  function showLoginView() {
    stopPlayersAutoRefresh();
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewRegister.hidden = true;
    viewAdmin.hidden = true;
    viewLogin.hidden = false;
    usernameLabel.hidden = true;
    logoutBtn.hidden = true;
    navServersBtn.hidden = true;
    adminNavBtn.hidden = true;
    addServerBtn.hidden = true;
    accountDangerZone.hidden = true;
    accountCard.hidden = true;
  }

  function showRegisterView() {
    stopPlayersAutoRefresh();
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewLogin.hidden = true;
    registerError.hidden = true;
    viewRegister.hidden = false;
  }

  function showAppView() {
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewSettings.hidden = true;
    viewAdmin.hidden = true;
    viewApp.hidden = false;
    usernameLabel.hidden = false;
    usernameLabel.textContent = currentUsername;
    logoutBtn.hidden = false;
    navServersBtn.hidden = false;
    adminNavBtn.hidden = !currentIsAdmin;
    addServerBtn.hidden = false;
    accountDangerZone.hidden = false;
    accountCard.hidden = false;
    setActiveNav(navServersBtn);
    renderServers();
    renderContent();
    if (selectedServerId !== null && isConnected(selectedServerId)) startPlayersAutoRefresh(consoles[selectedServerId]);
  }

  navServersBtn.addEventListener("click", showAppView);

  function showSettingsView() {
    stopPlayersAutoRefresh();
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewApp.hidden = true;
    viewAdmin.hidden = true;
    viewSettings.hidden = false;
    addServerBtn.hidden = true;
    if (authToken) setActiveNav(navSettingsBtn);
  }

  // --- admin panel ---

  function showAdminView() {
    stopPlayersAutoRefresh();
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewAdmin.hidden = false;
    addServerBtn.hidden = true;
    setActiveNav(adminNavBtn);
  }

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

  // --- server selection + detail pane ---

  // A console entry, once created, stays around for the session (so its
  // log history survives a manual disconnect) — "connected" is a
  // question about the socket's readyState, not whether the entry exists.
  function isConnected(id) {
    var c = consoles[id];
    return !!(c && c.socket && (c.socket.readyState === WebSocket.OPEN || c.socket.readyState === WebSocket.CONNECTING));
  }

  function selectServer(id) {
    stopPlayersAutoRefresh();
    selectedServerId = id;
    var server = findServer(id);
    if (server && server.has_password) {
      if (!isConnected(id)) {
        ensureConsole(server); // players auto-refresh starts once "connected" arrives
      } else {
        startPlayersAutoRefresh(consoles[id]);
      }
    }
    renderServers();
    renderContent();
  }

  // --- password entry (server has no saved RCON password yet) ---

  passwordForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var server = findServer(selectedServerId);
    if (!server) return;
    apiFetch("/api/servers/" + server.id + "/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error(I18N.t("errors.failedToSavePassword"));
        server.has_password = true;
        passwordInput.value = "";
        ensureConsole(server);
        renderServers();
        renderContent();
      })
      .catch(function (err) { alert(err.message); });
  });

  // --- content pane rendering ---

  function renderContent() {
    var server = findServer(selectedServerId);
    if (!server) selectedServerId = null;

    contentEmpty.hidden = !!server;
    contentPassword.hidden = true;
    contentConsole.hidden = true;

    if (!server) {
      contentEmptyText.textContent = servers.length ? I18N.t("content.selectPrompt") : I18N.t("servers.emptyTitle");
      emptyAddBtn.hidden = servers.length > 0;
      return;
    }

    if (!server.has_password) {
      contentPassword.hidden = false;
      passwordServerName.textContent = server.name;
      return;
    }

    contentConsole.hidden = false;
    renderHead(server);
    renderLog(consoles[server.id]);
    renderPlayersPanel(consoles[server.id]);
    updateCmdBarState();
  }

  function renderHead(server) {
    head.innerHTML = "";

    var h1 = document.createElement("h1");
    var dot = document.createElement("span");
    dot.className = "dot " + (isConnected(server.id) ? "on" : "off");
    h1.appendChild(dot);
    h1.appendChild(document.createTextNode(server.name));
    head.appendChild(h1);

    var protoTag = document.createElement("span");
    protoTag.className = "tag tag-outline";
    protoTag.textContent = server.protocol === "webrcon" ? I18N.t("addModal.protocolWebrcon") : I18N.t("common.protocolSource");
    head.appendChild(protoTag);

    if (server.source === "nitrado") {
      var nitradoTag = document.createElement("span");
      nitradoTag.className = "tag tag-nitrado";
      nitradoTag.textContent = I18N.t("common.nitrado");
      head.appendChild(nitradoTag);
    }

    var hostTag = document.createElement("span");
    hostTag.className = "tag tag-neutral mono";
    hostTag.textContent = server.host + ":" + server.port;
    head.appendChild(hostTag);

    var actions = document.createElement("div");
    actions.className = "head-actions";

    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "btn-secondary";
    if (isConnected(server.id)) {
      toggleBtn.textContent = I18N.t("content.disconnect");
      toggleBtn.addEventListener("click", function () {
        stopPlayersAutoRefresh();
        if (consoles[server.id] && consoles[server.id].socket) consoles[server.id].socket.close();
        renderServers();
        renderContent();
      });
    } else {
      toggleBtn.textContent = I18N.t("servers.connect");
      toggleBtn.addEventListener("click", function () {
        ensureConsole(server);
        renderServers();
        renderContent();
      });
    }
    actions.appendChild(toggleBtn);

    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-secondary btn-danger";
    removeBtn.textContent = I18N.t("common.remove");
    removeBtn.setAttribute("aria-label", I18N.t("servers.removeAriaLabel", { name: server.name }));
    removeBtn.addEventListener("click", function () { removeServer(server.id); });
    actions.appendChild(removeBtn);

    head.appendChild(actions);
  }

  function updateCmdBarState() {
    var c = consoles[selectedServerId];
    var ready = !!(c && c.socket && c.socket.readyState === WebSocket.OPEN);
    cmdSendBtn.disabled = !ready;
  }

  // --- console (background sockets keyed by server id) ---
  // An entry, once created, is kept around for the whole session so its
  // log history survives a manual disconnect — reconnecting reuses the
  // same entry and appends to the same log instead of starting fresh.

  function ensureConsole(server) {
    var c = consoles[server.id];
    if (!c) {
      c = {
        server: server,
        socket: null,
        lines: [],
        pendingPlayersRequest: false,
        authenticated: false,
        gameKey: window.NICON_GUESS_GAME(server.game),
        lastParsed: null,
      };
      consoles[server.id] = c;
    }
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
        renderServers();
        if (selectedServerId === server.id) startPlayersAutoRefresh(c);
      } else if (msg.type === "response") {
        appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : I18N.t("console.noOutput"));
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          var game = window.NICON_GAMES[c.gameKey];
          var parsed = game.parse(msg.output || "");
          c.lastParsed = parsed
            ? { ok: true, summary: parsed.summary, columns: parsed.columns, players: parsed.players }
            : { ok: false };
          if (selectedServerId === server.id) renderPlayersPanel(c);
        }
      } else if (msg.type === "broadcast") {
        // WebRCON servers (Rust) push chat/log lines unsolicited.
        appendConsoleLine(c, "broadcast", msg.output || "");
      } else if (msg.type === "error") {
        appendConsoleLine(c, "error", msg.message);
        c.pendingPlayersRequest = false;
      }
      refreshIfActive(c);
    });

    socket.addEventListener("close", function () {
      appendConsoleLine(c, "system", I18N.t("console.disconnected"));
      renderServers();
      if (selectedServerId === server.id) {
        stopPlayersAutoRefresh();
        renderContent();
      }
    });

    socket.addEventListener("error", function () {
      appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      refreshIfActive(c);
    });
  }

  function appendConsoleLine(c, kind, text) {
    c.lines.push({ kind: kind, text: text });
  }

  function refreshIfActive(c) {
    if (selectedServerId === c.server.id) {
      renderLog(c);
      updateCmdBarState();
    }
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
    if (!c) return;
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
    renderLog(consoles[selectedServerId]);
  });

  // --- players card (inline, next to the console) ---
  // Auto-detected from the server's game, auto-fetched on connect/select,
  // and kept fresh with a background poll while that server is the one
  // being viewed — no manual game picker or refresh button.

  var PLAYERS_REFRESH_MS = 10000;
  var activePlayersTimer = null;

  function stopPlayersAutoRefresh() {
    if (activePlayersTimer) {
      clearInterval(activePlayersTimer);
      activePlayersTimer = null;
    }
  }

  function startPlayersAutoRefresh(c) {
    stopPlayersAutoRefresh();
    if (!c) return;
    requestPlayers(c);
    activePlayersTimer = setInterval(function () { requestPlayers(c); }, PLAYERS_REFRESH_MS);
  }

  function requestPlayers(c) {
    if (!c.gameKey) {
      if (selectedServerId === c.server.id) renderPlayersPanel(c);
      return;
    }
    if (!c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    var game = window.NICON_GAMES[c.gameKey];
    c.pendingPlayersRequest = true;
    appendConsoleLine(c, "sent", "> " + game.command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: game.command }));
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

  function playersHint(text) {
    playersPanel.innerHTML = "";
    var notice = document.createElement("p");
    notice.className = "hint";
    notice.textContent = text;
    playersPanel.appendChild(notice);
  }

  function renderPlayersPanel(c) {
    playersPanel.innerHTML = "";
    if (!c) return;
    if (!c.gameKey) {
      playersHint(I18N.t("info.genericOption"));
      return;
    }
    if (!c.lastParsed) return; // waiting on the first response

    var game = window.NICON_GAMES[c.gameKey];
    if (!c.lastParsed.ok) {
      playersHint(I18N.t("info.couldNotParse", { game: game.label }));
      return;
    }

    var summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = c.lastParsed.summary;
    playersPanel.appendChild(summary);

    var players = c.lastParsed.players;
    if (!players.length) return;

    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var columns = c.lastParsed.columns;
    columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = columnLabel(col);
      headRow.appendChild(th);
    });
    headRow.appendChild(document.createElement("th"));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    players.forEach(function (player) {
      var tr = document.createElement("tr");
      player.cells.forEach(function (cell) {
        var td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });

      var actionsTd = document.createElement("td");
      actionsTd.className = "player-actions";
      if (player.isAdmin) {
        var rank = document.createElement("span");
        rank.className = "tag tag-rank";
        rank.textContent = I18N.t("admin.roleAdmin");
        actionsTd.appendChild(rank);
      } else {
        var kickCmd = game.kick ? game.kick(player) : null;
        var banCmd = game.ban ? game.ban(player) : null;
        if (kickCmd || banCmd) {
          var row = document.createElement("div");
          row.className = "player-actions-row";
          var label = player.cells[0] || player.id;
          if (kickCmd) row.appendChild(playerActionButton(I18N.t("players.kick"), false, function () {
            sendPlayerAction(c, kickCmd, I18N.t("players.kickConfirm", { name: label }));
          }));
          if (banCmd) row.appendChild(playerActionButton(I18N.t("players.ban"), true, function () {
            sendPlayerAction(c, banCmd, I18N.t("players.banConfirm", { name: label }));
          }));
          actionsTd.appendChild(row);
        }
      }
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    playersPanel.appendChild(table);
  }

  function playerActionButton(text, danger, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-xs" + (danger ? " btn-xs-danger" : "");
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function sendPlayerAction(c, command, confirmMessage) {
    if (!confirm(confirmMessage)) return;
    if (!c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
    setTimeout(function () { requestPlayers(c); }, 1200);
  }

  // --- command bar ---

  cmdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var c = consoles[selectedServerId];
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
      .then(function () { showAppView(); })
      .catch(function () { /* apiFetch already routes 401s to sessionExpired() */ });
  } else {
    showLoginView();
  }
})();
