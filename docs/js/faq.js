// The public FAQ view.
import { apiHttpUrl } from "./api.js";
import { addServerBtn, authShell, faqList, faqStatus, navFaqBtn, viewAdmin, viewApp, viewFaq, viewHealth, viewLogin, viewRegister, viewSettings } from "./dom.js";
import { stopPlayersAutoRefresh } from "./players.js";
import { I18N, state } from "./state.js";
import { setActiveNav } from "./views.js";

// --- public FAQ ---
// Same public /api/faq the standalone page used (published entries only,
// in the requested language, no authentication) — so it works signed out
// too, and its nav entry is always visible.

state.faqLoadSeq = 0;

function showFaqStatus(message, isError) {
  faqStatus.textContent = message;
  faqStatus.className = isError ? "faq-error" : "faq-empty";
  faqStatus.hidden = false;
}

function renderFaq(entries) {
  faqList.textContent = "";
  faqStatus.hidden = true;
  if (!Array.isArray(entries) || !entries.length) {
    showFaqStatus(I18N.t("faq.empty"), false);
    return;
  }
  entries.forEach(function (entry, index) {
    var details = document.createElement("details");
    details.className = "faq-item";
    if (index === 0) details.open = true;
    var summary = document.createElement("summary");
    summary.textContent = entry.question;
    details.appendChild(summary);
    var answer = document.createElement("div");
    answer.className = "faq-answer";
    answer.textContent = entry.answer;
    details.appendChild(answer);
    faqList.appendChild(details);
  });
}

export function loadFaq() {
  var seq = ++state.faqLoadSeq; // a slower earlier response must not overwrite a newer one (language switch)
  fetch(apiHttpUrl() + "/api/faq?lang=" + encodeURIComponent(I18N.getLang()), { headers: { "Accept": "application/json" } })
    .then(function (r) {
      if (!r.ok) throw new Error("FAQ request failed");
      return r.json();
    })
    .then(function (entries) { if (seq === state.faqLoadSeq) renderFaq(entries); })
    .catch(function () {
      if (seq !== state.faqLoadSeq) return;
      faqList.textContent = "";
      showFaqStatus(I18N.t("faq.error"), true);
    });
}

export function showFaqView() {
  stopPlayersAutoRefresh();
  authShell.hidden = true;
  viewLogin.hidden = true;
  viewRegister.hidden = true;
  viewApp.hidden = true;
  viewSettings.hidden = true;
  viewAdmin.hidden = true;
  viewHealth.hidden = true;
  viewFaq.hidden = false;
  addServerBtn.hidden = true;
  setActiveNav(navFaqBtn);
  try { history.replaceState(null, "", "#faq"); } catch (e) { /* ignore */ }
  loadFaq();
}

navFaqBtn.addEventListener("click", showFaqView);
window.addEventListener("hashchange", function () {
  if (location.hash === "#faq" && viewFaq.hidden) showFaqView();
});
