#!/bin/bash
# rollout-mannered-prose.sh — push sway's 2026-09-04 rule into every agent on this machine.
#
#   "Please remove all mannered prose."
#
# His words, verbatim, marked as the rule that outranks the rest of the section. This is
# the third house-style constraint, after 2026-08-25 (length and structure, no coined
# terms) and 2026-08-26 (sentences must read as if a person wrote them). Deliberately NOT
# expanded into a checklist of symptoms: on 2026-08-26 that expansion was rejected —
# "不需要这些详细，直接把我刚刚的翻译成英文" — a general constraint turned into five
# special cases costs context and narrows the rule.
#
# Two files per agent, both taken from the template so a rolled agent and a freshly
# scaffolded one are byte-identical:
#   AGENTS.md   first rule of '## Reporting Style'
#   CHAT.md     first bullet of '## How to answer'  (pure-chat sessions see only this)
#
#   bash scripts/rollout-mannered-prose.sh --dry    # show what would change
#   bash scripts/rollout-mannered-prose.sh          # apply
#
# Idempotent: a second run is a clean no-op. Every file it rewrites is copied first to
# ~/.trash-2026-09-04-mannered-prose/ with its path flattened, so a rollback is a copy back.
#
#   AGENTS_ROOT=~/agents bash scripts/rollout-mannered-prose.sh   # zhinan-macmini001 layout
set -uo pipefail

AGENTS_ROOT="${AGENTS_ROOT:-$HOME/claudeclaw}"
BACKUP="${BACKUP_DIR:-$HOME/.trash-2026-09-04-mannered-prose}"
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

[ -d "$AGENTS_ROOT" ] || { echo "no agents root: $AGENTS_ROOT" >&2; exit 1; }

splice() {  # <agent dir> <dry 0|1> <backup dir>; prints "<agents-word> <chat-word>"
  python3 - "$1" "$2" "$3" <<'PY'
import os, sys
d, dry, backup = sys.argv[1], sys.argv[2] == '1', sys.argv[3]

RULE = ("**Please remove all mannered prose.** This is the most important rule in this section;\n"
        "where it conflicts with anything below, it wins.\n\n")
BULLET = ("- Please remove all mannered prose — the most important rule here, it outranks\n"
          "  the rest of this list.\n")
MARK = 'mannered prose'

def save(path, text):
    if dry:
        return
    rel = os.path.relpath(path, os.path.expanduser('~')).replace(os.sep, '__')
    os.makedirs(backup, exist_ok=True)
    with open(os.path.join(backup, rel), 'w') as f:
        f.write(open(path).read())
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write(text)
    assert os.path.getsize(tmp) > 0
    os.replace(tmp, path)

def do_agents(path):
    if not os.path.isfile(path):
        return 'no-file'
    s = open(path).read()
    if MARK in s:
        return 'present'
    lines = s.splitlines(keepends=True)
    try:
        head = next(i for i, l in enumerate(lines) if l.startswith('## Reporting Style'))
    except StopIteration:
        return 'no-section'
    end = next((i for i, l in enumerate(lines[head+1:], head+1) if l.startswith('## ')), len(lines))
    # Preferred anchor: the rule that currently opens the section. Otherwise the top of
    # the section body, after the heading and its blank line. Never a fuzzy match.
    at = next((i for i in range(head, end) if lines[i].startswith('**Answer, then stop.**')), None)
    if at is None:
        at = head + 1
        while at < end and lines[at].strip() == '':
            at += 1
    save(path, ''.join(lines[:at]) + RULE + ''.join(lines[at:]))
    return 'inserted'

def do_chat(path):
    if not os.path.isfile(path):
        return 'no-file'
    s = open(path).read()
    if MARK in s:
        return 'present'
    anchor = '## How to answer\n\n'
    if s.count(anchor) != 1:
        return 'no-section'
    save(path, s.replace(anchor, anchor + BULLET, 1))
    return 'inserted'

print(do_agents(os.path.join(d, 'AGENTS.md')), do_chat(os.path.join(d, 'CHAT.md')))
PY
}

printf '%-28s %-10s %s\n' AGENT AGENTS.md CHAT.md
ins_a=0; ins_c=0; skip=0
for dir in "$AGENTS_ROOT"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/AGENTS.md" ] || [ -f "$dir/CHAT.md" ] || continue
  read -r a c < <(splice "${dir%/}" "$DRY" "$BACKUP") || { echo "FAILED $name" >&2; continue; }
  printf '%-28s %-10s %s\n' "$name" "$a" "$c"
  [ "$a" = inserted ] && ins_a=$((ins_a+1))
  [ "$c" = inserted ] && ins_c=$((ins_c+1))
  { [ "$a" = no-section ] || [ "$a" = no-file ]; } && skip=$((skip+1))
done

echo
[ "$DRY" = 1 ] && echo "(dry run — nothing written)"
echo "AGENTS.md updated: $ins_a   CHAT.md updated: $ins_c   AGENTS.md skipped: $skip"
[ "$DRY" = 1 ] || echo "backups: $BACKUP"
