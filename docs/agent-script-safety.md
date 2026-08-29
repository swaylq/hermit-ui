# Agent Script Safety — Rules for Long-Running and Browser Scripts

**Status:** advisory rules for every agent that writes scripts on a hermit machine.
Backed by the gateway watchdogs (Settings → Watchdogs), which are the *external* bound —
a script's own cleanup must never be the only thing standing between a bug and a host
that strangles itself.

Two incidents shape these rules:

- **2026-08-26** — a batch script leaked 391 headless browsers over 8 hours (its own
  leak watchdog was dead code: Linux-only `ps etimes` on macOS, exception swallowed by
  `catch {}`), taking a machine to load 237 and stopping chat fleet-wide.
- **2026-08-29** — a load-test script left 8 `while :; do :; done` loops running for
  12 days (its own `kill $(jobs -p)` was dead code: in a non-interactive shell job
  control is off, so `jobs -p` is always empty), each pinning a core, load 8.4.

The common thread: **a cleanup step inside the leaking script cannot be trusted** — it is
one silent bug away from never running. Write cleanup so it works in the shell you
actually run in, and let the fleet-side watchdogs be the backstop.

## Rule 1 — Never clean up background jobs with `jobs -p`

`jobs` only tracks background jobs when the shell has job control on, and job control
is off in every non-interactive shell — which is exactly what a script run by an agent
tool runs in. `jobs -p` returns empty and `kill $(jobs -p)` kills nothing.

```sh
# WRONG — silently kills nothing in a non-interactive shell
(sleep 100) & (sleep 100) &
LOADPIDS=$(jobs -p)        # always empty
kill $LOADPIDS

# RIGHT — capture each pid and kill it explicitly
pids=""
(sleep 100) & pids="$pids $!"
(sleep 100) & pids="$pids $!"
trap 'kill $pids 2>/dev/null' EXIT INT TERM HUP
```

Or wrap the whole thing in a timeout so nothing can outlive the job:

```sh
timeout 120 bash -c 'your_work_here'
```

**Load-testing is the dangerous case**: the whole point is to spin up burners, so a
missing kill means permanent CPU loss. Always pair burners with a `trap` or `timeout`,
and prefer `yes > /dev/null`-style bounded loops over bare `while :; do :; done` when a
bounded form would serve.

## Rule 2 — A `chromium.launch` must be paired with a `finally` close

A browser you launch yourself (not the shared per-agent Chrome) is your process to
reap. `close()` on the happy path is not enough — any throw skips it and leaves a
headless process until the stray-reaper finds it hours later.

```js
// WRONG — an exception anywhere above skips close()
const b = await chromium.launch({ headless: true });
const page = await b.newPage();
await page.goto(url);
await b.close();

// RIGHT
const b = await chromium.launch({ headless: true });
try {
  const page = await b.newPage();
  await page.goto(url);
} finally {
  await b.close().catch(() => {});
}
```

For the shared per-agent Chrome (via `chrome-launcher.sh` / `connectOverCDP`), the rule
inverts: **never `browser.close()`**, only `page.close()` in `finally` — the browser is
shared and its lifecycle is the launcher's and `chrome-reaper`'s, not yours.

## Rule 3 — A batch script needs three things

A loop that launches a browser (or any heavy process) per item, unattended, must carry:

1. **Single-instance guard** — a lock file or pidfile so two runs cannot double the
   leak. `browser-lock.sh` already does this for browser tasks; reuse it.
2. **Signal escorts** — on `SIGINT`/`SIGTERM`/`SIGHUP`, close what you opened, then
   exit. A tmux pane dying sends `SIGHUP`; without this, your children get reparented
   to pid 1 and outlive you (the 2026-08-29 shape).
3. **A global timeout** — a per-item timeout does not bound the whole run; a whole-run
   timeout does. `browser-lock.sh run --timeout N` covers both.

```js
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => { browser.close().catch(() => {}); process.exit(code); });
}
```

## The backstop — why the rules can be violated once without losing a machine

The gateway runs three process-reaping ticks, all configurable in **Settings → Watchdogs**:

| Watchdog | What it kills | Default |
|---|---|---|
| Stray browser reaper | headless browsers nobody owns, by age / count | 2h old, or >25 roots |
| Idle Chrome reaper | an agent's shared Chrome left idle | 10 min |
| CPU orphan reaper | orphaned (pid-1) processes pinned at ≥90% of one core | 2h accumulated CPU, 3 samples |

The defaults are deliberately loose — a legitimate one-shot job is never touched. Tighten
or loosen them on the Watchdogs page rather than in scripts.
