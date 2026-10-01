import { checkApi, checkRelay } from "./js/api.js";
import { showFaqView } from "./js/faq.js";
import { loadServers } from "./js/servers.js";
import { I18N, state } from "./js/state.js";
import { registerServiceWorker } from "./js/ui.js";
import { showAppView, showLoginView } from "./js/views.js";
import { renderSupportedGamesList } from "./js/welcome.js";

// --- boot ---

I18N.applyStatic(document);
registerServiceWorker();
renderSupportedGamesList();
checkApi();
checkRelay();
var openFaqOnBoot = location.hash === "#faq";
if (state.authToken) {
  loadServers()
    .then(function () {
      showAppView();
      if (openFaqOnBoot) showFaqView();
    })
    .catch(function () { /* apiFetch already routes 401s to sessionExpired() */ });
} else {
  showLoginView();
  if (openFaqOnBoot) showFaqView();
}
