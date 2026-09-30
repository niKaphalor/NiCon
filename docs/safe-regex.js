// Static safety check for the regular expression a user types into the
// console filter. That pattern runs over up to 2,000 log lines whose content
// comes from a game server (or from other players), so a pathological pattern
// — the classic "(a+)+" family — can freeze the browser tab: JavaScript cannot
// interrupt a regex once it is running.
//
// This is deliberately conservative ("hard limits" rather than a full
// analysis): it rejects the constructs that cause exponential backtracking
// and bounds the ones that cause polynomial backtracking. A rejected
// pattern is simply not applied and the UI says why; some harmless but
// unusual patterns (for example a repeated group that contains an
// alternation, like "(foo|bar)+") are rejected too.
//
//   analyze(pattern) -> { ok: true } | { ok: false, reason: <code> }
//
// reason codes: "length", "backreference", "nested", "quantifiers", "repeat",
// "syntax".
//
// Complements (does not replace) the runtime guards in app.js's renderLog:
// each line is only tested up to a maximum length, and filtering stops once a
// time budget is spent.
(function () {
  "use strict";

  var MAX_LENGTH = 100;       // characters in the pattern
  var MAX_QUANTIFIERS = 8;    // quantifiers in total
  var MAX_UNBOUNDED = 3;      // * + {n,} — each one multiplies the worst case by the line length
  var MAX_REPEAT = 1000;      // the largest number allowed inside {n,m}
  var MAX_PRODUCT = 200;      // bounded repeats inside bounded repeats: (x{1,20}){1,20} multiplies out

  function fail(reason) { return { ok: false, reason: reason }; }

  function newGroup() {
    return { hasRepeat: false, hasUnbounded: false, hasAlt: false, product: 1 };
  }

  // Reads a "{n}", "{n,}" or "{n,m}" quantifier at index i (which points at
  // "{"). Anything else is a literal brace in non-unicode mode.
  function readBraces(pattern, i) {
    var match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i, i + 24));
    if (!match) return null;
    var min = parseInt(match[1], 10);
    var hasComma = match[2] === ",";
    var max = hasComma ? (match[3] === "" ? Infinity : parseInt(match[3], 10)) : min;
    return { length: match[0].length, min: min, max: max };
  }

  function analyze(pattern) {
    if (typeof pattern !== "string") return fail("syntax");
    if (pattern.length > MAX_LENGTH) return fail("length");

    var stack = [];
    var current = newGroup();      // the group we are inside (start: the whole pattern)
    var lastAtom = null;           // { group: <closed group info> | null } for the token before a quantifier
    var quantifiers = 0;
    var unbounded = 0;
    var i = 0;

    while (i < pattern.length) {
      var ch = pattern.charAt(i);

      if (ch === "\\") {
        var next = pattern.charAt(i + 1);
        if (next === "k" || (next >= "1" && next <= "9")) return fail("backreference");
        lastAtom = { group: null };
        i += 2;
        continue;
      }

      if (ch === "[") {
        i++;
        if (pattern.charAt(i) === "^") i++;
        while (i < pattern.length && pattern.charAt(i) !== "]") {
          if (pattern.charAt(i) === "\\") i++;
          i++;
        }
        if (i >= pattern.length) return fail("syntax");
        i++;
        lastAtom = { group: null };
        continue;
      }

      if (ch === "(") {
        stack.push(current);
        current = newGroup();
        i++;
        if (pattern.charAt(i) === "?") {
          var kind = pattern.slice(i + 1, i + 3);
          if (kind.charAt(0) === ":" || kind.charAt(0) === "=" || kind.charAt(0) === "!") {
            i += 2;
          } else if (kind === "<=" || kind === "<!") {
            i += 3;
          } else if (kind.charAt(0) === "<") {
            var nameEnd = pattern.indexOf(">", i);
            if (nameEnd < 0) return fail("syntax");
            i = nameEnd + 1;
          } else {
            return fail("syntax");
          }
        }
        lastAtom = null;
        continue;
      }

      if (ch === ")") {
        if (!stack.length) return fail("syntax");
        var closed = current;
        current = stack.pop();
        // Whatever repeats or alternates inside a group is inside its parents too.
        current.hasRepeat = current.hasRepeat || closed.hasRepeat;
        current.hasUnbounded = current.hasUnbounded || closed.hasUnbounded;
        current.hasAlt = current.hasAlt || closed.hasAlt;
        current.product = Math.max(current.product, closed.product);
        lastAtom = { group: closed };
        i++;
        continue;
      }

      if (ch === "|") {
        current.hasAlt = true;
        lastAtom = null;
        i++;
        continue;
      }

      var isQuantifier = ch === "*" || ch === "+" || ch === "?" || ch === "{";
      if (isQuantifier) {
        var repeats = false;   // may match more than once
        var isUnbounded = false;
        var maxCount = 1;      // upper bound of repetitions when bounded
        var consumed = 1;
        if (ch === "*" || ch === "+") {
          repeats = true;
          isUnbounded = true;
        } else if (ch === "{") {
          var braces = readBraces(pattern, i);
          if (!braces) {        // a literal "{"
            lastAtom = { group: null };
            i++;
            continue;
          }
          consumed = braces.length;
          if ((braces.min > MAX_REPEAT) || (braces.max !== Infinity && braces.max > MAX_REPEAT)) return fail("repeat");
          repeats = braces.max > 1;
          isUnbounded = braces.max === Infinity;
          maxCount = isUnbounded ? 1 : braces.max;
        }
        if (lastAtom === null) return fail("syntax"); // nothing to repeat
        quantifiers++;
        if (repeats) {
          var inner = lastAtom.group;
          if (inner) {
            // The exponential-backtracking shapes: an unbounded repeat inside
            // any repeat — (a+)+  (a*)*  (x+x+)+  (.*a){12} — and a group that
            // alternates or repeats inside an UNBOUNDED repeat — (a|aa)+  ((a{1,3})b)*.
            if (inner.hasUnbounded) return fail("nested");
            if (isUnbounded && (inner.hasRepeat || inner.hasAlt)) return fail("nested");
            // Bounded inside bounded (an IP address: \d{1,3}(\.\d{1,3}){3}) is
            // fine while the counts multiply out to something small.
            if (!isUnbounded && inner.product * maxCount > MAX_PRODUCT) return fail("nested");
          }
          current.hasRepeat = true;
          current.product = Math.max(current.product, (inner ? inner.product : 1) * maxCount);
        }
        if (isUnbounded) {
          unbounded++;
          current.hasUnbounded = true;
        }
        if (quantifiers > MAX_QUANTIFIERS || unbounded > MAX_UNBOUNDED) return fail("quantifiers");
        i += consumed;
        if (pattern.charAt(i) === "?") i++; // lazy modifier
        lastAtom = null;                    // a quantified atom is not quantified again
        continue;
      }

      lastAtom = { group: null };            // ordinary character, ".", "^", "$", ...
      i++;
    }

    if (stack.length) return fail("syntax");
    return { ok: true };
  }

  window.NICON_SAFE_REGEX = { analyze: analyze, MAX_LENGTH: MAX_LENGTH };
})();
