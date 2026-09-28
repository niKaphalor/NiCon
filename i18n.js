// NiCon's translation layer: looks up a flat key -> string dictionary per
// language and applies it to the DOM via data-i18n* attributes. The
// strings themselves live in i18n.en.js / i18n.de.js (loaded before this
// file) — one file per language, so translating means editing exactly one
// file. Adding a language means adding an i18n.<code>.js file, one entry
// to LANGUAGES below, and a <script> tag in index.html; nothing else
// needs to change.
window.NICON_I18N = (function () {
  "use strict";

  var STORAGE_KEY = "nicon_lang";

  // Each language's own name and flag, in that language — never run
  // through t(), since a language's own name doesn't get translated.
  var LANGUAGES = [
    { code: "de", flag: "🇩🇪", name: "Deutsch" },
    { code: "en", flag: "🇬🇧", name: "English" },
  ];
  var SUPPORTED = LANGUAGES.map(function (l) { return l.code; });
  var DEFAULT_LANG = "en";

  var dict = window.NICON_I18N_STRINGS || {};

  function detectInitialLang() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (e) {
      // private window / storage blocked — fall through to browser language.
    }
    var nav = ((navigator.language || navigator.userLanguage || "") + "").slice(0, 2).toLowerCase();
    if (SUPPORTED.indexOf(nav) !== -1) return nav;
    return DEFAULT_LANG;
  }

  var currentLang = detectInitialLang();

  function lookup(lang, key) {
    var node = dict[lang];
    var parts = key.split(".");
    for (var i = 0; i < parts.length && node != null; i++) {
      node = node[parts[i]];
    }
    return node;
  }

  // t() looks up `key` (dot-path into the dictionary, e.g. "servers.title")
  // in the current language, falling back to English and then to the key
  // itself so a missing translation is visible instead of blank. `vars`
  // fills in {{placeholders}} in the string.
  function t(key, vars) {
    var value = lookup(currentLang, key);
    if (value == null) value = lookup(DEFAULT_LANG, key);
    if (value == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        value = value.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), vars[k]);
      });
    }
    return value;
  }

  // Legal pages are separate files per language (imprint.html /
  // imprint.de.html, ...) rather than translated in place, since they're
  // long-form prose best reviewed per language, not assembled from
  // fragments. English has no suffix since it's the canonical/default file.
  function legalHref(doc) {
    return currentLang === "en" ? doc + ".html" : doc + "." + currentLang + ".html";
  }

  function applyStatic(root) {
    root = root || document;
    document.documentElement.lang = currentLang;

    root.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
    });
    root.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    root.querySelectorAll("[data-i18n-doc]").forEach(function (el) {
      el.href = legalHref(el.getAttribute("data-i18n-doc"));
    });
  }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1 || lang === currentLang) return;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      // ignore — language choice just won't persist across reloads.
    }
    applyStatic(document);
    document.dispatchEvent(new CustomEvent("nicon:langchange", { detail: { lang: lang } }));
  }

  return {
    SUPPORTED: SUPPORTED,
    LANGUAGES: LANGUAGES,
    t: t,
    getLang: function () { return currentLang; },
    setLang: setLang,
    legalHref: legalHref,
    applyStatic: applyStatic,
  };
})();
