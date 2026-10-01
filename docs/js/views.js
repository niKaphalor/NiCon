// Switching between the login, app, settings, health, FAQ and admin views.
import { loadActivity } from "./admin.js";
import { loadAccountInfo } from "./auth.js";
import { loadCommandTemplates, loadModerationRules } from "./commands.js";
import { renderContent } from "./detail.js";
import { accountCard, accountDangerZone, accountUsernameLine, activityCard, addServerBtn, adminNavBtn, authShell, logoutBtn, navFaqBtn, navHealthBtn, navServersBtn, navSettingsBtn, nitradoSettingsCard, notificationsBellBtn, notificationsModal, privacyCard, registerError, usernameLabel, viewAdmin, viewApp, viewFaq, viewHealth, viewLogin, viewRegister, viewSettings } from "./dom.js";
import { loadNotifications } from "./notifications.js";
import { startPlayersAutoRefresh, stopPlayersAutoRefresh } from "./players.js";
import { isConnected, renderServers } from "./servers.js";
import { I18N, state } from "./state.js";

// --- view switching ---
// Selecting a server never closes any other open console — it just
// changes which one is shown. Multiple consoles can stay connected in
// the background at once; switching views (Servers/Settings/Admin)
// doesn't touch them either.

export function setActiveNav(btn) {
  [navServersBtn, navHealthBtn, navSettingsBtn, navFaqBtn, adminNavBtn].forEach(function (b) {
    if (b === btn) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

// The FAQ is public content shown as its own view, addressable as
// index.html#faq (the old standalone faq.html redirects there). Every
// other view calls this first so the FAQ never stays visible underneath,
// and a stale #faq doesn't reopen it after a reload.
export function leaveFaqView() {
  viewFaq.hidden = true;
  if (location.hash === "#faq") {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
  }
}

export function showLoginView() {
  leaveFaqView();
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

export function showRegisterView() {
  leaveFaqView();
  stopPlayersAutoRefresh();
  viewApp.hidden = true;
  viewSettings.hidden = true;
  viewLogin.hidden = true;
  registerError.hidden = true;
  authShell.hidden = false;
  viewRegister.hidden = false;
  navSettingsBtn.hidden = true;
}

export function showAppView() {
  leaveFaqView();
  authShell.hidden = true;
  viewLogin.hidden = true;
  viewRegister.hidden = true;
  viewSettings.hidden = true;
  viewAdmin.hidden = true;
  viewHealth.hidden = true;
  viewApp.hidden = false;
  usernameLabel.hidden = false;
  usernameLabel.textContent = state.currentUsername;
  logoutBtn.hidden = false;
  navServersBtn.hidden = false;
  navHealthBtn.hidden = false;
  navSettingsBtn.hidden = false;
  adminNavBtn.hidden = !state.currentIsAdmin;
  addServerBtn.hidden = false;
  accountDangerZone.hidden = false;
  accountCard.hidden = false;
  nitradoSettingsCard.hidden = false;
  privacyCard.hidden = false;
  activityCard.hidden = false;
  accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: state.currentUsername });
  notificationsBellBtn.hidden = false;
  loadNotifications();
  loadAccountInfo();
  loadActivity();
  loadCommandTemplates();
  loadModerationRules();
  setActiveNav(navServersBtn);
  renderServers();
  renderContent();
  if (state.selectedServerId !== null && isConnected(state.selectedServerId)) startPlayersAutoRefresh(state.consoles[state.selectedServerId]);
}

navServersBtn.addEventListener("click", showAppView);

export function showSettingsView() {
  leaveFaqView();
  stopPlayersAutoRefresh();
  authShell.hidden = true;
  viewLogin.hidden = true;
  viewRegister.hidden = true;
  viewApp.hidden = true;
  viewAdmin.hidden = true;
  viewHealth.hidden = true;
  viewSettings.hidden = false;
  addServerBtn.hidden = true;
  if (state.authToken) setActiveNav(navSettingsBtn);
}
