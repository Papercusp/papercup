## Now

**State:** **Date:** 2026-05-20 **Author:** frontend-removal agent (coord/frontend.jsonl) **Status:** Draft for user review — executable independent of [next-removal-2026-05-20.md](./next-removal-2026-05-20.md) **Effort:** ~1.5 weeks single-agent **Reversibility:** High (1-PR revert until cutover Phase 9)

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).

# Docs migration: fumadocs → Starlight

**Date:** 2026-05-20
**Author:** frontend-removal agent (coord/frontend.jsonl)
**Status:** Draft for user review — executable independent of [next-removal-2026-05-20.md](./next-removal-2026-05-20.md)
**Effort:** ~1.5 weeks single-agent
**Reversibility:** High (1-PR revert until cutover Phase 9)

---

## Why this plan exists separately

This was originally Phase F of the Next-removal plan. The other reviewer's feedback (and my agreement): **this is the highest-EV chunk of that plan, contained, and worth doing on its own merits even if Next removal is deferred.** Concretely:

- Same React component model as the rest of the operator (vs. fumadocs's React, which is fine, but also vs. Vue / Docusaurus / VitePress alternatives).
- Astro static output → no second Node process in production.
- `starlight-llms-txt` preserves the agent-facing `/llms.txt`, `/llms-full.txt`, and per-page `.md` URL contract — agents don't relearn anything.
- One unified docs app replaces two parallel fumadocs setups (`apps/operator/` + `apps/papercup/`).
- First-party autogen sidebar from filesystem + per-page frontmatter overrides — closer to fumadocs's `meta.json` mental model than VitePress's manual config.

The cost-of-doing-nothing baseline isn't trivial:
- Two fumadocs setups drift (already happens — both consume `content/internal-docs/` but render via two separate Next pipelines).
- fumadocs is tightly coupled to Next. Any non-trivial Next upgrade churns docs at the same time as app code.
- Custom Accept-header content negotiation lives in `proxy.ts`. Adding agent-facing routes requires touching that file.
- Two source.config.ts setups + two sets of fumadocs deps in package.json.

Estimated maintenance tax of staying on fumadocs: ~3–5 days/year. Migration cost: ~7 working days. Payback: 1.5–2 years even before considering "Astro docs site survives Next removal." Reasonable bar to clear.

---

## Scope

### In scope

- All MDX content under `apps/operator/content/internal-docs/` (~150+ pages across 16 sections).
- The two fumadocs renderer setups (`apps/operator/` operator-internal-docs route + `apps/papercup/` (docs) route group) collapse into one Starlight app.
- The agent-facing URL surface (`/llms.txt`, `/llms-full.txt`, `/internal/docs/<section>/<slug>`, content negotiation via `Accept: text/markdown`).
- MCP tools `docs:outline`, `docs:get`, `docs:search` (operator-scoped) and their cross-harness equivalents — keep external JSON shape, swap underlying source adapter.
- The 6 agent prompt files that reference fumadocs / `content/internal-docs/`.
- The global CLAUDE.md "Read documentation" / "Write / update documentation" sections.
- Sidebar order configuration (currently per-section `meta.json` files).
- E2E coverage: `apps/operator/e2e/docs-routes.spec.ts`.

### Out of scope

- `apps/operator/content/docs/` (the public-facing placeholder). Stays as-is or gets its own follow-up plan.
- Next.js removal anywhere else in the codebase.
- Any change to the docs *content* — this is purely a renderer / host swap.
- Migration of any other Next app or page.

---

## Architecture

### App layout

```
apps/operator-docs/                   ← new Astro app
  package.json                        # astro, @astrojs/starlight, @astrojs/react, starlight-llms-txt
  astro.config.mjs                    # site, base: '/internal/docs', integrations, sidebar config
  tsconfig.json
  src/
    content/
      docs/                           ← contents moved from apps/operator/content/internal-docs/
        index.mdx
        agent-insights/
        agent-policies.mdx
        agents/
        ...
    components/                       ← React islands for any custom MDX components that don't map to Starlight built-ins
      Callout.tsx                     # if not using Starlight's <Aside>
  public/
  astro.d.ts
```

### URL surface (preserved)

| URL | Today (fumadocs) | After (Starlight + starlight-llms-txt) |
|---|---|---|
| `/internal/docs/<section>/<slug>` (HTML) | fumadocs route renders MDX | Starlight renders MDX, same path via `base: '/internal/docs'` |
| `/internal/docs/<section>/<slug>` with `Accept: text/markdown` | proxy.ts negotiates, serves source markdown | `starlight-llms-txt` produces per-page `.md` twin; Hono middleware serves it on Accept negotiation (see F4 below) |
| `/llms.txt` | fumadocs route emits index | `starlight-llms-txt` emits index |
| `/llms-full.txt` | fumadocs route emits concat | `starlight-llms-txt` emits concat |
| `/llms-small.txt` | n/a | `starlight-llms-txt` emits abridged (new; harmless) |

### Where Starlight is served from

**During migration (Phases 1–7):** Astro dev server on its own port. fumadocs continues to serve production.

**After cutover (Phase 8):** Astro `build` outputs to `apps/operator-docs/dist/` (pure static HTML + assets). The existing Hono server (`apps/operator/app/_hono/`) mounts a static-serve middleware at `/internal/docs/*` pointing at that dist directory. No second Node process; no Astro server runtime in prod.

This works regardless of whether Next is ever removed — the static output is just files; Hono serves them.

### Content negotiation decision (was F4) — DECIDED: F4b

Keep `Accept: text/markdown` semantics. Two implementation paths, both preserve agent contract:

**F4b — preferred.** `starlight-llms-txt` already produces per-page `.md` twins. Hono middleware checks `Accept` header on `/internal/docs/<path>` requests:
- HTML accepted → serve `dist/internal/docs/<path>/index.html`
- text/markdown accepted → serve `dist/internal/docs/<path>.md` (the twin)

~15 lines of Hono middleware. Preserved across Next removal automatically.

**F4a (rejected).** Force agents to use a separate `/internal/docs/<path>.md` URL. Requires updating ~6 prompt files + CLAUDE.md + all of agents' learned behavior. Bad cost/benefit.

---

## Phases (F1 – F11)

### F1 — Bootstrap `apps/operator-docs/` (~0.5 day)

1. `cd apps && npm create astro@latest operator-docs -- --template starlight`
2. Install deps: `@astrojs/react`, `starlight-llms-txt`, optionally `starlight-llm-tools` (Copy-as-Markdown button on each page).
3. Add to monorepo workspace (`package.json` workspaces).
4. Configure `astro.config.mjs`:
   - `site: 'http://127.0.0.1:<API_PORT>/'` (matches Tauri target)
   - `base: '/internal/docs'` — preserves the agent URL surface
   - `integrations: [react(), starlight({...}), starlightLlmsTxt()]`
   - Starlight title, social, etc.
5. Verify dev server boots: `npm run dev` in `apps/operator-docs/` opens at the configured port; placeholder home page renders.

**Acceptance:** Astro dev server boots; placeholder Starlight site renders at `/internal/docs/`.

### F2 — Move content + verify (~0.5 day)

1. `cp -r apps/operator/content/internal-docs/. apps/operator-docs/src/content/docs/`
2. Verify Astro picks up the content collection (Starlight's default content collection config does).
3. Dev server: navigate to a few pages. Many will render *with errors* on first pass because of fumadocs-specific MDX imports — that's expected; F3 handles it.
4. **Don't delete** the source content yet (`apps/operator/content/internal-docs/`). It stays as the canonical source until the cutover PR in F9. The two trees stay in sync via a script run nightly during the migration window (or one-time as we approach cutover — see F8).

**Acceptance:** Content visible in Astro dev server; most page navigation works; expected MDX-import errors documented as F3 backlog.

### F3 — MDX component compatibility sweep (~2 days)

This is the variable-effort phase. Map every fumadocs-ui component used in MDX to a Starlight equivalent:

| fumadocs-ui | Starlight equivalent | Migration |
|---|---|---|
| `<Callout type="info">` | `<Aside type="note">` | Find/replace; types map: info→note, warning→caution, danger→danger, tip→tip |
| `<Card>` / `<Cards>` | Starlight `<Card>` / `<CardGrid>` | Import path change |
| `<Files>` / `<Folder>` / `<File>` | Starlight `<FileTree>` (different markup shape) | Manual review per usage |
| `<Tabs>` / `<Tab>` | Starlight `<Tabs>` / `<TabItem>` | Find/replace, prop renames |
| `<Steps>` | Starlight `<Steps>` (different wrapping) | Manual review |
| Code blocks (` ```ts title="..." ` ) | Starlight Expressive Code (same syntax) | No change |
| `<TypeTable>` | No direct equivalent → custom React island in `src/components/TypeTable.tsx` | Build once; import via `@/components/TypeTable` |
| Custom callouts / banners | Either `<Aside>` variants or custom React island | Per-usage decision |

**Process:**
1. `grep -rl 'fumadocs-ui' apps/operator/content/internal-docs/` → list of files importing.
2. For each unique import, decide map vs. custom-island vs. delete.
3. Build any custom React islands in `apps/operator-docs/src/components/`.
4. Codemod find/replace across the content tree.
5. Verify each affected page renders correctly.

**Risk:** unknown count of `<TypeTable>` or other non-1:1 components. Audit-first sub-task at the start of F3 produces the real count; if it's >10 distinct custom components, F3 stretches to 3 days.

**Acceptance:** Every MDX page renders in Astro dev server with zero React errors / Astro warnings; visual diff against current fumadocs site shows acceptable parity (some Starlight components look slightly different — fine, document any deviations).

### F4 — Sidebar configuration (~0.5 day)

fumadocs uses `meta.json` files per section to control sidebar ordering. Starlight uses either:
- Frontmatter `sidebar` field per page (override per-page order/label).
- Per-section `_meta.md` file (legacy fumadocs-shape — does **not** exist in Starlight natively).
- `astro.config.mjs` `starlight.sidebar` array (manual order; tedious for 16 sections).

**Decision:** Use frontmatter `sidebar: { order: N, label: '...' }` per page, plus directory-based autogen for everything else. Convert each section's `meta.json` to per-page frontmatter via a one-off script.

```mjs
// Script: convert meta.json → frontmatter
for each apps/operator-docs/src/content/docs/*/meta.json:
  read pages: ['intro', 'setup', 'usage', ...]
  for each entry, edit apps/operator-docs/src/content/docs/<section>/<slug>.mdx:
    add to frontmatter: sidebar: { order: <index> }
  delete meta.json
```

**Acceptance:** Sidebar order in Astro dev server matches current fumadocs ordering for every section.

### F5 — Agent surface wiring (~0.5 day)

1. Install + configure `starlight-llms-txt` in `astro.config.mjs`:
   ```js
   integrations: [
     starlight({
       title: 'Papercusp Internal',
       plugins: [
         starlightLlmsTxt({
           projectName: 'papercusp',
           description: 'Engineering docs for the Papercusp multi-agent coding harness.',
           // any optional inclusion/exclusion rules
         }),
       ],
       // ...
     }),
   ],
   ```
2. Verify the plugin emits at build:
   - `dist/llms.txt`
   - `dist/llms-full.txt`
   - `dist/llms-small.txt`
   - Per-page `.md` twin alongside each `index.html` (e.g. `dist/internal/docs/agent-policies.md`).
3. Compare `llms.txt` shape against current fumadocs output. Differences are expected (different generator). Document differences; verify agents can still navigate (manual: invoke `docs:outline` MCP tool against a built Astro dist served locally, confirm the per-page list looks right).

**Acceptance:** `curl http://127.0.0.1:<astro-dev-port>/llms.txt` returns a usable index; per-page `.md` twins resolve.

### F6 — MCP `docs:*` adapter swap (~1 day)

Today: `packages/docs-engine/` exports a `fumadocsAdapter` consumed by `apps/operator/lib/agent-tools/docs/{outline,get,search}.ts` and the cross-harness siblings.

Goal: add a `starlightContentAdapter` (or `astroCollectionAdapter`) that reads the same content but from the Astro content collection on disk. The MCP tool surfaces (`docs:outline`, `docs:get`, `docs:search`) keep their **external JSON shape** exactly so agents don't see the swap.

Strategy: the adapter reads files directly from `apps/operator-docs/src/content/docs/**/*.mdx`. It doesn't need a running Astro server — Astro content collections are filesystem-backed, same as fumadocs source files. The adapter:

- Walks the directory tree.
- Parses each `.mdx` for frontmatter (title, description, sidebar) and body.
- Strips MDX-JSX via the existing `remark-mdx-to-markdown.ts` (no change needed there — it operates on the AST shape, not the source loader).
- Builds the outline / get / search response payloads in the existing JSON shape.

**Tasks:**

1. Add `starlightContentAdapter` to `packages/docs-engine/src/adapters/`.
2. Add a config switch in `packages/docs-engine/src/index.ts` to pick the adapter (`PAPERCUSP_DOCS_ADAPTER=starlight|fumadocs`, default fumadocs during migration).
3. Run regression tests: capture current `docs:outline` / `docs:get` / `docs:search` outputs against a known corpus, run against new adapter, diff.
4. Acceptable deltas: order of items within a section (if frontmatter order changes), text inside MDX where component-replacement changed wording. Unacceptable deltas: missing pages, missing sections, broken slug shapes.

**Acceptance:** Regression-test JSON-diff produces only documented acceptable deltas.

### F7 — Agent prompt sweep (~0.5 day)

Six prompt files reference fumadocs / `content/internal-docs/`:

```
apps/operator/prompts/papercusp-su.tools.md      ← canonical source for the global block in ~/.claude/CLAUDE.md
apps/operator/prompts/architect.tools.md
apps/operator/prompts/debugger.tools.md
apps/operator/prompts/reviewer.tools.md
apps/operator/prompts/scoper.tools.md
apps/operator/prompts/validator.tools.md
```

Find/replace pairs (mechanical):

| Old | New |
|---|---|
| `apps/operator/content/internal-docs/<section>/<slug>.mdx` | `apps/operator-docs/src/content/docs/<section>/<slug>.mdx` |
| `fumadocs` | `Starlight` |
| `fumadocs-ui components` | `Starlight components` |
| `source.config.ts` (where mentioned as authoritative loc) | drop reference or replace with `astro.config.mjs` |

URLs (`/internal/docs/<section>/<slug>`) are unchanged — `base: '/internal/docs'` preserves them.

**Acceptance:** `grep -ri 'fumadocs' apps/operator/prompts/` returns 0 lines.

### F8 — Global CLAUDE.md update (~0.5 day)

The user's `~/.claude/CLAUDE.md` is auto-managed by `apps/operator/scripts/install-standalone-mcp.sh` — it reads `apps/operator/prompts/papercusp-su.tools.md` and projects a block between BEGIN/END markers into CLAUDE.md.

**Tasks:**

1. Update `papercusp-su.tools.md` (already done in F7) — rewrite the "Write / update documentation" section for Starlight:
   - Path: `apps/operator-docs/src/content/docs/<section>/<slug>.mdx`
   - Frontmatter conventions: Starlight's `title` + `description` + optional `sidebar`
   - Components available: Starlight's `<Aside>`, `<Card>`, `<CardGrid>`, `<Tabs>`, `<FileTree>`, `<Steps>`, plus any React islands shipped in F3
   - Section structure: list of directories under `apps/operator-docs/src/content/docs/`
   - Engine: "Starlight (on Astro)" — replace "fumadocs"
   - Dev server: still `cd papercusp-desktop && npm run dev` (no change — Tauri proxies / Hono serves dist)
2. Update the "Read documentation" section — URL surfaces unchanged, only path references update.
3. Re-run `bin/install-standalone-mcp.sh` (locally, on user's machine) to refresh the BEGIN/END block in `~/.claude/CLAUDE.md`.
4. **Note:** This step's "side effect" lands in the user's home dir, not the repo. Coordinate with user for the install-script run.

**Acceptance:** `grep fumadocs ~/.claude/CLAUDE.md` returns 0 lines after re-running install script.

### F9 — Hono integration + Accept-negotiation middleware (~0.5 day)

Wire the new Astro dist into the existing Hono server (today this is `apps/operator/app/_hono/`; doesn't matter whether Next is removed or not).

1. After `npm run build` in `apps/operator-docs/`, output lands at `apps/operator-docs/dist/`.
2. Add a Hono middleware:

   ```ts
   import { serveStatic } from '@hono/node-server/serve-static';
   import { existsSync, readFileSync } from 'node:fs';
   import { join } from 'node:path';

   const DOCS_DIST = join(process.cwd(), 'apps/operator-docs/dist');

   docsApp.use('/internal/docs/*', async (c, next) => {
     const accept = c.req.header('accept') ?? '';
     if (accept.includes('text/markdown')) {
       // Strip /internal/docs/ prefix, try the .md twin
       const path = c.req.path.replace(/^\/internal\/docs\//, '');
       const mdPath = join(DOCS_DIST, 'internal/docs', `${path}.md`);
       if (existsSync(mdPath)) {
         return c.text(readFileSync(mdPath, 'utf-8'), 200, {
           'Content-Type': 'text/markdown; charset=utf-8',
         });
       }
     }
     return next();
   });

   docsApp.use('/internal/docs/*', serveStatic({ root: DOCS_DIST }));
   docsApp.use('/llms.txt', serveStatic({ root: DOCS_DIST, path: '/llms.txt' }));
   docsApp.use('/llms-full.txt', serveStatic({ root: DOCS_DIST, path: '/llms-full.txt' }));
   docsApp.use('/llms-small.txt', serveStatic({ root: DOCS_DIST, path: '/llms-small.txt' }));
   ```

3. Verify the build script wires up: add `apps/operator-docs/` to monorepo turbo pipeline so `turbo build` produces `dist` before the Hono server starts.

**Acceptance:**
- `curl http://127.0.0.1:<port>/internal/docs/agent-policies` returns HTML.
- `curl -H 'Accept: text/markdown' http://127.0.0.1:<port>/internal/docs/agent-policies` returns markdown.
- `curl http://127.0.0.1:<port>/llms.txt` returns the index.

### F10 — Cutover PR (~0.5 day)

This is the irreversible step. After this PR lands, fumadocs is gone.

**Pre-flight checklist (must all be true):**

- [ ] F1–F9 complete and verified individually.
- [ ] `apps/operator-docs/` builds cleanly.
- [ ] Hono server serves docs via the new middleware.
- [ ] MCP `docs:*` tools return acceptable regression deltas with the new adapter.
- [ ] All 6 prompt files updated.
- [ ] `apps/operator/e2e/docs-routes.spec.ts` passes against the new stack.
- [ ] Manual smoke: load 5 random pages in Tauri dev WebView, verify rendering.
- [ ] No paperclip / parallel agent active in `coord/`.

**Cutover steps:**

1. Switch the MCP adapter default from `fumadocs` to `starlight` (`PAPERCUSP_DOCS_ADAPTER=starlight` becomes the default; flip the env-var-checked default in `packages/docs-engine/src/index.ts`).
2. Remove the fumadocs routes:
   - Delete `apps/operator/app/(docs)/**`
   - Delete `apps/papercup/app/(docs)/**`
   - Delete `apps/operator/source.config.ts`
   - Delete `apps/papercup/source.config.ts`
   - Delete `apps/operator/proxy.ts` Accept-negotiation block (lines covered by the new Hono middleware in F9).
3. Remove fumadocs deps from both apps' `package.json`:
   - `fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`, `fumadocs-openapi` (any subset that's installed).
4. Delete `apps/operator/content/internal-docs/` — content has moved to `apps/operator-docs/src/content/docs/`.
5. Delete the now-unused `fumadocsAdapter` from `packages/docs-engine/`.

**Acceptance:**
- `git grep fumadocs` returns 0 lines in the repo.
- All tests pass.
- Desktop app boots and loads docs at `/internal/docs/*` end-to-end.
- MCP smoke (real Claude session): `docs:outline` + `docs:get` + `docs:search` all work.

### F11 — Post-cutover (~0.5 day)

1. Write `apps/operator-docs/src/content/docs/agent-insights/starlight-migration-2026-XX-XX.mdx` capturing what changed, why, and any non-obvious gotchas for future agents.
2. Remove the env-var switch (`PAPERCUSP_DOCS_ADAPTER`) — there's only one adapter now.
3. Sweep historical plans under `apps/operator/docs/plans/` for stale fumadocs references; mark with `**superseded by fumadocs-to-starlight-2026-05-20**` headers where applicable.
4. Update `MEMORY.md` (auto-memory) — record that fumadocs is gone and Starlight is the docs engine.
5. Performance compare: build time (Astro vs fumadocs), bundle size, dev-server cold start. Document in the agent insight regardless of whether numbers are favorable.

**Acceptance:** Agent insight written; MEMORY.md reflects the new state.


---

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| MDX component coverage gap (a fumadocs-ui component without a clean Starlight or React-island replacement) | Medium | Medium | F3 audit-first sub-task produces real count before committing to F3 duration. If >10 distinct components, F3 stretches to 3 days; total plan stretches to ~9 working days. |
| `starlight-llms-txt` output shape differs from current fumadocs `/llms.txt` enough that some agent flow breaks | Low | Medium | F5 compares shapes explicitly. If agents have a brittle parser, fix the parser (it's our code). |
| MCP `docs:*` JSON shape drift in F6 adapter swap | Medium | High | Explicit regression test in F6 acceptance — known corpus, full diff, only acceptable deltas pass. |
| Astro build time prohibitive for 150+ pages | Low | Low | Astro static builds ~150 pages in well under a minute. Worst case: cache in CI; not load-bearing. |
| Search UX regression (Starlight uses Pagefind locally; fumadocs has built-in search route) | Low | Low | Pagefind ships with Starlight defaults; UX is comparable. The MCP `docs:search` tool uses our own search backend, not Pagefind, so unaffected. |
| Sidebar order drifts from current expectations after `meta.json` → frontmatter conversion | Low | Low | F4 conversion script preserves order numerically; verify in dev server before F10. |
| install-standalone-mcp.sh propagation lag — user's CLAUDE.md takes some time to refresh | Low | Low | User runs the install script once at F8; coordinate timing. |
| paperclip-style stomps on `content/internal-docs/` during migration | Low | Low | docs content isn't in the harness UI's stomp zone; no historical pattern of conflicts here. Verify with `pgrep -af paperclip` before F2. |
| Custom React island (`TypeTable` etc.) doesn't hydrate correctly under Astro's island model | Low | Medium | Ship one island in F3 first as a proof; if it works, the rest follow. |

---

## Open questions back to user

These are user decisions (not coord-channel decisions like the prior Q3):

### Q-S1 — Final app directory name

Default: `apps/operator-docs/`. Alternatives: `apps/docs/`, `apps/internal-docs/`. Default reads cleanly alongside `apps/operator/` and is unambiguous about coupling.

### Q-S2 — Keep `<Aside>` or build a `<Callout>` shim?

Default: replace `<Callout>` usages with Starlight's `<Aside>` directly. Cleaner and uses the framework's idiom. Alternative: ship a `<Callout>` shim component that wraps `<Aside>` so MDX find/replace is unnecessary. Cost: extra component to maintain; benefit: zero MDX content changes. Default is the cleaner path; confirm.

### Q-S3 — When to run `bin/install-standalone-mcp.sh` (F8)

The install script lives at `apps/operator/scripts/install-standalone-mcp.sh` and projects into `~/.claude/CLAUDE.md` on the user's machine. Either:
- F8 PR includes a one-liner instruction "user re-runs install script after merge."
- F10 cutover PR includes the same instruction.

Default: F10. The CLAUDE.md update is part of cutover, not pre-cutover. Confirm.

### Q-S4 — Public docs site (`apps/operator/content/docs/`)?

Out of scope per the scope section, but the placeholder exists. Either:
- Leave the public placeholder on fumadocs forever (or until it gets real content).
- Migrate it to Starlight at the same time as F2 (cheap; one extra section). Even if there's no content yet, having both engines on Starlight is cleaner.

Default: migrate it as part of F2 for consistency, since the marginal cost is ~10 minutes. Confirm.

### Q-S5 — Effort window confirmation

~1.5 working weeks single-agent is the realistic estimate (vs. 1 week optimistic, 2 weeks pessimistic if F3 reveals heavy custom-component usage). OK with this window?

---

## Acceptance (overall plan)

The plan is complete when:

1. `git grep fumadocs` returns 0 lines in the repo.
2. `apps/operator-docs/` is the single source of docs rendering.
3. Hono serves docs at `/internal/docs/*` with Accept-negotiation working for `text/markdown`.
4. `/llms.txt`, `/llms-full.txt`, `/llms-small.txt` are served.
5. MCP tools (`docs:outline`, `docs:get`, `docs:search`) return acceptable-delta JSON.
6. All 6 prompt files + global CLAUDE.md reflect Starlight.
7. `apps/operator/e2e/docs-routes.spec.ts` passes.
8. Agent insight written.
9. MEMORY.md updated.

---

## Rollback

Reversibility is high until F10. Before F10:
- The legacy fumadocs renderers still serve the docs site in production.
- The MCP adapter still defaults to fumadocs (env-var switch).
- The new Astro app is parallel, not replacing.

If F10 ships and a regression is found within 1 week:
- Revert the F10 PR. fumadocs renderers come back; adapter default flips back.
- The new Astro app stays in the tree (it's just not wired). Re-attempt cutover after fixing the regression.

After 1 week post-F10 with no regressions, delete the legacy fumadocs files for real (or accept they're already deleted by F10 — the legacy state isn't preserved, just the ability to revert the PR).

---

## Appendix A — File inventory

### New files

```
apps/operator-docs/
  package.json
  astro.config.mjs
  tsconfig.json
  src/
    content/docs/**             ← moved from apps/operator/content/internal-docs/
    components/**.tsx           ← React islands for non-Starlight components (count TBD by F3)
  public/
```

### Modified files

```
apps/operator/prompts/papercusp-su.tools.md       (F7)
apps/operator/prompts/architect.tools.md          (F7)
apps/operator/prompts/debugger.tools.md           (F7)
apps/operator/prompts/reviewer.tools.md           (F7)
apps/operator/prompts/scoper.tools.md             (F7)
apps/operator/prompts/validator.tools.md          (F7)
apps/operator/proxy.ts                            (F9: remove Accept-negotiation block — covered by Hono middleware)
apps/operator/app/_hono/<file>.ts                 (F9: add docs middleware)
packages/docs-engine/src/index.ts                 (F6: adapter switch)
packages/docs-engine/src/adapters/*.ts            (F6: new starlightContentAdapter)
package.json (root)                               (F1: workspaces; F10: remove fumadocs deps)
turbo.json                                        (F1, F9: build pipeline entry)
```

### Deleted files (at F10)

```
apps/operator/source.config.ts
apps/papercup/source.config.ts
apps/operator/app/(docs)/**                       (if exists)
apps/papercup/app/(docs)/**
apps/operator/content/internal-docs/              (entire tree; moved at F2, deleted at F10)
packages/docs-engine/src/adapters/fumadocs*.ts
```

### Untouched (deliberately)

```
apps/operator/content/docs/index.mdx              (public placeholder — see Q-S4)
apps/operator/docs/plans/**                       (historical plans; pointer updates only in F11)
```

---

## Appendix B — Library versions (May 2026)

- `astro@^6.0.0`
- `@astrojs/starlight@^0.39.2`
- `@astrojs/react` (latest compatible with Astro 6)
- `starlight-llms-txt` (latest; peer deps satisfied above)
- Optional: `starlight-llm-tools` (Copy-as-Markdown UI button)

Pin specific versions during F1; document in `package.json`.

---

## Appendix C — Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Docs engine | Starlight | React-friendly islands, native MDX, first-party autogen sidebar, static output, healthy maintenance |
| Bundler under it | Astro 6 (Starlight's substrate) | Comes with Starlight; multi-framework support |
| Agent surface | `starlight-llms-txt` | Maintained by Starlight core; preserves `/llms.txt`+twin URL contract |
| Content negotiation | F4b — Hono middleware reads `.md` twins | 15 lines of code vs. cascading prompt/CLAUDE.md changes |
| Custom callout strategy | Replace `<Callout>` → `<Aside>` in MDX (no shim) | Cleaner framework idiom |
| Sidebar config | Per-page frontmatter `sidebar: { order: N }` | Closest to fumadocs's `meta.json` mental model |
| When to delete legacy | F10 cutover PR | Single irreversible step; revert window = git-revert |
| Public docs migration | Migrate alongside internal in F2 | Marginal cost; consistency win |

---

## Document lifecycle

- **Today (2026-05-20):** draft for user review.
- **On user approval of Q-S1–Q-S5:** plan enters execution. `coord/frontend.jsonl` claim. Each phase's PR references this doc; phase completion updates a **Status** section at top.
- **At F11:** plan moves from active to historical. Final state captured in agent-insights doc.
- **If shelved:** mark `**Status: shelved**`, archive next to other plans. The phase structure is reusable if reopened.

