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
        api: "API",
        relay: "relay",
        connectionSettings: "Connection settings",
        settingsLink: "settings",
        imprint: "Imprint",
        privacy: "Privacy",
        language: "Language",
      },
      banner: {
        apiUnreachable: "NiCon can't reach its cloud API — sign-in, your server list, and account management won't work until it's reachable.",
        apiThenCheck: "Check the address in",
        unreachable: "NiCon can't reach its local relay — you can still sign in and manage your server list, but connecting to a server's console needs it running.",
        getItHere: "Get it here",
        thenCheck: "then check the address in",
        lnaHint: "If your browser shows a “local network” permission prompt, allow it — NiCon can't connect to a server without it.",
      },
      auth: {
        signIn: "Sign in",
        noAccountYet: "No account yet?",
        createOne: "Create one",
        alreadyHaveAccount: "Already have an account?",
        forgotPassword: "Forgot your password?",
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
        continue: "Continue",
        host: "Host",
        port: "Port",
        rconPassword: "RCON password",
      },
      reset: {
        title: "Reset your password",
        hint: "Enter the recovery code you saved when you created your account (or the last time you reset your password) along with a new password.",
        codePlaceholder: "Recovery code",
        newPasswordPlaceholder: "New password (min. 8 characters)",
        submit: "Reset password",
      },
      recovery: {
        title: "Save your recovery code",
        hint: "This is the only way to reset your password if you forget it — no email, no other way to recover your account. It's shown only this once.",
        copy: "Copy code",
        copied: "Copied!",
        ack: "I've saved this recovery code somewhere safe.",
      },
      admin: {
        navLabel: "Admin",
        title: "Admin",
        backToServers: "← Servers",
        subhead: "Every account on this NiCon instance. Regenerating a code or deleting an account takes effect immediately — hand any regenerated code to that person yourself, there's no email to send it to.",
        colCreated: "Created",
        colServers: "Servers",
        colRole: "Role",
        roleAdmin: "Admin",
        regenerateCode: "Regenerate code",
        delete: "Delete",
        confirmDelete: "Delete the account \"{{username}}\" and everything in it? This can't be undone.",
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
        searchPlaceholder: "Search servers…",
        noSearchResults: "No servers match your search.",
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
        nitradoHint: "Your token is sent once to the cloud API to list servers whose current game supports RCON, then discarded — nothing is stored, here or there.",
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
        navLabel: "Settings",
        title: "Connection",
        apiTitle: "Cloud API",
        apiHint: "Handles sign-in, your account, and your server list — a normal web address, reachable whether or not your computer is on.",
        apiAddressAriaLabel: "Cloud API address",
        relayTitle: "Relay",
        hintBefore: "NiCon needs a small local relay running on your machine to actually speak RCON to a server — browsers can't open raw TCP or WebRCON sockets on their own.",
        getItHereLink: "Get it here.",
        relayAddressAriaLabel: "Relay address",
        privacyKicker: "Privacy",
        privacyForDetails: " for details.",
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
      content: {
        selectPrompt: "Select a server from the list to see its console.",
        passwordHint: "Enter this server's RCON password to connect.",
        notConnectedHint: "Not connected.",
        disconnect: "Disconnect",
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
        resetFailed: "Password reset failed.",
        adminLoadFailed: "Failed to load users.",
        adminDeleteFailed: "Failed to delete user.",
        adminRegenerateFailed: "Failed to regenerate recovery code.",
      },
    },
    de: {
      nav: {
        signOut: "Abmelden",
        api: "API",
        relay: "Relay",
        connectionSettings: "Verbindungseinstellungen",
        settingsLink: "Einstellungen",
        imprint: "Impressum",
        privacy: "Datenschutz",
        language: "Sprache",
      },
      banner: {
        apiUnreachable: "NiCon kann die Cloud-API nicht erreichen — Anmeldung, Serverliste und Kontoverwaltung funktionieren erst, wenn sie erreichbar ist.",
        apiThenCheck: "Prüfe die Adresse in den",
        unreachable: "NiCon kann den lokalen Relay nicht erreichen — Anmeldung und Serverliste funktionieren trotzdem, aber für eine Verbindung zur Server-Konsole muss er laufen.",
        getItHere: "Hier herunterladen",
        thenCheck: "dann die Adresse in den",
        lnaHint: "Falls dein Browser eine Berechtigungsabfrage fürs lokale Netzwerk zeigt, erlaube sie — ohne das kann NiCon keine Verbindung zu einem Server herstellen.",
      },
      auth: {
        signIn: "Anmelden",
        noAccountYet: "Noch kein Konto?",
        createOne: "Jetzt erstellen",
        alreadyHaveAccount: "Schon ein Konto?",
        forgotPassword: "Passwort vergessen?",
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
        continue: "Weiter",
        host: "Host",
        port: "Port",
        rconPassword: "RCON-Passwort",
      },
      reset: {
        title: "Passwort zurücksetzen",
        hint: "Gib den Wiederherstellungscode ein, den du bei der Kontoerstellung (oder beim letzten Zurücksetzen) gespeichert hast, zusammen mit einem neuen Passwort.",
        codePlaceholder: "Wiederherstellungscode",
        newPasswordPlaceholder: "Neues Passwort (mind. 8 Zeichen)",
        submit: "Passwort zurücksetzen",
      },
      recovery: {
        title: "Wiederherstellungscode speichern",
        hint: "Das ist der einzige Weg, dein Passwort zurückzusetzen, falls du es vergisst — keine E-Mail, keine andere Möglichkeit, dein Konto wiederherzustellen. Er wird nur dieses eine Mal angezeigt.",
        copy: "Code kopieren",
        copied: "Kopiert!",
        ack: "Ich habe diesen Wiederherstellungscode sicher gespeichert.",
      },
      admin: {
        navLabel: "Admin",
        title: "Admin",
        backToServers: "← Server",
        subhead: "Alle Konten auf dieser NiCon-Instanz. Ein Code neu generieren oder ein Konto löschen wirkt sofort — einen neu generierten Code musst du der Person selbst geben, es gibt keine E-Mail zum Versenden.",
        colCreated: "Erstellt",
        colServers: "Server",
        colRole: "Rolle",
        roleAdmin: "Admin",
        regenerateCode: "Code neu generieren",
        delete: "Löschen",
        confirmDelete: "Konto \"{{username}}\" und alles darin löschen? Das kann nicht rückgängig gemacht werden.",
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
        searchPlaceholder: "Server durchsuchen…",
        noSearchResults: "Keine Server gefunden.",
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
        nitradoHint: "Dein Token wird einmalig an die Cloud-API gesendet, um Server mit RCON-fähigem Spiel aufzulisten, und danach verworfen — weder hier noch dort wird er gespeichert.",
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
        navLabel: "Einstellungen",
        title: "Verbindung",
        apiTitle: "Cloud-API",
        apiHint: "Zuständig für Anmeldung, dein Konto und deine Serverliste — eine normale Web-Adresse, erreichbar egal ob dein Rechner an ist.",
        apiAddressAriaLabel: "Cloud-API-Adresse",
        relayTitle: "Relay",
        hintBefore: "NiCon benötigt einen kleinen lokalen Relay auf deinem Rechner, um tatsächlich RCON mit einem Server zu sprechen — Browser können von sich aus keine rohen TCP- oder WebRCON-Sockets öffnen.",
        getItHereLink: "Hier herunterladen.",
        relayAddressAriaLabel: "Relay-Adresse",
        privacyKicker: "Datenschutz",
        privacyForDetails: ".",
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
      content: {
        selectPrompt: "Wähle einen Server aus der Liste, um seine Konsole zu sehen.",
        passwordHint: "Gib das RCON-Passwort dieses Servers ein, um dich zu verbinden.",
        notConnectedHint: "Nicht verbunden.",
        disconnect: "Trennen",
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
        resetFailed: "Zurücksetzen fehlgeschlagen.",
        adminLoadFailed: "Nutzer konnten nicht geladen werden.",
        adminDeleteFailed: "Nutzer konnte nicht gelöscht werden.",
        adminRegenerateFailed: "Wiederherstellungscode konnte nicht neu generiert werden.",
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
