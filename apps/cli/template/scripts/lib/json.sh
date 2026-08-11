# shellcheck shell=bash
# lib/json.sh — read one field out of a JSON blob, with or without jq.
#
# jq is /usr/bin/jq on macOS and NOT installed on a default Ubuntu. Four
# template scripts reached for it, and three of them are hooks — so on a Linux
# node the web-permission gate, the turn-state reporter and the image guard all
# stopped working at once, and all three did it by evaluating an empty string
# and exiting 0. A hook that "succeeds" because it parsed nothing is the worst
# possible failure: it looks exactly like a hook that ran and approved.
#
# node is the fallback rather than python or sed because every machine that can
# host an agent already has it — the gateway is a node process.

[ -n "${_HERMIT_JSON_SH:-}" ] && return 0
_HERMIT_JSON_SH=1

_lib_dir_json="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./platform.sh
. "$_lib_dir_json/platform.sh"

# json_get <dotted.path> [json]
#
# Reads the JSON from $2 or stdin. Prints the value, or nothing when the path is
# absent — the same shape `jq -r '.a.b // empty'` gives, so call sites keep
# their existing `[ -z "$x" ] && exit 0` logic.
#
# Returns non-zero ONLY when no parser is available at all. A caller that must
# not fail open has to check that:
#
#     value=$(json_get .tool_name "$input") || die_missing "a JSON parser" jq
#
# Arrays and objects come back as compact JSON, which is what both backends do.
json_get() {
  local path="$1" json="${2:-}"
  [ -z "$json" ] && json=$(cat)

  if have jq; then
    printf '%s' "$json" | jq -r "${path} // empty" 2>/dev/null
    return 0
  fi

  if have node; then
    # The path is a jq-ish dotted string; walk it rather than eval it, so a
    # field name from an untrusted payload cannot become code.
    printf '%s' "$json" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let v;
  try { v = JSON.parse(raw); } catch { process.exit(0); }
  const path = process.argv[1].replace(/^\./, "");
  if (path) {
    for (const key of path.split(".")) {
      if (v === null || typeof v !== "object") { v = undefined; break; }
      v = v[key];
    }
  }
  if (v === undefined || v === null) process.exit(0);
  process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
});
' "$path" 2>/dev/null
    return 0
  fi

  return 1
}

# Can anything on this machine parse JSON at all?
#
# Callers that must fail OPEN (the web-permission hook: exit 2 there means
# "deny", which would block every tool the agent has) use this to say so out
# loud before deferring, instead of deferring silently forever.
have_json_parser() { have jq || have node; }

# json_array_has <dotted.path> <value> [json] — is <value> an element of the
# array at that path? Exit 0 yes, 1 no, 2 when nothing can parse.
json_array_has() {
  local path="$1" needle="$2" json="${3:-}"
  [ -z "$json" ] && json=$(cat)

  if have jq; then
    printf '%s' "$json" | jq -e --arg n "$needle" "((${path} // []) | index(\$n)) != null" >/dev/null 2>&1
    return $?
  fi

  if have node; then
    printf '%s' "$json" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let v;
  try { v = JSON.parse(raw); } catch { process.exit(1); }
  const path = process.argv[1].replace(/^\./, "");
  if (path) {
    for (const key of path.split(".")) {
      if (v === null || typeof v !== "object") { v = undefined; break; }
      v = v[key];
    }
  }
  process.exit(Array.isArray(v) && v.includes(process.argv[2]) ? 0 : 1);
});
' "$path" "$needle" 2>/dev/null
    return $?
  fi

  return 2
}

# json_quote <string> → a JSON string literal, quotes and escaping included.
# For building a patch object in shell without hand-rolling escapes.
json_quote() {
  if have jq; then
    printf '%s' "$1" | jq -Rs .
  elif have node; then
    printf '%s' "$1" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => process.stdout.write(JSON.stringify(raw)));
'
  else
    return 1
  fi
}

# json_merge <patch-json> [base-json]
#
# Shallow merge, patch wins. Base comes from $2 or stdin. Used where a script
# updates a few top-level fields of a state file it owns.
json_merge() {
  local patch="$1" base="${2:-}"
  [ -z "$base" ] && base=$(cat)

  if have jq; then
    printf '%s' "$base" | jq -c --argjson patch "$patch" '. * $patch' 2>/dev/null
    return $?
  fi

  if have node; then
    printf '%s' "$base" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const base = JSON.parse(raw);
    const patch = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify({ ...base, ...patch }));
  } catch {
    process.exit(1);
  }
});
' "$patch" 2>/dev/null
    return $?
  fi

  return 1
}

# NOTE — there is deliberately no `json_get_or_die`.
#
# The obvious helper ("read this field, or exit") CANNOT WORK, because every
# call site reads its value with `x=$(json_get …)`. `exit` inside a command
# substitution ends the SUBSHELL; the parent carries on with an empty string
# and then takes whatever branch an empty value leads to. Measured while
# building this: the image hook printed "refusing to continue — a hook that
# cannot parse its input must not pass" and then exited 0, which is precisely
# the silent pass the whole exercise exists to remove.
#
# So availability is checked ONCE, in the parent shell, before any substitution:
#
#     have_json_parser || { echo "…" >&2; exit 2; }   # or exit 0, per hook
#     tool=$(json_get '.tool_name' "$input")
#
# Which exit code is right differs per hook and is a real decision, not a
# default — the image hook blocks (2) because an unverified image wedges the
# session, while the permission hook defers (0) because 2 there means "deny"
# and would block every tool the agent has.
