// Every element of index.html the app touches, looked up once.
import { state } from "./state.js";

// --- element refs ---

export var apiPill = document.getElementById("api-pill");
export var apiBanner = document.getElementById("api-banner");

export var relayPill = document.getElementById("relay-pill");
export var relayBanner = document.getElementById("relay-banner");

export var usernameLabel = document.getElementById("username-label");
export var logoutBtn = document.getElementById("logout-btn");
export var pwaInstallBtn = document.getElementById("pwa-install-btn");
export var langWidget = document.getElementById("lang-widget");
export var langCurrentBtn = document.getElementById("lang-current");
export var langCurrentFlag = document.getElementById("lang-current-flag");
export var langCurrentName = document.getElementById("lang-current-name");
export var langOptions = document.getElementById("lang-options");

export var navServersBtn = document.getElementById("nav-servers-btn");
export var navHealthBtn = document.getElementById("nav-health-btn");
export var navSettingsBtn = document.getElementById("nav-settings-btn");
export var navFaqBtn = document.getElementById("nav-faq-btn");
export var viewFaq = document.getElementById("view-faq");
export var faqList = document.getElementById("faq-list");
export var faqStatus = document.getElementById("faq-status");
export var adminNavBtn = document.getElementById("admin-nav-btn");
export var addServerBtn = document.getElementById("add-server-btn");

export var authShell = document.getElementById("auth-shell");
export var viewLogin = document.getElementById("view-login");
export var loginForm = document.getElementById("login-form");
export var loginError = document.getElementById("login-error");
export var showRegisterBtn = document.getElementById("show-register-btn");

export var viewRegister = document.getElementById("view-register");
export var registerForm = document.getElementById("register-form");
export var registerError = document.getElementById("register-error");
export var showLoginBtn = document.getElementById("show-login-btn");

export var showResetBtn = document.getElementById("show-reset-btn");
export var resetModal = document.getElementById("reset-modal");
export var resetClose = document.getElementById("reset-close");
export var resetForm = document.getElementById("reset-form");
export var resetError = document.getElementById("reset-error");

export var recoveryModal = document.getElementById("recovery-modal");
export var recoveryCodeEl = document.getElementById("recovery-code");
export var recoveryCopyBtn = document.getElementById("recovery-copy-btn");
export var recoveryAckCheckbox = document.getElementById("recovery-ack");
export var recoveryContinueBtn = document.getElementById("recovery-continue-btn");

export var viewApp = document.getElementById("view-app");
export var serverSearch = document.getElementById("server-search");
export var serverList = document.getElementById("server-list");
export var contentPane = document.getElementById("content");

export var contentEmpty = document.getElementById("content-empty");
export var contentEmptyText = document.getElementById("content-empty-text");
export var supportedGamesList = document.getElementById("supported-games-list");
export var supportedGamesCount = document.getElementById("supported-games-count");
export var emptyAddBtn = document.getElementById("empty-add-btn");
export var contentPassword = document.getElementById("content-password");
export var passwordServerName = document.getElementById("password-server-name");
export var passwordPublicStatus = document.getElementById("password-public-status");
export var passwordPublicStatusValues = document.getElementById("password-public-status-values");
export var passwordPowerActions = document.getElementById("password-power-actions");
export var passwordForm = document.getElementById("password-form");
export var passwordInput = document.getElementById("password-input");
export var passwordEditServerBtn = document.getElementById("password-edit-server-btn");
export var contentConsole = document.getElementById("content-console");
export var head = document.getElementById("head");
export var serverTabs = document.getElementById("server-tabs");
export var serverTabButtons = serverTabs.querySelectorAll("[data-server-tab]");
export var serverOverviewPanel = document.getElementById("server-overview-panel");
export var serverOverviewRange = document.getElementById("server-overview-range");
export var serverOverviewContent = document.getElementById("server-overview-content");
export var serverConsolePanel = document.getElementById("server-console-panel");
export var serverPlayersPanel = document.getElementById("server-players-panel");
export var serverPlayersList = document.getElementById("server-players-list");
export var serverPlayerCount = document.getElementById("server-player-count");
export var serverAuditPanel = document.getElementById("server-audit-panel");
export var serverAuditList = document.getElementById("server-audit-list");

export var viewSettings = document.getElementById("view-settings");
export var privacyCard = document.getElementById("privacy-card");
export var exportDataBtn = document.getElementById("export-data-btn");
export var accountCard = document.getElementById("account-card");
export var activityCard = document.getElementById("activity-card");
export var activityList = document.getElementById("activity-list");
export var accountUsernameLine = document.getElementById("account-username-line");
export var accountDangerZone = document.getElementById("account-danger-zone");
export var deleteAccountBtn = document.getElementById("delete-account-btn");
export var changeUsernameForm = document.getElementById("change-username-form");
export var newUsernameInput = document.getElementById("new-username-input");
export var usernameCurrentPasswordInput = document.getElementById("username-current-password-input");
export var changeUsernameError = document.getElementById("change-username-error");
export var changePasswordForm = document.getElementById("change-password-form");
export var passwordCurrentPasswordInput = document.getElementById("password-current-password-input");
export var newPasswordInput = document.getElementById("new-password-input");
export var newPasswordConfirmInput = document.getElementById("new-password-confirm-input");
export var changePasswordError = document.getElementById("change-password-error");

export var notificationsBellBtn = document.getElementById("notifications-bell-btn");
export var notificationsBadge = document.getElementById("notifications-badge");
export var notificationsModal = document.getElementById("notifications-modal");
export var notificationsClose = document.getElementById("notifications-close");
export var notificationsList = document.getElementById("notifications-list");

export var viewAdmin = document.getElementById("view-admin");
export var adminUsersBody = document.getElementById("admin-users-body");
export var notificationForm = document.getElementById("notification-form");
export var notificationType = document.getElementById("notification-type");
export var notificationMessage = document.getElementById("notification-message");
export var adminNotificationsList = document.getElementById("admin-notifications-list");
export var adminAuditLogList = document.getElementById("admin-audit-log-list");
export var faqEditorForm = document.getElementById("faq-editor-form");
export var faqEditorId = document.getElementById("faq-editor-id");
export var faqQuestionDe = document.getElementById("faq-question-de");
export var faqAnswerDe = document.getElementById("faq-answer-de");
export var faqQuestionEn = document.getElementById("faq-question-en");
export var faqAnswerEn = document.getElementById("faq-answer-en");
export var faqSortOrder = document.getElementById("faq-sort-order");
export var faqPublished = document.getElementById("faq-published");
export var faqEditorCancel = document.getElementById("faq-editor-cancel");
export var adminFaqList = document.getElementById("admin-faq-list");

export var viewHealth = document.getElementById("view-health");
export var healthBody = document.getElementById("health-body");
export var healthRangeSelect = document.getElementById("health-range-select");

export var addModal = document.getElementById("add-modal");
export var addClose = document.getElementById("add-close");
export var addTabs = document.querySelectorAll(".tab");
export var addTabPanels = document.querySelectorAll(".tab-panel");
export var nitradoForm = document.getElementById("nitrado-form");
export var nitradoTokenInput = document.getElementById("nitrado-token");
export var nitradoTokenStatus = document.getElementById("nitrado-token-status");
export var forgetNitradoTokenBtn = document.getElementById("forget-nitrado-token-btn");
export var nitradoSettingsCard = document.getElementById("nitrado-settings-card");
export var settingsNitradoForm = document.getElementById("settings-nitrado-form");
export var settingsNitradoTokenInput = document.getElementById("settings-nitrado-token");
export var settingsNitradoTokenStatus = document.getElementById("settings-nitrado-token-status");
export var settingsForgetNitradoTokenBtn = document.getElementById("settings-forget-nitrado-token-btn");
export var manualForm = document.getElementById("manual-form");
export var manualTestBtn = document.getElementById("manual-test-btn");
export var manualQueryTestBtn = document.getElementById("manual-query-test-btn");
export var manualTestStatus = document.getElementById("manual-test-status");
export var manualQueryTestStatus = document.getElementById("manual-query-test-status");
export var manualGameSelect = document.getElementById("manual-game");
export var manualQueryProtocol = document.getElementById("manual-query-protocol");
export var manualQueryPort = document.getElementById("manual-query-port");

export var editServerModal = document.getElementById("edit-server-modal");
export var editServerClose = document.getElementById("edit-server-close");
export var editServerForm = document.getElementById("edit-server-form");
export var editServerName = document.getElementById("edit-server-name");
export var editServerHost = document.getElementById("edit-server-host");
export var editServerPort = document.getElementById("edit-server-port");
export var editServerProtocol = document.getElementById("edit-server-protocol");
export var editServerGame = document.getElementById("edit-server-game");
export var editServerQueryProtocol = document.getElementById("edit-server-query-protocol");
export var editServerQueryPort = document.getElementById("edit-server-query-port");
export var editServerQueryTestBtn = document.getElementById("edit-server-query-test-btn");
export var editServerQueryTestStatus = document.getElementById("edit-server-query-test-status");
export var editServerPassword = document.getElementById("edit-server-password");
export var editServerError = document.getElementById("edit-server-error");
export var editServerNitradoHint = document.getElementById("edit-server-nitrado-hint");
state.editingServerId = null;

export var filterInput = document.getElementById("filter-input");
export var filterRegexToggle = document.getElementById("filter-regex-toggle");
export var consoleFollowBtn = document.getElementById("console-follow-btn");
export var consoleCopyBtn = document.getElementById("console-copy-btn");
export var consoleClearBtn = document.getElementById("console-clear-btn");
export var cmdHistoryBtn = document.getElementById("cmd-history-btn");
export var cmdHistoryPanel = document.getElementById("cmd-history-panel");
export var cmdTemplatesBtn = document.getElementById("cmd-templates-btn");
export var cmdTemplatesPanel = document.getElementById("cmd-templates-panel");
export var cmdTemplatesList = document.getElementById("cmd-templates-list");
export var cmdTemplateAddForm = document.getElementById("cmd-template-add-form");
export var cmdTemplateNameInput = document.getElementById("cmd-template-name-input");
export var cmdTemplateCommandInput = document.getElementById("cmd-template-command-input");
export var cmdTemplateError = document.getElementById("cmd-template-error");
export var moderationRulesBtn = document.getElementById("moderation-rules-btn");
export var moderationRulesPanel = document.getElementById("moderation-rules-panel");
export var moderationRulesList = document.getElementById("moderation-rules-list");
export var moderationRuleForm = document.getElementById("moderation-rule-form");
export var moderationPatternInput = document.getElementById("moderation-pattern-input");
export var moderationActionSelect = document.getElementById("moderation-action-select");
export var log = document.getElementById("log");
export var cmdForm = document.getElementById("cmd-form");
export var cmdInput = document.getElementById("cmd-input");
export var cmdSuggestions = document.getElementById("cmd-suggestions");
export var cmdSendBtn = cmdForm.querySelector("button[type=submit]");

export var quickCmdBar = document.getElementById("quick-cmd-bar");
export var quickCmdModal = document.getElementById("quick-command-modal");
export var quickCmdModalTitle = document.getElementById("quick-command-modal-title");
export var quickCmdModalClose = document.getElementById("quick-command-modal-close");
export var quickCmdModalWarning = document.getElementById("quick-command-modal-warning");
export var quickCmdModalForm = document.getElementById("quick-command-modal-form");
export var quickCmdModalMessage = document.getElementById("quick-command-modal-message");
export var quickCmdModalError = document.getElementById("quick-command-modal-error");
export var quickCmdModalConfirm = document.getElementById("quick-command-modal-confirm");

export var playersPanel = document.getElementById("players-panel");
export var playerContextMenu = document.getElementById("player-context-menu");
export var playerMessageModal = document.getElementById("player-message-modal");
export var playerMessageClose = document.getElementById("player-message-close");
export var playerMessageForm = document.getElementById("player-message-form");
export var playerMessageInput = document.getElementById("player-message-input");
export var nitradoResourcesCard = document.getElementById("nitrado-resources-card");
export var nitradoResources = document.getElementById("nitrado-resources");
