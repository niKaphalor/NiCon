// Command bar and history, command templates, word filters / moderation rules and quick commands.
import { apiErrorMessage, apiFetch } from "./api.js";
import { cmdForm, cmdHistoryBtn, cmdHistoryPanel, cmdInput, cmdSuggestions, cmdTemplateAddForm, cmdTemplateCommandInput, cmdTemplateError, cmdTemplateNameInput, cmdTemplatesBtn, cmdTemplatesList, cmdTemplatesPanel, moderationActionSelect, moderationPatternInput, moderationRuleForm, moderationRulesBtn, moderationRulesList, moderationRulesPanel, quickCmdBar, quickCmdModal, quickCmdModalClose, quickCmdModalConfirm, quickCmdModalError, quickCmdModalForm, quickCmdModalMessage, quickCmdModalTitle, quickCmdModalWarning } from "./dom.js";
import { renderPager } from "./lists.js";
import { sendConsoleCommand } from "./players.js";
import { I18N, state } from "./state.js";
import { showConfirm, showToast } from "./ui.js";

// --- command bar + history ---
// History is per-console, in-memory only — same lifetime as the log
// itself (nothing here is persisted; a reload starts fresh, matching
// how the rest of a console's state already works). Only commands
// actually typed into the command bar are recorded — a Quick Command or
// a template already has its own one-click path, so echoing those into
// "what did I type" history too would just be noise.

var MAX_COMMAND_HISTORY = 100;

function pushCommandHistory(c, command) {
  if (!c.history) c.history = [];
  // Mashing the same command twice shouldn't fill history with
  // duplicates — same convention as a shell's history file.
  if (c.history[c.history.length - 1] !== command) {
    c.history.push(command);
    if (c.history.length > MAX_COMMAND_HISTORY) c.history.shift();
  }
  c.historyIndex = null;
  c.historyDraft = "";
}

var COMMAND_HISTORY_PER_PAGE = 10;

function renderCommandHistory(c) {
  cmdHistoryPanel.innerHTML = "";
  var entries = c && c.history ? c.history : [];
  if (!entries.length) {
    var hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = I18N.t("console.historyEmpty");
    cmdHistoryPanel.appendChild(hint);
    return;
  }
  var totalPages = Math.max(1, Math.ceil(entries.length / COMMAND_HISTORY_PER_PAGE));
  var historyPage = Math.min(Math.max(1, c.historyPage || 1), totalPages);
  c.historyPage = historyPage;
  // Most recently sent first. .forEach() (not a for-loop reusing one
  // `var`) so each button's click handler closes over its own `command`
  // — a shared `var` across loop iterations would make every button
  // recall whichever entry the loop last visited, not the one clicked.
  entries.slice().reverse().slice((historyPage - 1) * COMMAND_HISTORY_PER_PAGE, historyPage * COMMAND_HISTORY_PER_PAGE).forEach(function (command) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = command;
    btn.addEventListener("click", function () {
      // Fills the input rather than sending immediately — history can
      // recall something risky (a past kick/ban/stop), so it should
      // always go through a deliberate second Send, same as manual
      // typing would.
      cmdInput.value = command;
      cmdHistoryPanel.hidden = true;
      cmdInput.focus();
    });
    cmdHistoryPanel.appendChild(btn);
  });

  var pagerHost = document.createElement("div");
  pagerHost.className = "pager";
  pagerHost.setAttribute("role", "group");
  cmdHistoryPanel.appendChild(pagerHost);
  renderPager(pagerHost, { page: historyPage, total_pages: totalPages, total: entries.length }, function (p) {
    c.historyPage = p;
    renderCommandHistory(c);
  });
}

cmdHistoryBtn.addEventListener("click", function () {
  var wasHidden = cmdHistoryPanel.hidden;
  cmdTemplatesPanel.hidden = true; // only one of History/Templates open at a time
  moderationRulesPanel.hidden = true;
  cmdHistoryPanel.hidden = !wasHidden;
  if (wasHidden) {
    var historyConsole = state.consoles[state.selectedServerId];
    if (historyConsole) historyConsole.historyPage = 1; // reopen at the newest commands
    renderCommandHistory(historyConsole);
  }
});

// Shell-style Up/Down recall: Up steps backward through this console's
// history (saving whatever was being typed so Down can return to it),
// Down steps forward and clears back to that saved draft at the end.
cmdInput.addEventListener("keydown", function (e) {
  if (e.key === "Tab" && !cmdSuggestions.hidden) {
    var first = cmdSuggestions.querySelector("button");
    if (first) { e.preventDefault(); cmdInput.value = first.dataset.command; cmdSuggestions.hidden = true; }
    return;
  }
  if (e.key === "Escape") { cmdSuggestions.hidden = true; return; }
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  var c = state.consoles[state.selectedServerId];
  if (!c || !c.history || !c.history.length) return;
  e.preventDefault();

  if (e.key === "ArrowUp") {
    if (c.historyIndex == null) {
      c.historyDraft = cmdInput.value;
      c.historyIndex = c.history.length;
    }
    if (c.historyIndex > 0) c.historyIndex--;
  } else {
    if (c.historyIndex == null) return;
    c.historyIndex++;
  }

  if (c.historyIndex >= c.history.length) {
    c.historyIndex = null;
    cmdInput.value = c.historyDraft || "";
  } else {
    cmdInput.value = c.history[c.historyIndex];
  }
});

cmdInput.addEventListener("input", function () {
  cmdSuggestions.innerHTML = "";
  var c = state.consoles[state.selectedServerId];
  var game = c && window.NICON_GAMES[c.gameKey];
  var prefix = cmdInput.value.trim().toLowerCase();
  var commands = (game && game.commands ? game.commands : []).concat((c && c.history) || []);
  var unique = commands.filter(function (command, index, all) { return all.indexOf(command) === index; })
    .filter(function (command) { return prefix && command.toLowerCase().indexOf(prefix) === 0 && command.toLowerCase() !== prefix; }).slice(0, 8);
  unique.forEach(function (command) {
    var button = document.createElement("button"); button.type = "button"; button.dataset.command = command; button.textContent = command;
    button.addEventListener("click", function () { cmdInput.value = command; cmdSuggestions.hidden = true; cmdInput.focus(); });
    cmdSuggestions.appendChild(button);
  });
  cmdSuggestions.hidden = !unique.length;
});

cmdForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var c = state.consoles[state.selectedServerId];
  var command = cmdInput.value.trim();
  if (!command || !sendConsoleCommand(c, command)) return;
  pushCommandHistory(c, command);
  cmdHistoryPanel.hidden = true;
  cmdInput.value = "";
});

// --- command templates ---
// Per-account saved commands (server-side — see
// webspace/handlers/command_templates.php — not localStorage, so they
// follow the user's account rather than one browser), listed in the
// Templates panel next to History and sent through the exact same path
// (sendConsoleCommand above) as one typed by hand. Loaded once per
// sign-in (showAppView) and re-synced from the server's own response on
// every add/delete, rather than trusted purely locally.

state.commandTemplates = [];

function sendMacro(c, source) {
  var steps = source.split(/\r?\n/).map(function (line) { return line.trim(); })
    .filter(function (line) { return line && line.charAt(0) !== "#"; }).slice(0, 20);
  if (!steps.length) return;
  var index = 0;
  function next() {
    if (index >= steps.length) return;
    var step = steps[index++];
    var wait = step.match(/^@wait\s+([0-9]+(?:\.[0-9]+)?)$/i);
    if (wait) { setTimeout(next, Math.min(10, Number(wait[1])) * 1000); return; }
    if (!sendConsoleCommand(c, step, { origin: "macro", action: "macro" })) return;
    setTimeout(next, 750);
  }
  next();
}

export function loadCommandTemplates() {
  return apiFetch("/api/command-templates", { method: "GET" })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (list) {
      state.commandTemplates = list || [];
      renderCommandTemplates();
    })
    .catch(function () { /* templates are a nice-to-have, fail silently */ });
}

function renderCommandTemplates() {
  cmdTemplatesList.innerHTML = "";
  if (!state.commandTemplates.length) {
    var hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = I18N.t("templates.empty");
    cmdTemplatesList.appendChild(hint);
    return;
  }

  state.commandTemplates.forEach(function (tpl) {
    var row = document.createElement("div");
    row.className = "cmd-template-row";

    var info = document.createElement("div");
    info.className = "template-info";
    var name = document.createElement("span");
    name.className = "template-name";
    name.textContent = tpl.name;
    var command = document.createElement("span");
    command.className = "template-command";
    command.textContent = tpl.command;
    info.appendChild(name);
    info.appendChild(command);
    row.appendChild(info);

    var actions = document.createElement("div");
    actions.className = "template-actions-row";

    var sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "btn-xs";
    sendBtn.textContent = I18N.t("templates.send");
    sendBtn.addEventListener("click", function () {
      var c = state.consoles[state.selectedServerId];
      if (c) sendMacro(c, tpl.command);
    });
    actions.appendChild(sendBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-xs btn-xs-danger";
    deleteBtn.textContent = I18N.t("templates.delete");
    deleteBtn.addEventListener("click", function () {
      showConfirm(I18N.t("templates.deleteConfirm", { name: tpl.name })).then(function (ok) {
        if (!ok) return;
        apiFetch("/api/command-templates/" + tpl.id, { method: "DELETE" })
          .then(function (r) {
            if (!r.ok && r.status !== 204) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("templates.deleteFailed")); });
            state.commandTemplates = state.commandTemplates.filter(function (x) { return x.id !== tpl.id; });
            renderCommandTemplates();
          })
          .catch(function (err) { showToast(err.message); });
      });
    });
    actions.appendChild(deleteBtn);

    row.appendChild(actions);
    cmdTemplatesList.appendChild(row);
  });
}

cmdTemplatesBtn.addEventListener("click", function () {
  var wasHidden = cmdTemplatesPanel.hidden;
  cmdHistoryPanel.hidden = true; // only one of History/Templates open at a time
  moderationRulesPanel.hidden = true;
  cmdTemplatesPanel.hidden = !wasHidden;
});

cmdTemplateAddForm.addEventListener("submit", function (e) {
  e.preventDefault();
  cmdTemplateError.hidden = true;
  var name = cmdTemplateNameInput.value.trim();
  var command = cmdTemplateCommandInput.value.trim();
  if (!name || !command) {
    cmdTemplateError.textContent = I18N.t("templates.nameAndCommandRequired");
    cmdTemplateError.hidden = false;
    return;
  }

  apiFetch("/api/command-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, command: command }),
  })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(apiErrorMessage(t) || I18N.t("templates.saveFailed")); });
      return r.json();
    })
    .then(function (tpl) {
      state.commandTemplates.push(tpl);
      state.commandTemplates.sort(function (a, b) { return a.name.localeCompare(b.name); });
      renderCommandTemplates();
      cmdTemplateAddForm.reset();
    })
    .catch(function (err) {
      cmdTemplateError.textContent = err.message;
      cmdTemplateError.hidden = false;
    });
});

// --- word filters and automated moderation ---
state.moderationRules = [];

export function loadModerationRules() {
  return apiFetch("/api/moderation-rules")
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rules) { state.moderationRules = rules || []; renderModerationRules(); })
    .catch(function () { state.moderationRules = []; });
}

export function renderModerationRules() {
  moderationRulesList.innerHTML = "";
  if (!state.moderationRules.length) {
    var empty = document.createElement("p"); empty.className = "hint"; empty.textContent = I18N.t("phase2.noRules");
    moderationRulesList.appendChild(empty); return;
  }
  state.moderationRules.forEach(function (rule) {
    var row = document.createElement("div"); row.className = "cmd-template-row";
    var info = document.createElement("div"); info.className = "template-info";
    var name = document.createElement("span"); name.className = "template-name"; name.textContent = rule.pattern;
    var action = document.createElement("span"); action.className = "template-command";
    action.textContent = rule.action === "highlight" ? I18N.t("phase2.highlight") : (rule.action === "mute" ? I18N.t("phase2.autoMute") : I18N.t("phase2.autoKick"));
    info.appendChild(name); info.appendChild(action); row.appendChild(info);
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "btn-xs btn-xs-danger"; remove.textContent = I18N.t("templates.delete");
    remove.addEventListener("click", function () {
      apiFetch("/api/moderation-rules/" + rule.id, { method: "DELETE" }).then(function (r) {
        if (!r.ok && r.status !== 204) throw new Error("Could not delete rule");
        state.moderationRules = state.moderationRules.filter(function (item) { return item.id !== rule.id; }); renderModerationRules();
      }).catch(function (error) { showToast(error.message); });
    });
    row.appendChild(remove); moderationRulesList.appendChild(row);
  });
}

moderationRulesBtn.addEventListener("click", function () {
  var show = moderationRulesPanel.hidden;
  cmdTemplatesPanel.hidden = true; cmdHistoryPanel.hidden = true;
  moderationRulesPanel.hidden = !show;
});
moderationRuleForm.addEventListener("submit", function (event) {
  event.preventDefault();
  apiFetch("/api/moderation-rules", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pattern: moderationPatternInput.value.trim(), action: moderationActionSelect.value }),
  }).then(function (r) { return r.ok ? r.json() : r.text().then(function (text) { throw new Error(apiErrorMessage(text)); }); })
    .then(function (rule) { state.moderationRules.push(rule); moderationRuleForm.reset(); renderModerationRules(); })
    .catch(function (error) { showToast(error.message); });
});

// --- quick commands ---
// One button per game.quickCommands entry (see docs/games.js) — same
// send path as manual input (sendConsoleCommand above), never a second
// one. Buttons only appear for a recognized game, since the actual
// command syntax is per-game/protocol; an unrecognized server's game
// shows no quick-commands bar at all, same as it already shows no
// player-list parsing.

state.pendingQuickCommand = null; // { c: ..., def: ... } while the dialog is open

export function renderQuickCommands(c) {
  quickCmdBar.innerHTML = "";
  var game = c && c.gameKey ? window.NICON_GAMES[c.gameKey] : null;
  var defs = game && game.quickCommands ? game.quickCommands : null;
  quickCmdBar.hidden = !defs || !defs.length;
  if (!defs) return;

  defs.forEach(function (def) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-cmd-btn" + (def.risk === "high" ? " quick-cmd-btn-danger" : "");
    var label = I18N.t("quickCommands." + def.id);
    btn.textContent = label;
    btn.title = label;
    btn.addEventListener("click", function () { runQuickCommand(c, def); });
    quickCmdBar.appendChild(btn);
  });
  updateQuickCommandsEnabled(c);
}

export function updateQuickCommandsEnabled(c) {
  var ready = !!(c && c.gameConnected && c.socket && c.socket.readyState === WebSocket.OPEN);
  var buttons = quickCmdBar.querySelectorAll("button");
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !ready;
}

function runQuickCommand(c, def) {
  if (!c.gameConnected || !c.socket || c.socket.readyState !== WebSocket.OPEN) return;
  if (def.risk === "low") {
    sendConsoleCommand(c, def.build(), { origin: "quick_action", action: def.id });
    return;
  }
  openQuickCommandModal(c, def);
}

function openQuickCommandModal(c, def) {
  state.pendingQuickCommand = { c: c, def: def };
  var label = I18N.t("quickCommands." + def.id);
  quickCmdModalTitle.textContent = label;

  var needsMessage = def.param === "message";
  quickCmdModalMessage.hidden = !needsMessage;
  quickCmdModalMessage.value = "";
  quickCmdModalWarning.hidden = def.risk !== "high";
  quickCmdModalWarning.textContent = def.risk === "high" ? I18N.t("quickCommands." + def.id + "Confirm") : "";
  quickCmdModalError.hidden = true;
  quickCmdModalConfirm.textContent = I18N.t(def.risk === "high" ? "quickCommands.confirm" : "quickCommands.send");
  quickCmdModalConfirm.className = def.risk === "high" ? "btn-secondary btn-danger" : "btn-primary";

  quickCmdModal.showModal();
  // showModal() focuses the dialog's first focusable element on its
  // own, but that's the "Close" link when the message field was hidden
  // a moment ago — focus it explicitly so typing works right away.
  if (needsMessage) quickCmdModalMessage.focus();
}

function closeQuickCommandModal() {
  quickCmdModal.close();
}

quickCmdModalClose.addEventListener("click", closeQuickCommandModal);
quickCmdModal.addEventListener("click", function (e) {
  if (e.target === quickCmdModal) closeQuickCommandModal();
});
quickCmdModal.addEventListener("close", function () { state.pendingQuickCommand = null; });

quickCmdModalForm.addEventListener("submit", function (e) {
  e.preventDefault();
  if (!state.pendingQuickCommand) return;
  var c = state.pendingQuickCommand.c;
  var def = state.pendingQuickCommand.def;
  var needsMessage = def.param === "message";
  var message = quickCmdModalMessage.value.trim();

  if (needsMessage && !message) {
    quickCmdModalError.textContent = I18N.t("quickCommands.messageRequired");
    quickCmdModalError.hidden = false;
    quickCmdModalMessage.focus();
    return;
  }

  var command = needsMessage ? def.build(message) : def.build();
  quickCmdModal.close();
  if (command) sendConsoleCommand(c, command, { origin: "quick_action", action: def.id });
});
