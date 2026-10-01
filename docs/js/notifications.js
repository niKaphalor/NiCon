// Admin-authored notices shown to every signed-in user.
import { apiFetch } from "./api.js";
import { notificationsBadge, notificationsBellBtn, notificationsClose, notificationsList, notificationsModal } from "./dom.js";
import { I18N, state } from "./state.js";

// --- notifications (admin-authored, shown to every signed-in user) ---
// A modal, not an inline banner — pops up once per new notification,
// and stays reachable afterward via the bell in the topbar. Dismissal
// is per-browser (localStorage, not server-side): it only controls
// whether the modal auto-opens again, never removes a notification
// from the list the bell reopens — "look at it again" has to still
// show it.

var DISMISSED_NOTIFICATIONS_KEY = "nicon_dismissed_notifications";
state.lastNotifications = [];

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

export function loadNotifications() {
  apiFetch("/api/notifications", { method: "GET" })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (list) {
      state.lastNotifications = list || [];
      renderNotificationsBadge();
      renderNotificationsModal();
      if (undismissedCount(state.lastNotifications) > 0) notificationsModal.showModal();
    })
    .catch(function () { /* notifications are a nice-to-have, fail silently */ });
}

function renderNotificationsBadge() {
  var count = undismissedCount(state.lastNotifications);
  notificationsBadge.hidden = count === 0;
  notificationsBadge.textContent = String(count);
}

function renderNotificationsModal() {
  var dismissed = dismissedNotificationIds();
  notificationsList.innerHTML = "";

  if (!state.lastNotifications.length) {
    var empty = document.createElement("p");
    empty.className = "notifications-empty";
    empty.textContent = I18N.t("notifications.empty");
    notificationsList.appendChild(empty);
    return;
  }

  state.lastNotifications.forEach(function (n) {
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
