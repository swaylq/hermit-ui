# shellcheck shell=bash
# lib/image.sh — read and rewrite images, on whatever backend this box has.
#
# Three backends, probed in this order:
#   1. sips        — macOS built-in, zero dependencies, what this all started as
#   2. ImageMagick — `identify` + `magick`/`convert`, the Linux default answer
#   3. Python PIL  — the fallback when someone has pillow but not ImageMagick
#
# The order is "cheapest and most certainly present first", not "best".
#
# WHY THIS MATTERS MORE THAN IT LOOKS: the image path guards a HARD RULE — an
# oversized image read into context wedges the session with a 400 that repeats
# on every subsequent call until /compact. On Ubuntu the old code failed two
# ways at once: safe-image.sh exited 127 (no sips), and the pre-read hook,
# having no jq either, parsed an empty tool_name and exited 0 — so the guard
# silently disappeared and every image went straight through. A missing backend
# must therefore be LOUD (image_backend returns none; callers block), never a
# quiet pass.

[ -n "${_HERMIT_IMAGE_SH:-}" ] && return 0
_HERMIT_IMAGE_SH=1

_lib_dir_image="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./platform.sh
. "$_lib_dir_image/platform.sh"

# `sips` | `magick` | `pil` | `none`
image_backend() {
  if [ -n "${_HERMIT_IMAGE_BACKEND:-}" ]; then echo "$_HERMIT_IMAGE_BACKEND"; return 0; fi
  if have sips; then _HERMIT_IMAGE_BACKEND=sips
  elif have identify && { have magick || have convert; }; then _HERMIT_IMAGE_BACKEND=magick
  elif python3 -c 'import PIL' >/dev/null 2>&1; then _HERMIT_IMAGE_BACKEND=pil
  else _HERMIT_IMAGE_BACKEND=none
  fi
  echo "$_HERMIT_IMAGE_BACKEND"
}

# The ImageMagick 7 name, falling back to the 6 one.
_magick() { if have magick; then echo magick; else echo convert; fi; }

# Human-readable "install one of these" line, for the block messages.
image_backend_hint() {
  if is_linux; then echo "sudo apt install -y imagemagick   # or: pip3 install pillow"
  elif is_macos; then echo "sips ships with macOS — if it is missing, try: brew install imagemagick"
  else echo "install ImageMagick or Python pillow"
  fi
}

# image_dims <file> → "W H" on stdout, non-zero exit if it cannot be determined.
#
# Prints nothing on failure so callers can test for an empty string, which is
# what the existing hook already does.
image_dims() {
  local f="$1" w h
  case "$(image_backend)" in
    sips)
      w=$(sips -g pixelWidth  "$f" 2>/dev/null | awk '/pixelWidth/{print $2}')
      h=$(sips -g pixelHeight "$f" 2>/dev/null | awk '/pixelHeight/{print $2}')
      ;;
    magick)
      # %w %h is the canonical form and works on both 6 and 7. [0] takes the
      # first frame — a multi-page tiff or animated gif otherwise prints one
      # line per frame and the caller gets "1200 800 1200 800 …".
      read -r w h <<<"$(identify -format '%w %h' "$f[0]" 2>/dev/null)"
      ;;
    pil)
      read -r w h <<<"$(python3 -c '
import sys
from PIL import Image
with Image.open(sys.argv[1]) as im:
    print(im.size[0], im.size[1])
' "$f" 2>/dev/null)"
      ;;
    *) return 1 ;;
  esac
  # Catches empty, "<nil>" (what sips prints for an unreadable file) and any
  # other non-numeric output in one test.
  case "$w$h" in
    ""|*[!0-9]*) return 1 ;;
  esac
  echo "$w $h"
}

# image_format <file> → a lowercase format name (jpeg, png, tiff, …), or empty.
image_format() {
  local f="$1"
  case "$(image_backend)" in
    sips)   sips -g format "$f" 2>/dev/null | awk '/format:/{print $2}' ;;
    magick) identify -format '%m' "$f[0]" 2>/dev/null | tr '[:upper:]' '[:lower:]' ;;
    pil)    python3 -c '
import sys
from PIL import Image
with Image.open(sys.argv[1]) as im:
    print((im.format or "").lower())
' "$f" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# image_to_png <src> <dst> [max_px]
#
# Always writes PNG bytes; resizes so the long edge is ≤ max_px when given.
# Both matter: the API rejects by sniffed content type, so a `.png` filename
# holding TIFF bytes 400s exactly like an oversized image does (2026-05-14).
image_to_png() {
  local src="$1" dst="$2" max="${3:-}"
  case "$(image_backend)" in
    sips)
      cp "$src" "$dst" || return 1
      local args=(-s format png)
      if [ -n "$max" ]; then
        local dims w h
        dims=$(image_dims "$src") || return 1
        w=${dims% *}; h=${dims#* }
        if [ "$w" -ge "$h" ]; then args+=(--resampleWidth "$max"); else args+=(--resampleHeight "$max"); fi
      fi
      sips "${args[@]}" "$dst" >/dev/null 2>&1 || return 1
      ;;
    magick)
      # `>` means "only shrink" — without it a small image is UPSCALED to the
      # limit, which is a quality loss and a pointless file-size increase.
      if [ -n "$max" ]; then
        "$(_magick)" "$src[0]" -resize "${max}x${max}>" "png:$dst" 2>/dev/null || return 1
      else
        "$(_magick)" "$src[0]" "png:$dst" 2>/dev/null || return 1
      fi
      ;;
    pil)
      python3 -c '
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
max_px = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0
with Image.open(src) as im:
    im = im.convert("RGBA") if im.mode in ("P", "LA", "RGBA") else im.convert("RGB")
    if max_px and max(im.size) > max_px:
        im.thumbnail((max_px, max_px))
    im.save(dst, format="PNG")
' "$src" "$dst" "$max" 2>/dev/null || return 1
      ;;
    *) return 1 ;;
  esac
  [ -s "$dst" ]
}
