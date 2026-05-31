# Papercup — agent guide

## ▶ Running / testing this app — it is the **Tauri DESKTOP app**, not a browser webapp

> This is the most-ignored rule in the repo. Read it before you try to "open the app".

**To run or test the app, launch the desktop shell — the ONLY supported way:**

```bash
cd /home/marsh-office/papercupai-workspace/papercusp-desktop && npm run dev
```

Then drive the **Tauri window** it opens (for agent-driven UI checks see
`/internal/docs/testing/agent-e2e`).

**Do NOT "launch the web version":**

- **Never open `:3055` or `:3070` in a browser** (verdict / playwright / chrome /
  `xdg-open`). Those ports are the desktop's *internal content source*, not a
  standalone site — a browser view is the **retired** webapp and gives a
  broken/misleading result. A `PreToolUse` hook blocks browser navigation to them
  and points you back here.
- **Never start `apps/operator` as a standalone server** (`next dev` / `next start`
  / `bin/dev` / `bin/prod`). That standalone webapp is **retired** — `bin/dev` and
  `bin/prod` are gone, and native PG was renamed `papercusp_legacy` so it fails
  loud.
- A `curl http://127.0.0.1:3070/...` for a quick **API** check (not a UI check) is
  fine **while the desktop is running**.

The operator's Next/Vite/Hono layer on `:3055`/`:3070` **is the desktop's content
layer** — `papercusp-desktop` points its webview at `:3070` and spawns
`npm --prefix ../papercup run dev:operator` itself. It is **not** a separable
"webapp" and **cannot be moved to `_retired/`** without breaking the desktop. The
retired thing is the *act of running/browsing it standalone* — see "Retired /
preserved-not-active surfaces" below.

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
- `:3070` — operator harness sidecar API + internal engineering docs at `/internal/docs` (Starlight static output; only when the desktop is up).

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

## Retired / preserved-not-active surfaces

Some code is **retired but deliberately kept** in the tree for reference — not
deleted, not deployed, not tested, and not to be extended. Agents repeatedly
mis-read these as active because they still look like workspaces, carry deploy
config, or have recent commits. **Treat everything in this list as dead:** do not
write tests for it, wire new code to it, or "revive" it without an explicit ask.

| Surface | Location | Status | Restore |
|---|---|---|---|
| `@papercup/web` — papercupai.com public site | `_retired/papercup/` | Retired 2026-05-30. Dropped from the workspace glob + root scripts; `docker-compose.papercup.prod.yml` + `Dockerfile.papercup` bannered (preserved, not deployed). | `_retired/papercup/RESTORE.md` + git tag `papercup-web-retired-2026-05-30` |
| Standalone operator webapp (`apps/operator` opened on `:3055` in a browser) | `apps/operator` — run **only** via the Tauri shell | Retired 2026-05-14; native PG renamed `papercusp_legacy` to fail loud. | n/a — the operator still ships, just not as a standalone webapp |
| `libs/zero-harness` — Zero ZQL schema/queries | `libs/zero-harness` | On the Zero-retirement path; still imported by ~10 operator files. **Migrate off, don't add tests.** | n/a |
| `libs/papercup-db` — fictional-org demo schema | `libs/papercup-db` | Demo data; only consumed by `_retired/papercup` + a vendored submodule. Deletion candidate. | n/a |
| `libs/holepunch-spike` — P2P spike | `libs/holepunch-spike` | Phase-0 spike, zero importers. Deletion candidate. | n/a |
| `libs/papercup-shared/**/*View.tsx` | `libs/papercup-shared` | The read-only `*View.tsx` components render the retired web surface; the non-view helpers (e.g. `_admin-paths`) are still shared and live. | n/a |

**Convention for retiring-but-keeping a surface:** (1) move it under `_retired/`
— this drops it from the `apps/*` / `packages/*` workspace globs so npm, the
affected-test runner, knip, and nx stop treating it as live (the structural signal
that fools agents, not a prose note); (2) remove its root `package.json` scripts
and banner any deploy config — **preserve, don't delete**; (3) add a `RESTORE.md`
in the moved directory with the exact re-wiring steps + the last-active commit, and
cut a `git tag <name>-retired-<date>` restore point; (4) add a row to the table
above. Restoration is then `git mv _retired/<x> <orig>` + re-apply the RESTORE.md
steps.

## Borrowable libraries — generic, domain-free, reusable anywhere

A growing set of our libraries carry **zero Papercusp/Restart domain coupling** —
any project can borrow them. Where a host-specific value is needed it's injected
through a small seam (a `configure*()` call or a prop); Papercusp maps its own
domain onto that seam in the operator, so the lib itself names no consuming app.

**The catalog is `BORROWABLE.md` at the repo root** (generated — `npm run
gen:borrowable`; source of truth `scripts/gen-borrowable-catalog.mjs`). It lists
each borrowable lib (in `packages/*` in-repo, or grouped under `libs/generic/*`
as standalone submodules under `github.com/Papercusp/`) with its description +
repo, grouped by domain, plus a "reusable with host wiring" section for libs that
keep a Papercusp tie-in by design (`locks`, `coordination`, `backup`,
`docs-engine`, `host-platform`). The borrowable submodules were physically
regrouped into `libs/generic/` on 2026-05-31 (consumers import by package name,
so nothing broke). When you make a lib generic — or notice domain coupling
leaking into one — add/adjust it in the generator and re-run. See
`papercusp-systems-abstraction-2026-05-29`.

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

**Work on `main` directly — do NOT use `git worktree` or feature
branches.** We deliberately run one shared tree rather than many
diverging worktrees: it's simpler, and it spares everyone the
merge-reconciliation tax later. The tradeoff is a messy history — your
work gets swept into other agents' commits and theirs into yours — and
that's expected and fine. Coordinate through the **lock + coord
systems**, not through tree isolation:

- **`locks:*`** claims the files you're about to edit. A `PreToolUse`
  hook does this per-edit automatically and blocks an edit when another
  agent holds the file; call `locks:acquire` by hand only for a
  multi-file change you must hold across several edits + the commit.
- **`coord:*`** announces what you're working on (`coord:declare-intent`)
  so peers see you, and carries hand-offs / messages.

Parallel agents on one `main`, serialized by locks + coord, is how
concurrent work stays collision-free here. Don't `git push`, either —
pushing isn't expected; just commit (see below).

**Symptoms that you've forgotten this rule:**
- `git status` shows `On branch <not-main>` in the main checkout —
  switch back to `main` immediately and recover any in-flight work via
  `git stash`.
- Paperclip starts editing files that look stale or wrong — it
  almost certainly thinks it's on a different branch than you.
- Dev/prod servers start serving 404s or HMR-error pages for routes
  that exist on disk — branch divergence between server and source.

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

**Server-side code has no hot-reload — restart to pick it up.** The `:3070` **Hono host** (`bin/hono-host.ts` — the MCP tools, the `lib/endpoint-route` handlers, and everything in `apps/operator/lib/**` they import) runs under `tsx` with no file-watch, so edits there do **not** go live until the host process is restarted: reload the Tauri shell, or — on the standing systemd dev box — `systemctl --user restart papercup-dev-api.service`. (The `:3055` Next layer *does* hot-reload its own routes/components.) The tell that you're testing stale server code: a probe lands in the *old* place — e.g. during the coord FS→PG cutover a `coord:send` kept writing `coord/*.jsonl` instead of Postgres because the host hadn't reloaded. Probe where the write actually lands; if it's stale, restart and re-probe before trusting any result.

## Read this before changing code

Performance regressions in this repo have repeatedly come from the same
small set of patterns (serial fs loops, per-slug PG-pool opens, `<details>`
gating, duplicate React keys, stale Radix pointer-events overrides, etc.).
**Read the operator docs site's performance page before any non-trivial
change**:

→ With Tauri dev running, open `localhost:3070/internal/docs/performance` (Starlight) or the in-shell docs link
→ Source: `apps/operator-docs/src/content/docs/performance.mdx`

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
yes. See `apps/operator-docs/src/content/docs/system/storage-policy.mdx` for the
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

Full reference: `/internal/docs/posthog` and `/internal/docs/posthog/feature-flags`.

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
5. **Run** the Vitest sync test `apps/operator/lib/__tests__/tools-md-sync.test.ts` (e.g. `cd apps/operator && npx vitest run tools-md-sync`) — must be green before commit.

The CI test validates:
- Every tool in the role's surface has `guidance.when` (warn-only through Phase 4; fail after Phase 5 backfill lands).
- Every backtick-wrapped `tool:name` mentioned in `<role>.tools.md` is in the role's allowed surface.
- Every `byRole.<role>` key references a known role.

Per-tool when/not-when goes in the tool file. Cross-tool patterns
(chaining, panel verbs, workflows) go in `<role>.tools.md`. Behavior
rules ("always call", "tier-high → confirm") go in `<role>.persona.md`.
The split is intentional — see `apps/operator/lib/prompt-assembly.ts`.

## Where new tests go — four canonical frameworks (2026-05-24)

Per `admin-testing-tab-restructure-2026-05-24` D-006, every new test
goes in **exactly one** of:

- **Vitest** `<package>/lib/**/<name>.test.ts` — unit/integration/non-browser E2E
- **Playwright** `apps/operator/e2e/<name>.spec.ts` — browser-driven E2E
- **Cargo** `#[cfg(test)] mod tests { … }` — Rust
- **LLM scenarios** `apps/operator/lib/llm-testing/scenarios/<role>/` — judge-scored prompts

**Never** create new `.mjs` integration scripts under
`apps/operator/__tests__/integration/` or tsx smoke scripts under
`apps/operator/scripts/`. CI lint (P-038) fails the build on additions.
Drop files into the conventional path and `/admin/testing` picks them
up automatically via the registry glob walk — no registration step.

See `apps/operator-docs/src/content/docs/testing/index.mdx` §1.0a for
the full convention and `apps/operator/lib/testing-domains-registry.ts`
for which globs each `/admin/testing` subtab discovers.
