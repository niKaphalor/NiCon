// Mutable state and constants shared by all modules (the session, the server list, open consoles, ...).
// Mutable state shared by the modules. Modules cannot assign to each other's
// bindings, so everything that is reassigned lives on this one object.
export var state = {
authToken: undefined,
currentUsername: undefined,
currentIsAdmin: undefined,
servers: undefined,
searchQuery: undefined,
consoles: undefined,
selectedServerId: undefined,
activeServerTab: undefined,
activityPage: undefined,
adminAuditPage: undefined,
serverAuditPage: undefined,
serverAuditServerId: undefined,
editingServerId: undefined,
deferredInstallPrompt: undefined,
offeredPwaWorker: undefined,
activatingPwaUpdate: undefined,
pendingConfirmResolve: undefined,
pendingConfirmNeedsPassword: undefined,
pendingRecoveryContinue: undefined,
hasNitradoToken: undefined,
faqLoadSeq: undefined,
adminUsersPage: undefined,
adminNoticesPage: undefined,
adminFaqPage: undefined,
lastNotifications: undefined,
serverHealth: undefined,
logRenderScheduled: undefined,
renderingConsoleLog: undefined,
lastRenderedLogConsole: undefined,
activePlayersTimer: undefined,
contextPlayerAction: undefined,
commandTemplates: undefined,
moderationRules: undefined,
pendingQuickCommand: undefined,
};

export var I18N = window.NICON_I18N;

// The session token lives in sessionStorage (cleared when the tab
// closes, unlike localStorage) so a reload doesn't force a re-login but
// nothing survives beyond this browser session. Everything else —
// server list, console state — is fetched fresh from the relay/database
// each time, never cached to disk.
var TOKEN_KEY = "nicon_token";
export var USERNAME_KEY = "nicon_username";
var IS_ADMIN_KEY = "nicon_is_admin";
state.authToken = null;
state.currentUsername = "";
state.currentIsAdmin = false;
try {
  state.authToken = sessionStorage.getItem(TOKEN_KEY);
  state.currentUsername = sessionStorage.getItem(USERNAME_KEY) || "";
  state.currentIsAdmin = sessionStorage.getItem(IS_ADMIN_KEY) === "1";
} catch (e) {
  // Some browser contexts (e.g. a private window with storage blocked)
  // throw on access; fall back to session-memory-only auth.
}

export function setAuthState(token, username, isAdmin) {
  state.authToken = token;
  state.currentUsername = username;
  state.currentIsAdmin = !!isAdmin;
  try {
    sessionStorage.setItem(TOKEN_KEY, state.authToken);
    sessionStorage.setItem(USERNAME_KEY, state.currentUsername);
    sessionStorage.setItem(IS_ADMIN_KEY, state.currentIsAdmin ? "1" : "0");
  } catch (e) { /* ignore */ }
}

export function clearAuthState() {
  state.authToken = null;
  state.currentIsAdmin = false;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USERNAME_KEY);
    sessionStorage.removeItem(IS_ADMIN_KEY);
  } catch (e) { /* ignore */ }
}

state.servers = [];
state.searchQuery = "";

// One entry per currently-open console: serverId -> { server, socket,
// lines: [{kind, text}], pendingPlayersRequest, authenticated }. A
// server can be selected in the sidebar without a console entry (not
// connected yet, or missing a saved password).
state.consoles = {};
export var nitradoPowerPending = {};
state.selectedServerId = null;
state.activeServerTab = "console";
export var AUDIT_PER_PAGE = 25;     // admin audit log
export var ACTIVITY_PER_PAGE = 10;  // own activity and the per-server audit list (narrower cards)
state.activityPage = 1;
state.adminAuditPage = 1;
state.serverAuditPage = 1;
state.serverAuditServerId = null;
