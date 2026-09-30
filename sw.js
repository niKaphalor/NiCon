"use strict";

// Bump this version whenever the app shell changes. The new worker installs
// alongside the current one and waits; app.js offers the update to the user
// before sending SKIP_WAITING, avoiding a mid-session code swap.
const CACHE_NAME = "nicon-shell-v23";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./i18n.en.js",
  "./i18n.de.js",
  "./i18n.js",
  "./games.js",
  "./app.js",
  "./contact.html",
  "./contact.de.html",
  "./contact.js",
  "./imprint.html",
  "./imprint.de.html",
  "./privacy.html",
  "./privacy.de.html",
  "./site.webmanifest",
  "./favicon.ico",
  "./favicon.svg",
  "./favicon-96x96.png",
  "./apple-touch-icon.png",
  "./nicon-favicon.png",
  "./nicon-favicon.webp",
  "./web-app-manifest-192x192.png",
  "./web-app-manifest-512x512.png",
  "./fonts/inter-latin-400-700.woff2",
  "./fonts/inter-latin-ext-400-700.woff2",
];
const APP_SHELL_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("nicon-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(request, { ignoreSearch: true })) || caches.match("./index.html"))
    );
    return;
  }

  if (!APP_SHELL_URLS.has(url.href)) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
