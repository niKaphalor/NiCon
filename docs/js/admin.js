// Admin panel: users, broadcast notices, audit logs and the FAQ editor.
import { apiErrorMessage, apiFetch } from "./api.js";
import { showRecoveryCodeModal } from "./auth.js";
import { activityList, addServerBtn, adminAuditLogList, adminFaqList, adminNavBtn, adminNotificationsList, adminUsersBody, authShell, faqAnswerDe, faqAnswerEn, faqEditorCancel, faqEditorForm, faqEditorId, faqPublished, faqQuestionDe, faqQuestionEn, faqSortOrder, notificationForm, notificationMessage, notificationType, viewAdmin, viewApp, viewHealth, viewLogin, viewRegister, viewSettings } from "./dom.js";
import { fetchPagedList, pagerHostFor, renderPager } from "./lists.js";
import { stopPlayersAutoRefresh } from "./players.js";
import { ACTIVITY_PER_PAGE, AUDIT_PER_PAGE, I18N, state } from "./state.js";
import { showConfirm, showPasswordConfirm, showToast } from "./ui.js";
import { leaveFaqView, setActiveNav } from "./views.js";

// --- admin panel ---

function showAdminView() {
  leaveFaqView();
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
  loadAdminFaq();
  loadAdminAuditLog();
  showAdminView();
});

var ADMIN_USERS_PER_PAGE = 25;
var ADMIN_NOTICES_PER_PAGE = 10;
var ADMIN_FAQ_PER_PAGE = 10;
state.adminUsersPage = 1;
state.adminNoticesPage = 1;
state.adminFaqPage = 1;

function loadAdminUsers(page) {
  if (page) state.adminUsersPage = page;
  return fetchPagedList("/api/admin/users", state.adminUsersPage, ADMIN_USERS_PER_PAGE, null, null, I18N.t("errors.adminLoadFailed"))
    .then(function (data) {
      if (!data.items.length && data.page > 1) return loadAdminUsers(Math.max(1, data.total_pages));
      state.adminUsersPage = data.page;
      renderAdminUsers(data.items);
      renderPager(pagerHostFor(adminUsersBody.closest(".table-shell")), data, loadAdminUsers);
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
      showPasswordConfirm(I18N.t("admin.confirmRegenerate", { username: u.username })).then(function (password) {
        if (!password) return;
        apiFetch("/api/admin/users/" + u.id + "/recovery-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: password }),
        })
          .then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.adminRegenerateFailed")); });
            return r.json();
          })
          .then(function (data) {
            showRecoveryCodeModal(data.recovery_code, function () { /* stays on the admin view */ });
          })
          .catch(function (err) { showToast(err.message); });
      });
    });
    actionsTd.appendChild(regenBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-secondary btn-danger";
    deleteBtn.textContent = I18N.t("admin.delete");
    deleteBtn.addEventListener("click", function () {
      showPasswordConfirm(I18N.t("admin.confirmDelete", { username: u.username })).then(function (password) {
        if (!password) return;
        apiFetch("/api/admin/users/" + u.id, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: password }),
        })
          .then(function (r) {
            if (!r.ok && r.status !== 204) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.adminDeleteFailed")); });
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

function loadAdminNotifications(page) {
  if (page) state.adminNoticesPage = page;
  return fetchPagedList("/api/notifications", state.adminNoticesPage, ADMIN_NOTICES_PER_PAGE, null, null, I18N.t("errors.notificationsLoadFailed"))
    .then(function (data) {
      if (!data.items.length && data.page > 1) return loadAdminNotifications(Math.max(1, data.total_pages));
      state.adminNoticesPage = data.page;
      renderAdminNotifications(data.items);
      renderPager(pagerHostFor(adminNotificationsList), data, loadAdminNotifications);
    })
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
    case "admin_faq_created": return I18N.t("auditLog.action_adminFaqCreated", { actor: actor, detail: detail });
    case "admin_faq_updated": return I18N.t("auditLog.action_adminFaqUpdated", { actor: actor, detail: detail });
    case "admin_faq_deleted": return I18N.t("auditLog.action_adminFaqDeleted", { actor: actor, detail: detail });
    default: return entry.action; // forward-compatible fallback for an action this build doesn't know a template for yet
  }
}

export function renderAuditLogList(container, list, emptyTextKey) {
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

export function loadActivity(page) {
  if (page) state.activityPage = page;
  return fetchPagedList("/api/audit-log", state.activityPage, ACTIVITY_PER_PAGE)
    .then(function (data) {
      // Entries expire, so the last page can vanish underneath us.
      if (!data.items.length && data.page > 1) return loadActivity(Math.max(1, data.total_pages));
      state.activityPage = data.page;
      renderAuditLogList(activityList, data.items, "settings.activityEmpty");
      renderPager(pagerHostFor(activityList), data, loadActivity);
    })
    .catch(function () { /* the rest of settings still works without this */ });
}

function loadAdminAuditLog(page) {
  if (page) state.adminAuditPage = page;
  return fetchPagedList("/api/admin/audit-log", state.adminAuditPage, AUDIT_PER_PAGE)
    .then(function (data) {
      if (!data.items.length && data.page > 1) return loadAdminAuditLog(Math.max(1, data.total_pages));
      state.adminAuditPage = data.page;
      renderAuditLogList(adminAuditLogList, data.items, "admin.auditLogEmpty");
      renderPager(pagerHostFor(adminAuditLogList), data, loadAdminAuditLog);
    })
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

// --- admin: public FAQ ---

function resetFaqEditor() {
  faqEditorForm.reset();
  faqEditorId.value = "";
  faqSortOrder.value = "0";
  faqPublished.checked = true;
  faqEditorCancel.hidden = true;
}

function loadAdminFaq(page) {
  if (page) state.adminFaqPage = page;
  return fetchPagedList("/api/admin/faq", state.adminFaqPage, ADMIN_FAQ_PER_PAGE, null, null, I18N.t("errors.faqLoadFailed"))
    .then(function (data) {
      if (!data.items.length && data.page > 1) return loadAdminFaq(Math.max(1, data.total_pages));
      state.adminFaqPage = data.page;
      renderAdminFaq(data.items);
      renderPager(pagerHostFor(adminFaqList), data, loadAdminFaq);
    })
    .catch(function (err) { showToast(err.message); });
}

function editFaqEntry(entry) {
  faqEditorId.value = String(entry.id);
  faqQuestionDe.value = entry.question_de;
  faqAnswerDe.value = entry.answer_de;
  faqQuestionEn.value = entry.question_en;
  faqAnswerEn.value = entry.answer_en;
  faqSortOrder.value = String(entry.sort_order || 0);
  faqPublished.checked = !!entry.is_published;
  faqEditorCancel.hidden = false;
  faqQuestionDe.focus();
}

function renderAdminFaq(list) {
  adminFaqList.innerHTML = "";
  if (!list.length) {
    var empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = I18N.t("admin.faqEmpty");
    adminFaqList.appendChild(empty);
    return;
  }
  list.forEach(function (entry) {
    var row = document.createElement("article");
    row.className = "faq-admin-row";

    var copy = document.createElement("div");
    copy.className = "faq-admin-copy";
    var heading = document.createElement("h3");
    heading.textContent = entry.question_de;
    copy.appendChild(heading);
    var english = document.createElement("p");
    english.className = "hint";
    english.textContent = entry.question_en;
    copy.appendChild(english);
    var meta = document.createElement("div");
    meta.className = "faq-admin-meta";
    var badge = document.createElement("span");
    badge.className = "tag " + (entry.is_published ? "tag-tested" : "tag-neutral");
    badge.textContent = I18N.t(entry.is_published ? "admin.faqPublished" : "admin.faqDraft");
    meta.appendChild(badge);
    var order = document.createElement("span");
    order.className = "hint mono";
    order.textContent = I18N.t("admin.faqOrderValue", { value: entry.sort_order });
    meta.appendChild(order);
    copy.appendChild(meta);
    row.appendChild(copy);

    var actions = document.createElement("div");
    actions.className = "faq-admin-actions";
    var edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn-secondary";
    edit.textContent = I18N.t("common.edit");
    edit.addEventListener("click", function () { editFaqEntry(entry); });
    actions.appendChild(edit);
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-secondary btn-danger";
    remove.textContent = I18N.t("admin.delete");
    remove.addEventListener("click", function () {
      showConfirm(I18N.t("admin.faqDeleteConfirm", { question: entry.question_de })).then(function (ok) {
        if (!ok) return;
        apiFetch("/api/admin/faq/" + entry.id, { method: "DELETE" })
          .then(function (r) {
            if (!r.ok && r.status !== 204) throw new Error(I18N.t("errors.faqDeleteFailed"));
            if (faqEditorId.value === String(entry.id)) resetFaqEditor();
            loadAdminFaq();
          })
          .catch(function (err) { showToast(err.message); });
      });
    });
    actions.appendChild(remove);
    row.appendChild(actions);
    adminFaqList.appendChild(row);
  });
}

faqEditorCancel.addEventListener("click", resetFaqEditor);
faqEditorForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var id = faqEditorId.value;
  var payload = {
    question_de: faqQuestionDe.value.trim(),
    answer_de: faqAnswerDe.value.trim(),
    question_en: faqQuestionEn.value.trim(),
    answer_en: faqAnswerEn.value.trim(),
    sort_order: Number(faqSortOrder.value || 0),
    is_published: faqPublished.checked,
  };
  apiFetch(id ? "/api/admin/faq/" + id : "/api/admin/faq", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("errors.faqSaveFailed")); });
      return r.json();
    })
    .then(function () {
      resetFaqEditor();
      loadAdminFaq();
    })
    .catch(function (err) { showToast(err.message); });
});
