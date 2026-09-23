// NiCon's translation layer: a flat key -> string dictionary per language,
// applied to the DOM via data-i18n* attributes. No framework, no build
// step — consistent with the rest of docs/. Adding a language means adding
// one object to `dict` and one <option> to the #lang-select in index.html;
// nothing else needs to change.
window.NICON_I18N = (function () {
  "use strict";

  var STORAGE_KEY = "nicon_lang";
  var SUPPORTED = ["en", "de"];
  var DEFAULT_LANG = "en";

  var dict = {
    en: {
      nav: {
        signOut: "Sign out",
        relay: "relay",
        relaySettings: "Relay settings",
        settingsLink: "settings",
        imprint: "Imprint",
        privacy: "Privacy",
        language: "Language",
      },
      banner: {
        unreachable: "NiCon can't reach its local relay — nothing will work until it's running.",
        getItHere: "Get it here",
        thenCheck: "then check the address in",
      },
      auth: {
        signIn: "Sign in",
        noAccountYet: "No account yet?",
        createOne: "Create one",
        alreadyHaveAccount: "Already have an account?",
      },
      login: {
        subhead: "Your servers are tied to your NiCon account — sign in to see them.",
      },
      register: {
        title: "Create an account",
        subheadBefore: "Only your username and a password hash are stored — see what that means in the",
        usernamePlaceholder: "Username (3–32 characters)",
        passwordPlaceholder: "Password (min. 8 characters)",
        confirmPasswordPlaceholder: "Confirm password",
        consentBefore: "I've read the",
        consentAfter: "and agree to it.",
        submit: "Create account",
      },
      common: {
        username: "Username",
        password: "Password",
        privacyPolicyLink: "privacy policy",
        save: "Save",
        close: "Close",
        remove: "Remove",
        host: "Host",
        port: "Port",
        rconPassword: "RCON password",
      },
      servers: {
        title: "Servers",
        addServer: "+ Add server",
        subheadPart1: "Your server list and RCON passwords are stored for your account only — no one else can see, edit, or connect through them.",
        seeThe: "See the",
        subheadPart2: "for details, or delete your account any time in",
        emptyTitle: "No servers yet.",
        emptyAdd: "+ Add a server",
        connect: "Connect",
        openConsole: "Open console",
        rconPasswordAriaLabel: "RCON password for {{name}}",
        removeAriaLabel: "Remove {{name}}",
        connectedTooltip: "Connected",
      },
      console: {
        back: "← Servers",
        players: "Players",
        filterPlaceholder: "Filter (regex)…",
        commandPlaceholder: "Type a command…",
        send: "Send",
        connecting: "(connecting…)",
        connected: "(connected)",
        disconnected: "(disconnected)",
        noOutput: "(no output)",
        relayConnectionFailed: "relay connection failed — is the relay running at {{url}}?",
        couldNotParseMessage: "could not parse relay message",
      },
      addModal: {
        title: "Add server",
        tabNitrado: "From Nitrado",
        tabManual: "Manually",
        nitradoHint: "Your token is sent once to the relay to list servers whose current game supports RCON, then discarded — nothing is stored, here or there.",
        nitradoTokenPlaceholder: "Nitrado API token",
        syncServers: "Sync servers",
        manualNamePlaceholder: "Name",
        manualNameAriaLabel: "Server name",
        addServerSubmit: "Add server",
        protocolAriaLabel: "RCON protocol",
        protocolSource: "Source RCON (most games)",
        protocolWebrcon: "Rust WebRCON",
      },
      settings: {
        title: "Relay",
        hintBefore: "NiCon needs a small local relay running on your machine to speak RCON — browsers can't open raw TCP or WebRCON sockets on their own.",
        getItHereLink: "Get it here.",
        relayAddressAriaLabel: "Relay address",
        deleteAccountTitle: "Delete account",
        deleteAccountHint: "Permanently deletes your account and every server you've added — RCON passwords included. This can't be undone.",
        deleteAccountButton: "Delete my account",
        deleteAccountConfirm: "Delete your account and every server you've added? This can't be undone.",
      },
      info: {
        parsingHint: "Parsing is best-effort, based on documented command formats, not verified against a live server of each game — if it looks wrong, the raw response is still visible in the console.",
        gameAriaLabel: "Game",
        genericOption: "Generic (no parsing)",
        showPlayers: "Show players",
        couldNotParse: "Could not parse the {{game}} response — see the raw output in the console.",
      },
      errors: {
        sessionExpired: "Your session expired — sign in again.",
        signInFailed: "Sign in failed.",
        registrationFailed: "Registration failed.",
        passwordMismatch: "Passwords don't match.",
        mustAcceptPrivacy: "You need to accept the privacy policy to create an account.",
        failedToLoadServers: "failed to load servers",
        failedToRemoveServer: "failed to remove server",
        failedToSavePassword: "failed to save password",
        couldNotAddServer: "Could not add server: {{message}}",
        nitradoSyncFailed: "Nitrado sync failed: {{message}}",
        failedToDeleteAccount: "failed to delete account",
      },
    },
    de: {
      nav: {
        signOut: "Abmelden",
        relay: "Relay",
        relaySettings: "Relay-Einstellungen",
        settingsLink: "Einstellungen",
        imprint: "Impressum",
        privacy: "Datenschutz",
        language: "Sprache",
      },
      banner: {
        unreachable: "NiCon kann den lokalen Relay nicht erreichen — nichts funktioniert, bis er läuft.",
        getItHere: "Hier herunterladen",
        thenCheck: "dann die Adresse in den",
      },
      auth: {
        signIn: "Anmelden",
        noAccountYet: "Noch kein Konto?",
        createOne: "Jetzt erstellen",
        alreadyHaveAccount: "Schon ein Konto?",
      },
      login: {
        subhead: "Deine Server sind an dein NiCon-Konto gebunden — melde dich an, um sie zu sehen.",
      },
      register: {
        title: "Konto erstellen",
        subheadBefore: "Es werden nur dein Benutzername und ein Passwort-Hash gespeichert — was das bedeutet, steht in der",
        usernamePlaceholder: "Benutzername (3–32 Zeichen)",
        passwordPlaceholder: "Passwort (mind. 8 Zeichen)",
        confirmPasswordPlaceholder: "Passwort bestätigen",
        consentBefore: "Ich habe die",
        consentAfter: "gelesen und stimme ihr zu.",
        submit: "Konto erstellen",
      },
      common: {
        username: "Benutzername",
        password: "Passwort",
        privacyPolicyLink: "Datenschutzerklärung",
        save: "Speichern",
        close: "Schließen",
        remove: "Entfernen",
        host: "Host",
        port: "Port",
        rconPassword: "RCON-Passwort",
      },
      servers: {
        title: "Server",
        addServer: "+ Server hinzufügen",
        subheadPart1: "Deine Serverliste und RCON-Passwörter werden ausschließlich für dein Konto gespeichert — niemand sonst kann sie sehen, bearbeiten oder darüber eine Verbindung herstellen.",
        seeThe: "Mehr dazu in der",
        subheadPart2: "Dein Konto kannst du außerdem jederzeit in den",
        emptyTitle: "Noch keine Server.",
        emptyAdd: "+ Server hinzufügen",
        connect: "Verbinden",
        openConsole: "Konsole öffnen",
        rconPasswordAriaLabel: "RCON-Passwort für {{name}}",
        removeAriaLabel: "{{name}} entfernen",
        connectedTooltip: "Verbunden",
      },
      console: {
        back: "← Server",
        players: "Spieler",
        filterPlaceholder: "Filter (Regex)…",
        commandPlaceholder: "Befehl eingeben…",
        send: "Senden",
        connecting: "(verbinde…)",
        connected: "(verbunden)",
        disconnected: "(getrennt)",
        noOutput: "(keine Ausgabe)",
        relayConnectionFailed: "Relay-Verbindung fehlgeschlagen — läuft der Relay unter {{url}}?",
        couldNotParseMessage: "Relay-Nachricht konnte nicht verarbeitet werden",
      },
      addModal: {
        title: "Server hinzufügen",
        tabNitrado: "Von Nitrado",
        tabManual: "Manuell",
        nitradoHint: "Dein Token wird einmalig an den Relay gesendet, um Server mit RCON-fähigem Spiel aufzulisten, und danach verworfen — weder hier noch dort wird er gespeichert.",
        nitradoTokenPlaceholder: "Nitrado-API-Token",
        syncServers: "Server synchronisieren",
        manualNamePlaceholder: "Name",
        manualNameAriaLabel: "Servername",
        addServerSubmit: "Server hinzufügen",
        protocolAriaLabel: "RCON-Protokoll",
        protocolSource: "Source RCON (die meisten Spiele)",
        protocolWebrcon: "Rust WebRCON",
      },
      settings: {
        title: "Relay",
        hintBefore: "NiCon benötigt einen kleinen lokalen Relay auf deinem Rechner, um RCON zu sprechen — Browser können von sich aus keine rohen TCP- oder WebRCON-Sockets öffnen.",
        getItHereLink: "Hier herunterladen.",
        relayAddressAriaLabel: "Relay-Adresse",
        deleteAccountTitle: "Konto löschen",
        deleteAccountHint: "Löscht dein Konto und alle von dir hinzugefügten Server dauerhaft — inklusive RCON-Passwörter. Das kann nicht rückgängig gemacht werden.",
        deleteAccountButton: "Mein Konto löschen",
        deleteAccountConfirm: "Dein Konto und alle hinzugefügten Server löschen? Das kann nicht rückgängig gemacht werden.",
      },
      info: {
        parsingHint: "Das Parsen erfolgt nach bestem Wissen anhand dokumentierter Befehlsformate, nicht gegen einen echten Server jedes Spiels geprüft — falls es falsch aussieht, bleibt die Rohausgabe in der Konsole sichtbar.",
        gameAriaLabel: "Spiel",
        genericOption: "Allgemein (kein Parsing)",
        showPlayers: "Spieler anzeigen",
        couldNotParse: "Die {{game}}-Antwort konnte nicht verarbeitet werden — siehe die Rohausgabe in der Konsole.",
      },
      errors: {
        sessionExpired: "Deine Sitzung ist abgelaufen — melde dich erneut an.",
        signInFailed: "Anmeldung fehlgeschlagen.",
        registrationFailed: "Registrierung fehlgeschlagen.",
        passwordMismatch: "Passwörter stimmen nicht überein.",
        mustAcceptPrivacy: "Du musst die Datenschutzerklärung akzeptieren, um ein Konto zu erstellen.",
        failedToLoadServers: "Server konnten nicht geladen werden",
        failedToRemoveServer: "Server konnte nicht entfernt werden",
        failedToSavePassword: "Passwort konnte nicht gespeichert werden",
        couldNotAddServer: "Server konnte nicht hinzugefügt werden: {{message}}",
        nitradoSyncFailed: "Nitrado-Synchronisierung fehlgeschlagen: {{message}}",
        failedToDeleteAccount: "Konto konnte nicht gelöscht werden",
      },
    },
  };

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
    t: t,
    getLang: function () { return currentLang; },
    setLang: setLang,
    legalHref: legalHref,
    applyStatic: applyStatic,
  };
})();
