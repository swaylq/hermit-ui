# `secret` — encrypted credentials for the agent fleet

Ships in the repo so any machine that clones hermit-ui can self-initialize.
What's here is **public-safe only**: the CLI, the age **public** recipient, and
the usage doc. The age **private key** and the encrypted **store** are NEVER
committed (this repo is public) — they're supplied once over stdin at `init`.

## Files
- `secret` — the CLI (bash 3.2). Subcommands: `init list get set rm exec load`.
- `hermit-secrets-recipient.txt` — age **public** key (recipients can't decrypt; safe).
- `secrets-usage.md` — agent-facing usage + safety rules (also @import'd into CLAUDE.md).

## Initialize a new machine
The machine already has this repo (the gateway is cloned to `~/hermit-ui`).

```sh
# 1. age is required
brew install age            # macOS;  apt-get install -y age on Linux

# 2. run init, piping the shared private key (+ optional store) on STDIN.
#    From a machine that already has secret working, e.g. the Mac:
{ security find-generic-password -s hermit-secrets-age -w        # the age private key
  printf '==SECRETS-STORE==\n'
  cat ~/.claude/global-memory/secrets.age                        # the encrypted store
} | ssh NEWHOST '~/hermit-ui/apps/gateway/scripts/secret/secret init'
```

`init` is idempotent and:
- symlinks `~/.local/bin/secret` → this repo copy (so `git pull` keeps it current),
- installs the recipient + usage doc into `~/.claude/…`,
- writes the private key to `~/.claude/hermit-secrets-identity.txt` (mode 600) —
  it does **not** call `security add-generic-password`, which needs an interactive
  GUI dialog and would hang over SSH,
- installs the store (if piped) at `~/.claude/global-memory/secrets.age`,
- verifies it can decrypt.

Verify: `secret list` (names only). The key never touches argv or this terminal —
it flows Keychain → pipe → ssh → remote file.

## Identity: Keychain vs file
Decrypt prefers the macOS Keychain (service `hermit-secrets-age`); if absent it
falls back to the mode-600 identity file. The original Mac keeps its key in
Keychain (never on disk); SSH-provisioned machines use the identity file because
Keychain writes can't be scripted headlessly. To use Keychain on a new machine
instead, add it interactively in a real Terminal and delete the identity file.

## Shared-key model
One age keypair for the whole fleet → the same `secrets.age` decrypts everywhere.
`secret set` / `rm` on one machine only changes THAT machine's local store; there
is no auto-sync yet (re-distribute the store, or add a gateway sync, if needed).
