<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Verifying a build locally: use `npm run build:check`, not `next build`

A full `next build` **cannot complete on the macOS dev machine**. It compiles fine
and then every static page fails the export phase with:

```
Invariant: Cannot access "entryCSSFiles" without a work store. This is a bug in Next.js.
```

**This is not your change.** It reproduces on a two-file Next app with no config, no
CSS and no dependencies, and it is not fixed by any of: a different Node (22 or 26),
a clean environment (`env -i`), removing `next.config.ts`, pinning `turbopack.root`,
or upgrading Next (16.2.6 → 16.2.12). It does not reproduce on the VPS.

So:

- **Locally, verify with `npm run build:check`** (`next build --experimental-build-mode
  compile`). That runs the compile, the TypeScript pass and route collection — which
  is what catches a broken import, a type error or a bad route — and stops before the
  export phase that can't run here.
- **Production builds happen on the VPS** (`scripts/vps-deploy.sh` does pull → install
  → migrate → generate → build → restart, and builds *before* restarting, so a bad
  build leaves the running dashboard alone). The export phase works there.

What `build:check` does NOT cover: prerender-time failures in server components. For
this app those are thin — every page is a client component behind `AuthGate` — but it
is a real gap, and the VPS build is what closes it.

Full investigation: `docs/local-build-export-failure.md`.
