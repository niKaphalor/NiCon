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
  var nitradoPowerPending = {};
  var selectedServerId = null;
  var activeServerTab = "console";
  var lastActivityLog = [];

  // --- element refs ---

  var apiPill = document.getElementById("api-pill");
  var apiBanner = document.getElementById("api-banner");

  var relayPill = document.getElementById("relay-pill");
  var relayBanner = document.getElementById("relay-banner");

  var usernameLabel = document.getElementById("username-label");
  var logoutBtn = document.getElementById("logout-btn");
  var pwaInstallBtn = document.getElementById("pwa-install-btn");
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
  var contentPane = document.getElementById("content");

  var contentEmpty = document.getElementById("content-empty");
  var contentEmptyText = document.getElementById("content-empty-text");
  var supportedGamesList = document.getElementById("supported-games-list");
  var emptyAddBtn = document.getElementById("empty-add-btn");
  var contentPassword = document.getElementById("content-password");
  var passwordServerName = document.getElementById("password-server-name");
  var passwordPublicStatus = document.getElementById("password-public-status");
  var passwordPublicStatusValues = document.getElementById("password-public-status-values");
  var passwordPowerActions = document.getElementById("password-power-actions");
  var passwordForm = document.getElementById("password-form");
  var passwordInput = document.getElementById("password-input");
  var passwordEditServerBtn = document.getElementById("password-edit-server-btn");
  var contentConsole = document.getElementById("content-console");
  var head = document.getElementById("head");
  var serverTabs = document.getElementById("server-tabs");
  var serverTabButtons = serverTabs.querySelectorAll("[data-server-tab]");
  var serverOverviewPanel = document.getElementById("server-overview-panel");
  var serverOverviewRange = document.getElementById("server-overview-range");
  var serverOverviewContent = document.getElementById("server-overview-content");
  var serverConsolePanel = document.getElementById("server-console-panel");
  var serverPlayersPanel = document.getElementById("server-players-panel");
  var serverPlayersList = document.getElementById("server-players-list");
  var serverPlayerCount = document.getElementById("server-player-count");
  var serverAuditPanel = document.getElementById("server-audit-panel");
  var serverAuditList = document.getElementById("server-audit-list");

  var viewSettings = document.getElementById("view-settings");
  var privacyCard = document.getElementById("privacy-card");
  var accountCard = document.getElementById("account-card");
  var activityCard = document.getElementById("activity-card");
  var activityList = document.getElementById("activity-list");
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
  var adminAuditLogList = document.getElementById("admin-audit-log-list");

  var viewHealth = document.getElementById("view-health");
  var healthBody = document.getElementById("health-body");
  var healthRangeSelect = document.getElementById("health-range-select");

  var addModal = document.getElementById("add-modal");
  var addClose = document.getElementById("add-close");
  var addTabs = document.querySelectorAll(".tab");
  var addTabPanels = document.querySelectorAll(".tab-panel");
  var nitradoForm = document.getElementById("nitrado-form");
  var nitradoTokenInput = document.getElementById("nitrado-token");
  var nitradoTokenStatus = document.getElementById("nitrado-token-status");
  var forgetNitradoTokenBtn = document.getElementById("forget-nitrado-token-btn");
  var manualForm = document.getElementById("manual-form");
  var manualTestBtn = document.getElementById("manual-test-btn");
  var manualQueryTestBtn = document.getElementById("manual-query-test-btn");
  var manualTestStatus = document.getElementById("manual-test-status");
  var manualQueryTestStatus = document.getElementById("manual-query-test-status");
  var manualGameSelect = document.getElementById("manual-game");
  var manualQueryProtocol = document.getElementById("manual-query-protocol");
  var manualQueryPort = document.getElementById("manual-query-port");

  var editServerModal = document.getElementById("edit-server-modal");
  var editServerClose = document.getElementById("edit-server-close");
  var editServerForm = document.getElementById("edit-server-form");
  var editServerName = document.getElementById("edit-server-name");
  var editServerHost = document.getElementById("edit-server-host");
  var editServerPort = document.getElementById("edit-server-port");
  var editServerProtocol = document.getElementById("edit-server-protocol");
  var editServerGame = document.getElementById("edit-server-game");
  var editServerQueryProtocol = document.getElementById("edit-server-query-protocol");
  var editServerQueryPort = document.getElementById("edit-server-query-port");
  var editServerQueryTestBtn = document.getElementById("edit-server-query-test-btn");
  var editServerQueryTestStatus = document.getElementById("edit-server-query-test-status");
  var editServerPassword = document.getElementById("edit-server-password");
  var editServerError = document.getElementById("edit-server-error");
  var editServerNitradoHint = document.getElementById("edit-server-nitrado-hint");
  var editingServerId = null;

  var filterInput = document.getElementById("filter-input");
  var filterRegexToggle = document.getElementById("filter-regex-toggle");
  var consoleFollowBtn = document.getElementById("console-follow-btn");
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
  var moderationRulesBtn = document.getElementById("moderation-rules-btn");
  var moderationRulesPanel = document.getElementById("moderation-rules-panel");
  var moderationRulesList = document.getElementById("moderation-rules-list");
  var moderationRuleForm = document.getElementById("moderation-rule-form");
  var moderationPatternInput = document.getElementById("moderation-pattern-input");
  var moderationActionSelect = document.getElementById("moderation-action-select");
  var log = document.getElementById("log");
  var cmdForm = document.getElementById("cmd-form");
  var cmdInput = document.getElementById("cmd-input");
  var cmdSuggestions = document.getElementById("cmd-suggestions");
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
  var playerContextMenu = document.getElementById("player-context-menu");
  var playerMessageModal = document.getElementById("player-message-modal");
  var playerMessageClose = document.getElementById("player-message-close");
  var playerMessageForm = document.getElementById("player-message-form");
  var playerMessageInput = document.getElementById("player-message-input");
  var nitradoResourcesCard = document.getElementById("nitrado-resources-card");
  var nitradoResources = document.getElementById("nitrado-resources");

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
    renderModerationRules();
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

  function showToast(message, type, action) {
    if (typeof toastContainer.showPopover === "function" && !toastContainer.matches(":popover-open")) {
      try { toastContainer.showPopover(); } catch (e) { /* already showing, or unsupported */ }
    }

    var toast = document.createElement("div");
    toast.className = "toast toast-" + (type || "error");

    var messageEl = document.createElement("span");
    messageEl.className = "toast-message";
    messageEl.textContent = message;
    toast.appendChild(messageEl);

    if (action && action.label) {
      var actionBtn = document.createElement("button");
      actionBtn.type = "button";
      actionBtn.className = "toast-action";
      actionBtn.textContent = action.label;
      actionBtn.addEventListener("click", function () {
        action.onClick();
        dismiss();
      });
      toast.appendChild(actionBtn);
    }

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
    if (!action || !action.persistent) setTimeout(dismiss, 6000);
    return toast;
  }

  // --- PWA install and controlled updates ---
  // The browser owns install eligibility. We only reveal the button after
  // beforeinstallprompt, so unsupported/already-installed clients never see
  // a dead control. A new service worker waits until the user accepts the
  // update toast; controllerchange then reloads exactly once.
  var deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    pwaInstallBtn.hidden = false;
  });
  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    pwaInstallBtn.hidden = true;
  });
  pwaInstallBtn.addEventListener("click", function () {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    Promise.resolve(deferredInstallPrompt.userChoice).finally(function () {
      deferredInstallPrompt = null;
      pwaInstallBtn.hidden = true;
    });
  });

  var offeredPwaWorker = null;
  var activatingPwaUpdate = false;
  function offerPwaUpdate(worker) {
    if (!worker || offeredPwaWorker === worker) return;
    offeredPwaWorker = worker;
    showToast(I18N.t("pwa.updateAvailable"), "info", {
      label: I18N.t("pwa.updateNow"),
      persistent: true,
      onClick: function () {
        activatingPwaUpdate = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      },
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    var reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      // clients.claim() also fires controllerchange after the very first
      // install. Reload only when this page explicitly activated an update.
      if (!activatingPwaUpdate || reloading) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (registration) {
      if (registration.waiting) offerPwaUpdate(registration.waiting);
      registration.addEventListener("updatefound", function () {
        var worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", function () {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerPwaUpdate(worker);
        });
      });
      setInterval(function () { registration.update(); }, 60 * 60 * 1000);
    }).catch(function () {
      // The app remains fully usable as a normal website if registration is
      // unavailable (private browsing policy, old browser, or local file URL).
    });
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
      disposeConsole(consoles[id]);
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
    manualTestStatus.hidden = true;
    manualQueryTestStatus.hidden = true;
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
          disposeConsole(consoles[id]);
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
    if (protocol === "telnet") return "Telnet";
    if (protocol === "battlebit") return "BattleBit WebRCON";
    return I18N.t("common.protocolSource");
  }

  // A short badge for the sidebar row's meta line — omitted for plain
  // Source RCON, since that's the common default and doesn't need calling
  // out the way the less-common protocols do.
  function protocolBadge(protocol) {
    if (protocol === "webrcon") return I18N.t("common.webrcon");
    if (protocol === "palworld_rest") return I18N.t("common.restApi");
    if (protocol === "battleye") return I18N.t("common.battleye");
    if (protocol === "telnet") return "Telnet";
    if (protocol === "battlebit") return "BattleBit";
    return null;
  }

  function suggestedProtocolForGame(game) {
    var key = window.NICON_GUESS_GAME(game);
    if (key === "sevendaystodie") return "telnet";
    if (["arma2", "arma3", "armareforger", "dayz"].indexOf(key) !== -1) return "battleye";
    if (key === "battlebit") return "battlebit";
    if (key === "rust") return "webrcon";
    if (key === "palworld") return "palworld_rest";
    return "source";
  }

  function suggestedQueryProtocolForGame(game) {
    var key = window.NICON_GUESS_GAME(game);
    if (key === "minecraft") return "minecraft";
    if (["rust", "arma2", "arma3", "armareforger", "dayz"].indexOf(key) !== -1) return "a2s";
    return "auto";
  }

  function optionalPort(input) {
    if (!input.value) return null;
    var value = parseInt(input.value, 10);
    return value >= 1 && value <= 65535 ? value : null;
  }

  manualGameSelect.addEventListener("change", function () {
    document.getElementById("manual-protocol").value = suggestedProtocolForGame(manualGameSelect.value);
    manualQueryProtocol.value = suggestedQueryProtocolForGame(manualGameSelect.value);
  });

  function setGameSelectValue(select, game) {
    var value = game || "";
    var custom = select.querySelector("option[data-custom-game]");
    if (custom) custom.remove();
    var exists = Array.prototype.some.call(select.options, function (option) { return option.value === value; });
    if (value && !exists) {
      custom = document.createElement("option");
      custom.value = value;
      custom.textContent = value;
      custom.dataset.customGame = "true";
      select.appendChild(custom);
    }
    select.value = value;
  }

  function openEditServerModal(server) {
    editingServerId = server.id;
    editServerName.value = server.name;
    editServerHost.value = server.host;
    editServerPort.value = server.port;
    editServerProtocol.value = server.protocol || "source";
    editServerQueryProtocol.value = server.query_protocol || "auto";
    editServerQueryPort.value = server.query_port || "";
    setGameSelectValue(editServerGame, server.game);
    editServerPassword.value = "";
    editServerError.hidden = true;
    editServerQueryTestStatus.hidden = true;
    editServerNitradoHint.hidden = server.source !== "nitrado";
    editServerModal.showModal();
  }

  editServerClose.addEventListener("click", function () { editServerModal.close(); });
  editServerModal.addEventListener("click", function (event) {
    if (event.target === editServerModal) editServerModal.close();
  });
  editServerGame.addEventListener("change", function () {
    editServerProtocol.value = suggestedProtocolForGame(editServerGame.value);
    editServerQueryProtocol.value = suggestedQueryProtocolForGame(editServerGame.value);
  });
  passwordEditServerBtn.addEventListener("click", function () {
    var server = findServer(selectedServerId);
    if (server) openEditServerModal(server);
  });

  editServerForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var server = findServer(editingServerId);
    if (!server) return;
    editServerError.hidden = true;
    var password = editServerPassword.value;
    var payload = {
      name: editServerName.value.trim(),
      host: editServerHost.value.trim(),
      port: parseInt(editServerPort.value, 10),
      protocol: editServerProtocol.value,
      query_protocol: editServerQueryProtocol.value,
      query_port: optionalPort(editServerQueryPort),
      game: editServerGame.value,
    };

    apiFetch("/api/servers/" + server.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (response) {
      if (!response.ok) return response.text().then(function (text) { throw new Error(apiErrorMessage(text) || I18N.t("editServer.updateFailed")); });
      return response.json();
    }).then(function (updated) {
      if (!password) return updated;
      return apiFetch("/api/servers/" + server.id + "/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password }),
      }).then(function (response) {
        if (!response.ok) throw new Error(I18N.t("errors.failedToSavePassword"));
        updated.has_password = true;
        return updated;
      });
    }).then(function (updated) {
      var index = servers.findIndex(function (item) { return item.id === updated.id; });
      if (index !== -1) servers[index] = updated;
      if (consoles[updated.id]) {
        disposeConsole(consoles[updated.id]);
        delete consoles[updated.id];
      }
      stopPlayersAutoRefresh();
      editServerModal.close();
      renderServers();
      renderContent();
    }).catch(function (error) {
      editServerError.textContent = error.message;
      editServerError.hidden = false;
    });
  });

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

      var content = document.createElement("span");
      content.className = "server-row-content";

      var nameLine = document.createElement("span");
      nameLine.className = "name";
      if (server.game_icon_url) {
        row.classList.add("has-game-icon");
        var gameIcon = document.createElement("img");
        gameIcon.className = "server-game-icon";
        gameIcon.src = server.game_icon_url;
        gameIcon.alt = "";
        gameIcon.addEventListener("error", function () {
          gameIcon.remove();
          row.classList.remove("has-game-icon");
        });
        row.appendChild(gameIcon);
      }
      var dot = document.createElement("span");
      dot.className = "dot " + serverStatusClass(server);
      dot.title = serverStatusTooltip(server);
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", serverStatusTooltip(server));
      nameLine.appendChild(dot);
      nameLine.appendChild(document.createTextNode(server.name));
      content.appendChild(nameLine);

      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = serverMeta(server);
      content.appendChild(meta);
      row.appendChild(content);

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

  // --- manual add: test connection ---
  // Opens its own short-lived WebSocket (auth + a "test" message carrying
  // the form's current host/port/password/protocol directly, since there's
  // no saved server_id yet to test against) and closes it again as soon as
  // a result comes back — never leaves a connection open.

  function setManualTestStatus(text, isError) {
    manualTestStatus.textContent = text;
    manualTestStatus.classList.toggle("is-error", !!isError);
    manualTestStatus.classList.toggle("is-success", !isError);
    manualTestStatus.hidden = false;
  }

  // Its own status line, not shared with setManualTestStatus above — "Test
  // connection" and "Test status query" are two unrelated checks (RCON vs.
  // public query), and sharing one line made a stale result briefly read as
  // belonging to the wrong test (the Edit-Server modal already gives its
  // own query test a dedicated line; this matches that).
  function setManualQueryTestStatus(text, isError) {
    manualQueryTestStatus.textContent = text;
    manualQueryTestStatus.classList.toggle("is-error", !!isError);
    manualQueryTestStatus.classList.toggle("is-success", !isError);
    manualQueryTestStatus.hidden = false;
  }

  function runQueryTest(options) {
    var host = options.host.value.trim();
    var port = optionalPort(options.queryPort) || parseInt(options.rconPort.value, 10);
    var protocol = options.queryProtocol.value;
    if (protocol === "auto") {
      protocol = options.game.value === "Minecraft" ? "minecraft" : (options.rconProtocol.value === "source" ? "a2s" : "disabled");
    }
    if (!host || !port || protocol === "disabled") {
      options.setStatus(I18N.t("addModal.queryNeedsConfig"), true);
      return;
    }
    options.button.disabled = true;
    options.setStatus(I18N.t("addModal.testing"), false);
    var socket;
    var settled = false;
    var timer = setTimeout(function () { finish(I18N.t("addModal.testTimedOut"), true); }, 10000);
    function finish(message, isError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.setStatus(message, isError);
      options.button.disabled = false;
      if (socket) socket.close();
    }
    try { socket = new WebSocket(relayWsUrl() + "/ws/rcon"); }
    catch (e) { finish(I18N.t("addModal.testRelayUnreachable"), true); return; }
    socket.addEventListener("open", function () { socket.send(JSON.stringify({ type: "auth", token: authToken })); });
    socket.addEventListener("error", function () { finish(I18N.t("addModal.testRelayUnreachable"), true); });
    socket.addEventListener("close", function () { finish(I18N.t("addModal.testRelayUnreachable"), true); });
    socket.addEventListener("message", function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "authenticated") {
        socket.send(JSON.stringify({ type: "query_test", host: host, port: port, query_protocol: protocol }));
      } else if (msg.type === "query_test_result") {
        var success = I18N.t("addModal.queryTestOk", { players: msg.players == null ? "–" : msg.players, max: msg.players_max == null ? "–" : msg.players_max });
        finish(msg.ok ? success : I18N.t("addModal.testFailed", { message: msg.message || "" }), !msg.ok);
      } else if (msg.type === "error") {
        finish(I18N.t("addModal.testFailed", { message: msg.message || "" }), true);
      }
    });
  }

  manualQueryTestBtn.addEventListener("click", function () {
    runQueryTest({
      host: document.getElementById("manual-host"), rconPort: document.getElementById("manual-port"),
      rconProtocol: document.getElementById("manual-protocol"), game: manualGameSelect,
      queryProtocol: manualQueryProtocol, queryPort: manualQueryPort, button: manualQueryTestBtn,
      setStatus: setManualQueryTestStatus,
    });
  });

  editServerQueryTestBtn.addEventListener("click", function () {
    runQueryTest({
      host: editServerHost, rconPort: editServerPort, rconProtocol: editServerProtocol, game: editServerGame,
      queryProtocol: editServerQueryProtocol, queryPort: editServerQueryPort, button: editServerQueryTestBtn,
      setStatus: function (text, isError) {
        editServerQueryTestStatus.textContent = text;
        editServerQueryTestStatus.classList.toggle("is-error", !!isError);
        editServerQueryTestStatus.classList.toggle("is-success", !isError);
        editServerQueryTestStatus.hidden = false;
      },
    });
  });

  manualTestBtn.addEventListener("click", function () {
    var host = document.getElementById("manual-host").value.trim();
    var port = parseInt(document.getElementById("manual-port").value, 10);
    var password = document.getElementById("manual-password").value;
    var protocol = document.getElementById("manual-protocol").value;

    if (!host || !port) {
      setManualTestStatus(I18N.t("addModal.testNeedsHostPort"), true);
      return;
    }

    manualTestBtn.disabled = true;
    setManualTestStatus(I18N.t("addModal.testing"), false);

    var socket;
    var settled = false;
    var timer = setTimeout(function () { finish(I18N.t("addModal.testTimedOut"), true); }, 10000);

    function finish(text, isError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setManualTestStatus(text, isError);
      manualTestBtn.disabled = false;
      if (socket) socket.close();
    }

    try {
      socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    } catch (e) {
      finish(I18N.t("addModal.testRelayUnreachable"), true);
      return;
    }

    socket.addEventListener("open", function () {
      socket.send(JSON.stringify({ type: "auth", token: authToken }));
    });
    socket.addEventListener("error", function () {
      finish(I18N.t("addModal.testRelayUnreachable"), true);
    });
    socket.addEventListener("close", function () {
      finish(I18N.t("addModal.testRelayUnreachable"), true);
    });
    socket.addEventListener("message", function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (msg.type === "authenticated") {
        socket.send(JSON.stringify({ type: "test", host: host, port: port, password: password, protocol: protocol }));
      } else if (msg.type === "test_result") {
        finish(msg.ok ? I18N.t("addModal.testOk") : I18N.t("addModal.testFailed", { message: msg.message || "" }), !msg.ok);
      } else if (msg.type === "error") {
        finish(I18N.t("addModal.testFailed", { message: msg.message || "" }), true);
      }
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
    var game = manualGameSelect.value;
    var queryProtocol = manualQueryProtocol.value;
    var queryPort = optionalPort(manualQueryPort);

    apiFetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, host: host, port: port, password: password, protocol: protocol, query_protocol: queryProtocol, query_port: queryPort, game: game }),
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
        manualTestStatus.hidden = true;
        manualQueryTestStatus.hidden = true;
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
    activityCard.hidden = false;
    accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: currentUsername });
    notificationsBellBtn.hidden = false;
    loadNotifications();
    loadAccountInfo();
    loadActivity();
    loadCommandTemplates();
    loadModerationRules();
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
    loadAdminAuditLog();
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

  // --- audit log ---
  // Same row shape (renderAuditLogList) feeds both the admin's full log
  // and a user's own activity card in settings — just a different
  // endpoint (and therefore a different, pre-filtered list) behind each.

  function auditLogEntryText(entry) {
    var actor = entry.actor_username || "?";
    var target = entry.target_username || "?";
    var detail = entry.detail || "";
    if (entry.kind === "rcon") {
      return I18N.t("auditLog.action_rconCommand", {
        actor: actor,
        server: entry.server_name || "?",
        action: entry.rcon_action || "command",
        target: entry.target_player ? " → " + entry.target_player : "",
        command: entry.command || "",
      });
    }
    switch (entry.action) {
      case "login_success": return I18N.t("auditLog.action_loginSuccess", { actor: actor });
      case "login_failed":
        return entry.actor_username
          ? I18N.t("auditLog.action_loginFailedKnown", { actor: actor })
          : I18N.t("auditLog.action_loginFailedUnknown", { detail: detail });
      case "password_changed": return I18N.t("auditLog.action_passwordChanged", { actor: actor });
      case "username_changed": return I18N.t("auditLog.action_usernameChanged", { actor: actor, detail: detail });
      case "account_deleted": return I18N.t("auditLog.action_accountDeleted", { actor: actor, detail: detail });
      case "server_added": return I18N.t("auditLog.action_serverAdded", { actor: actor, detail: detail });
      case "server_updated": return I18N.t("auditLog.action_serverUpdated", { actor: actor, detail: detail });
      case "server_password_changed": return I18N.t("auditLog.action_serverPasswordChanged", { actor: actor, detail: detail });
      case "server_deleted": return I18N.t("auditLog.action_serverDeleted", { actor: actor, detail: detail });
      case "nitrado_server_started": return I18N.t("auditLog.action_nitradoServerStarted", { actor: actor, detail: detail });
      case "nitrado_server_stopped": return I18N.t("auditLog.action_nitradoServerStopped", { actor: actor, detail: detail });
      case "nitrado_server_restarted": return I18N.t("auditLog.action_nitradoServerRestarted", { actor: actor, detail: detail });
      case "admin_user_deleted": return I18N.t("auditLog.action_adminUserDeleted", { actor: actor, detail: detail });
      case "admin_recovery_code_regenerated": return I18N.t("auditLog.action_adminRecoveryCodeRegenerated", { actor: actor, target: target });
      case "admin_notification_created": return I18N.t("auditLog.action_adminNotificationCreated", { actor: actor, detail: detail });
      case "admin_notification_deleted": return I18N.t("auditLog.action_adminNotificationDeleted", { actor: actor, detail: detail });
      default: return entry.action; // forward-compatible fallback for an action this build doesn't know a template for yet
    }
  }

  function renderAuditLogList(container, list, emptyTextKey) {
    container.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = I18N.t(emptyTextKey);
      container.appendChild(empty);
      return;
    }
    list.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "admin-notification-row";

      var msg = document.createElement("p");
      msg.textContent = auditLogEntryText(entry);
      row.appendChild(msg);

      if (entry.kind === "rcon") {
        var latency = Number(entry.upstream_ms || 0) + Number(entry.relay_overhead_ms || 0);
        var result = document.createElement("details");
        result.className = "audit-command-result";
        var resultSummary = document.createElement("summary");
        resultSummary.textContent = I18N.t(entry.success ? "auditLog.rconSucceeded" : "auditLog.rconFailed", { latency: latency.toFixed(2) });
        result.appendChild(resultSummary);
        var resultText = document.createElement("pre");
        resultText.setAttribute("aria-label", I18N.t("auditLog.rconResult"));
        resultText.textContent = entry.result || "—";
        result.appendChild(resultText);
        row.appendChild(result);
      }

      var when = document.createElement("span");
      when.className = "hint";
      when.textContent = new Date(entry.created_at).toLocaleString();
      row.appendChild(when);

      container.appendChild(row);
    });
  }

  function loadActivity() {
    return apiFetch("/api/audit-log", { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        lastActivityLog = list || [];
        renderAuditLogList(activityList, lastActivityLog, "settings.activityEmpty");
        var server = findServer(selectedServerId);
        if (server) renderServerAudit(server);
      })
      .catch(function () { /* the rest of settings still works without this */ });
  }

  function loadAdminAuditLog() {
    return apiFetch("/api/admin/audit-log", { method: "GET" })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
        return r.json();
      })
      .then(function (list) { renderAuditLogList(adminAuditLogList, list || [], "admin.auditLogEmpty"); })
      .catch(function (err) { showToast(err.message); });
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

  // Three-state status dot: hollow red (credentials still missing), solid
  // red (offline), green (a live console).
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
  // the WebSocket itself), and the browser round-trip of its most recent
  // player-list poll. Command responses split that total into game/protocol
  // time and relay-local overhead, so the relay's <=50 ms objective is not
  // confused with Internet distance or a slow game server. The console's
  // existing 10s auto-refresh
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
  var serverHealth = {}; // { [serverId]: { lastConnectedAt, lastError, lastErrorAt, latencyMs, relayOverheadMs, upstreamMs } }
  var healthHistoryCache = {};
  healthRangeSelect.addEventListener("change", function () { renderHealth(); });

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
    if (selectedServerId === serverId && activeServerTab === "overview") renderServerOverview(findServer(serverId));
  }

  function recordHealthError(serverId, message) {
    var h = healthFor(serverId);
    h.lastError = message;
    h.lastErrorAt = Date.now();
    saveServerHealth();
    if (!viewHealth.hidden) renderHealth();
    if (selectedServerId === serverId && activeServerTab === "overview") renderServerOverview(findServer(serverId));
  }

  function recordLatency(serverId, ms, relayOverheadMs, upstreamMs) {
    var h = healthFor(serverId);
    h.latencyMs = ms;
    h.relayOverheadMs = typeof relayOverheadMs === "number" ? relayOverheadMs : null;
    h.upstreamMs = typeof upstreamMs === "number" ? upstreamMs : null;
    saveServerHealth();
    if (!viewHealth.hidden) renderHealth();
    if (selectedServerId === serverId && activeServerTab === "overview") renderServerOverview(findServer(serverId));
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

      var autoCheckTd = document.createElement("td");
      if (server.health_checked_at == null) {
        autoCheckTd.className = "health-muted";
        autoCheckTd.textContent = I18N.t("health.autoCheckNeverRun");
      } else {
        var autoCheckWrap = document.createElement("span");
        autoCheckWrap.className = "health-status";
        var autoDot = document.createElement("span");
        autoDot.className = "dot " + (server.health_ok ? "ok" : "error");
        autoDot.setAttribute("role", "img");
        autoDot.setAttribute("aria-label", server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed"));
        autoCheckWrap.appendChild(autoDot);
        autoCheckWrap.appendChild(document.createTextNode(server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed")));
        autoCheckTd.appendChild(autoCheckWrap);

        var autoCheckWhen = document.createElement("span");
        autoCheckWhen.className = "health-timestamp";
        autoCheckWhen.textContent = new Date(server.health_checked_at).toLocaleString();
        autoCheckTd.appendChild(autoCheckWhen);

        if (!server.health_ok && server.health_error) {
          var autoCheckError = document.createElement("span");
          autoCheckError.className = "health-timestamp health-error";
          autoCheckError.textContent = server.health_error;
          autoCheckTd.appendChild(autoCheckError);
        } else if (server.health_ok && server.health_latency_ms != null) {
          var autoCheckLatency = document.createElement("span");
          autoCheckLatency.className = "health-timestamp";
          autoCheckLatency.textContent = server.health_latency_ms + " ms";
          autoCheckTd.appendChild(autoCheckLatency);
        }
      }
      tr.appendChild(autoCheckTd);

      var range = healthRangeSelect.value;
      var historyKey = server.id + ":" + range;
      var historyEntry = healthHistoryCache[historyKey];
      var uptimeTd = document.createElement("td");
      var playersTd = document.createElement("td");
      if (!historyEntry || !historyEntry.data) {
        uptimeTd.className = playersTd.className = "health-muted";
        uptimeTd.textContent = playersTd.textContent = historyEntry && historyEntry.failed ? "—" : "Loading…";
        if (!historyEntry) {
          healthHistoryCache[historyKey] = { loading: true };
          apiFetch("/api/servers/" + server.id + "/health-history?range=" + encodeURIComponent(range))
            .then(function (response) { if (!response.ok) throw new Error("history unavailable"); return response.json(); })
            .then(function (data) { healthHistoryCache[historyKey] = { data: data, fetchedAt: Date.now() }; if (!viewHealth.hidden) renderHealth(); })
            .catch(function () { healthHistoryCache[historyKey] = { data: null, failed: true }; if (!viewHealth.hidden) renderHealth(); });
        }
      } else {
        var history = historyEntry.data;
        var uptimeSummary = document.createElement("span");
        uptimeSummary.className = "health-summary";
        uptimeSummary.textContent = history.uptime_percent == null ? "—" : history.uptime_percent.toFixed(2) + "%";
        uptimeTd.appendChild(uptimeSummary);
        var completeness = document.createElement("span");
        completeness.className = "health-completeness";
        completeness.textContent = I18N.t("health.samples", { value: history.sample_completeness_percent });
        uptimeTd.appendChild(completeness);
        uptimeTd.appendChild(buildHealthChart(history.samples, false, history.range));

        var playersSummary = document.createElement("span");
        playersSummary.className = "health-summary";
        playersSummary.textContent = history.players_peak == null ? "—" : I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak });
        playersTd.appendChild(playersSummary);
        playersTd.appendChild(buildHealthChart(history.samples, true, history.range));
      }
      tr.appendChild(uptimeTd);
      tr.appendChild(playersTd);

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
        latencyHint.textContent = I18N.t("health.latencyHint", {
          relay: h.relayOverheadMs == null ? "—" : h.relayOverheadMs.toFixed(1),
          upstream: h.upstreamMs == null ? "—" : h.upstreamMs.toFixed(1),
        });
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

  function buildHealthChart(samples, players, range) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "health-chart");
    svg.setAttribute("viewBox", "0 0 150 34");
    svg.setAttribute("aria-hidden", "true");
    if (!samples || !samples.length) return svg;
    if (!players) {
      var availability = samples.filter(function (sample) { return sample.source !== "client"; });
      if (!availability.length) return svg;
      var background = document.createElementNS(svg.namespaceURI, "rect");
      background.setAttribute("x", "0"); background.setAttribute("y", "3");
      background.setAttribute("width", "150"); background.setAttribute("height", "28");
      background.setAttribute("class", "unknown-bg"); svg.appendChild(background);
      var rangeMs = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "90d": 7776000000 }[range] || 86400000;
      var end = Date.now(); var start = end - rangeMs;
      availability.forEach(function (sample) {
        var rect = document.createElementNS(svg.namespaceURI, "rect");
        var x = Math.max(0, Math.min(149, (Date.parse(sample.at) - start) * 150 / rangeMs));
        rect.setAttribute("x", String(x)); rect.setAttribute("y", "3");
        rect.setAttribute("width", "1.5"); rect.setAttribute("height", "28");
        rect.setAttribute("class", sample.online ? "online" : "offline"); svg.appendChild(rect);
      });
      return svg;
    }
    var values = samples.filter(function (sample) { return sample.players != null; });
    if (!values.length) return svg;
    var max = Math.max(1, values.reduce(function (peak, sample) { return Math.max(peak, sample.players_max || sample.players); }, 0));
    var points = values.map(function (sample, index) {
      var x = values.length === 1 ? 0 : index * 150 / (values.length - 1);
      return x.toFixed(1) + "," + (32 - sample.players * 29 / max).toFixed(1);
    }).join(" ");
    var line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("class", "player-line"); line.setAttribute("points", points); svg.appendChild(line);
    return svg;
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
    activeServerTab = "console";
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

  // Nitrado's own panel hides "Start" while a server is running (and
  // "Stop"/"Restart" while it's stopped) — calling games/start on an
  // already-running server gets a confusing "game not found" error back
  // instead of a clear "already running" one. Mirror that gating here so
  // the same mistake isn't possible from NiCon's menu. "unknown" (status
  // not loaded yet) keeps every action available rather than guessing.
  function nitradoStatusKind(status) {
    var normalized = String(status || "").toLowerCase();
    if (["started", "running", "online"].indexOf(normalized) !== -1) return "online";
    if (["stopped", "offline"].indexOf(normalized) !== -1) return "offline";
    if (["restarting", "restart"].indexOf(normalized) !== -1) return "restarting";
    return "unknown";
  }

  function nitradoActionLabel(action) {
    if (action === "start") return I18N.t("content.nitradoStart");
    if (action === "stop") return I18N.t("content.nitradoStop");
    return I18N.t("content.nitradoRestart");
  }

  function nitradoActionConfirm(action) {
    if (action === "start") return I18N.t("content.nitradoStartConfirm");
    if (action === "stop") return I18N.t("content.nitradoStopConfirm");
    return I18N.t("content.nitradoRestartConfirm");
  }

  function appendNitradoPowerButtons(container, server, includeLabel) {
    if (server.source !== "nitrado") return;
    if (includeLabel) {
      var label = document.createElement("span");
      label.className = "nitrado-power-label";
      label.textContent = I18N.t("content.nitradoPower");
      container.appendChild(label);
    }
    ["start", "stop", "restart"].forEach(function (action) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn-secondary nitrado-power-btn";
      button.dataset.nitradoAction = action;
      button.textContent = nitradoActionLabel(action);
      button.disabled = !!nitradoPowerPending[server.id];
      button.addEventListener("click", function () {
        requestNitradoPower(server, action);
      });
      container.appendChild(button);
    });
  }

  function requestNitradoPower(server, action) {
    if (nitradoPowerPending[server.id]) return;
    showConfirm(nitradoActionConfirm(action)).then(function (confirmed) {
      if (!confirmed || nitradoPowerPending[server.id]) return;
      nitradoPowerPending[server.id] = true;
      renderContent();

      apiFetch("/api/servers/" + server.id + "/nitrado-power", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action }),
      })
        .then(function (r) {
          if (r.ok) return r.json();
          return r.text().then(function (body) {
            throw new Error(apiErrorMessage(body) || ("HTTP " + r.status));
          });
        })
        .then(function () {
          if (action === "stop" && consoles[server.id]) {
            disconnectConsole(consoles[server.id]);
          }
          showToast(I18N.t("content.nitradoActionSent", { action: nitradoActionLabel(action) }), "success");
        })
        .catch(function (err) {
          showToast(I18N.t("errors.nitradoPowerFailed", { message: err.message || "unknown error" }));
        })
        .finally(function () {
          delete nitradoPowerPending[server.id];
          if (selectedServerId === server.id) renderContent();
        });
    });
  }

  function renderContent() {
    var server = findServer(selectedServerId);
    if (!server) selectedServerId = null;
    setServerBackground(server);

    contentEmpty.hidden = !!server;
    contentPassword.hidden = true;
    contentConsole.hidden = true;
    nitradoResourcesCard.hidden = true;
    passwordPublicStatus.hidden = true;
    passwordPublicStatusValues.innerHTML = "";
    passwordPowerActions.hidden = true;
    passwordPowerActions.innerHTML = "";

    if (!server) {
      contentEmptyText.textContent = servers.length ? I18N.t("content.selectPrompt") : I18N.t("servers.emptyTitle");
      emptyAddBtn.hidden = servers.length > 0;
      return;
    }

    if (!server.has_password) {
      contentPassword.hidden = false;
      passwordServerName.textContent = server.name;
      // The relay's A2S/Minecraft-Query sampling (see README's Relay
      // section) needs no RCON password at all, so a server can already
      // have real player/uptime history before one is ever entered here.
      renderPublicStatus(server);
      if (server.source === "nitrado") {
        passwordPowerActions.hidden = false;
        appendNitradoPowerButtons(passwordPowerActions, server, true);
      }
      return;
    }

    contentConsole.hidden = false;
    renderHead(server);
    renderServerWorkspace(server);
    renderLog(consoles[server.id]);
    renderQuickCommands(consoles[server.id]);
    cmdHistoryPanel.hidden = true; // a switch to a different server's console starts closed, not showing the old one's history
    cmdTemplatesPanel.hidden = true;
    moderationRulesPanel.hidden = true;
    renderPlayersPanel(consoles[server.id]);
    renderPlayersInto(serverPlayersList, consoles[server.id]);
    updateServerPlayerCount(server);
    renderNitradoResources(server);
    updateCmdBarState();
  }

  function setActiveServerTab(tab) {
    if (["overview", "console", "players", "audit"].indexOf(tab) === -1) tab = "console";
    activeServerTab = tab;
    var server = findServer(selectedServerId);
    if (server) renderServerWorkspace(server);
  }

  function renderServerWorkspace(server) {
    var panels = {
      overview: serverOverviewPanel,
      console: serverConsolePanel,
      players: serverPlayersPanel,
      audit: serverAuditPanel,
    };
    serverTabButtons.forEach(function (button) {
      var selected = button.dataset.serverTab === activeServerTab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== activeServerTab; });
    if (activeServerTab === "overview") renderServerOverview(server);
    if (activeServerTab === "players") renderPlayersInto(serverPlayersList, consoles[server.id]);
    if (activeServerTab === "audit") {
      renderServerAudit(server);
      loadActivity();
    }
  }

  serverTabs.addEventListener("click", function (event) {
    var button = event.target.closest("[data-server-tab]");
    if (button) setActiveServerTab(button.dataset.serverTab);
  });

  serverTabs.addEventListener("keydown", function (event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    var buttons = Array.prototype.slice.call(serverTabButtons);
    var index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    var next = (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
    setActiveServerTab(buttons[next].dataset.serverTab);
  });

  serverOverviewRange.addEventListener("change", function () {
    var server = findServer(selectedServerId);
    if (server) renderServerOverview(server);
  });

  function currentPlayerCount(server) {
    var c = consoles[server.id];
    if (c && c.lastParsed && c.lastParsed.ok) return c.lastParsed.players.length;
    if (server.nitrado_resources && server.nitrado_resources.players != null) return Number(server.nitrado_resources.players);
    return null;
  }

  function updateServerPlayerCount(server) {
    var count = currentPlayerCount(server);
    serverPlayerCount.textContent = count == null ? "—" : String(count);
    var headerCount = head.querySelector(".server-current-player-count");
    if (headerCount) headerCount.textContent = I18N.t("workspace.playersNow") + ": " + (count == null ? "—" : count);
  }

  function appendOverviewMetric(container, labelText, valueText, detailText, stateClass) {
    var card = document.createElement("div");
    card.className = "overview-metric" + (stateClass ? " " + stateClass : "");
    var label = document.createElement("span"); label.textContent = labelText;
    var value = document.createElement("strong"); value.textContent = valueText;
    card.appendChild(label); card.appendChild(value);
    if (detailText) {
      var detail = document.createElement("small"); detail.textContent = detailText; card.appendChild(detail);
    }
    container.appendChild(card);
  }

  function renderServerOverview(server) {
    serverOverviewContent.innerHTML = "";
    var h = serverHealth[server.id] || {};
    var range = serverOverviewRange.value;
    var historyKey = server.id + ":" + range;
    var historyEntry = healthHistoryCache[historyKey];
    var history = historyEntry && historyEntry.data;

    var metrics = document.createElement("div"); metrics.className = "overview-metrics";
    appendOverviewMetric(metrics, I18N.t("health.colUptime"), history && history.uptime_percent != null ? history.uptime_percent.toFixed(2) + "%" : "—", history ? I18N.t("health.samples", { value: history.sample_completeness_percent }) : "", server.health_ok ? "is-good" : "");
    var playerCount = currentPlayerCount(server);
    appendOverviewMetric(metrics, I18N.t("workspace.playersNow"), playerCount == null ? "—" : String(playerCount), history && history.players_peak != null ? I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak }) : "");
    appendOverviewMetric(metrics, I18N.t("workspace.relayOverhead"), h.relayOverheadMs == null ? "—" : h.relayOverheadMs.toFixed(1) + " ms", I18N.t("workspace.relayTarget"), h.relayOverheadMs != null && h.relayOverheadMs <= 50 ? "is-good" : "");
    appendOverviewMetric(metrics, I18N.t("workspace.lastCheck"), server.health_checked_at ? new Date(server.health_checked_at).toLocaleString() : I18N.t("health.autoCheckNeverRun"), server.health_latency_ms == null ? "" : server.health_latency_ms + " ms", server.health_ok ? "is-good" : (server.health_checked_at ? "is-bad" : ""));
    serverOverviewContent.appendChild(metrics);

    if (!historyEntry) {
      healthHistoryCache[historyKey] = { loading: true };
      apiFetch("/api/servers/" + server.id + "/health-history?range=" + encodeURIComponent(range))
        .then(function (response) { if (!response.ok) throw new Error("history unavailable"); return response.json(); })
        .then(function (data) { healthHistoryCache[historyKey] = { data: data, fetchedAt: Date.now() }; if (selectedServerId === server.id && activeServerTab === "overview") renderServerOverview(server); })
        .catch(function () { healthHistoryCache[historyKey] = { data: null, failed: true }; if (selectedServerId === server.id && activeServerTab === "overview") renderServerOverview(server); });
    }

    var charts = document.createElement("div"); charts.className = "overview-charts";
    [[I18N.t("workspace.chartUptime"), false], [I18N.t("workspace.chartPlayers"), true]].forEach(function (item) {
      var figure = document.createElement("figure"); figure.className = "overview-chart-card";
      var caption = document.createElement("figcaption"); caption.textContent = item[0]; figure.appendChild(caption);
      if (history) {
        var chart = buildHealthChart(history.samples, item[1], history.range || range);
        chart.removeAttribute("aria-hidden");
        chart.setAttribute("role", "img");
        chart.setAttribute("aria-label", item[0]);
        figure.appendChild(chart);
      } else {
        var placeholder = document.createElement("p"); placeholder.className = "hint";
        placeholder.textContent = historyEntry && historyEntry.failed ? I18N.t("workspace.unavailable") : I18N.t("workspace.loading");
        figure.appendChild(placeholder);
      }
      charts.appendChild(figure);
    });
    serverOverviewContent.appendChild(charts);

    var signals = document.createElement("div"); signals.className = "card overview-signals";
    var title = document.createElement("div"); title.className = "card-kicker"; title.textContent = I18N.t("workspace.recentSignals"); signals.appendChild(title);
    var list = document.createElement("dl");
    function signal(labelText, valueText, error) {
      var dt = document.createElement("dt"); dt.textContent = labelText;
      var dd = document.createElement("dd"); dd.textContent = valueText; if (error) dd.className = "health-error";
      list.appendChild(dt); list.appendChild(dd);
    }
    signal(I18N.t("workspace.status"), serverStatusTooltip(server));
    signal(I18N.t("workspace.autoCheck"), server.health_checked_at ? (server.health_ok ? I18N.t("health.autoCheckOk") : I18N.t("health.autoCheckFailed")) : I18N.t("health.autoCheckNeverRun"), !!server.health_checked_at && !server.health_ok);
    signal(I18N.t("workspace.lastConnected"), formatHealthTimestamp(h.lastConnectedAt) || I18N.t("health.never"));
    signal(I18N.t("workspace.lastError"), h.lastError || server.health_error || I18N.t("health.noError"), !!(h.lastError || server.health_error));
    signals.appendChild(list); serverOverviewContent.appendChild(signals);
  }

  function renderServerAudit(server) {
    var filtered = lastActivityLog.filter(function (entry) {
      return entry.kind === "rcon" && (Number(entry.server_id) === Number(server.id) || (!entry.server_id && entry.server_name === server.name));
    });
    renderAuditLogList(serverAuditList, filtered, "workspace.auditEmpty");
  }

  function setServerBackground(server) {
    var key = server ? window.NICON_GUESS_GAME(server.game) : "";
    var game = key ? window.NICON_GAMES[key] : null;
    var image = game && game.backgroundImage ? game.backgroundImage : "";
    contentPane.classList.toggle("has-game-background", !!image);
    if (image) {
      contentPane.style.setProperty("--game-background-image", 'url("' + image + '")');
    } else {
      contentPane.style.removeProperty("--game-background-image");
    }
  }

  function setDashboardLayout(layout) {
    if (["balanced", "wide", "stacked", "compact"].indexOf(layout) === -1) layout = "balanced";
    localStorage.setItem("nicon_dashboard_layout", layout);
    var work = document.querySelector(".work");
    work.classList.toggle("layout-wide", layout === "wide");
    work.classList.toggle("layout-stacked", layout === "stacked");
    work.classList.toggle("layout-compact", layout === "compact");
  }

  // Shown on the "enter RCON password" screen, for any server (not just
  // Nitrado-sourced ones) — reads whatever the relay's passive A2S/
  // Minecraft-Query sampling has already recorded (see README's Relay
  // section), since that never needed a password in the first place. A
  // server this has no data for yet (wrong protocol, unreachable query
  // port, or just too soon after being added) degrades to a plain
  // "unavailable" line rather than an empty box.
  function renderPublicStatus(server) {
    passwordPublicStatus.hidden = false;
    // "disabled" is known client-side already (it's on the server object
    // itself) — no need to fetch just to say so, and it avoids this
    // collapsing into the same "no data yet" text as a server that simply
    // hasn't been sampled yet, which is exactly the ambiguity that made a
    // real ARK: Survival Ascended timeout confusing to diagnose.
    if (server.query_protocol === "disabled") {
      passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusDisabled");
      return;
    }
    passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusLoading");
    apiFetch("/api/servers/" + server.id + "/health-history?range=24h")
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status unavailable")); })
      .then(function (history) {
        if (selectedServerId !== server.id || server.has_password) return;
        var samples = history.samples || [];
        var latest = samples.length ? samples[samples.length - 1] : null;
        passwordPublicStatusValues.innerHTML = "";
        if (!latest) {
          passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusUnavailable");
          return;
        }
        var items = [
          [I18N.t("phase2.status"), latest.online ? I18N.t("phase2.statusStarted") : I18N.t("phase2.statusStopped"),
            "is-status " + (latest.online ? "is-online" : "is-offline")],
          [I18N.t("console.players"), latest.players == null ? "—" : latest.players + (latest.players_max != null ? " / " + latest.players_max : "")],
        ];
        if (history.players_peak != null) {
          items.push([I18N.t("health.range24h"), I18N.t("health.playerSummary", { average: history.players_average, peak: history.players_peak })]);
        }
        items.forEach(function (item) {
          var box = document.createElement("div"); box.className = "resource-item" + (item[2] ? " " + item[2] : "");
          var label = document.createElement("span"); label.textContent = item[0];
          var value = document.createElement("strong"); value.textContent = item[1];
          box.appendChild(label); box.appendChild(value); passwordPublicStatusValues.appendChild(box);
        });
      })
      .catch(function () {
        if (selectedServerId === server.id && !server.has_password) passwordPublicStatusValues.textContent = I18N.t("phase2.publicStatusFetchFailed");
      });
  }

  function renderNitradoResources(server) {
    setDashboardLayout(localStorage.getItem("nicon_dashboard_layout") || "balanced");
    nitradoResourcesCard.hidden = server.source !== "nitrado";
    if (server.source !== "nitrado") return;
    nitradoResources.innerHTML = "";
    var cached = server.nitrado_resources;
    function statusLabel(status) {
      var kind = nitradoStatusKind(status);
      if (kind === "online") return I18N.t("phase2.statusStarted");
      if (kind === "offline") return I18N.t("phase2.statusStopped");
      if (kind === "restarting") return I18N.t("phase2.statusRestarting");
      return status || I18N.t("phase2.statusUnknown");
    }
    function statusClass(status) {
      var kind = nitradoStatusKind(status);
      if (kind === "online") return "is-status is-online";
      if (kind === "offline") return "is-status is-offline";
      if (kind === "restarting") return "is-status is-restarting";
      return "is-status";
    }
    function draw(data) {
      nitradoResources.innerHTML = "";
      var items = [
        [I18N.t("phase2.status"), statusLabel(data.status), statusClass(data.status)],
        [I18N.t("console.players"), (data.players || 0) + " / " + (data.players_max || 0)],
        [I18N.t("phase2.map"), data.map || "—"],
        [I18N.t("phase2.version"), data.version || "—"],
      ];
      items.forEach(function (item) {
        var box = document.createElement("div"); box.className = "resource-item" + (item[2] ? " " + item[2] : "");
        var label = document.createElement("span"); label.textContent = item[0];
        var value = document.createElement("strong"); value.textContent = item[1];
        box.appendChild(label); box.appendChild(value); nitradoResources.appendChild(box);
      });
    }
    if (cached) draw(cached); else nitradoResources.textContent = I18N.t("phase2.resourcesLoading");
    if (server.nitradoResourcesLoading || (server.nitradoResourcesFetchedAt && Date.now() - server.nitradoResourcesFetchedAt < 60000)) return;
    server.nitradoResourcesLoading = true;
    apiFetch("/api/servers/" + server.id + "/nitrado-status")
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("status unavailable")); })
      .then(function (data) {
        server.nitrado_resources = data;
        server.nitradoResourcesFetchedAt = Date.now();
        if (selectedServerId === server.id) {
          draw(data);
          updateServerPlayerCount(server);
          renderHead(server); // refresh Start/Stop gating now that the real status is known
          if (activeServerTab === "overview") renderServerOverview(server);
        }
      })
      .catch(function () { if (!cached && selectedServerId === server.id) nitradoResources.textContent = I18N.t("phase2.resourcesUnavailable"); })
      .finally(function () { server.nitradoResourcesLoading = false; });
  }

  function renderHead(server) {
    head.innerHTML = "";

    var identity = document.createElement("div");
    identity.className = "server-identity";
    var gameKey = window.NICON_GUESS_GAME(server.game);
    var game = gameKey ? window.NICON_GAMES[gameKey] : null;
    var eyebrow = document.createElement("div");
    eyebrow.className = "server-eyebrow";
    eyebrow.textContent = (game ? game.label : server.game || I18N.t("info.genericOption")) + " · " + protocolLabel(server.protocol);
    identity.appendChild(eyebrow);

    var h1 = document.createElement("h1");
    if (server.game_icon_url) {
      var gameIcon = document.createElement("img");
      gameIcon.className = "server-game-icon";
      gameIcon.src = server.game_icon_url;
      gameIcon.alt = "";
      gameIcon.addEventListener("error", function () { gameIcon.remove(); });
      h1.appendChild(gameIcon);
    }
    var dot = document.createElement("span");
    dot.className = "dot " + serverStatusClass(server);
    dot.title = serverStatusTooltip(server);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", serverStatusTooltip(server));
    h1.appendChild(dot);
    h1.appendChild(document.createTextNode(server.name));
    identity.appendChild(h1);

    var meta = document.createElement("div");
    meta.className = "server-meta";
    var status = document.createElement("span"); status.textContent = serverStatusTooltip(server); meta.appendChild(status);
    var playerCount = currentPlayerCount(server);
    var players = document.createElement("span"); players.className = "server-current-player-count"; players.textContent = I18N.t("workspace.playersNow") + ": " + (playerCount == null ? "—" : playerCount); meta.appendChild(players);
    var endpoint = document.createElement("span"); endpoint.className = "mono"; endpoint.textContent = server.host + ":" + server.port; meta.appendChild(endpoint);
    if (server.source === "nitrado") {
      var nitradoTag = document.createElement("span"); nitradoTag.className = "tag tag-nitrado"; nitradoTag.textContent = I18N.t("common.nitrado"); meta.appendChild(nitradoTag);
    }
    identity.appendChild(meta);
    head.appendChild(identity);

    var actions = document.createElement("div");
    actions.className = "head-actions";

    var toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = isConnected(server.id) ? "btn-secondary" : "btn-primary";
    if (isConnected(server.id)) {
      toggleBtn.textContent = I18N.t("content.disconnect");
      toggleBtn.addEventListener("click", function () {
        var c = consoles[server.id];
        if (c) disconnectConsole(c);
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

    var nitradoStatus = nitradoStatusKind(server.nitrado_resources && server.nitrado_resources.status);

    if (server.source === "nitrado" && nitradoStatus !== "offline") {
      var restartBtn = document.createElement("button");
      restartBtn.type = "button"; restartBtn.className = "btn-secondary"; restartBtn.textContent = I18N.t("content.nitradoRestart");
      restartBtn.disabled = !!nitradoPowerPending[server.id];
      restartBtn.addEventListener("click", function () { requestNitradoPower(server, "restart"); });
      actions.appendChild(restartBtn);
    }

    var menu = document.createElement("details"); menu.className = "server-actions-menu";
    var menuSummary = document.createElement("summary"); menuSummary.className = "icon-btn"; menuSummary.textContent = "•••"; menuSummary.setAttribute("aria-label", I18N.t("workspace.moreActions")); menu.appendChild(menuSummary);
    var menuBody = document.createElement("div"); menuBody.className = "server-actions-menu-body";

    if (server.source === "nitrado") {
      // Mirror Nitrado's own panel: Start only when known to be stopped
      // (or not yet loaded), Stop only when known to be running (or not
      // yet loaded) — calling either against the wrong state is what
      // produced Nitrado's misleading "game not found" 500 on start.
      ["start", "stop"].filter(function (action) {
        if (action === "start") return nitradoStatus !== "online";
        return nitradoStatus !== "offline";
      }).forEach(function (action) {
        var powerButton = document.createElement("button"); powerButton.type = "button"; powerButton.className = "server-menu-action"; powerButton.textContent = nitradoActionLabel(action); powerButton.disabled = !!nitradoPowerPending[server.id];
        powerButton.addEventListener("click", function () { menu.open = false; requestNitradoPower(server, action); }); menuBody.appendChild(powerButton);
      });
    }

    var editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "server-menu-action"; editBtn.textContent = I18N.t("common.edit");
    editBtn.addEventListener("click", function () { menu.open = false; openEditServerModal(server); }); menuBody.appendChild(editBtn);

    var layoutLabel = document.createElement("span"); layoutLabel.className = "server-menu-label"; layoutLabel.textContent = I18N.t("workspace.layout"); menuBody.appendChild(layoutLabel);
    var layout = localStorage.getItem("nicon_dashboard_layout") || "balanced";
    [["balanced", I18N.t("workspace.balanced")], ["wide", I18N.t("phase2.wide")], ["stacked", I18N.t("phase2.stack")], ["compact", I18N.t("workspace.compact")]].forEach(function (item) {
      var layoutButton = document.createElement("button"); layoutButton.type = "button"; layoutButton.className = "server-menu-action"; layoutButton.textContent = item[1]; layoutButton.setAttribute("aria-pressed", String(layout === item[0]));
      layoutButton.addEventListener("click", function () { menu.open = false; setDashboardLayout(item[0]); renderContent(); }); menuBody.appendChild(layoutButton);
    });

    var removeBtn = document.createElement("button"); removeBtn.type = "button"; removeBtn.className = "server-menu-action danger"; removeBtn.textContent = I18N.t("common.remove");
    removeBtn.setAttribute("aria-label", I18N.t("servers.removeAriaLabel", { name: server.name })); removeBtn.addEventListener("click", function () { menu.open = false; removeServer(server.id); }); menuBody.appendChild(removeBtn);
    menu.appendChild(menuBody); actions.appendChild(menu);

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

  var RECONNECT_BASE_DELAY_MS = 1000;
  var RECONNECT_MAX_DELAY_MS = 30000;

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
        manualDisconnect: false,
        reconnectTimer: null,
        reconnectAttempts: 0,
        followTail: true,
        scrollTop: 0,
        steamProfiles: {},
        steamRequested: {},
        moderationCooldowns: {},
      };
      consoles[server.id] = c;
    }
    c.server = server;
    c.manualDisconnect = false;
    c.reconnectAttempts = 0;
    clearConsoleReconnect(c);
    openConsoleSocket(c);
  }

  function clearConsoleReconnect(c) {
    if (!c.reconnectTimer) return;
    clearTimeout(c.reconnectTimer);
    c.reconnectTimer = null;
  }

  function disposeConsole(c) {
    c.manualDisconnect = true;
    clearConsoleReconnect(c);
    var socket = c.socket;
    c.socket = null;
    c.authenticated = false;
    c.gameConnected = false;
    c.pendingPlayersRequest = false;
    if (socket) socket.close();
  }

  function disconnectConsole(c) {
    var wasActive = !!(c.socket || c.reconnectTimer || c.gameConnected);
    disposeConsole(c);
    if (wasActive) appendConsoleLine(c, "system", I18N.t("console.disconnected"));
    markDisconnected(c);
    refreshIfActive(c);
  }

  function isFatalConsoleError(message) {
    return /unauthorized|must authenticate|server not found|no RCON password|invalid password|authentication failed/i.test(message || "");
  }

  function scheduleConsoleReconnect(c) {
    if (c.manualDisconnect || c.reconnectTimer || !authToken || consoles[c.server.id] !== c) return;
    var delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, c.reconnectAttempts));
    c.reconnectAttempts += 1;
    appendConsoleLine(c, "system", I18N.t("console.reconnectingIn", { seconds: Math.ceil(delay / 1000) }));
    refreshIfActive(c);
    c.reconnectTimer = setTimeout(function () {
      c.reconnectTimer = null;
      if (c.manualDisconnect || !authToken || consoles[c.server.id] !== c) return;
      openConsoleSocket(c);
    }, delay);
  }

  function openConsoleSocket(c) {
    if (c.manualDisconnect || !authToken || consoles[c.server.id] !== c) return;
    clearConsoleReconnect(c);

    var previousSocket = c.socket;
    c.socket = null;
    if (previousSocket) previousSocket.close();
    c.authenticated = false;
    c.gameConnected = false;
    c.pendingPlayersRequest = false;
    appendConsoleLine(c, "system", I18N.t("console.connecting"));
    refreshIfActive(c);

    var socket;
    try {
      socket = new WebSocket(relayWsUrl() + "/ws/rcon");
    } catch (err) {
      appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      recordHealthError(c.server.id, err.message || I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      scheduleConsoleReconnect(c);
      return;
    }
    c.socket = socket;

    socket.addEventListener("open", function () {
      if (c.socket !== socket) return;
      socket.send(JSON.stringify({ type: "auth", token: authToken }));
    });

    socket.addEventListener("message", function (event) {
      if (c.socket !== socket) return;
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
        socket.send(JSON.stringify({ type: "connect", server_id: c.server.id }));
      } else if (msg.type === "connected") {
        c.gameConnected = true;
        c.reconnectAttempts = 0;
        appendConsoleLine(c, "system", I18N.t("console.connected"));
        recordConnected(c.server.id);
        renderServers();
        if (selectedServerId === c.server.id) {
          renderHead(c.server);
          startPlayersAutoRefresh(c);
        }
      } else if (msg.type === "response") {
        appendConsoleLine(c, "response", msg.output && msg.output.length ? msg.output : I18N.t("console.noOutput"));
        if (c.pendingPlayersRequest) {
          c.pendingPlayersRequest = false;
          if (c.playersRequestSentAt) recordLatency(c.server.id, Date.now() - c.playersRequestSentAt, msg.relay_overhead_ms, msg.upstream_ms);
          var game = window.NICON_GAMES[c.gameKey];
          var parsed = game.parse(msg.output || "");
          c.lastParsed = parsed
            ? { ok: true, summary: parsed.summary, columns: parsed.columns, players: parsed.players }
            : { ok: false };
          if (parsed) {
            requestSteamProfiles(c, parsed.columns, parsed.players);
            apiFetch("/api/servers/" + c.server.id + "/player-sample", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ players: parsed.players.length }),
            }).then(function () {
              Object.keys(healthHistoryCache).forEach(function (key) {
                if (key.indexOf(c.server.id + ":") === 0) delete healthHistoryCache[key];
              });
            }).catch(function () { /* telemetry must never interrupt the console */ });
          }
          if (selectedServerId === c.server.id) {
            renderPlayersPanel(c);
            renderPlayersInto(serverPlayersList, c);
            updateServerPlayerCount(c.server);
            if (activeServerTab === "overview") renderServerOverview(c.server);
          }
        }
      } else if (msg.type === "broadcast") {
        // WebRCON servers (Rust) push chat/log lines unsolicited.
        handleBroadcastLine(c, msg.output || "");
      } else if (msg.type === "error") {
        var message = msg.message || "unknown relay error";
        appendConsoleLine(c, "error", message);
        c.pendingPlayersRequest = false;
        recordHealthError(c.server.id, message);
        // The relay tears down the game connection on any command error
        // (not just connect-time failures), so this always means "no
        // longer connected" — see the isConnected()/markDisconnected()
        // comment above.
        if (message === "unauthorized") {
          sessionExpired();
          return;
        }
        if (isFatalConsoleError(message)) c.manualDisconnect = true;
        markDisconnected(c);
        socket.close(); // close event schedules a retry for recoverable failures
      }
      refreshIfActive(c);
    });

    socket.addEventListener("close", function () {
      if (c.socket !== socket) return;
      c.socket = null;
      c.authenticated = false;
      appendConsoleLine(c, "system", I18N.t("console.disconnected"));
      markDisconnected(c);
      scheduleConsoleReconnect(c);
    });

    socket.addEventListener("error", function () {
      if (c.socket !== socket) return;
      appendConsoleLine(c, "error", I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
      recordHealthError(c.server.id, I18N.t("console.relayConnectionFailed", { url: relayHttpUrl() }));
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
    if (kind === "broadcast") kind = "chat";
    if (kind === "response" && /\b(warn(?:ing)?|caution)\b/i.test(text)) kind = "warning";
    if (kind === "response" && /\b(error|exception|fatal|failed)\b/i.test(text)) kind = "error";
    c.lines.push({ kind: kind, text: text });
    if (c.lines.length > MAX_CONSOLE_LOG_LINES) {
      c.lines.splice(0, c.lines.length - MAX_CONSOLE_LOG_LINES);
    }
  }

  function playerForLogLine(c, text) {
    if (!c.lastParsed || !c.lastParsed.ok) return null;
    var best = null;
    c.lastParsed.players.forEach(function (player) {
      var name = String(player.cells[0] || "");
      if (name && text.toLowerCase().indexOf(name.toLowerCase()) !== -1 && (!best || name.length > String(best.cells[0]).length)) best = player;
    });
    return best;
  }

  function handleBroadcastLine(c, text) {
    var matched = moderationRules.filter(function (rule) {
      return rule.enabled && text.toLowerCase().indexOf(rule.pattern.toLowerCase()) !== -1;
    });
    appendConsoleLine(c, matched.length ? "warning" : "chat", text);
    if (!matched.length) return;
    var player = playerForLogLine(c, text);
    var game = window.NICON_GAMES[c.gameKey];
    matched.forEach(function (rule) {
      if (rule.action === "highlight" || !player || !game) return;
      var build = rule.action === "kick" ? game.kick : game.mute;
      var command = build ? build(player) : null;
      var cooldownKey = rule.id + ":" + player.id;
      if ((c.moderationCooldowns[cooldownKey] || 0) > Date.now()) return;
      if (!command) {
        c.moderationCooldowns[cooldownKey] = Date.now() + 60000;
        appendConsoleLine(c, "system", "Moderation: " + rule.action + " is not supported for " + (game.label || c.gameKey));
        return;
      }
      c.moderationCooldowns[cooldownKey] = Date.now() + 60000;
      sendConsoleCommand(c, command, {
        origin: "automatic_moderation",
        action: rule.action,
        targetPlayer: player.cells[0] || player.id,
      });
      appendConsoleLine(c, "system", "Moderation: " + rule.action + " → " + (player.cells[0] || player.id));
    });
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

  var renderingConsoleLog = false;

  function updateConsoleFollowButton(c) {
    consoleFollowBtn.hidden = !c || c.followTail !== false;
  }

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
    var previousScrollTop = c ? c.scrollTop : 0;
    renderingConsoleLog = true;
    log.innerHTML = "";
    if (!c) {
      renderingConsoleLog = false;
      updateConsoleFollowButton(null);
      return;
    }
    var regex = activeFilterRegex();

    c.lines.forEach(function (line) {
      if (regex && !regex.test(line.text)) return;
      var div = document.createElement("div");
      div.className = "log-line kind-" + line.kind;
      appendHighlighted(div, line.text, regex);
      log.appendChild(div);
    });
    if (c.followTail !== false) {
      log.scrollTop = log.scrollHeight;
    } else {
      log.scrollTop = previousScrollTop;
    }
    c.scrollTop = log.scrollTop;
    renderingConsoleLog = false;
    updateConsoleFollowButton(c);
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

  log.addEventListener("scroll", function () {
    if (renderingConsoleLog) return;
    var c = consoles[selectedServerId];
    if (!c) return;
    c.scrollTop = log.scrollTop;
    c.followTail = log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
    updateConsoleFollowButton(c);
  });

  consoleFollowBtn.addEventListener("click", function () {
    var c = consoles[selectedServerId];
    if (!c) return;
    c.followTail = true;
    renderLog(c);
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
    renderPlayersInto(serverPlayersList, c);
    updateServerPlayerCount(c.server);
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
  function sendConsoleCommand(c, command, audit) {
    if (!c || !command || !c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return false;
    appendConsoleLine(c, "sent", "> " + command);
    refreshIfActive(c);
    var message = { type: "command", command: command };
    if (audit) {
      message.audit_origin = audit.origin || "manual";
      message.audit_action = audit.action || "command";
      if (audit.targetPlayer) message.target_player = String(audit.targetPlayer);
    }
    c.socket.send(JSON.stringify(message));
    return true;
  }

  function requestPlayers(c) {
    if (!c.gameKey) {
      if (selectedServerId === c.server.id) {
        renderPlayersPanel(c);
        renderPlayersInto(serverPlayersList, c);
      }
      return;
    }
    if (!c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
    var game = window.NICON_GAMES[c.gameKey];
    c.pendingPlayersRequest = true;
    c.playersRequestSentAt = Date.now();
    sendConsoleCommand(c, game.command, { origin: "system", action: "player_poll" });
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

  function playersHint(container, text) {
    container.innerHTML = "";
    var notice = document.createElement("p");
    notice.className = "hint";
    notice.textContent = text;
    container.appendChild(notice);
  }

  function renderPlayersPanel(c) {
    renderPlayersInto(playersPanel, c);
  }

  function renderPlayersInto(container, c) {
    container.innerHTML = "";
    if (!c) return;
    if (!c.gameKey) {
      playersHint(container, I18N.t("info.genericOption"));
      return;
    }
    if (!c.lastParsed) return; // waiting on the first response

    var game = window.NICON_GAMES[c.gameKey];
    if (!c.lastParsed.ok) {
      playersHint(container, I18N.t("info.couldNotParse", { game: game.label }));
      return;
    }

    var summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = c.lastParsed.summary;
    container.appendChild(summary);

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
      row.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        openPlayerContextMenu(event.clientX, event.clientY, c, game, player);
      });

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
            sendPlayerAction(c, kickCmd, I18N.t("players.kickConfirm", { name: label }), "kick", label);
          }));
          if (banCmd) actions.appendChild(playerActionButton(I18N.t("players.ban"), true, function () {
            sendPlayerAction(c, banCmd, I18N.t("players.banConfirm", { name: label }), "ban", label);
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
        var steamIndex = columns.indexOf("steamid");
        if (steamIndex !== -1) appendSteamProfile(details, c.steamProfiles[String(player.cells[steamIndex] || "")]);
        row.appendChild(details);
      }

      list.appendChild(row);
    });
    container.appendChild(list);
  }

  function requestSteamProfiles(c, columns, players) {
    var index = columns.indexOf("steamid");
    if (index === -1) return;
    var ids = players.map(function (player) { return String(player.cells[index] || ""); })
      .filter(function (id) { return /^7656119\d{10}$/.test(id) && !c.steamRequested[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { c.steamRequested[id] = true; });
    apiFetch("/api/steam/players", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steamids: ids.slice(0, 100) }),
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("Steam unavailable")); })
      .then(function (data) {
        (data.players || []).forEach(function (profile) { c.steamProfiles[profile.steamid] = profile; });
        if (selectedServerId === c.server.id) {
          renderPlayersPanel(c);
          renderPlayersInto(serverPlayersList, c);
        }
      }).catch(function () { /* optional integration */ });
  }

  function appendSteamProfile(container, profile) {
    if (!profile) return;
    var line = document.createElement("div"); line.className = "steam-profile";
    if (profile.profile_url) {
      var link = document.createElement("a"); link.href = profile.profile_url; link.target = "_blank"; link.rel = "noopener";
      link.textContent = profile.name || "Steam profile"; line.appendChild(link);
    }
    if (profile.vac_banned || profile.community_banned || profile.game_bans > 0) {
      var risk = document.createElement("span"); risk.className = "steam-risk";
      risk.textContent = "VAC " + (profile.vac_bans || 0) + " · Game bans " + (profile.game_bans || 0); line.appendChild(risk);
    }
    if (profile.created_at && Date.now() / 1000 - profile.created_at < 30 * 86400) {
      var fresh = document.createElement("span"); fresh.className = "steam-fresh"; fresh.textContent = "New account"; line.appendChild(fresh);
    }
    container.appendChild(line);
  }

  var contextPlayerAction = null;
  function openPlayerContextMenu(x, y, c, game, player) {
    contextPlayerAction = { c: c, game: game, player: player };
    ["kick", "ban", "mute", "whisper"].forEach(function (action) {
      var button = playerContextMenu.querySelector('[data-player-action="' + action + '"]');
      button.disabled = !game[action] || player.isAdmin;
    });
    playerContextMenu.hidden = false;
    playerContextMenu.style.left = Math.min(x, window.innerWidth - 170) + "px";
    playerContextMenu.style.top = Math.min(y, window.innerHeight - 170) + "px";
  }

  document.addEventListener("click", function (event) {
    if (!playerContextMenu.contains(event.target)) playerContextMenu.hidden = true;
  });
  playerContextMenu.addEventListener("click", function (event) {
    var action = event.target.dataset.playerAction;
    var target = contextPlayerAction;
    playerContextMenu.hidden = true;
    if (!action || !target || !target.game[action]) return;
    if (action === "whisper") {
      playerMessageInput.value = ""; playerMessageModal.showModal(); playerMessageInput.focus(); return;
    }
    var command = target.game[action](target.player);
    if (command) {
      var targetLabel = target.player.cells[0] || target.player.id;
      sendPlayerAction(target.c, command, action + " " + targetLabel + "?", action, targetLabel);
    }
  });
  playerMessageClose.addEventListener("click", function () { playerMessageModal.close(); });
  playerMessageForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var target = contextPlayerAction;
    if (target && target.game.whisper) sendConsoleCommand(
      target.c,
      target.game.whisper(target.player, playerMessageInput.value.trim()),
      { origin: "player_action", action: "whisper", targetPlayer: target.player.cells[0] || target.player.id }
    );
    playerMessageModal.close();
  });

  function playerActionButton(text, danger, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-xs" + (danger ? " btn-xs-danger" : "");
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function sendPlayerAction(c, command, confirmMessage, action, targetPlayer) {
    showConfirm(confirmMessage).then(function (ok) {
      if (!ok) return;
      if (!sendConsoleCommand(c, command, { origin: "player_action", action: action, targetPlayer: targetPlayer })) return;
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
    // Most recently sent first. .forEach() (not a for-loop reusing one
    // `var`) so each button's click handler closes over its own `command`
    // — a shared `var` across loop iterations would make every button
    // recall whichever entry the loop last visited, not the one clicked.
    entries.slice().reverse().forEach(function (command) {
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
    });
  }

  cmdHistoryBtn.addEventListener("click", function () {
    var wasHidden = cmdHistoryPanel.hidden;
    cmdTemplatesPanel.hidden = true; // only one of History/Templates open at a time
    moderationRulesPanel.hidden = true;
    cmdHistoryPanel.hidden = !wasHidden;
    if (wasHidden) renderCommandHistory(consoles[selectedServerId]);
  });

  // Shell-style Up/Down recall: Up steps backward through this console's
  // history (saving whatever was being typed so Down can return to it),
  // Down steps forward and clears back to that saved draft at the end.
  cmdInput.addEventListener("keydown", function (e) {
    if (e.key === "Tab" && !cmdSuggestions.hidden) {
      var first = cmdSuggestions.querySelector("button");
      if (first) { e.preventDefault(); cmdInput.value = first.dataset.command; cmdSuggestions.hidden = true; }
      return;
    }
    if (e.key === "Escape") { cmdSuggestions.hidden = true; return; }
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

  cmdInput.addEventListener("input", function () {
    cmdSuggestions.innerHTML = "";
    var c = consoles[selectedServerId];
    var game = c && window.NICON_GAMES[c.gameKey];
    var prefix = cmdInput.value.trim().toLowerCase();
    var commands = (game && game.commands ? game.commands : []).concat((c && c.history) || []);
    var unique = commands.filter(function (command, index, all) { return all.indexOf(command) === index; })
      .filter(function (command) { return prefix && command.toLowerCase().indexOf(prefix) === 0 && command.toLowerCase() !== prefix; }).slice(0, 8);
    unique.forEach(function (command) {
      var button = document.createElement("button"); button.type = "button"; button.dataset.command = command; button.textContent = command;
      button.addEventListener("click", function () { cmdInput.value = command; cmdSuggestions.hidden = true; cmdInput.focus(); });
      cmdSuggestions.appendChild(button);
    });
    cmdSuggestions.hidden = !unique.length;
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

  function sendMacro(c, source) {
    var steps = source.split(/\r?\n/).map(function (line) { return line.trim(); })
      .filter(function (line) { return line && line.charAt(0) !== "#"; }).slice(0, 20);
    if (!steps.length) return;
    var index = 0;
    function next() {
      if (index >= steps.length) return;
      var step = steps[index++];
      var wait = step.match(/^@wait\s+([0-9]+(?:\.[0-9]+)?)$/i);
      if (wait) { setTimeout(next, Math.min(10, Number(wait[1])) * 1000); return; }
      if (!sendConsoleCommand(c, step, { origin: "macro", action: "macro" })) return;
      setTimeout(next, 750);
    }
    next();
  }

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
        if (c) sendMacro(c, tpl.command);
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
    moderationRulesPanel.hidden = true;
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

  // --- word filters and automated moderation ---
  var moderationRules = [];

  function loadModerationRules() {
    return apiFetch("/api/moderation-rules")
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rules) { moderationRules = rules || []; renderModerationRules(); })
      .catch(function () { moderationRules = []; });
  }

  function renderModerationRules() {
    moderationRulesList.innerHTML = "";
    if (!moderationRules.length) {
      var empty = document.createElement("p"); empty.className = "hint"; empty.textContent = I18N.t("phase2.noRules");
      moderationRulesList.appendChild(empty); return;
    }
    moderationRules.forEach(function (rule) {
      var row = document.createElement("div"); row.className = "cmd-template-row";
      var info = document.createElement("div"); info.className = "template-info";
      var name = document.createElement("span"); name.className = "template-name"; name.textContent = rule.pattern;
      var action = document.createElement("span"); action.className = "template-command";
      action.textContent = rule.action === "highlight" ? I18N.t("phase2.highlight") : (rule.action === "mute" ? I18N.t("phase2.autoMute") : I18N.t("phase2.autoKick"));
      info.appendChild(name); info.appendChild(action); row.appendChild(info);
      var remove = document.createElement("button"); remove.type = "button"; remove.className = "btn-xs btn-xs-danger"; remove.textContent = I18N.t("templates.delete");
      remove.addEventListener("click", function () {
        apiFetch("/api/moderation-rules/" + rule.id, { method: "DELETE" }).then(function (r) {
          if (!r.ok && r.status !== 204) throw new Error("Could not delete rule");
          moderationRules = moderationRules.filter(function (item) { return item.id !== rule.id; }); renderModerationRules();
        }).catch(function (error) { showToast(error.message); });
      });
      row.appendChild(remove); moderationRulesList.appendChild(row);
    });
  }

  moderationRulesBtn.addEventListener("click", function () {
    var show = moderationRulesPanel.hidden;
    cmdTemplatesPanel.hidden = true; cmdHistoryPanel.hidden = true;
    moderationRulesPanel.hidden = !show;
  });
  moderationRuleForm.addEventListener("submit", function (event) {
    event.preventDefault();
    apiFetch("/api/moderation-rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern: moderationPatternInput.value.trim(), action: moderationActionSelect.value }),
    }).then(function (r) { return r.ok ? r.json() : r.text().then(function (text) { throw new Error(apiErrorMessage(text)); }); })
      .then(function (rule) { moderationRules.push(rule); moderationRuleForm.reset(); renderModerationRules(); })
      .catch(function (error) { showToast(error.message); });
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
      sendConsoleCommand(c, def.build(), { origin: "quick_action", action: def.id });
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
    if (command) sendConsoleCommand(c, command, { origin: "quick_action", action: def.id });
  });

  // --- welcome screen: supported games list ---
  // Driven by NICON_GAMES itself (docs/games.js) rather than a hand-kept
  // duplicate list here, so it can't drift when a game is added/removed.

  // This badge deliberately means a real game-server verification, not
  // merely a passing parser fixture or protocol mock. The detailed and
  // more granular evidence lives in docs/compatibility.md.
  var TESTED_GAMES = ["rust", "sevendaystodie", "dayz", "arksurvivalascended", "minecraft", "palworld"];

  function renderSupportedGamesList() {
    supportedGamesList.innerHTML = "";
    Object.keys(window.NICON_GAMES).forEach(function (key) {
      var tested = TESTED_GAMES.indexOf(key) !== -1;
      var game = window.NICON_GAMES[key];
      var li = document.createElement("li");
      li.setAttribute("aria-label", game.label);
      li.title = game.label;

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
      li.appendChild(image);
      li.appendChild(fallback);

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
        li.appendChild(logo);
      }

      var tag = document.createElement("span");
      tag.className = "tag " + (tested ? "tag-tested" : "tag-untested");
      tag.textContent = I18N.t(tested ? "welcome.tested" : "welcome.untested");
      li.appendChild(tag);
      supportedGamesList.appendChild(li);
    });
  }

  // --- boot ---

  I18N.applyStatic(document);
  registerServiceWorker();
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
