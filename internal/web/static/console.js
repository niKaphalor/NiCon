(function () {
  "use strict";

  var form = document.getElementById("cmd-form");
  var input = document.getElementById("cmd-input");
  var log = document.getElementById("log");
  var serverID = form.dataset.serverId;

  function append(line) {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var command = input.value.trim();
    if (!command) {
      return;
    }
    append("> " + command);
    input.value = "";
    input.disabled = true;

    fetch("/servers/" + encodeURIComponent(serverID) + "/rcon", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "command=" + encodeURIComponent(command),
    })
      .then(function (response) {
        return response.text().then(function (text) {
          return { ok: response.ok, text: text };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          append("error: " + result.text);
        } else {
          append(result.text.length ? result.text : "(no output)");
        }
      })
      .catch(function (err) {
        append("error: " + err.message);
      })
      .finally(function () {
        input.disabled = false;
        input.focus();
      });
  });
})();
