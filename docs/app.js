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

  var relayPill = document.getElementById("relay-pill");
  var relayBanner = document.getElementById("relay-banner");

  var usernameLabel = document.getElementById("username-label");
  var logoutBtn = document.getElementById("logout-btn");
  var langWidget = document.getElementById("lang-widget");
  var langCurrentBtn = document.getElementById("lang-current");
  var langCurrentFlag = document.getElementById("lang-current-flag");
  var langCurrentName = document.getElementById("lang-current-name");
  var langOptions = document.getElementById("lang-options");

  var navServersBtn = document.getElementById("nav-servers-btn");
  var navHealthBtn = document.getElementById("nav-health-btn");
  var navSettingsBtn = document.getElementById("nav-settings-btn");
  var adminNavBtn = document.getElementById("admin-nav-btn");
  var addServerBtn = document.getElementById("add-server-btn");

  var authShell = document.getElementById("auth-shell");
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
  var supportedGamesList = document.getElementById("supported-games-list");
  var emptyAddBtn = document.getElementById("empty-add-btn");
  var contentPassword = document.getElementById("content-password");
  var passwordServerName = document.getElementById("password-server-name");
  var passwordForm = document.getElementById("password-form");
  var passwordInput = document.getElementById("password-input");
  var contentConsole = document.getElementById("content-console");
  var head = document.getElementById("head");

  var viewSettings = document.getElementById("view-settings");
  var privacyCard = document.getElementById("privacy-card");
  var accountCard = document.getElementById("account-card");
  var accountUsernameLine = document.getElementById("account-username-line");
  var accountDangerZone = document.getElementById("account-danger-zone");
  var deleteAccountBtn = document.getElementById("delete-account-btn");
  var changeUsernameForm = document.getElementById("change-username-form");
  var newUsernameInput = document.getElementById("new-username-input");
  var usernameCurrentPasswordInput = document.getElementById("username-current-password-input");
  var changeUsernameError = document.getElementById("change-username-error");
  var changePasswordForm = document.getElementById("change-password-form");
  var passwordCurrentPasswordInput = document.getElementById("password-current-password-input");
  var newPasswordInput = document.getElementById("new-password-input");
  var newPasswordConfirmInput = document.getElementById("new-password-confirm-input");
  var changePasswordError = document.getElementById("change-password-error");

  var notificationsBellBtn = document.getElementById("notifications-bell-btn");
  var notificationsBadge = document.getElementById("notifications-badge");
  var notificationsModal = document.getElementById("notifications-modal");
  var notificationsClose = document.getElementById("notifications-close");
  var notificationsList = document.getElementById("notifications-list");

  var viewAdmin = document.getElementById("view-admin");
  var adminUsersBody = document.getElementById("admin-users-body");
  var notificationForm = document.getElementById("notification-form");
  var notificationType = document.getElementById("notification-type");
  var notificationMessage = document.getElementById("notification-message");
  var adminNotificationsList = document.getElementById("admin-notifications-list");

  var viewHealth = document.getElementById("view-health");
  var healthBody = document.getElementById("health-body");

  var addModal = document.getElementById("add-modal");
  var addClose = document.getElementById("add-close");
  var addTabs = document.querySelectorAll(".tab");
  var addTabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var nitradoTokenStatus = document.getElementById("nitrado-token-status");
  var forgetNitradoTokenBtn = document.getElementById("forget-nitrado-token-btn");
  var manualForm = document.getElementById("manual-form");

  var filterInput = document.getElementById("filter-input");
  var filterRegexToggle = document.getElementById("filter-regex-toggle");
  var consoleCopyBtn = document.getElementById("console-copy-btn");
  var consoleClearBtn = document.getElementById("console-clear-btn");
  var cmdHistoryBtn = document.getElementById("cmd-history-btn");
  var cmdHistoryPanel = document.getElementById("cmd-history-panel");
  var cmdTemplatesBtn = document.getElementById("cmd-templates-btn");
  var cmdTemplatesPanel = document.getElementById("cmd-templates-panel");
  var cmdTemplatesList = document.getElementById("cmd-templates-list");
  var cmdTemplateAddForm = document.getElementById("cmd-template-add-form");
  var cmdTemplateNameInput = document.getElementById("cmd-template-name-input");
  var cmdTemplateCommandInput = document.getElementById("cmd-template-command-input");
  var cmdTemplateError = document.getElementById("cmd-template-error");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");
  var cmdSendBtn = cmdForm.querySelector("button[type=submit]");

  var quickCmdBar = document.getElementById("quick-cmd-bar");
  var quickCmdModal = document.getElementById("quick-command-modal");
  var quickCmdModalTitle = document.getElementById("quick-command-modal-title");
  var quickCmdModalClose = document.getElementById("quick-command-modal-close");
  var quickCmdModalWarning = document.getElementById("quick-command-modal-warning");
  var quickCmdModalForm = document.getElementById("quick-command-modal-form");
  var quickCmdModalMessage = document.getElementById("quick-command-modal-message");
  var quickCmdModalError = document.getElementById("quick-command-modal-error");
  var quickCmdModalConfirm = document.getElementById("quick-command-modal-confirm");

  var playersPanel = document.getElementById("players-panel");

  // --- cloud API + relay addresses ---
  // Both fixed to this instance's own infrastructure — not user-
  // configurable. Handles sign-in/account/server list (API, HTTPS,
  // always-on) and the actual WebSocket<->RCON bridge (relay) separately;
  // see checkApi()/checkRelay() below for why each gets its own status
  // pill even though neither address can be changed from the UI anymore.

  var API_URL = "https://nicon.mylss.de";
  var RELAY_URL = "https://relay.130.61.8.150.sslip.io";

  function apiHttpUrl() {
    return API_URL;
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

  function relayHttpUrl() {
    return RELAY_URL;
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
    renderSupportedGamesList();
    if (authToken) accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: currentUsername });
  });

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

  // Every handler on the PHP/Go side that fails a request sends
  // {"error": "..."} as the JSON body (see webspace/lib/http.php's
  // nicon_send_error / internal/relay's equivalent) — but the call sites
  // below read the body with r.text() (they need the raw string for the
  // non-JSON-error case, e.g. a proxy's own HTML error page) and used to
  // pass it straight into `new Error(...)`, so a failure surfaced the
  // literal `{"error":"invalid username or password"}` to the user
  // instead of the message inside it. This unwraps that shape when
  // present and otherwise falls back to the raw text unchanged, so a
  // non-JSON error body still displays exactly as before.
  function apiErrorMessage(text) {
    if (!text) return text;
    try {
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch (e) { /* not JSON — fall through to the raw text */ }
    return text;
  }

  // --- toasts + confirm dialog ---
  // Central replacements for window.alert()/window.confirm(): a non-
  // blocking notice stack and a Promise-based modal, used everywhere
  // instead of the native calls. Both live in the DOM from page load
  // (see index.html) rather than being built on demand.
  //
  // toastContainer is a `popover`, not a plain fixed div, specifically so
  // a toast still renders above an already-open <dialog> (e.g. an error
  // from the Nitrado sync form inside the Add Server modal) — the
  // Popover API promotes it into the same top layer dialogs use, which a
  // z-index on a normal element can never reach into. showPopover()/
  // hidePopover() are missing on very old browsers, so both calls are
  // no-ops there (feature-detected below) — the container still shows
  // via its own fixed positioning, just possibly behind an open dialog.

  var toastContainer = document.getElementById("toast-container");

  function showToast(message, type) {
    if (typeof toastContainer.showPopover === "function" && !toastContainer.matches(":popover-open")) {
      try { toastContainer.showPopover(); } catch (e) { /* already showing, or unsupported */ }
    }

    var toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "error");

    var messageEl = document.createElement("span");
    messageEl.className = "toast-message";
    messageEl.textContent = message;
    toast.appendChild(messageEl);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", I18N.t("common.close"));
    closeBtn.textContent = "×";
    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      if (!toastContainer.children.length && typeof toastContainer.hidePopover === "function") {
        try { toastContainer.hidePopover(); } catch (e) { /* already hidden */ }
      }
    }
    closeBtn.addEventListener("click", dismiss);
    toast.appendChild(closeBtn);

    toastContainer.appendChild(toast);
    setTimeout(dismiss, 6000);
    return toast;
  }

  // Promise-based stand-in for window.confirm(): resolves true/false
  // instead of blocking. A <dialog>, like every other modal here, so it
  // stacks correctly (on top) even when opened from inside another
  // already-open dialog, e.g. confirming "forget token" from inside Add
  // Server — window.confirm() used to just float above everything as a
  // native browser dialog; a plain custom overlay wouldn't.
  var confirmDialog = document.getElementById("confirm-dialog");
  var confirmDialogMessage = document.getElementById("confirm-dialog-message");
  var confirmDialogCancel = document.getElementById("confirm-dialog-cancel");
  var confirmDialogOk = document.getElementById("confirm-dialog-ok");
  var pendingConfirmResolve = null;

  function showConfirm(message) {
    confirmDialogMessage.textContent = message;
    confirmDialog.showModal();
    return new Promise(function (resolve) {
      pendingConfirmResolve = resolve;
    });
  }

  confirmDialogCancel.addEventListener("click", function () { confirmDialog.close(); });
  confirmDialogOk.addEventListener("click", function () {
    // Resolve before close() — the 'close' handler below would otherwise
    // also see a pending resolver and settle it a second time as false.
    var resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    confirmDialog.close();
    if (resolve) resolve(true);
  });
  confirmDialog.addEventListener("click", function (e) {
    if (e.target === confirmDialog) confirmDialog.close(); // backdrop click = cancel
  });
  // Covers every other way the dialog can close — Cancel, backdrop click,
  // Escape — as a single "still pending means it wasn't confirmed" fallback.
  confirmDialog.addEventListener("close", function () {
    var resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    if (resolve) resolve(false);
  });

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
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || "sign in failed"); });
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
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || "registration failed"); });
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
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || "reset failed"); });
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

  // --- change username / change password (self-service, current password required) ---

  changeUsernameForm.addEventListener("submit", function (e) {
    e.preventDefault();
    changeUsernameError.hidden = true;

    apiFetch("/api/account/username", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        new_username: newUsernameInput.value.trim(),
        current_password: usernameCurrentPasswordInput.value,
      }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.usernameChangeFailed")); });
        return r.json();
      })
      .then(function (data) {
        currentUsername = data.username;
        try { sessionStorage.setItem(USERNAME_KEY, currentUsername); } catch (err) { /* ignore */ }
        usernameLabel.textContent = currentUsername;
        accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: currentUsername });
        changeUsernameForm.reset();
      })
      .catch(function (err) {
        changeUsernameError.textContent = err.message;
        changeUsernameError.hidden = false;
      });
  });

  changePasswordForm.addEventListener("submit", function (e) {
    e.preventDefault();
    changePasswordError.hidden = true;

    if (newPasswordInput.value !== newPasswordConfirmInput.value) {
      changePasswordError.textContent = I18N.t("errors.passwordMismatch");
      changePasswordError.hidden = false;
      return;
    }

    apiFetch("/api/account/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_password: passwordCurrentPasswordInput.value,
        new_password: newPasswordInput.value,
      }),
    })
      .then(function (r) {
        if (!r.ok && r.status !== 204) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.passwordChangeFailed")); });
        changePasswordForm.reset();
      })
      .catch(function (err) {
        changePasswordError.textContent = err.message;
        changePasswordError.hidden = false;
      });
  });

  // --- account deletion (self-service, Art. 17 GDPR) ---

  deleteAccountBtn.addEventListener("click", function () {
    showConfirm(I18N.t("settings.deleteAccountConfirm")).then(function (ok) {
      if (!ok) return;
      apiFetch("/api/account", { method: "DELETE" })
        .then(function (r) {
          if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.failedToDeleteAccount"));
          clearAuthState();
          disconnectAllConsoles();
          servers = [];
          showLoginView();
        })
        .catch(function (err) { showToast(err.message); });
    });
  });

  // --- account info (currently just: is a Nitrado token already saved?) ---

  var hasNitradoToken = false;

  function loadAccountInfo() {
    return apiFetch("/api/account", { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (data) {
        hasNitradoToken = !!(data && data.has_nitrado_token);
        renderNitradoTokenStatus();
      })
      .catch(function () { /* the sync form still works without this */ });
  }

  function renderNitradoTokenStatus() {
    nitradoTokenStatus.hidden = !hasNitradoToken;
    nitradoTokenInput.required = !hasNitradoToken;
  }

  forgetNitradoTokenBtn.addEventListener("click", function () {
    showConfirm(I18N.t("addModal.forgetTokenConfirm")).then(function (ok) {
      if (!ok) return;
      apiFetch("/api/account/nitrado-token", { method: "DELETE" })
        .then(function (r) {
          if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.forgetTokenFailed"));
          hasNitradoToken = false;
          renderNitradoTokenStatus();
        })
        .catch(function (err) { showToast(err.message); });
    });
  });

  // --- add-server modal + tabs ---

  function openAddModal() {
    loadAccountInfo();
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
        if (serverHealth[id]) {
          delete serverHealth[id]; // no point keeping health history for a server that no longer exists
          saveServerHealth();
        }
        renderServers();
        renderContent();
      })
      .catch(function (err) { showToast(err.message); });
  }

  // The full protocol name shown as a tag in the console head — mirrors
  // the "Add server" protocol dropdown's own option text.
  function protocolLabel(protocol) {
    if (protocol === "webrcon") return I18N.t("addModal.protocolWebrcon");
    if (protocol === "palworld_rest") return I18N.t("addModal.protocolPalworldRest");
    if (protocol === "battleye") return I18N.t("addModal.protocolBattleye");
    return I18N.t("common.protocolSource");
  }

  // A short badge for the sidebar row's meta line — omitted for plain
  // Source RCON, since that's the common default and doesn't need calling
  // out the way the less-common protocols do.
  function protocolBadge(protocol) {
    if (protocol === "webrcon") return I18N.t("common.webrcon");
    if (protocol === "palworld_rest") return I18N.t("common.restApi");
    if (protocol === "battleye") return I18N.t("common.battleye");
    return null;
  }

  function serverMeta(server) {
    var parts = [];
    if (server.game) parts.push(server.game);
    var badge = protocolBadge(server.protocol);
    if (badge) parts.push(badge);
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
      dot.className = "dot " + serverStatusClass(server);
      dot.title = serverStatusTooltip(server);
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", serverStatusTooltip(server));
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
    if (!token && !hasNitradoToken) return; // required attribute already blocks this, belt and suspenders

    apiFetch("/api/nitrado/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token ? { token: token } : {}),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
        return r.json();
      })
      .then(function (list) {
        servers = list || [];
        renderServers();
        renderContent();
        addModal.close();
        if (token) loadAccountInfo(); // a new token was just saved
      })
      .catch(function (err) {
        showToast(I18N.t("errors.nitradoSyncFailed", { message: err.message }));
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
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
        return r.json();
      })
      .then(function (srv) {
        servers.push(srv);
        renderServers();
        renderContent();
        manualForm.reset();
        addModal.close();
      })
      .catch(function (err) { showToast(I18N.t("errors.couldNotAddServer", { message: err.message })); });
  });

  // --- view switching ---
  // Selecting a server never closes any other open console — it just
  // changes which one is shown. Multiple consoles can stay connected in
  // the background at once; switching views (Servers/Settings/Admin)
  // doesn't touch them either.

  function setActiveNav(btn) {
    [navServersBtn, navHealthBtn, navSettingsBtn, adminNavBtn].forEach(function (b) {
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
    viewHealth.hidden = true;
    authShell.hidden = false;
    viewLogin.hidden = false;
    usernameLabel.hidden = true;
    logoutBtn.hidden = true;
    navServersBtn.hidden = true;
    navHealthBtn.hidden = true;
    navSettingsBtn.hidden = true;
    adminNavBtn.hidden = true;
    addServerBtn.hidden = true;
    accountDangerZone.hidden = true;
    accountCard.hidden = true;
    privacyCard.hidden = true;
    notificationsBellBtn.hidden = true;
    if (notificationsModal.open) notificationsModal.close();
  }

  function showRegisterView() {
    stopPlayersAutoRefresh();
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewLogin.hidden = true;
    registerError.hidden = true;
    authShell.hidden = false;
    viewRegister.hidden = false;
    navSettingsBtn.hidden = true;
  }

  function showAppView() {
    authShell.hidden = true;
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewSettings.hidden = true;
    viewAdmin.hidden = true;
    viewHealth.hidden = true;
    viewApp.hidden = false;
    usernameLabel.hidden = false;
    usernameLabel.textContent = currentUsername;
    logoutBtn.hidden = false;
    navServersBtn.hidden = false;
    navHealthBtn.hidden = false;
    navSettingsBtn.hidden = false;
    adminNavBtn.hidden = !currentIsAdmin;
    addServerBtn.hidden = false;
    accountDangerZone.hidden = false;
    accountCard.hidden = false;
    privacyCard.hidden = false;
    accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: currentUsername });
    notificationsBellBtn.hidden = false;
    loadNotifications();
    loadAccountInfo();
    loadCommandTemplates();
    setActiveNav(navServersBtn);
    renderServers();
    renderContent();
    if (selectedServerId !== null && isConnected(selectedServerId)) startPlayersAutoRefresh(consoles[selectedServerId]);
  }

  navServersBtn.addEventListener("click", showAppView);

  function showSettingsView() {
    stopPlayersAutoRefresh();
    authShell.hidden = true;
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewApp.hidden = true;
    viewAdmin.hidden = true;
    viewHealth.hidden = true;
    viewSettings.hidden = false;
    addServerBtn.hidden = true;
    if (authToken) setActiveNav(navSettingsBtn);
  }

  // --- admin panel ---

  function showAdminView() {
    stopPlayersAutoRefresh();
    authShell.hidden = true;
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewHealth.hidden = true;
    viewAdmin.hidden = false;
    addServerBtn.hidden = true;
    setActiveNav(adminNavBtn);
  }

  adminNavBtn.addEventListener("click", function () {
    loadAdminUsers();
    loadAdminNotifications();
    showAdminView();
  });

  // --- server health dashboard ---

  function showHealthView() {
    stopPlayersAutoRefresh();
    authShell.hidden = true;
    viewLogin.hidden = true;
    viewRegister.hidden = true;
    viewApp.hidden = true;
    viewSettings.hidden = true;
    viewAdmin.hidden = true;
    viewHealth.hidden = false;
    addServerBtn.hidden = true;
    setActiveNav(navHealthBtn);
    renderHealth();
  }

  navHealthBtn.addEventListener("click", showHealthView);

  function loadAdminUsers() {
    return apiFetch("/api/admin/users", { method: "GET" })
      .then(function (r) {
        if (!r.ok) throw new Error(I18N.t("errors.adminLoadFailed"));
        return r.json();
      })
      .then(function (users) {
        renderAdminUsers(users || []);
      })
      .catch(function (err) { showToast(err.message); });
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
      } else {
        var noRole = document.createElement("span");
        noRole.className = "hint";
        noRole.textContent = "–";
        roleTd.appendChild(noRole);
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
          .catch(function (err) { showToast(err.message); });
      });
      actionsTd.appendChild(regenBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-secondary btn-danger";
      deleteBtn.textContent = I18N.t("admin.delete");
      deleteBtn.addEventListener("click", function () {
        showConfirm(I18N.t("admin.confirmDelete", { username: u.username })).then(function (ok) {
          if (!ok) return;
          apiFetch("/api/admin/users/" + u.id, { method: "DELETE" })
            .then(function (r) {
              if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.adminDeleteFailed"));
              loadAdminUsers();
            })
            .catch(function (err) { showToast(err.message); });
        });
      });
      actionsTd.appendChild(deleteBtn);

      tr.appendChild(actionsTd);
      adminUsersBody.appendChild(tr);
    });
  }

  // --- admin: notifications (broadcast to every signed-in user) ---

  function loadAdminNotifications() {
    return apiFetch("/api/notifications", { method: "GET" })
      .then(function (r) {
        if (!r.ok) throw new Error(I18N.t("errors.notificationsLoadFailed"));
        return r.json();
      })
      .then(function (list) { renderAdminNotifications(list || []); })
      .catch(function (err) { showToast(err.message); });
  }

  function renderAdminNotifications(list) {
    adminNotificationsList.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = I18N.t("admin.notificationsEmpty");
      adminNotificationsList.appendChild(empty);
      return;
    }
    list.forEach(function (n) {
      var row = document.createElement("div");
      row.className = "admin-notification-row type-" + n.type;

      var tag = document.createElement("span");
      tag.className = "tag tag-neutral";
      tag.textContent = I18N.t("admin.notificationType" + n.type.charAt(0).toUpperCase() + n.type.slice(1));
      row.appendChild(tag);

      var msg = document.createElement("p");
      msg.textContent = n.message;
      row.appendChild(msg);

      var when = document.createElement("span");
      when.className = "hint";
      when.textContent = new Date(n.created_at).toLocaleString();
      row.appendChild(when);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-secondary btn-danger";
      deleteBtn.textContent = I18N.t("admin.delete");
      deleteBtn.addEventListener("click", function () {
        apiFetch("/api/admin/notifications/" + n.id, { method: "DELETE" })
          .then(function (r) {
            if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.notificationDeleteFailed"));
            loadAdminNotifications();
          })
          .catch(function (err) { showToast(err.message); });
      });
      row.appendChild(deleteBtn);

      adminNotificationsList.appendChild(row);
    });
  }

  notificationForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var message = notificationMessage.value.trim();
    if (!message) return;

    apiFetch("/api/admin/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: notificationType.value, message: message }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.notificationCreateFailed")); });
        return r.json();
      })
      .then(function () {
        notificationForm.reset();
        loadAdminNotifications();
      })
      .catch(function (err) { showToast(err.message); });
  });

  // --- notifications (admin-authored, shown to every signed-in user) ---
  // A modal, not an inline banner — pops up once per new notification,
  // and stays reachable afterward via the bell in the topbar. Dismissal
  // is per-browser (localStorage, not server-side): it only controls
  // whether the modal auto-opens again, never removes a notification
  // from the list the bell reopens — "look at it again" has to still
  // show it.

  var DISMISSED_NOTIFICATIONS_KEY = "nicon_dismissed_notifications";
  var lastNotifications = [];

  function dismissedNotificationIds() {
    try {
      return JSON.parse(localStorage.getItem(DISMISSED_NOTIFICATIONS_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function dismissNotification(id) {
    var ids = dismissedNotificationIds();
    if (ids.indexOf(id) === -1) ids.push(id);
    try { localStorage.setItem(DISMISSED_NOTIFICATIONS_KEY, JSON.stringify(ids)); } catch (e) { /* ignore */ }
  }

  function undismissedCount(list) {
    var dismissed = dismissedNotificationIds();
    return list.filter(function (n) { return dismissed.indexOf(n.id) === -1; }).length;
  }

  function loadNotifications() {
    apiFetch("/api/notifications", { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        lastNotifications = list || [];
        renderNotificationsBadge();
        renderNotificationsModal();
        if (undismissedCount(lastNotifications) > 0) notificationsModal.showModal();
      })
      .catch(function () { /* notifications are a nice-to-have, fail silently */ });
  }

  function renderNotificationsBadge() {
    var count = undismissedCount(lastNotifications);
    notificationsBadge.hidden = count === 0;
    notificationsBadge.textContent = String(count);
  }

  function renderNotificationsModal() {
    var dismissed = dismissedNotificationIds();
    notificationsList.innerHTML = "";

    if (!lastNotifications.length) {
      var empty = document.createElement("p");
      empty.className = "notifications-empty";
      empty.textContent = I18N.t("notifications.empty");
      notificationsList.appendChild(empty);
      return;
    }

    lastNotifications.forEach(function (n) {
      var isDismissed = dismissed.indexOf(n.id) !== -1;
      var row = document.createElement("div");
      row.className = "notification-row type-" + n.type + (isDismissed ? " dismissed" : "");

      var tag = document.createElement("span");
      tag.className = "tag tag-neutral";
      tag.textContent = I18N.t("admin.notificationType" + n.type.charAt(0).toUpperCase() + n.type.slice(1));
      row.appendChild(tag);

      var body = document.createElement("div");
      body.className = "notif-body";
      var p = document.createElement("p");
      p.textContent = n.message;
      body.appendChild(p);
      var when = document.createElement("span");
      when.className = "hint";
      when.textContent = new Date(n.created_at).toLocaleString();
      body.appendChild(when);
      row.appendChild(body);

      if (!isDismissed) {
        var closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "icon-btn";
        closeBtn.setAttribute("aria-label", I18N.t("notifications.dismiss"));
        closeBtn.textContent = "×";
        closeBtn.addEventListener("click", function () {
          dismissNotification(n.id);
          renderNotificationsBadge();
          renderNotificationsModal();
        });
        row.appendChild(closeBtn);
      }

      notificationsList.appendChild(row);
    });
  }

  notificationsBellBtn.addEventListener("click", function () {
    renderNotificationsModal();
    notificationsModal.showModal();
  });
  notificationsClose.addEventListener("click", function () { notificationsModal.close(); });
  notificationsModal.addEventListener("click", function (e) {
    if (e.target === notificationsModal) notificationsModal.close();
  });

  // --- server selection + detail pane ---

  // A console entry, once created, stays around for the session (so its
  // log history survives a manual disconnect) — "connected" tracks
  // whether the relay currently has a live connection to the game server
  // itself, not just whether the browser's WebSocket to the relay is
  // open. Those aren't the same thing: the relay tears down the game
  // connection on any command error (e.g. a WebRCON timeout) without
  // closing the browser's WebSocket, and if "connected" were based on
  // the WebSocket alone, the UI would keep believing it's live — and the
  // players auto-refresh would keep polling into "not connected" errors
  // forever instead of stopping.
  function isConnected(id) {
    var c = consoles[id];
    return !!(c && c.gameConnected);
  }

  // Three-state status dot: red (nothing to connect with yet), yellow
  // (ready, but not connected right now), green (a live console).
  function serverStatusClass(server) {
    if (!server.has_password) return "status-missing";
    return isConnected(server.id) ? "status-connected" : "status-ready";
  }

  function serverStatusTooltip(server) {
    if (!server.has_password) return I18N.t("servers.statusMissing");
    return isConnected(server.id) ? I18N.t("servers.connectedTooltip") : I18N.t("servers.statusReady");
  }

  // --- server health dashboard: data ---
  // Per-server connection telemetry for the Health view: the last time
  // its game connection came up, the last error seen (from the relay or
  // the WebSocket itself), and the round-trip latency of its most recent
  // player-list poll — the console's existing 10s auto-refresh
  // (startPlayersAutoRefresh above), re-used rather than adding a new
  // relay message type just to measure this. That poll only runs for
  // whichever server's console is currently open, so latency is only
  // ever known for that one at a time, same limitation the player count
  // itself already has.
  //
  // Kept in localStorage, not the account's own server-side database
  // (unlike Command Templates): it's throwaway telemetry about this one
  // browser's connections, not something that should follow the user to
  // another device, so it doesn't warrant a new API table. It does
  // survive a page reload, though, which a plain in-memory variable
  // wouldn't.
  var HEALTH_STORAGE_KEY = "nicon_health";
  var serverHealth = {}; // { [serverId]: { lastConnectedAt, lastError, lastErrorAt, latencyMs } }

  (function loadServerHealth() {
    try {
      var raw = localStorage.getItem(HEALTH_STORAGE_KEY);
      serverHealth = raw ? JSON.parse(raw) : {};
    } catch (e) {
      serverHealth = {};
    }
  })();

  function saveServerHealth() {
    try {
      localStorage.setItem(HEALTH_STORAGE_KEY, JSON.stringify(serverHealth));
    } catch (e) {
      // Storage full or unavailable (private browsing) — health just
      // won't survive a reload; nothing else in the app depends on it.
    }
  }

  function healthFor(serverId) {
    if (!serverHealth[serverId]) serverHealth[serverId] = {};
    return serverHealth[serverId];
  }

  function recordConnected(serverId) {
    var h = healthFor(serverId);
    h.lastConnectedAt = Date.now();
    h.lastError = null;
    h.lastErrorAt = null;
    saveServerHealth();
    if (!viewHealth.hidden) renderHealth();
  }

  function recordHealthError(serverId, message) {
    var h = healthFor(serverId);
    h.lastError = message;
    h.lastErrorAt = Date.now();
    saveServerHealth();
    if (!viewHealth.hidden) renderHealth();
  }

  function recordLatency(serverId, ms) {
    var h = healthFor(serverId);
    h.latencyMs = ms;
    saveServerHealth();
    if (!viewHealth.hidden) renderHealth();
  }

  function formatHealthTimestamp(ms) {
    if (!ms) return null;
    return new Date(ms).toLocaleString();
  }

  function renderHealth() {
    healthBody.innerHTML = "";
    servers.forEach(function (server) {
      var h = serverHealth[server.id] || {};
      var tr = document.createElement("tr");

      var nameTd = document.createElement("td");
      nameTd.className = "health-server-name";
      nameTd.textContent = server.name;
      tr.appendChild(nameTd);

      var statusTd = document.createElement("td");
      var statusWrap = document.createElement("span");
      statusWrap.className = "health-status";
      var dot = document.createElement("span");
      dot.className = "dot " + serverStatusClass(server);
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", serverStatusTooltip(server));
      statusWrap.appendChild(dot);
      statusWrap.appendChild(document.createTextNode(serverStatusTooltip(server)));
      statusTd.appendChild(statusWrap);
      tr.appendChild(statusTd);

      var connectedTd = document.createElement("td");
      var connectedText = formatHealthTimestamp(h.lastConnectedAt);
      connectedTd.className = connectedText ? "" : "health-muted";
      connectedTd.textContent = connectedText || I18N.t("health.never");
      tr.appendChild(connectedTd);

      var latencyTd = document.createElement("td");
      if (h.latencyMs != null) {
        latencyTd.textContent = h.latencyMs + " ms";
        var latencyHint = document.createElement("span");
        latencyHint.className = "health-timestamp";
        latencyHint.textContent = I18N.t("health.latencyHint");
        latencyTd.appendChild(latencyHint);
      } else {
        latencyTd.className = "health-muted";
        latencyTd.textContent = "—";
      }
      tr.appendChild(latencyTd);

      var errorTd = document.createElement("td");
      if (h.lastError) {
        errorTd.className = "health-error";
        errorTd.textContent = h.lastError;
        var errorWhen = document.createElement("span");
        errorWhen.className = "health-timestamp";
        errorWhen.textContent = formatHealthTimestamp(h.lastErrorAt);
        errorTd.appendChild(errorWhen);
      } else {
        errorTd.className = "health-muted";
        errorTd.textContent = I18N.t("health.noError");
      }
      tr.appendChild(errorTd);

      healthBody.appendChild(tr);
    });
  }

  // Called whenever the relay's game-server connection is known to be
  // gone (a command error, or the WebSocket itself closing) — updates
  // state once, in one place, instead of duplicating the same cleanup at
  // every call site that can discover a dead connection.
  function markDisconnected(c) {
    c.gameConnected = false;
    renderServers();
    if (selectedServerId === c.server.id) {
      stopPlayersAutoRefresh();
      renderContent();
    }
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
      .catch(function (err) { showToast(err.message); });
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
    renderQuickCommands(consoles[server.id]);
    cmdHistoryPanel.hidden = true; // a switch to a different server's console starts closed, not showing the old one's history
    cmdTemplatesPanel.hidden = true;
    renderPlayersPanel(consoles[server.id]);
    updateCmdBarState();
  }

  function renderHead(server) {
    head.innerHTML = "";

    var h1 = document.createElement("h1");
    var dot = document.createElement("span");
    dot.className = "dot " + serverStatusClass(server);
    dot.title = serverStatusTooltip(server);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", serverStatusTooltip(server));
    h1.appendChild(dot);
    h1.appendChild(document.createTextNode(server.name));
    head.appendChild(h1);

    var protoTag = document.createElement("span");
    protoTag.className = "tag tag-outline";
    protoTag.textContent = protocolLabel(server.protocol);
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
        var c = consoles[server.id];
        if (c && c.socket) c.socket.close();
        if (c) markDisconnected(c);
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
    var ready = !!(c && c.gameConnected && c.socket && c.socket.readyState === WebSocket.OPEN);
    cmdSendBtn.disabled = !ready;
    updateQuickCommandsEnabled(c);
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
        gameConnected: false,
        gameKey: window.NICON_GUESS_GAME(server.game),
        lastParsed: null,
      };
      consoles[server.id] = c;
    }
    c.gameConnected = false; // a fresh WebSocket means a fresh handshake either way
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
        c.gameConnected = true;
        appendConsoleLine(c, "system", I18N.t("console.connected"));
        recordConnected(server.id);
        renderServers();
        if (selectedServerId === server.id) startPlayersAutoRefresh(c);
      } else if (msg.type === "response") {
        appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : I18N.t("console.noOutput"));
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          if (c.playersRequestSentAt) recordLatency(server.id, Date.now() - c.playersRequestSentAt);
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
        recordHealthError(server.id, msg.message);
        // The relay tears down the game connection on any command error
        // (not just connect-time failures), so this always means "no
        // longer connected" — see the isConnected()/markDisconnected()
        // comment above.
        markDisconnected(c);
      }
      refreshIfActive(c);
    });

    socket.addEventListener("close", function () {
      appendConsoleLine(c, "system", I18N.t("console.disconnected"));
      markDisconnected(c);
    });

    socket.addEventListener("error", function () {
      appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      recordHealthError(server.id, I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      refreshIfActive(c);
    });
  }

  // Caps how many lines a single console keeps in memory (and therefore
  // how many renderLog() ever has to rebuild) — a long-running console on
  // a chatty server (WebRCON/BattlEye broadcast lines arrive continuously,
  // not just on command) would otherwise grow both without bound. Oldest
  // lines are dropped first, same as scrolling a real terminal's
  // scrollback off the top.
  var MAX_CONSOLE_LOG_LINES = 2000;

  function appendConsoleLine(c, kind, text) {
    c.lines.push({ kind: kind, text: text });
    if (c.lines.length > MAX_CONSOLE_LOG_LINES) {
      c.lines.splice(0, c.lines.length - MAX_CONSOLE_LOG_LINES);
    }
  }

  // renderLog does a full rebuild (log.innerHTML = "" + re-append every
  // line) rather than an incremental append, so it can re-run the filter
  // regex over the whole log; that's fine for a single command's
  // response, but a burst of broadcast lines arriving back-to-back
  // (WebRCON/BattlEye chat, kill feed) used to trigger one full rebuild
  // per line. Coalescing same-frame calls into one keeps the same
  // rendering path and the same final output, just not redone once per
  // line when several arrive within a frame.
  var logRenderScheduled = false;
  function scheduleLogRender() {
    if (logRenderScheduled) return;
    logRenderScheduled = true;
    window.requestAnimationFrame(function () {
      logRenderScheduled = false;
      renderLog(consoles[selectedServerId]);
    });
  }

  function refreshIfActive(c) {
    if (selectedServerId === c.server.id) {
      scheduleLogRender();
      updateCmdBarState();
    }
  }

  // --- console log: filtering + highlighting ---

  function activeFilterRegex() {
    var text = filterInput.value.trim();
    if (!text) return null;
    if (!filterRegexToggle.checked) {
      text = text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      return new RegExp(text, "i");
    }
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

  filterRegexToggle.addEventListener("change", function () {
    renderLog(consoles[selectedServerId]);
  });

  consoleCopyBtn.addEventListener("click", function () {
    var c = consoles[selectedServerId];
    if (!c || !c.lines.length || !navigator.clipboard) return;
    navigator.clipboard.writeText(c.lines.map(function (line) {
      return line.text;
    }).join("\n")).catch(function () {
      // Clipboard access can be unavailable on HTTP or locked-down browsers.
    });
  });

  consoleClearBtn.addEventListener("click", function () {
    var c = consoles[selectedServerId];
    if (!c) return;
    c.lines = [];
    c.lastParsed = null;
    renderLog(c);
    renderPlayersPanel(c);
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

  // sendConsoleCommand is the one path every command actually goes out
  // through: manual command-bar input, the players-card's per-player
  // kick/ban buttons, the auto-refresh player-list poll, and the Quick
  // Commands bar all call this instead of touching c.socket directly, so
  // there's exactly one place that logs the outgoing line, refreshes the
  // console if it's the one on screen, and does the actual send. Returns
  // false (and sends nothing) if there's no live game connection right
  // now, so every caller shares the same "not connected" guard.
  function sendConsoleCommand(c, command) {
    if (!c || !command || !c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return false;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    c.socket.send(JSON.stringify({ type: "command", command: command }));
    return true;
  }

  function requestPlayers(c) {
    if (!c.gameKey) {
      if (selectedServerId === c.server.id) renderPlayersPanel(c);
      return;
    }
    if (!c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    var game = window.NICON_GAMES[c.gameKey];
    c.pendingPlayersRequest = true;
    c.playersRequestSentAt = Date.now();
    sendConsoleCommand(c, game.command);
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

    // columns[0] is always the display name (every games.js entry puts it
    // first) — that plus kick/ban is what actually matters at a glance,
    // so only those sit in the main row; every other column (SteamID,
    // ping, address, …) is real but rarely needed, so it's tucked behind
    // a <details> instead of squeezing a wide table into the sidebar.
    var columns = c.lastParsed.columns;
    var list = document.createElement("div");
    list.className = "players-list";

    players.forEach(function (player) {
      var row = document.createElement("div");
      row.className = "player-row";

      var main = document.createElement("div");
      main.className = "player-row-main";

      var name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.cells[0] || player.id;
      main.appendChild(name);

      if (player.isAdmin) {
        var rank = document.createElement("span");
        rank.className = "tag tag-rank";
        rank.textContent = I18N.t("admin.roleAdmin");
        main.appendChild(rank);
      } else {
        var kickCmd = game.kick ? game.kick(player) : null;
        var banCmd = game.ban ? game.ban(player) : null;
        if (kickCmd || banCmd) {
          var actions = document.createElement("div");
          actions.className = "player-actions-row";
          var label = player.cells[0] || player.id;
          if (kickCmd) actions.appendChild(playerActionButton(I18N.t("players.kick"), false, function () {
            sendPlayerAction(c, kickCmd, I18N.t("players.kickConfirm", { name: label }));
          }));
          if (banCmd) actions.appendChild(playerActionButton(I18N.t("players.ban"), true, function () {
            sendPlayerAction(c, banCmd, I18N.t("players.banConfirm", { name: label }));
          }));
          main.appendChild(actions);
        }
      }
      row.appendChild(main);

      if (columns.length > 1) {
        var details = document.createElement("details");
        details.className = "player-details";
        var summaryEl = document.createElement("summary");
        summaryEl.textContent = I18N.t("players.details");
        details.appendChild(summaryEl);

        var dl = document.createElement("dl");
        for (var i = 1; i < columns.length; i++) {
          var dt = document.createElement("dt");
          dt.textContent = columnLabel(columns[i]);
          var dd = document.createElement("dd");
          dd.textContent = player.cells[i];
          dl.appendChild(dt);
          dl.appendChild(dd);
        }
        details.appendChild(dl);
        row.appendChild(details);
      }

      list.appendChild(row);
    });
    playersPanel.appendChild(list);
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
    showConfirm(confirmMessage).then(function (ok) {
      if (!ok) return;
      if (!sendConsoleCommand(c, command)) return;
      setTimeout(function () { requestPlayers(c); }, 1200);
    });
  }

  // --- command bar + history ---
  // History is per-console, in-memory only — same lifetime as the log
  // itself (nothing here is persisted; a reload starts fresh, matching
  // how the rest of a console's state already works). Only commands
  // actually typed into the command bar are recorded — a Quick Command or
  // a template already has its own one-click path, so echoing those into
  // "what did I type" history too would just be noise.

  var MAX_COMMAND_HISTORY = 100;

  function pushCommandHistory(c, command) {
    if (!c.history) c.history = [];
    // Mashing the same command twice shouldn't fill history with
    // duplicates — same convention as a shell's history file.
    if (c.history[c.history.length - 1] !== command) {
      c.history.push(command);
      if (c.history.length > MAX_COMMAND_HISTORY) c.history.shift();
    }
    c.historyIndex = null;
    c.historyDraft = "";
  }

  function renderCommandHistory(c) {
    cmdHistoryPanel.innerHTML = "";
    var entries = c && c.history ? c.history : [];
    if (!entries.length) {
      var hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = I18N.t("console.historyEmpty");
      cmdHistoryPanel.appendChild(hint);
      return;
    }
    // Most recently sent first.
    for (var i = entries.length - 1; i >= 0; i--) {
      var command = entries[i];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = command;
      btn.addEventListener("click", function () {
        // Fills the input rather than sending immediately — history can
        // recall something risky (a past kick/ban/stop), so it should
        // always go through a deliberate second Send, same as manual
        // typing would.
        cmdInput.value = command;
        cmdHistoryPanel.hidden = true;
        cmdInput.focus();
      });
      cmdHistoryPanel.appendChild(btn);
    }
  }

  cmdHistoryBtn.addEventListener("click", function () {
    var wasHidden = cmdHistoryPanel.hidden;
    cmdTemplatesPanel.hidden = true; // only one of History/Templates open at a time
    cmdHistoryPanel.hidden = !wasHidden;
    if (wasHidden) renderCommandHistory(consoles[selectedServerId]);
  });

  // Shell-style Up/Down recall: Up steps backward through this console's
  // history (saving whatever was being typed so Down can return to it),
  // Down steps forward and clears back to that saved draft at the end.
  cmdInput.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    var c = consoles[selectedServerId];
    if (!c || !c.history || !c.history.length) return;
    e.preventDefault();

    if (e.key === "ArrowUp") {
      if (c.historyIndex == null) {
        c.historyDraft = cmdInput.value;
        c.historyIndex = c.history.length;
      }
      if (c.historyIndex > 0) c.historyIndex--;
    } else {
      if (c.historyIndex == null) return;
      c.historyIndex++;
    }

    if (c.historyIndex >= c.history.length) {
      c.historyIndex = null;
      cmdInput.value = c.historyDraft || "";
    } else {
      cmdInput.value = c.history[c.historyIndex];
    }
  });

  cmdForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var c = consoles[selectedServerId];
    var command = cmdInput.value.trim();
    if (!command || !sendConsoleCommand(c, command)) return;
    pushCommandHistory(c, command);
    cmdHistoryPanel.hidden = true;
    cmdInput.value = "";
  });

  // --- command templates ---
  // Per-account saved commands (server-side — see
  // webspace/handlers/command_templates.php — not localStorage, so they
  // follow the user's account rather than one browser), listed in the
  // Templates panel next to History and sent through the exact same path
  // (sendConsoleCommand above) as one typed by hand. Loaded once per
  // sign-in (showAppView) and re-synced from the server's own response on
  // every add/delete, rather than trusted purely locally.

  var commandTemplates = [];

  function loadCommandTemplates() {
    return apiFetch("/api/command-templates", { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        commandTemplates = list || [];
        renderCommandTemplates();
      })
      .catch(function () { /* templates are a nice-to-have, fail silently */ });
  }

  function renderCommandTemplates() {
    cmdTemplatesList.innerHTML = "";
    if (!commandTemplates.length) {
      var hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = I18N.t("templates.empty");
      cmdTemplatesList.appendChild(hint);
      return;
    }

    commandTemplates.forEach(function (tpl) {
      var row = document.createElement("div");
      row.className = "cmd-template-row";

      var info = document.createElement("div");
      info.className = "template-info";
      var name = document.createElement("span");
      name.className = "template-name";
      name.textContent = tpl.name;
      var command = document.createElement("span");
      command.className = "template-command";
      command.textContent = tpl.command;
      info.appendChild(name);
      info.appendChild(command);
      row.appendChild(info);

      var actions = document.createElement("div");
      actions.className = "template-actions-row";

      var sendBtn = document.createElement("button");
      sendBtn.type = "button";
      sendBtn.className = "btn-xs";
      sendBtn.textContent = I18N.t("templates.send");
      sendBtn.addEventListener("click", function () {
        var c = consoles[selectedServerId];
        if (c) sendConsoleCommand(c, tpl.command);
      });
      actions.appendChild(sendBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-xs btn-xs-danger";
      deleteBtn.textContent = I18N.t("templates.delete");
      deleteBtn.addEventListener("click", function () {
        showConfirm(I18N.t("templates.deleteConfirm", { name: tpl.name })).then(function (ok) {
          if (!ok) return;
          apiFetch("/api/command-templates/" + tpl.id, { method: "DELETE" })
            .then(function (r) {
              if (!r.ok && r.status !== 204) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("templates.deleteFailed")); });
              commandTemplates = commandTemplates.filter(function (x) { return x.id !== tpl.id; });
              renderCommandTemplates();
            })
            .catch(function (err) { showToast(err.message); });
        });
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      cmdTemplatesList.appendChild(row);
    });
  }

  cmdTemplatesBtn.addEventListener("click", function () {
    var wasHidden = cmdTemplatesPanel.hidden;
    cmdHistoryPanel.hidden = true; // only one of History/Templates open at a time
    cmdTemplatesPanel.hidden = !wasHidden;
  });

  cmdTemplateAddForm.addEventListener("submit", function (e) {
    e.preventDefault();
    cmdTemplateError.hidden = true;
    var name = cmdTemplateNameInput.value.trim();
    var command = cmdTemplateCommandInput.value.trim();
    if (!name || !command) {
      cmdTemplateError.textContent = I18N.t("templates.nameAndCommandRequired");
      cmdTemplateError.hidden = false;
      return;
    }

    apiFetch("/api/command-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, command: command }),
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("templates.saveFailed")); });
        return r.json();
      })
      .then(function (tpl) {
        commandTemplates.push(tpl);
        commandTemplates.sort(function (a, b) { return a.name.localeCompare(b.name); });
        renderCommandTemplates();
        cmdTemplateAddForm.reset();
      })
      .catch(function (err) {
        cmdTemplateError.textContent = err.message;
        cmdTemplateError.hidden = false;
      });
  });

  // --- quick commands ---
  // One button per game.quickCommands entry (see docs/games.js) — same
  // send path as manual input (sendConsoleCommand above), never a second
  // one. Buttons only appear for a recognized game, since the actual
  // command syntax is per-game/protocol; an unrecognized server's game
  // shows no quick-commands bar at all, same as it already shows no
  // player-list parsing.

  var pendingQuickCommand = null; // { c: ..., def: ... } while the dialog is open

  function renderQuickCommands(c) {
    quickCmdBar.innerHTML = "";
    var game = c && c.gameKey ? window.NICON_GAMES[c.gameKey] : null;
    var defs = game && game.quickCommands ? game.quickCommands : null;
    quickCmdBar.hidden = !defs || !defs.length;
    if (!defs) return;

    defs.forEach(function (def) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-cmd-btn" + (def.risk === "high" ? " quick-cmd-btn-danger" : "");
      var label = I18N.t("quickCommands." + def.id);
      btn.textContent = label;
      btn.title = label;
      btn.addEventListener("click", function () { runQuickCommand(c, def); });
      quickCmdBar.appendChild(btn);
    });
    updateQuickCommandsEnabled(c);
  }

  function updateQuickCommandsEnabled(c) {
    var ready = !!(c && c.gameConnected && c.socket && c.socket.readyState === WebSocket.OPEN);
    var buttons = quickCmdBar.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !ready;
  }

  function runQuickCommand(c, def) {
    if (!c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    if (def.risk === "low") {
      sendConsoleCommand(c, def.build());
      return;
    }
    openQuickCommandModal(c, def);
  }

  function openQuickCommandModal(c, def) {
    pendingQuickCommand = { c: c, def: def };
    var label = I18N.t("quickCommands." + def.id);
    quickCmdModalTitle.textContent = label;

    var needsMessage = def.param === "message";
    quickCmdModalMessage.hidden = !needsMessage;
    quickCmdModalMessage.value = "";
    quickCmdModalWarning.hidden = def.risk !== "high";
    quickCmdModalWarning.textContent = def.risk === "high" ? I18N.t("quickCommands." + def.id + "Confirm") : "";
    quickCmdModalError.hidden = true;
    quickCmdModalConfirm.textContent = I18N.t(def.risk === "high" ? "quickCommands.confirm" : "quickCommands.send");
    quickCmdModalConfirm.className = def.risk === "high" ? "btn-secondary btn-danger" : "btn-primary";

    quickCmdModal.showModal();
    // showModal() focuses the dialog's first focusable element on its
    // own, but that's the "Close" link when the message field was hidden
    // a moment ago — focus it explicitly so typing works right away.
    if (needsMessage) quickCmdModalMessage.focus();
  }

  function closeQuickCommandModal() {
    quickCmdModal.close();
  }

  quickCmdModalClose.addEventListener("click", closeQuickCommandModal);
  quickCmdModal.addEventListener("click", function (e) {
    if (e.target === quickCmdModal) closeQuickCommandModal();
  });
  quickCmdModal.addEventListener("close", function () { pendingQuickCommand = null; });

  quickCmdModalForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!pendingQuickCommand) return;
    var c = pendingQuickCommand.c;
    var def = pendingQuickCommand.def;
    var needsMessage = def.param === "message";
    var message = quickCmdModalMessage.value.trim();

    if (needsMessage && !message) {
      quickCmdModalError.textContent = I18N.t("quickCommands.messageRequired");
      quickCmdModalError.hidden = false;
      quickCmdModalMessage.focus();
      return;
    }

    var command = needsMessage ? def.build(message) : def.build();
    quickCmdModal.close();
    if (command) sendConsoleCommand(c, command);
  });

  // --- welcome screen: supported games list ---
  // Driven by NICON_GAMES itself (docs/games.js) rather than a hand-kept
  // duplicate list here, so it can't drift when a game is added/removed.

  var TESTED_GAMES = ["rust", "palworld"];

  function renderSupportedGamesList() {
    supportedGamesList.innerHTML = "";
    Object.keys(window.NICON_GAMES).forEach(function (key) {
      var tested = TESTED_GAMES.indexOf(key) !== -1;
      var li = document.createElement("li");

      var tag = document.createElement("span");
      tag.className = "tag " + (tested ? "tag-tested" : "tag-untested");
      tag.textContent = I18N.t(tested ? "welcome.tested" : "welcome.untested");
      li.appendChild(tag);

      li.appendChild(document.createTextNode(window.NICON_GAMES[key].label));
      supportedGamesList.appendChild(li);
    });
  }

  // --- boot ---

  I18N.applyStatic(document);
  renderSupportedGamesList();
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
