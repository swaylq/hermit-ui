// Canonical tmux pane name for a chat session — the single source of truth on the
// dashboard side (the custom server's terminal WS bridge + the terminal page's
// copy-this-command string). Mirrors @hermit-ui/tmux-driver's paneName() exactly,
// kept as a separate PURE, browser-safe copy (zero node imports) so the client bundle
// never has to pull in the gateway's tmux/pty driver just to render "hermit-<id>".
// If you change the derivation, change it in packages/tmux-driver/src/index.ts too —
// a future shared contract package (docs/code-quality-backlog.md P1-3) would unify them.
export function tmuxPaneName(sessionId: string): string {
  // tmux session names allow alnum + . _ -. Take the last 12 chars of the id (cuids
  // are 25 chars; the entropic suffix is what we keep) — short but collision-resistant.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12);
  return `hermit-${safe}`;
}
