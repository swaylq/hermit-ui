# shellcheck shell=bash
# lib/platform.sh — the small facts every other script needs about this machine.
#
# Source it, don't run it:
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/platform.sh"
#
# The agent template used to be macOS-only by accident rather than by decision:
# sips, /usr/bin/jq and a bare `google-chrome` are all things a Mac happens to
# have. On Ubuntu each one failed differently, and two of them failed SILENTLY —
# which is the part that mattered. A hook that cannot check something must say
# so and stop, never shrug and exit 0.

# Guard against double-sourcing (hooks source this from several entry points).
[ -n "${_HERMIT_PLATFORM_SH:-}" ] && return 0
_HERMIT_PLATFORM_SH=1

# A daemon-spawned hook inherits a thin PATH. Everything below probes for real
# binaries, so give it the places they actually live first.
case ":$PATH:" in
  *":/usr/local/bin:"*) ;;
  *) PATH="/usr/bin:/bin:/usr/local/bin:$PATH" ;;
esac
[ -d /opt/homebrew/bin ] && case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
[ -d "$HOME/.local/bin" ] && case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
export PATH

# `macos` | `linux` | `unknown`
os_kind() {
  case "$(uname -s)" in
    Darwin) echo macos ;;
    Linux)  echo linux ;;
    *)      echo unknown ;;
  esac
}

is_macos() { [ "$(uname -s)" = "Darwin" ]; }
is_linux() { [ "$(uname -s)" = "Linux" ]; }

# Is this binary runnable?
have() { command -v "$1" >/dev/null 2>&1; }

# Print the install command for THIS platform. Naming the wrong package manager
# is worse than naming none — it sends the reader down a dead end.
install_hint() {
  local apt_pkg="$1" brew_pkg="${2:-$1}"
  if is_linux; then echo "sudo apt install -y $apt_pkg"
  elif is_macos; then echo "brew install $brew_pkg"
  else echo "install $apt_pkg"
  fi
}

# Bail out loudly, naming the package. For a hook, exit 2 is what reaches the
# model; for a plain script it is an ordinary failure. Either way the message
# says what to install rather than leaving a reader to guess from "command not
# found".
die_missing() {
  local what="$1" apt_pkg="$2" brew_pkg="${3:-$2}"
  echo "error: $what is not available on this machine ($(os_kind))." >&2
  echo "  install it with: $(install_hint "$apt_pkg" "$brew_pkg")" >&2
  exit 2
}
