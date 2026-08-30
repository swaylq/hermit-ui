---
name: worktree
description: Use BEFORE editing files in any git repo when another live session of this agent could be working in it too — every dashboard session of an agent shares one checkout, so concurrent edits and branch switches clobber each other. Gives this session its own git worktree, lands the work onto the base branch without anyone checking it out, and cleans up after dead sessions. Triggers - the session-start notice says other sessions are live, "another session changed my files", "branch switched under me", work spanning several commits in a shared repo.
---

# worktree — one repo, several sessions, no collisions

Every session of this agent runs in the **same directory** — whichever backend drives
it (a `claude-sdk` subprocess of the gateway, or a tmux pane). They share every git
repo in it. So a `git switch` in one session moves the working tree under another, and
two sessions editing the same file overwrite each other — both have happened here.

This skill hands you your own worktree when, and only when, that risk is real.

**Announce it:** "Another session of this agent is live — using the worktree skill to
work in an isolated checkout."

`wt.sh` lives next to this file (the absolute path below is this agent's). Everything below is idempotent; running it twice is
safe, and so is running it in a session that's already isolated.

## 1. Before you edit — ask

```bash
{{AGENT_DIR}}/.claude/skills/worktree/wt.sh check <repo>
```

Three answers:

- `isolated=no reason=sole-session` — you're the only live session. **Work in the main
  checkout as usual.** Isolation costs a full checkout plus a dependency install; don't
  pay it for nothing.
- `isolated=needed siblings=N` — go to step 2.
- `isolated=already` — you're in a worktree. Carry on; land it when done.

`check` and `enter` also warn about the **repo itself**. Two states are ordinary for a
project someone started with `git init` and never pushed, and git only complains about
them much later, in wording that names none of this:

- *no commits yet* — isolation is impossible. `git worktree add` needs a real HEAD and
  dies with `fatal: invalid reference: HEAD`. This one blocks.
- *no remote* — it works, but `land` can only move a local ref, so the main checkout's
  files stay as they are and nobody is told.

Both are fixed by giving the repo a home on GitLab:

```bash
{{AGENT_DIR}}/.claude/skills/worktree/gitlab-init.sh <repo>
```

It creates the project under `swaylq/` on `git.daguchuangyi.com` (private), wires up
`origin`, pushes, and installs a git credential helper that reads `GITLAB_TOKEN` out of
the encrypted store on each call — so the plain `git fetch` / `git push` that `land`
runs work afterwards, with the token never in a config file, a remote URL or an argv.

It **refuses** while the repo has no commits, and prints the five biggest files it would
otherwise take. Decide `.gitignore` before that first commit: a worktree is a full
checkout, so every session pays for every byte you track. One repo here was 406MB, of
which 344MB was source art that never needed to be in git.

## 2. Enter

```bash
WT=$({{AGENT_DIR}}/.claude/skills/worktree/wt.sh enter <repo>) && cd "$WT"
```

Prints the worktree path (`~/.hermit/worktrees/<repo>/<session-id>`, branch
`wt/<session-id>`). Reuses yours if it exists — a restarted session picks its work back
up, including uncommitted changes.

**From here on, every path you touch is inside `$WT`.** The main checkout's paths are
not yours any more. This is the whole point; editing both is exactly the collision the
skill exists to prevent.

**Dependencies, if the work needs a build or tests:**

```bash
cd "$WT" && NODE_ENV=development npm install     # or the project's own install
```

`NODE_ENV` matters. This shell exports `NODE_ENV=production`, under which npm silently
skips devDependencies — and the failure surfaces much later as a build error that names
something unrelated (`next build` reporting an `entryCSSFiles` invariant). Doc-only work
doesn't need any of this.

## 3. Land it

Only after the work is verified the way that repo expects (tests, typecheck, build).

```bash
{{AGENT_DIR}}/.claude/skills/worktree/wt.sh land "$WT"
```

It fetches, rebases onto `origin/<base>`, pushes `HEAD:<base>`, then removes the
worktree and its branch.

**Nobody checks out the base branch — not even you.** That's why no other session is
disturbed. The main checkout simply reports "behind" until it pulls; that is expected,
not a fault.

**When the main checkout is the live thing, landing is not the last step.** A preview
server serving it, another session reading it, a person looking at it — then add:

```bash
git -C <repo> pull --ff-only
```

`land` moves the repository, not those files. Skip the pull and your work is invisible
to everyone else while nothing reports an error. A *rejected* pull means someone is
editing a file you also changed — that, and only that, is worth a message to them.

It refuses, loudly, when:

- the worktree is dirty → commit or stash first;
- the rebase conflicts → it aborts and leaves everything intact for you to resolve **in
  the worktree**, then re-run;
- the push is rejected → someone moved the base; re-run to rebase again.

Never work around a refusal by checking out the base branch in the main checkout. That
reintroduces the exact problem this prevents.

## 4. Sweep (cheap, do it when you land or when you notice mess)

```bash
{{AGENT_DIR}}/.claude/skills/worktree/wt.sh sweep <repo>
```

Worktrees whose session is gone: removed if clean **and** already on the remote base,
otherwise reported and left alone. Uncommitted work is never deleted — it prints `KEEP`
and you decide.

## What this does not cover

- Repos with submodules or git-LFS — not handled; do it by hand and say so.
- Other agents' sessions. Different agent directories don't share repos, so they were
  never in conflict.
- Non-git projects — `git init` plus `gitlab-init.sh` first, then everything here
  applies. Do not try to isolate a directory that is not a repo.

## Why it needs no lock file

The rule is only ever evaluated by the session that's about to edit: *is another
session of mine alive?* Whoever started first stays in the main checkout because the
rule never fired for them. Two sessions starting at once both take worktrees, which is
correct — the main checkout sits unused, which is safer than either of them holding it.
No registry, no lock, no shared state to corrupt or to clean up.
