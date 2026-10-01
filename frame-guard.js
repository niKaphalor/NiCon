// Clickjacking protection for hosting that cannot send the real headers.
//
// The right defence is the response header `Content-Security-Policy:
// frame-ancestors 'none'` (or X-Frame-Options: DENY); browsers ignore
// frame-ancestors in a <meta> CSP. GitHub Pages — where the public frontend
// is hosted — does not let us set headers, so this is the fallback: if the
// page finds itself inside another page's frame, it hides itself and tries to
// break out. deploy/security-headers/ has ready-made header configuration for
// any host that does allow headers; with those in place this file never fires.
//
// Loaded synchronously in <head> (before anything is painted). It does
// nothing when scripts are disabled, which is why it is a fallback.
(function () {
  "use strict";
  if (window.top === window.self) return;
  document.documentElement.style.display = "none";
  try {
    window.top.location.replace(window.self.location.href);
  } catch (e) {
    // A sandboxed or cross-origin frame may not navigate its parent — the
    // page simply stays hidden.
  }
})();
