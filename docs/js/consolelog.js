// Console log rendering: filtering, highlighting and follow mode.
import { updateServerPlayerCount } from "./detail.js";
import { consoleClearBtn, consoleCopyBtn, consoleFollowBtn, filterInput, filterRegexToggle, log, serverPlayersList } from "./dom.js";
import { renderPlayersInto, renderPlayersPanel } from "./players.js";
import { I18N, state } from "./state.js";

// --- console log: filtering + highlighting ---

state.renderingConsoleLog = false;
state.lastRenderedLogConsole = null;

export function updateConsoleFollowButton(c) {
  consoleFollowBtn.hidden = !c || c.followTail !== false;
}

// The console filter runs a user-typed regex over up to 2,000 lines of text
// that a game server (or other players) control. JavaScript cannot interrupt
// a running regex, so a pathological pattern would freeze the tab. Three
// guards, cheapest first: a static check that rejects the patterns that
// backtrack exponentially (safe-regex.js), a cap on how much of each line is
// tested, and a time budget for the whole pass (see renderLog).
var FILTER_MAX_LINE_CHARS = 2000;
var FILTER_TIME_BUDGET_MS = 250;
var filterHint = document.getElementById("filter-hint");

function setFilterHint(message) {
  filterHint.textContent = message || "";
  filterHint.hidden = !message;
}

export function activeFilterRegex() {
  var text = filterInput.value.trim();
  setFilterHint("");
  if (!text) return null;
  if (!filterRegexToggle.checked) {
    text = text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    return new RegExp(text, "i");
  }
  var verdict = window.NICON_SAFE_REGEX.analyze(text);
  if (!verdict.ok) {
    // An unfinished pattern while typing is not worth a warning; anything
    // else is explained so the user can simplify it.
    if (verdict.reason !== "syntax") {
      setFilterHint(I18N.t("console.filterRejected", { reason: I18N.t("console.filterReason_" + verdict.reason) }));
    }
    return null;
  }
  try {
    return new RegExp(text, "i");
  } catch (e) {
    return null; // invalid regex mid-typing — just show everything
  }
}

export function renderLog(c) {
  var previousScrollTop = c ? c.scrollTop : 0;
  state.renderingConsoleLog = true;
  log.innerHTML = "";
  if (!c) {
    state.renderingConsoleLog = false;
    state.lastRenderedLogConsole = null;
    updateConsoleFollowButton(null);
    return;
  }
  var regex = activeFilterRegex();

  var started = performance.now();
  var stoppedEarly = false;
  for (var lineIndex = 0; lineIndex < c.lines.length; lineIndex++) {
    var line = c.lines[lineIndex];
    if (regex) {
      // Bounds the total cost of a pattern that is merely slow (polynomial),
      // not catastrophic: check the clock between lines.
      if ((lineIndex & 31) === 0 && performance.now() - started > FILTER_TIME_BUDGET_MS) { stoppedEarly = true; break; }
      var scanned = line.text.length > FILTER_MAX_LINE_CHARS ? line.text.slice(0, FILTER_MAX_LINE_CHARS) : line.text;
      if (!regex.test(scanned)) continue;
    }
    var div = document.createElement("div");
    div.className = "log-line kind-" + line.kind;
    appendHighlighted(div, line.text, regex);
    log.appendChild(div);
  }
  if (stoppedEarly) setFilterHint(I18N.t("console.filterTooSlow"));
  if (c.followTail !== false) {
    log.scrollTop = log.scrollHeight;
  } else {
    log.scrollTop = previousScrollTop;
  }
  c.scrollTop = log.scrollTop;
  state.renderingConsoleLog = false;
  state.lastRenderedLogConsole = c;
  c._logRenderedFiltered = !!regex;
  c._logRenderedTrimGen = c.trimGen || 0;
  c._logRenderedCount = c.lines.length;
  updateConsoleFollowButton(c);
}

// Appends text to container as plain text, except for regex matches,
// which are wrapped in <mark>. Built with DOM nodes (never innerHTML
// with raw content) so console output can never be interpreted as HTML.
export function appendHighlighted(container, text, regex) {
  if (!regex) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  var global = new RegExp(regex.source, "gi");
  var lastIndex = 0;
  var match;
  // Only the first FILTER_MAX_LINE_CHARS are scanned for matches; the rest
  // of a very long line is appended as plain text below.
  var scan = text.length > FILTER_MAX_LINE_CHARS ? text.slice(0, FILTER_MAX_LINE_CHARS) : text;
  while ((match = global.exec(scan)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    var mark = document.createElement("mark");
    mark.textContent = match[0];
    container.appendChild(mark);
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) global.lastIndex++; // guard against zero-length match loops
  }
  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

filterInput.addEventListener("input", function () {
  renderLog(state.consoles[state.selectedServerId]);
});

filterRegexToggle.addEventListener("change", function () {
  renderLog(state.consoles[state.selectedServerId]);
});

log.addEventListener("scroll", function () {
  if (state.renderingConsoleLog) return;
  var c = state.consoles[state.selectedServerId];
  if (!c) return;
  c.scrollTop = log.scrollTop;
  c.followTail = log.scrollHeight - log.scrollTop - log.clientHeight <= 24;
  updateConsoleFollowButton(c);
});

consoleFollowBtn.addEventListener("click", function () {
  var c = state.consoles[state.selectedServerId];
  if (!c) return;
  c.followTail = true;
  renderLog(c);
});

consoleCopyBtn.addEventListener("click", function () {
  var c = state.consoles[state.selectedServerId];
  if (!c || !c.lines.length || !navigator.clipboard) return;
  navigator.clipboard.writeText(c.lines.map(function (line) {
    return line.text;
  }).join("\n")).catch(function () {
    // Clipboard access can be unavailable on HTTP or locked-down browsers.
  });
});

consoleClearBtn.addEventListener("click", function () {
  var c = state.consoles[state.selectedServerId];
  if (!c) return;
  c.lines = [];
  c.lastParsed = null;
  renderLog(c);
  renderPlayersPanel(c);
  renderPlayersInto(serverPlayersList, c);
  updateServerPlayerCount(c.server);
});
