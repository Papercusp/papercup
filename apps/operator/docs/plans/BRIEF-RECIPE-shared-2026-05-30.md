---
title: Shared recipe — Population-B shared-lib extractions
slug: BRIEF-RECIPE-shared-2026-05-30
status: active
created: 2026-05-30
owner: avi@storewolf.com
companion-to: [papercusp-systems-abstraction-2026-05-29]
---

# Shared recipe — extracting a `@papercusp/*` shared lib

Read this once, then your lib-specific `BRIEF-<lib>-extraction-2026-05-30.md`.
This is the pattern proven on **8 shipped packages** this arc (rrf,
embedded-pg-discovery, plan-parser, rate-limit, ipc-framing, desktop-ipc,
ipc-endpoint-server, backup). Follow it; don't reinvent.

## The package skeleton (src-as-entry, no build step)

1. `packages/<name>/` with `src/`. Mirror an existing package — **copy
   `packages/backup/package.json` + `packages/backup/tsconfig.json`** and
   edit. Key invariants:
   - `"type": "module"`, `"private": true`,
     `"main"`/`"types"` → `"./src/index.ts"`.
   - `exports` in **conditional-object form** (NOT string shorthand —
     standalone vitest / vite won't follow `{".":"./src/index.ts"}`):
     ```json
     "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts", "default": "./src/index.ts" } }
     ```
   - Runtime deps: **prefer ZERO `@papercusp/@restart` deps** — all host
     coupling becomes injected seams. A genuine sibling-package dep (e.g.
     `@papercusp/rrf`) goes in `dependencies` as `file:../rrf`. Type-only
     deps (e.g. `postgres` for the `Sql` type) go in `devDependencies`.
2. **Symlink** it into node_modules by hand — **do NOT `npm install`**
   (root install is BROKEN by a pre-existing `@blocknote/mantine` ERESOLVE;
   don't chase it):
   ```
   ln -sfn ../../packages/<name> node_modules/@papercusp/<name>
   ```
3. Add `"@papercusp/<name>": "file:../../packages/<name>"` to
   `apps/operator/package.json` (alphabetical) when you wire the operator.

## The seam pattern (host-adapter barrel)

The package must carry no operator coupling. Two equivalent shapes:

- **Module-level config** (used by backup): the package has a
  `config.ts` exposing `configure<Name>(host)` + an internal
  `host()` getter that throws if unconfigured. The operator's
  `lib/<name>/` becomes a host-adapter barrel: a `configure.ts` that
  calls `configure<Name>({…operator seams…})` at module load, an
  `index.ts` that does `import './configure'; export … from
  '@papercusp/<name>'`, and thin deep-path shims (each also
  `import './configure'`) for any consumer that imports a sub-path.
  **All consumers stay unchanged.**
- **Per-call injection** (used by ipc-endpoint-server, search): the
  package functions/classes take the seam (a `host` object / a `sql`
  handle) as a parameter; the operator's thin wrapper passes it.

`defineTool` tool files (anything importing `defineTool` from
`@papercusp/agent-mcp`) **stay in the operator** — extract the engine they
call, leave the tool wrapper thin. The agent-mcp coupling does not move.

## Verify (non-negotiable — this app is pre-alpha, break things, but prove it)

- Package: `cd packages/<name> && npx tsc -p tsconfig.json --noEmit`
  (expect **0 errors**) and `npx vitest run` (move/keep the lib's own
  tests; they should pass).
- Operator: `cd apps/operator && npx tsc --noEmit` then grep your area.
  The operator carries **~781 pre-existing errors** — your bar is **zero
  NEW errors in your files**, not zero total. (Strict package tsc often
  surfaces *latent* operator type bugs in the moved code — e.g.
  `sql<{x}>` should be `sql<{x}[]>`; an env object typed `NodeJS.ProcessEnv`
  should be `Record<string,string>`. Fix them; note them in the commit.)
- Runtime: dispatch the **live tool** to prove behavior is preserved.
  Agent tools are exposed as `mcp__papercusp-su__<group>_<verb>`; many
  have an operator integration test that runs against live embedded PG
  (it's up if the desktop is running). A passing tsc is NOT a working
  feature.

## Commit discipline (multi-agent repo — read carefully)

- Work on **`main`** in `~/papercupai-workspace/papercup`. No branches, no
  worktrees. **`git rev-parse --abbrev-ref HEAD` before every commit.**
- A background `paperclipai run` does `git add -A` on a timer and will
  sweep your uncommitted files into ITS commits. So right before each
  commit: `git reset -q` then `git add <explicit paths>` (never `-A`).
  Put `-m` **before** `--`, or use `git commit -F -`.
- Commit the instant a piece verifies; don't batch across libs. Working
  tree must be clean between turns.
- End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- A `PreToolUse` hook auto-locks each individual edit. Only hand-call
  `locks:acquire { paths, intent, ttl_sec: 1200 }` for a multi-file change
  you hold across the commit; `locks:release { all_mine: true }` at the end.

## Coordination + bookkeeping

- `coord:declare-intent` at start (name your lib + files). `coord:send
  { to:["*"] }` when done, summarizing cross-cutting changes (esp. any
  edit to a shared package other agents touch).
- Flip your plan item(s):
  `plans:set-status { slug: "papercusp-systems-abstraction-2026-05-29",
  itemId: "P-0XX", status: "done", note: "<pkg> + commit sha" }`, then
  `plans:lint`.
- Update `HANDOFF-systems-abstraction-phase2-2026-05-30.md` only if you
  change the cross-cutting picture.

## Gotchas seen this arc

- A static-import grep MISSES `await import('../x')` — grep `import\(` too.
- When a moved test registers into a module-singleton registry, inject the
  registry functions via the seam so there's exactly one instance (don't
  `resolve.alias` it — that forks a 2nd instance).
- Keep load-bearing security/safety guards intact and call them out (e.g.
  backup's self-exclusion `IGNORE_PATTERNS`).
- Stale doc-comments referencing moved files: fix the path.
