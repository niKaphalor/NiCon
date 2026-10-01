// Language switch, toasts, confirm dialogs and the PWA install/update flow.
import { renderModerationRules } from "./commands.js";
import { disposeConsole } from "./console.js";
import { renderContent } from "./detail.js";
import { accountUsernameLine, langCurrentBtn, langCurrentFlag, langCurrentName, langOptions, langWidget, loginError, navSettingsBtn, pwaInstallBtn, viewFaq } from "./dom.js";
import { loadFaq } from "./faq.js";
import { renderServers } from "./servers.js";
import { I18N, clearAuthState, state } from "./state.js";
import { showAppView, showLoginView, showSettingsView } from "./views.js";
import { renderSupportedGamesList } from "./welcome.js";

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
  if (!viewFaq.hidden) loadFaq();
  if (state.authToken) accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: state.currentUsername });
});

navSettingsBtn.addEventListener("click", showSettingsView);

// The brand mark doubles as a "home" link — the only way back from the
// (always-reachable) settings page when signed out, and a quick way
// back to the server list from anywhere when signed in.
document.querySelector(".wordmark").addEventListener("click", function () {
  if (state.authToken) showAppView();
  else showLoginView();
});

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

export function showToast(message, type, action) {
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
state.deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", function (event) {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  pwaInstallBtn.hidden = false;
});
window.addEventListener("appinstalled", function () {
  state.deferredInstallPrompt = null;
  pwaInstallBtn.hidden = true;
});
pwaInstallBtn.addEventListener("click", function () {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  Promise.resolve(state.deferredInstallPrompt.userChoice).finally(function () {
    state.deferredInstallPrompt = null;
    pwaInstallBtn.hidden = true;
  });
});

state.offeredPwaWorker = null;
state.activatingPwaUpdate = false;
function offerPwaUpdate(worker) {
  if (!worker || state.offeredPwaWorker === worker) return;
  state.offeredPwaWorker = worker;
  showToast(I18N.t("pwa.updateAvailable"), "info", {
    label: I18N.t("pwa.updateNow"),
    persistent: true,
    onClick: function () {
      state.activatingPwaUpdate = true;
      worker.postMessage({ type: "SKIP_WAITING" });
    },
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  var reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    // clients.claim() also fires controllerchange after the very first
    // install. Reload only when this page explicitly activated an update.
    if (!state.activatingPwaUpdate || reloading) return;
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
var confirmDialogPassword = document.getElementById("confirm-dialog-password");
state.pendingConfirmResolve = null;
state.pendingConfirmNeedsPassword = false;

export function showConfirm(message) {
  confirmDialogMessage.textContent = message;
  confirmDialogPassword.hidden = true;
  confirmDialogPassword.value = "";
  state.pendingConfirmNeedsPassword = false;
  confirmDialog.showModal();
  return new Promise(function (resolve) {
    state.pendingConfirmResolve = resolve;
  });
}

// Step-up variant of showConfirm(): the same dialog plus a password
// field. Resolves to the typed password (never an empty string), or
// null if cancelled. Destructive and credential-level actions ask for
// the current password again so a stolen or unattended session alone
// can't trigger them — the API enforces this too (current_password).
export function showPasswordConfirm(message) {
  confirmDialogMessage.textContent = message;
  confirmDialogPassword.hidden = false;
  confirmDialogPassword.value = "";
  state.pendingConfirmNeedsPassword = true;
  confirmDialog.showModal();
  confirmDialogPassword.focus();
  return new Promise(function (resolve) {
    state.pendingConfirmResolve = resolve;
  });
}

confirmDialogCancel.addEventListener("click", function () { confirmDialog.close(); });
confirmDialogOk.addEventListener("click", function () {
  var password = confirmDialogPassword.value;
  if (state.pendingConfirmNeedsPassword && password === "") {
    confirmDialogPassword.focus();
    return;
  }
  // Resolve before close() — the 'close' handler below would otherwise
  // also see a pending resolver and settle it a second time as false.
  var resolve = state.pendingConfirmResolve;
  var needsPassword = state.pendingConfirmNeedsPassword;
  state.pendingConfirmResolve = null;
  confirmDialogPassword.value = "";
  confirmDialog.close();
  if (resolve) resolve(needsPassword ? password : true);
});
confirmDialogPassword.addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); confirmDialogOk.click(); }
});
confirmDialog.addEventListener("click", function (e) {
  if (e.target === confirmDialog) confirmDialog.close(); // backdrop click = cancel
});
// Covers every other way the dialog can close — Cancel, backdrop click,
// Escape — as a single "still pending means it wasn't confirmed" fallback.
confirmDialog.addEventListener("close", function () {
  var resolve = state.pendingConfirmResolve;
  var needsPassword = state.pendingConfirmNeedsPassword;
  state.pendingConfirmResolve = null;
  confirmDialogPassword.value = "";
  if (resolve) resolve(needsPassword ? null : false);
});

export function sessionExpired() {
  clearAuthState();
  disconnectAllConsoles();
  state.servers = [];
  showLoginView();
  loginError.textContent = I18N.t("errors.sessionExpired");
  loginError.hidden = false;
}

export function disconnectAllConsoles() {
  Object.keys(state.consoles).forEach(function (id) {
    disposeConsole(state.consoles[id]);
  });
  state.consoles = {};
  state.selectedServerId = null;
}
