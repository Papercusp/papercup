# Papercup — agent guide

## Almost all state should be in nuqs

**If a piece of state is reasonably user-meaningful, it goes in the URL via [nuqs](https://nuqs.dev), not `useState`.** This is non-negotiable. The agent → UI control surface (`ui:get_state`, `ui:dispatch`) reads/writes the URL — anything in `useState` is invisible to agents and undriveable without a per-feature intent.

**What goes in nuqs:**
- Tab / view / mode selectors (`?tab=...`, `?mode=...`)
- Open/closed state of panels, drawers, dialogs, dropdowns, banners
- Selection state (`?proposal=...`, `?feature=...`, `?slug=...`, `?file=...`)
- Search/filter inputs (`?q=...`, `?filter=...`)
- Sort/pagination (`?sort=...`, `?page=...`)
- Expansion / show-debug / show-timeline toggles

**What stays as `useState`:**
- Loading / saving / busy / streaming / error lifecycle flags
- Mid-edit form drafts (typing-in-progress that would lose on reload)
- Hover / focus / drag mouse-state
- Transient toasts, copied-indicators, animation tweens
- Ref-coupled state where a `useRef` must read the value synchronously (e.g. xterm search-addon coupling)
- Sub-millisecond render-only state (`mounted`, `RefreshKey`)

**When in doubt, choose nuqs.** It's strictly more capable: agents can read it, users can deep-link to it, reloads survive it. Defaulting to `useState` is the legacy habit — break it.

For the parser, prefer in this order: `parseAsStringEnum<T>([...allowed]).withDefault(...)` for closed enums, `parseAsBoolean.withDefault(...)` for toggles, `parseAsString.withDefault('')` or `parseAsString` (nullable) for open strings, `parseAsJson(shapeGuard)` for discriminated unions.

If a state encodes a complex object (like a `{kind:'review'|'thread', id}` selection), encode it as a short scalar (`"review:<id>"`) and derive the full object via a local `useMemo` lookup. Don't put 1KB of JSON in the URL.

See `apps/operator/docs/nuqs-audit-2026-05-11.md` for the rationale + the 46+ params already migrated this session.

## Deployment model: **desktop is the product. The standalone webapp is RETIRED.**

**Source of truth: `apps/operator/providers/HarnessZeroProvider.tsx` lines 6–19** (the "Transport selection by deployment context" doc-comment).

The shipping target is the **Tauri desktop app**, and it is also the only supported test surface. The old `next dev` / `bin/prod` standalone webapp path (running `apps/operator` directly and opening `localhost:3055` in a browser) is **retired as of 2026-05-14** — native Postgres has been renamed to `papercusp_legacy` specifically to make accidental webapp boots fail loudly.

**To run / test the app, launch the Tauri dev shell:**

```bash
cd /home/marsh-office/papercupai-workspace/papercusp-desktop
npm run dev
```

That single command boots embedded Postgres (writes `~/.papercusp/embedded-pg.json` discovery file), starts the operator sidecar against it, applies pending SQL migrations, and opens the Tauri webview. There is no longer a "just the webapp" mode.

Ports you may see internally (do not open these in a browser; let the desktop drive them):
- `:3055` — Next.js dev server consumed by the Tauri webview as its content source.
- `:3070` — operator harness sidecar API + standalone Fumadocs (only when the desktop is up).

**Implications for any agent making transport / persistence / sync decisions:**

| Concern | Desktop (production) | Browser (test/dev) |
|---|---|---|
| Sync transport | **SSE primary** (`/api/zero-harness/sse` pushes invalidate/update via PG LISTEN/NOTIFY) | Zero WS primary, SSE fallback, polling as floor |
| Persistence | embedded-pg (real PG 17 via libs/papercusp/packages/embedded-postgres-server) | Same — embedded-pg, NOT pglite |
| zero-cache process | **Not run** — operator sidecar serves SSE itself | Production zero-cache service from docker-compose.papercup.prod.yml |
| Runtime detection | `window.__TAURI_INTERNALS__` + server-side `/api/desktop/version` fingerprint | Neither present |
| Override for tests | `localStorage.harnessSyncTransport = 'SSE'` to force desktop path in browser | `'WEBSOCKETS'` to force browser path |

**Stale docs to mistrust** (cross-checked 2026-05-11):
- `libs/sync/PASS_2_1_DECISION.md` (2026-05-06) declared "stop SSE" — **SUPERSEDED 2026-05-07** by the HarnessZeroProvider decision to make SSE primary on desktop. The doc has a header banner now but is otherwise frozen.
- `libs/sync/src/transports/sse/SSEAdapter.tsx`'s old header claimed "no current consumer, preserved-but-frozen" — corrected to reflect production use.
- Any code comment or memory note that says "Zero WS is primary everywhere" or "SSE is dead" predates 2026-05-07 and is wrong for desktop.

**When designing new sync-touching features:** desktop SSE is the path that matters. Browser WS is a fallback that lets developers test in a normal browser. If a feature only works under WS, it's incomplete for production.

## This app is in testing — there are no users yet

There is no production. **Don't defer fixes for "let's see how it fares in production first"** — there's nothing to fare in. That gives us the luxury to break things continuously until the app is right. Pick the right fix *now*; don't ship awkward compromises to preserve compatibility with a future you haven't built yet.

In practice this means:
- Redesign APIs that are wrong instead of layering on top
- Rename identifiers when the old name is confusing — don't keep deprecation aliases "for one release cycle"
- Take schema migrations now if they're correct, not when usage forces your hand
- Refactor architecture when foundational decisions are wrong, not when they're load-bearing
- Pick the *best* tool/library, not the safe one — license + compatibility are footnotes, not vetoes

Surface what you're changing so the user knows; don't ask permission to do it well.

---

## Branch discipline: **the main directory always stays on `main`**

The repo at `/home/marsh-office/papercupai-workspace/papercup` is the
canonical checkout and **must always have `main` checked out**. Other
agents (paperclip, the operator UI, Next.js dev/prod, the harness
fleet) all assume this. Branch-switching there breaks them all.

If you need to work on a branch (review-merge work, experimental
spike, multi-day feature, anything that isn't a quick fix on main),
**use a git worktree** in a sibling directory:

```bash
git -C /home/marsh-office/papercupai-workspace/papercup \
    worktree add /home/marsh-office/papercupai-workspace/papercup-<topic> <branch>
ln -s /home/marsh-office/papercupai-workspace/papercup/node_modules \
      /home/marsh-office/papercupai-workspace/papercup-<topic>/node_modules
```

The worktree has its own working copy + index but shares git history
with the main checkout. Symlinking node_modules avoids a full
`npm install` (workspace hoisting means dev tooling resolves through
the root). Drop the worktree with `git worktree remove <path>` when
done.

**Symptoms that you've forgotten this rule:**
- `git status` shows `On branch <not-main>` in the main checkout —
  switch back immediately, recover any in-flight work via
  `git stash` or worktree.
- Paperclip starts editing files that look stale or wrong — it
  almost certainly thinks it's on a different branch than you.
- Dev/prod servers start serving 404s or HMR-error pages for routes
  that exist on disk — branch divergence between server and
  source.

**Existing worktrees** (don't reuse without checking):
- `/tmp/papercup-migration` (`feat/hetzner-deploy`)
- `/tmp/papercup-tauri-mobile-ref` (detached HEAD, mobile reference)

## Commit discipline: **commit before ending every turn**

Multiple agents (paperclip, claude, others) write to this repo
concurrently and will rewrite each other's uncommitted edits.

**Rule: before you hand control back to the user (end of every turn),
run `git add` + `git commit --no-verify` for any edits you made that
turn. Don't wait for the next turn — by then paperclip may have
overwritten the file.**

A small number of larger commits per session is fine; uncommitted work
sitting between turns is not. Use `git checkout -- <path>` to recover
from a stomp (works only if you committed).

Files paperclip is most likely to rewrite:
- `apps/operator-mobile/**`
- `apps/operator/app/api/_hono/mobile.ts`
- `apps/operator/app/api/mobile/qr.svg/route.ts`
- `apps/operator/lib/mobile-*.ts`

## Running the operator: `npm run dev` from `papercusp-desktop/`

`apps/operator/bin/dev` and `apps/operator/bin/prod` are **retired** as standalone entry points. The Tauri dev shell is the only supported way to bring up the operator — it spawns the same Next.js process under the hood with embedded PG attached.

```bash
cd /home/marsh-office/papercupai-workspace/papercusp-desktop
npm run dev
```

If you need to iterate on a server-side handler or API route and you don't want to wait for the Tauri webview to repaint, you can still reload the desktop window (Ctrl+R in the Tauri shell) or hit endpoints directly at `127.0.0.1:3055` and `127.0.0.1:3070` *while the desktop is running*. Do not try to start `apps/operator` on its own — it will fail at the first PG query because native PG was renamed to `papercusp_legacy`.

## Read this before changing code

Performance regressions in this repo have repeatedly come from the same
small set of patterns (serial fs loops, per-slug PG-pool opens, `<details>`
gating, duplicate React keys, stale Radix pointer-events overrides, etc.).
**Read the operator docs site's performance page before any non-trivial
change**:

→ With Tauri dev running, open `localhost:3070/docs/performance` (standalone Fumadocs) or the in-shell docs link
→ Source: `apps/operator/content/docs/performance.mdx`

Pay particular attention to the "What NOT to do" sections (A1–A14). If
your change matches one of those anti-patterns, change the approach
before writing the code. The audit findings (2026-05-03) at the bottom
of that page are real and were causing the dashboard's TTFB to be ~19s
on localhost.

## Storage policy: Postgres by default

**New durable state goes in Postgres unless there is a specific reason it
must be a file.** Across rounds 1-14 of the file→PG migration arc we
moved ~30 distinct surfaces (operator state, credentials, system
principals, registries, feature notes, provision state, audit log, trust
store, OAuth nonces, mobile pair tokens, rate limits, user-profile
preferences, …) from JSON files / in-memory Maps into PG. The pattern
keeps recurring: someone "temporarily" stores state in a file or a
module-local `Map`, it survives, and a later session has to migrate it
under load. Skip the cycle.

**Default: Postgres.** Storage helpers live in `apps/operator/lib/operator-state-pg.ts`
(single-row-per-workspace JSONB pattern) and various dedicated modules
for compound-key tables. Add a column to an existing table or write a
migration in `libs/papercusp/libs/db/sql/<NNN>-...sql`.

### Database topology — embedded-pg only. Native PG is retired.

The shipped product is a **desktop app backed by embedded Postgres**
(`embedded-postgres-server`, per-harness instance). As of 2026-05-14
the native-PG `papercusp` database has been **renamed to `papercusp_legacy`**
to enforce the embedded-only path — any code that connects to
`postgres://...@localhost:5432/papercusp` now fails immediately with
`database "papercusp" does not exist`. That failure is the loud signal
you forgot to launch the Tauri dev shell.

Practical rule: **never hardcode `localhost:5432`**. Resolve the admin
DSN through `getHarnessAdminUrl()` (which reads the embedded-pg discovery
file) so every code path automatically uses whichever embedded-pg the
desktop spun up.

Practical implications when writing code today:

- **SQL migrations** in `libs/papercusp/libs/db/sql/<NNN>-*.sql` are
  applied automatically by the embedded-pg boot runner
  (`libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js`,
  added 2026-05-05). For native PG you still apply manually with
  `psql -f` — but **don't write code that depends on the manual step
  having happened**; embedded-pg is the source of truth, and the
  schema must work there. The manual `psql -f` is a dev-only chore,
  not an architectural requirement.
- **Don't add features that only make sense against native PG**
  (cross-database queries, `pg_extension` not available in
  embedded-pg, OS-level pg tooling). If embedded-pg can't run it, the
  product can't ship it.
- **Connection-string assumptions:** prefer the workspace-resolved PG
  connection that the embedded-pg path returns; don't hard-code
  `localhost:5432`.
- **No system-PG-only migration runner** is planned, because the
  system PG is going away. The brief's "system PG :5432 has no runner
  → run psql -f" warning is correct *for dev today* but is not
  describing a long-term architectural gap.

**Acceptable file uses (the short list):**
- Bootstrap state that must be readable before a PG connection exists
  (`~/.papercusp-workspaces/registry.json`, `db-encryption-key`).
- Postgres's own data files (`pglite-data/`, `embedded-pg-data/`).
- Code, scripts, templates, snapshots — files that ARE the spec.
- Harness contract artifacts in `<harness>/.harness/*` — read by tools
  running inside the harness; the file IS the contract surface.
- Append-only logs at high volume (`.harness/action-runs/<run>.log`)
  where SQL log tables would dwarf the actual state.
- Per-process locks via O_EXCL semantics (legitimate FS atomicity).
- Plugin-sandbox storage (the plugin host exposes a virtual FS to plugins
  by design).

**NOT acceptable:**
- Plain JSON state files for app-level data the operator reads/writes.
- Module-scoped `Map`s holding TTL'd auth/session/rate-limit state.
- localStorage that should sync across devices (per-user preferences).
- "PG mirror" patterns where the file is primary and PG is best-effort —
  the file always drifts ahead. Either go full PG or document a real
  reason the file must be authoritative.

If you find yourself reaching for `fs.writeFileSync('something.json')`,
ask whether you can put it in PG instead. The answer is almost always
yes. See `apps/operator/content/docs/system/storage-policy.mdx` for the
full guide and the historical migration arc.

## Feature flags + PostHog

V1 ships with a feature-flag system that gates the 9 cut-for-V1 surfaces
(snapshots, templates, marketplace, cloudflare-publish, oracle, harness
phases, design, rust-port-ui, admin). Single source of truth for keys
and defaults is `libs/flags/src/types.ts`. Self-hosted PostHog runs at
`https://flags.papercuspai.com` for live evaluation; the operator falls
back to bundled `FLAG_DEFAULTS` (all `false` = V1 ship state) when the
discovery file (`~/.papercusp/posthog.json`) is missing or
`testingFeatures: false`.

**Flip flags via the in-app `/admin/features` page**, not by editing
JSON or hitting PostHog directly. The admin UI calls
`POST /api/flags/set` and `POST /api/flags/preset` which round-trip
through PostHog + the SSE flag-bus.

**When adding a feature you'll later want to cut**, gate it from day one:
add the flag to `libs/flags/src/types.ts`, create the matching definition
in PostHog (active=false, rollout 0), then guard pages with `requireFlag`,
nav with `useFlag`, API routes with `gateApiRoute`, Hono routes with a
`use('/path/*', …)` middleware, and MCP tools at registration.

Full reference: `/docs/posthog` and `/docs/posthog/feature-flags`.

## Tests after editing

After completing any file edit, run the affected tests **before** declaring
the task done:

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
```

The walker (`scripts/affected-tests.mjs`) diffs against `origin/main`,
maps changed files to npm workspaces, computes the reverse-dependency
closure, and runs every affected workspace's `test` (and optionally
`test:integration`) script.

If your edit touches:

- `libs/papercusp/libs/db/**` (Drizzle schema / migrations) → run
  `npm run test:all:integration` — schema changes affect every
  workspace and the dependency graph won't catch them.
- `libs/papercup-shared/**` → already covered by the walker.
- `infra/**` or `Procfile*` → no automated coverage; manually verify.

Do **not** run `npm run test:all` for routine edits — it's slow and
produces noise. Use it only for pre-merge sanity checks or schema
changes.

## Browser checks — use `verdict`

For any browser verification (clicks, fills, screenshots, CSS
inspection, accessibility), use the `verdict` skill, **not** Playwright
MCP tools and **not** ad-hoc Puppeteer scripts. We do not maintain a
checked-in Playwright suite in v1; verdict is the entire browser
testing surface. See per-project `TESTING.md` for what's covered.

## Per-project TESTING.md

Each app and lib ships a `TESTING.md` at its root listing what its
tests cover, what they don't, and what to run after editing. Read
the relevant project's `TESTING.md` before adding tests so you match
the existing pattern.

## Test infrastructure

- Test runner: **Vitest 4** (all layers).
- Shared config: `@papercusp/test-config` exports `defineVitestConfig`,
  `getTestPg` / `withTestSchema` (testcontainers-node Postgres), and
  `setupMsw` / `msw`.
- Integration tests get a per-file Postgres schema (`t_<hex>`) on a
  reused `postgres:16-alpine` testcontainer.
- **Docker must be running locally** for integration tests. Run
  `npm run test:doctor` to verify your environment.

## CI

- Per-PR: `.github/workflows/test.yml` runs the affected unit +
  integration suites; results posted as a PR comment via JUnit.
- Nightly: `.github/workflows/test-nightly.yml` runs everything.

## Property-based tests

Use `fast-check` for invariant-style tests where examples undercount —
encoders/decoders, slug rewrites, hash canonicalisation, validator
predicates. Pattern: `<source>.property.test.ts` colocated with source.
See `libs/papercup-shared/src/_admin-paths.property.test.ts` for a
worked example.

## Dead-code / unused-export checks (knip)

```bash
npm run lint:knip       # report
npm run lint:knip:fix   # auto-remove obvious unused imports
```

Knip runs in CI **informationally** — its output never gates a merge.
Treat its findings as a discussion input. False positives (Next.js
dynamic chunks, fonts, CSS-only consumed packages) live in
`knip.json`'s `ignoreDependencies` allow-list.

## Flaky-test quarantine

Tests known to flake live in `quarantine.txt` at the repo root, one
entry per line as `<workspace-name>::<file>`. Quarantined workspaces
still run in CI but their failures don't gate the merge — the walker
prints a `[QUARANTINED]` marker and a non-gating warning.

A PR that touches a quarantined test's source must either de-quarantine
the test (remove the line) or document why it stays. Do not silently
skip flakes.

## Test secrets

API keys for tests use the `TEST_<SERVICE>_KEY` naming convention,
stored in GH Actions repository secrets and surfaced as env vars in
the workflows. Do **not** check live keys into fixtures.

## Use Context7 for current library docs

Before using non-trivial APIs from third-party libraries (Vditor,
BlockNote, mind-elixir, Excalidraw, Tauri 2, Next.js 15, nuqs, Zero,
Hono, Radix, Vercel AI SDK, etc.), call the `context7` MCP tools
(`resolve-library-id` then `get-library-docs`) to fetch the current
API surface. Library APIs change faster than training cutoffs; do not
guess method names from memory.

## Adding a tool — the per-role guidance discipline

Every tool exposed via MCP is authored once in a `defineTool({ ... })`
call (or plugin manifest entry). When you ship a new tool:

1. **Define the tool** in `apps/operator/lib/agent-tools/<group>/<verb>.ts`
   (or `packages/agent-mcp/src/tools/...` for read-side tools).
2. **Add `import './<group>/<verb>';`** to `apps/operator/lib/agent-tools/index.ts`.
3. **Add `guidance: { when, notWhen?, chaining?, byRole? }`** to the `defineTool` call. `when` is the most important field — author it first.
4. **If exposed on a chat surface**: add `mcp__agentmcp__<group>:<verb>` to that surface's `allowedTools` array (operator-converse: `apps/operator/lib/operator-mcp-tools.ts`; oracle: `apps/operator/app/api/_hono/oracle.ts`).
5. **Run** `node apps/operator/__tests__/integration/tools-md-sync.mjs` — must be green before commit.

The CI test validates:
- Every tool in the role's surface has `guidance.when` (warn-only through Phase 4; fail after Phase 5 backfill lands).
- Every backtick-wrapped `tool:name` mentioned in `<role>.tools.md` is in the role's allowed surface.
- Every `byRole.<role>` key references a known role.

Per-tool when/not-when goes in the tool file. Cross-tool patterns
(chaining, panel verbs, workflows) go in `<role>.tools.md`. Behavior
rules ("always call", "tier-high → confirm") go in `<role>.persona.md`.
The split is intentional — see `apps/operator/lib/prompt-assembly.ts`.
