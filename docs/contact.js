// Contact form submit handler. This page stands alone (no app.js, no
// i18n.js) — same reasoning as imprint.html/privacy.html: it's a page
// people may land on without ever loading the app shell, so it carries
// its own tiny bit of logic instead of depending on that shell existing.
(function () {
  "use strict";

  var API_BASE = "https://nicon.mylss.de";
  var lang = document.documentElement.lang === "de" ? "de" : "en";

  var STRINGS = {
    en: {
      sending: "Sending…",
      sent: "Message sent — thanks, you'll hear back by email.",
      error: "Could not send your message — try again later.",
      networkError: "Could not reach the API — check your connection and try again.",
    },
    de: {
      sending: "Wird gesendet…",
      sent: "Nachricht gesendet — vielen Dank, Sie erhalten eine Antwort per E-Mail.",
      error: "Nachricht konnte nicht gesendet werden — bitte später erneut versuchen.",
      networkError: "API nicht erreichbar — bitte Verbindung prüfen und erneut versuchen.",
    },
  }[lang];

  var form = document.getElementById("contact-form");
  var nameInput = document.getElementById("contact-name");
  var emailInput = document.getElementById("contact-email");
  var messageInput = document.getElementById("contact-message");
  var honeypotInput = form.querySelector('input[name="website"]');
  var status = document.getElementById("contact-status");
  var submitBtn = form.querySelector('button[type="submit"]');

  function showStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle("is-error", !!isError);
    status.classList.toggle("is-success", !isError);
    status.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    submitBtn.disabled = true;
    showStatus(STRINGS.sending, false);

    fetch(API_BASE + "/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value,
        email: emailInput.value,
        message: messageInput.value,
        website: honeypotInput.value,
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error("http " + res.status);
          err.isServerError = true;
          throw err;
        }
        return res.json();
      })
      .then(function () {
        showStatus(STRINGS.sent, false);
        form.reset();
      })
      .catch(function (err) {
        showStatus(err && err.isServerError ? STRINGS.error : STRINGS.networkError, true);
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });
})();
