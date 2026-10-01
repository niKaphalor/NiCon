// Login, registration, password reset, recovery code and the account settings (rename, password, export, deletion, Nitrado token).
import { apiErrorMessage, apiFetch, apiHttpUrl } from "./api.js";
import { accountUsernameLine, changePasswordError, changePasswordForm, changeUsernameError, changeUsernameForm, deleteAccountBtn, exportDataBtn, forgetNitradoTokenBtn, loginError, loginForm, logoutBtn, newPasswordConfirmInput, newPasswordInput, newUsernameInput, nitradoTokenInput, nitradoTokenStatus, passwordCurrentPasswordInput, recoveryAckCheckbox, recoveryCodeEl, recoveryContinueBtn, recoveryCopyBtn, recoveryModal, registerError, registerForm, resetClose, resetError, resetForm, resetModal, settingsForgetNitradoTokenBtn, settingsNitradoTokenInput, settingsNitradoTokenStatus, showLoginBtn, showRegisterBtn, showResetBtn, usernameCurrentPasswordInput, usernameLabel } from "./dom.js";
import { loadServers } from "./servers.js";
import { I18N, USERNAME_KEY, clearAuthState, setAuthState, state } from "./state.js";
import { disconnectAllConsoles, showConfirm, showPasswordConfirm, showToast } from "./ui.js";
import { showAppView, showLoginView, showRegisterView } from "./views.js";

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
  state.servers = [];
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

state.pendingRecoveryContinue = null;

export function showRecoveryCodeModal(code, onContinue) {
  recoveryCodeEl.textContent = code;
  recoveryAckCheckbox.checked = false;
  recoveryContinueBtn.disabled = true;
  recoveryCopyBtn.textContent = I18N.t("recovery.copy");
  state.pendingRecoveryContinue = onContinue;
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
  var cb = state.pendingRecoveryContinue;
  state.pendingRecoveryContinue = null;
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
      state.currentUsername = data.username;
      try { sessionStorage.setItem(USERNAME_KEY, state.currentUsername); } catch (err) { /* ignore */ }
      usernameLabel.textContent = state.currentUsername;
      accountUsernameLine.textContent = I18N.t("settings.accountUsernameLine", { username: state.currentUsername });
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

// --- data export (self-service, Art. 15/20 GDPR) ---

exportDataBtn.addEventListener("click", function () {
  apiFetch("/api/account/export", { method: "GET" })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t)); });
      return r.text();
    })
    .then(function (text) {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "nicon-data-export-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    })
    .catch(function (err) {
      showToast(I18N.t("errors.exportDataFailed", { message: err.message }));
    });
});

// --- account deletion (self-service, Art. 17 GDPR) ---

deleteAccountBtn.addEventListener("click", function () {
  showPasswordConfirm(I18N.t("settings.deleteAccountConfirm")).then(function (password) {
    if (!password) return;
    apiFetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: password }),
    })
      .then(function (r) {
        if (!r.ok && r.status !== 204) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.failedToDeleteAccount")); });
        clearAuthState();
        disconnectAllConsoles();
        state.servers = [];
        showLoginView();
      })
      .catch(function (err) { showToast(err.message); });
  });
});

// --- account info (currently just: is a Nitrado token already saved?) ---

state.hasNitradoToken = false;

export function loadAccountInfo() {
  return apiFetch("/api/account", { method: "GET" })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (data) {
      state.hasNitradoToken = !!(data && data.has_nitrado_token);
      renderNitradoTokenStatus();
    })
    .catch(function () { /* the sync form still works without this */ });
}

// renderNitradoTokenStatus keeps both places a Nitrado token can be
// managed from — the Add Server modal's "From Nitrado" tab, and the
// Settings → Nitrado card — in sync with each other, since either one
// saving or forgetting a token changes state the other one displays too.
function renderNitradoTokenStatus() {
  nitradoTokenStatus.hidden = !state.hasNitradoToken;
  nitradoTokenInput.required = !state.hasNitradoToken;
  settingsNitradoTokenStatus.hidden = !state.hasNitradoToken;
  settingsNitradoTokenInput.required = !state.hasNitradoToken;
}

function forgetNitradoToken() {
  return showConfirm(I18N.t("addModal.forgetTokenConfirm")).then(function (ok) {
    if (!ok) return;
    return apiFetch("/api/account/nitrado-token", { method: "DELETE" })
      .then(function (r) {
        if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.forgetTokenFailed"));
        state.hasNitradoToken = false;
        renderNitradoTokenStatus();
      });
  });
}

forgetNitradoTokenBtn.addEventListener("click", function () {
  forgetNitradoToken().catch(function (err) { showToast(err.message); });
});

settingsForgetNitradoTokenBtn.addEventListener("click", function () {
  forgetNitradoToken().catch(function (err) { showToast(err.message); });
});
