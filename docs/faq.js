// Public FAQ renderer. Content is managed from NiCon's admin page and the
// API returns only published entries in the requested language.
(function () {
  "use strict";

  var API_BASE = "https://nicon.mylss.de";
  var lang = document.documentElement.lang === "de" ? "de" : "en";
  var list = document.getElementById("faq-list");
  var status = document.getElementById("faq-status");
  var strings = lang === "de"
    ? { empty: "Derzeit sind keine FAQ-Einträge veröffentlicht.", error: "Die FAQ konnte gerade nicht geladen werden. Bitte versuche es später erneut." }
    : { empty: "There are no published FAQ entries right now.", error: "The FAQ could not be loaded right now. Please try again later." };

  function showStatus(message, isError) {
    status.textContent = message;
    status.className = isError ? "faq-error" : "faq-empty";
    status.hidden = false;
  }

  fetch(API_BASE + "/api/faq?lang=" + encodeURIComponent(lang), { headers: { "Accept": "application/json" } })
    .then(function (response) {
      if (!response.ok) throw new Error("FAQ request failed");
      return response.json();
    })
    .then(function (entries) {
      if (!Array.isArray(entries) || !entries.length) {
        showStatus(strings.empty, false);
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
        list.appendChild(details);
      });
    })
    .catch(function () { showStatus(strings.error, true); });
})();
