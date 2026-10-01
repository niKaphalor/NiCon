// Pagination shared by every log and admin list.
import { apiErrorMessage, apiFetch } from "./api.js";
import { I18N } from "./state.js";

// --- list pagination ---
// Every log list and every admin list is shown a page at a time. The list endpoints paginate
// server-side ({items, page, per_page, total, total_pages}); an API that
// predates that answers with one plain array instead, which is paginated
// here so the UI behaves the same against either.

export function fetchPagedList(path, page, perPage, extraQuery, clientFilter, failText) {
  var query = "page=" + page + "&per_page=" + perPage + (extraQuery ? "&" + extraQuery : "");
  return apiFetch(path + "?" + query, { method: "GET" })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || failText || "request failed"); });
      return r.json();
    })
    .then(function (data) {
      if (!Array.isArray(data)) return data;
      var all = clientFilter ? data.filter(clientFilter) : data;
      var totalPages = Math.max(1, Math.ceil(all.length / perPage));
      var current = Math.min(page, totalPages);
      return { items: all.slice((current - 1) * perPage, current * perPage), page: current, per_page: perPage, total: all.length, total_pages: totalPages };
    });
}

// renderPager fills `host` with "‹ Previous · Page 2 of 7 · 163 entries · Next ›".
// A single page needs no pager, so the host is hidden then.
export function renderPager(host, data, onPage) {
  host.textContent = "";
  if (!data || !(data.total_pages > 1)) { host.hidden = true; return; }
  host.hidden = false;
  host.setAttribute("aria-label", I18N.t("pager.label"));

  var prev = document.createElement("button");
  prev.type = "button";
  prev.className = "btn-secondary";
  prev.textContent = "‹ " + I18N.t("pager.previous");
  prev.disabled = data.page <= 1;
  prev.addEventListener("click", function () { onPage(data.page - 1); });

  var status = document.createElement("span");
  status.className = "pager-status";
  status.setAttribute("aria-live", "polite");
  status.textContent = I18N.t("pager.status", { page: data.page, pages: data.total_pages }) + " · " + I18N.t("pager.entries", { count: data.total });

  var next = document.createElement("button");
  next.type = "button";
  next.className = "btn-secondary";
  next.textContent = I18N.t("pager.next") + " ›";
  next.disabled = data.page >= data.total_pages;
  next.addEventListener("click", function () { onPage(data.page + 1); });

  host.appendChild(prev);
  host.appendChild(status);
  host.appendChild(next);
}

// The pager sits right below its list; created on first use.
export function pagerHostFor(listEl) {
  var host = listEl.nextElementSibling;
  if (!host || !host.classList.contains("pager")) {
    host = document.createElement("div");
    host.className = "pager";
    host.setAttribute("role", "group");
    listEl.parentNode.insertBefore(host, listEl.nextSibling);
  }
  return host;
}
