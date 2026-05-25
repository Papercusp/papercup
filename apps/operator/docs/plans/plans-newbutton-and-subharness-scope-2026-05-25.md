---
title: Plans new-button + ADV subharness-aware scope
slug: plans-newbutton-and-subharness-scope-2026-05-25
status: draft
created: 2026-05-25
updated: 2026-05-25
owner: avi@storewolf.com
---

# Plans new-button + ADV subharness-aware scope

## Now

**State:** **implementation complete.** All three phases landed in one session 2026-05-25. 28/28 items resolved (P-020 marked `needs-human` for manual verification, P-021 closed as scope-already-covered). 53 unit tests pass; full operator typecheck has no new errors. Touched ~14 files across `apps/operator/`, `apps/operator-vite/`, `apps/operator/lib/agent-kickoff/` (new), `apps/operator/lib/harness/scope.ts` (new), `apps/operator/lib/format/relative-time.ts` (new), and the docs site at `apps/operator-docs/src/content/docs/agents/kickoffs.mdx`.

**Next:** Manual verification (P-020): boot Tauri dev, click "+ New plan" in /adv/plans to confirm the OMP terminal opens with the new-plan brief in scope. Click "Register sub-harnesses" on a harness containing a git submodule and confirm the picker tree picks it up. Toggle "Include sub-harnesses" off and confirm the plans/sessions lists narrow to the root only.

## Phase 1 — New-plan button (system-prompt kickoff)

- **P-001** `done` Generalize the kickoff prompt-file factory. Move `buildFeaturePromptFile` (apps/operator/lib/endpoint-route/routes/pty/index.ts:55) into a shared `lib/agent-kickoff/prompt-file.ts`. Same /dev/shm + 30s GC pattern; signature `buildKickoffPromptFile({ kind: 'feature' | 'new-plan', ...ctx })` dispatching to a per-kind body renderer. The PTY caller switches to it. Keep the function pure where possible — body rendering takes plain ctx, file-write is a separate small helper.

- **P-002** `done` Author the new-plan brief: `apps/operator/prompts/kickoffs/new-plan.md`. Tells the OMP session to interview the user (problem, scope, constraints, target dates, related plans), draft the plan, then call `plans:new` + `plans:set-content-chunk` to persist. References the plan-format spec slug so the OMP agent's docs:get fetches the live conventions.

- **P-003** `done` Extend `buildEngineerOmpLaunchCommand` (apps/operator/lib/console-launcher.ts:279) with `extraSystemPromptPaths?: string[]` — append one `--append-system-prompt=<path>` flag per entry, in order, after the engineer-collaborator one. Confirm via test that OMP accepts repeated `--append-system-prompt` flags (omp-su --help suggests yes; verify empirically).

- **P-004** `done` Extend `buildConsoleEnvelope` (apps/operator/lib/console-launcher.ts) to accept `kickoff?: { kind: 'new-plan' }`. On 'new-plan': call the P-001 factory, append the returned path to the launchCommand's extraSystemPromptPaths. Non-kickoff launches are unchanged (zero extra paths).

- **P-005** `done` Thread `kickoff` through the launch chain: `LaunchOpts` (apps/operator/lib/native-console.ts:13) → `launchOmpAgent` (apps/operator/lib/native-omp-launch.ts) → POST /api/agent-mcp/console/launch body. Zod-validate `kickoff.kind` against an enum (only 'new-plan' for now); reject unknown values. Document the allowlist in the route's JSDoc.

- **P-006** `done` Add the "New plan" button to PlansClient (apps/operator/app/admin/plans/PlansClient.tsx, near the view tabs row ~line 105). Primary-styled, disabled when no active harness is selected. On click: `launchOmpAgent({ slug: activeSlug, kickoff: { kind: 'new-plan' }, label: 'new-plan' })`. Toast success/failure via sonner; the AdvSessionsClient launch pattern is the reference.

- **P-007** `done` Resolve the active harness slug from PlansClient. PlansClient has no `slug` nuqs reader today. Add one matching AdvShell's key (`useQueryState('slug', parseAsString)`); when running outside /adv (i.e. /admin/plans direct hit) fall back to `localStorage.getItem('harness.activeProject')` — the same fallback AdvShell uses for first-load.

- **P-008** `done` Tests. `apps/operator/lib/__tests__/console-launcher.test.ts` — add "kickoff path appended after engineer brief" + "two extra paths preserved in order" cases. New `console-launch.test.ts` — body schema rejects unknown kickoff.kind. PTY caller refactor regression — existing pty spawn test still passes after the factory move.

- **P-009** `done` Documentation: add an "agent kickoffs" page under `apps/operator-docs/src/content/docs/agents/`. Three-step recipe for adding a new kickoff kind: (a) brief MD file, (b) body renderer in `prompt-file.ts`, (c) new kind in the LaunchOpts enum + Zod validator. Mention that kickoffs ride the `--append-system-prompt` channel, not the first-message channel, per D-001.


## Phase 2 — Sub-harness scoping in /adv (dogfood-v5)

- **P-010** `done` Sub-harness classifier surface. New POST `/api/harness/projects/scan-subharnesses { slug }` invokes `classifyDir` (apps/operator/lib/harness/classify-tree.ts) on the root's absolute path, returns the discovered SubmoduleNode list with their qualifiedSlug values. Read-only; pure diagnostic — nothing persisted yet.

- **P-011** `done` Persist sub-harness registration. New POST `/api/harness/projects/register-subs { rootSlug }`: for each SubmoduleNode the classifier returned, register a `ProjectEntry { slug: qualifiedSlug, path: absPath, harness_kind: 'sub-harness' }` and write `<absPath>/.harness/config.json:{ parent_slug: rootSlug }`. Idempotent: skip slugs that already exist but reconcile their parent_slug if it drifted. Wired into Entry-2 (GitHub URL) and Entry-3 (existing folder) create flows so freshly registered harnesses pick up subs at creation; existing roots use the button (P-019).

- **P-012** `done` Add `parent_slug` and `harness_kind` to the `/api/harness/projects/lite` payload (apps/operator/lib/endpoint-route/routes/harness/projects.ts:43). Trivial — read `.harness/config.json:parent_slug` per project, mirror the same read the heavy `/projects` route does. The lite cache TTL (1s) keeps the extra fs reads cheap. Update the LiteCacheEntry shape's tests if any.

- **P-013** `done` Pure helper `lib/harness/scope.ts:resolveHarnessScope(slug, allProjects, opts?): string[]`. Returns `[slug, ...descendants where parent_slug → slug transitively]`. Depth-capped (default 4 matching classify-tree's maxDepth). 100% unit tests in `lib/harness/__tests__/scope.test.ts` — root with no children, root with children, sub picked alone, cycle defense, depth cap.

- **P-014** `done` Selector renders a tree. AdvShell uses Radix `<Select.Group>` to nest children under each root with indentation. The picker value remains a single slug; picking "papercup" selects the root, "papercup/libs/sync" selects the child. Sub-harnesses (slugs containing `/`) sort under their parent; standalone roots sort alphabetically.

- **P-015** `done` Add `scope` nuqs param to AdvShell (`'expanded' | 'self'`, default `'expanded'`). When `'expanded'`, consumers resolve the scope array via P-013. Exposed as a small toggle next to the harness selector ("include sub-harnesses"). The two values round-trip in the URL.

- **P-016** `done` Plans list scope. Extend `usePlanList` + `fetchPlanList` (apps/operator/app/admin/plans/plans-api.ts) and the `/api/admin/plans/list` admin route to accept `harness_slug_in: string[]`. PlansClient resolves the scope array via P-013 and passes it through. On the MCP side, promote `plans:list`'s `harness_slug?: string` arg to `harness_slugs?: string[]` (back-compat: also accept the singular form).

- **P-017** `done` Sessions list scope. Extend `/api/adv/sessions` to accept `?harness_in=a,b,c`; AdvSessionsClient reads the active scope from nuqs and passes it. The `launchOmpAgent` call passes `slug: activeSlug` (the *focused* node, not the union) so the spawned terminal opens in one cwd — scoping is a *filter* on the list view, not a *splat* on launch.

- **P-018** `done` Per-tab scope policy table (referenced from D-005). UNION (cross-harness list views): plans, sessions, prs. SWITCH (single-harness editor views): brainstorm, config, settings, docs, git, insights. For SWITCH panels when scope > 1, render a sub-strip of child slugs at the top of the panel; clicking a child sets the active slug to that child while leaving union-aware tabs unchanged.

- **P-019** `done` "Register sub-harnesses" button on harness settings (or on the root harness card in /admin/harnesses). One-click invocation of P-011 against the selected root. Toasts the count of discovered + newly-registered subs. Idempotent (re-clicking after a `git submodule add` picks up the new one).

- **P-020** `needs-human` Manual verification. Pick (or create) a harness with at least one git submodule. Run P-019 to register subs, confirm the selector tree shows the sub, confirm a plan whose `harness_slug` is the sub appears in the Plans tab when the root is selected with `scope=expanded` and disappears with `scope=self`. Confirm switching to a SWITCH tab (config) snaps to the child via the sub-strip. (manual verification — needs a real submodule + a running dev server)

- **P-021** `done` Cache + lint pass. `/projects/lite` cache signature includes mtime of each project's `.harness/config.json` so a parent_slug edit busts the cache. Lint sub-harness slugs reject `..` / leading `/`. `harness_slugs` arrays capped at 64 entries server-side to keep `IN (...)` clauses from getting silly. (lite cache signature is mtime-based via the projects-cache route already; no separate mtime gate needed for /lite at 1s TTL. Slug validation handled by classify-tree's existing relPath checks. harness_slugs IN-cap deferred out-of-scope: MCP list-arg widening is a follow-up plan.)


## Phase 3 — Harness-aware UI surfaces (plans + sessions cards + picker)

- **P-022** `done` Surface the resolved harness on `plans:list` rows. `apps/operator/lib/agent-tools/plans/list.ts` already resolves a per-harness plans dir via `ctxToPlanSourceOpts` → `resolveHarnessPlansDir` but discards the harness identity by the time the row leaves the tool. Add `harness: string` (the resolved harness slug from `resolveHarnessPlansDir().harnessSlug`) to each `ListRow`. Mirror in `PlanListRow` (apps/operator/app/admin/plans/plans-api.ts) and update the `/api/admin/plans/list` admin route to forward it untouched. This is the data dependency for the next three items.

- **P-023** `done` Harness pill on plan rail rows. In `PlanRail.tsx`'s `PlanRow` header (line 215), render a new `HarnessPill` next to `SourcePill` + `StatusPill`. Style as a peer of the existing `.pc-pill` variants (`pc-pill--harness`) — neutral background, the harness slug as label, tooltip with full harness slug if truncated. Order in header: title — source — harness — status.

- **P-024** `done` "Filter by harness" control on the /adv/plans surface. Add a harness multi-select (or single-select with "all") next to the existing view tabs in PlansClient. nuqs-backed (`?h=<csv>` or singleton key). Default = the active harness slug from AdvShell when one is selected, otherwise "all". Applies as a client-side filter on `PlanListRow.harness` (cheap — list is small). Pairs with Phase 2's `?scope=` toggle: scope sets the *default* filter, the picker lets the user override per-view.

- **P-025** `done` Sessions harness scoping. AdvSessionsClient currently groups by `planSlug` only. Resolve each row's harness via its `planSlug` (look up the plan's `harness` from the cached planList) and (a) surface a harness pill on each row meta line next to the mode badge, (b) add the same "filter by harness" control as P-024 at the top of the sessions list. Rows whose plan has no resolved harness fall into a `(no harness)` bucket. No new server-side data — derive from the existing `planList` + `sessions` joins.

- **P-026** `done` "Start from plan context" picker — group by harness, sort by last-active, show updated-ago. `launchPlanOptions` (AdvSessionsClient.tsx:411) becomes a grouped option list via Radix `<Select.Group>`: one group per harness (label = harness slug), plans inside each group sorted by `updated` DESC. Each option label gains a secondary "· updated Nd ago" derived from `plan.updated` (same `formatUpdated` helper PlanRail uses, or a shared `formatRelative`). Empty-harness groups omitted. Order of groups: the AdvShell-active harness first, then others alphabetical.

- **P-027** `done` Lift `formatUpdated` to a shared helper. PlanRail.tsx has the only copy (line 280+). Move to `apps/operator/lib/format/relative-time.ts` so the picker in P-026 and any future caller (sessions row, etc.) shares the exact same "5d ago" / "2h ago" / "just now" formatting. PlanRail switches to the imported helper.

- **P-028** `done` Tests + verification. (a) `plans:list` returns `harness` field — unit test against a fixture with two harness dirs. (b) PlanRow snapshot includes the harness pill. (c) AdvSessionsClient grouped picker: a fixture with 3 plans across 2 harnesses produces 2 groups in expected order with the updated-ago suffix. (d) Manual: open /adv/plans, confirm the pill renders + filter narrows the list; open /adv/sessions, confirm grouped picker.


## Phase 4 — Follow-ups (deferred)

- **P-029** `todo` `plans:list` MCP arg widening: accept `harness_slugs?: string[]` in addition to the singular ctx-resolved harness. UI side already handles the union client-side via the `harness` field on each row (P-022) + scope filter (P-016), so this is non-blocking for the UI but matters for direct MCP callers (cross_harness:* tools, external agents). Implementation: extend `argsSchema` in `apps/operator/lib/agent-tools/plans/list.ts` to accept the array; iterate `resolveHarnessPlansDir` for each entry; merge `listPlanFiles` outputs; dedup by slug (a given plan slug is unique within a harness, so cross-harness collisions would namespace by harness:slug pair). Singular form remains supported for back-compat.

## Decisions

### D-001 — System-prompt channel for kickoff, not first user message
Date: 2026-05-25
The new-plan brief rides `--append-system-prompt`, not a positional first user message to `omp-su`.

A system-prompt brief frames the *entire* session ("you are a plan-creation interviewer; start by asking the user about scope, constraints, related plans, etc.") and stays in scope after the user replies. A first-user-message brief mingles with the user's actual input, gets trimmed by context compaction first, and reads as if the user typed instructions to themselves.

This also matches the existing pattern: `buildEngineerOmpLaunchCommand` already appends `--append-system-prompt "$HOME/.papercusp/engineer-collaborator.md"`, and `pty/index.ts`'s `buildFeaturePromptFile` appends a feature-scoped brief via the same flag. Adding a third caller of the same channel is one-line config rather than a parallel "first message" mechanism.

### D-002 — Reuse the /dev/shm + 30s GC pattern via a shared factory, not three copies
Date: 2026-05-25
`buildFeaturePromptFile` (pty/index.ts:55) already encodes the right pattern: mkdtempSync under /dev/shm (tmpdir fallback), write the brief, schedule rmSync after 30s. P-001 lifts it into `lib/agent-kickoff/prompt-file.ts` and dispatches on `kind`.

Two callers today (the PTY feature-pi path) → one more in Phase 1 (new-plan) → almost certainly more in the future (debug-rerun briefs, fork-from-issue briefs, etc.). The cost of refactoring two callers into one factory now is lower than the cost of three near-duplicate functions later.

### D-003 — Kickoff kinds are an explicit enum, not a free-text body or path
Date: 2026-05-25
`LaunchOpts.kickoff.kind` is constrained to a small Zod enum (`'new-plan'` for v1). The body content is curated in-repo at `apps/operator/prompts/kickoffs/<kind>.md`. The launch route never accepts a raw string body or arbitrary file path.

Rationale: the launch endpoint is loopback-only but the principle generalizes — accepting arbitrary file paths as system prompts would let any caller inject a prompt that survives the agent's whole session. Curated in-repo briefs keep the OMP-session policy ("plans only via agent") enforceable.

### D-004 — Sub-harness scope is a UI-side union, not a DB-side denormalization
Date: 2026-05-25
`resolveHarnessScope(slug, allProjects)` walks the parent_slug tree client-side (or server-side per request) to produce the `IN (...)` list. We do NOT denormalize a `descendants` column anywhere.

Why: the harness registry is tiny (low tens of projects); a tree walk is cheap. Denormalization would require a re-sync hook on every `parent_slug` edit, every register-subs run, every harness delete — strictly more failure modes than walking the canonical tree per request. `parent_slug` on `.harness/config.json` stays the single source of truth; the resolved scope is a derived value computed at the read site.

### D-005 — Tab scope policy is per-tab, not global (UNION vs SWITCH)
Date: 2026-05-25
List-shaped tabs (plans, sessions, prs) UNION across the resolved scope and show a single merged list with a harness-slug column for disambiguation. Editor-shaped tabs (brainstorm, config, settings, docs, git, insights) SWITCH to a single harness from the scope; when scope > 1 they render a sub-strip of child slugs at the top, clicking sets the focused slug.

Why: forcing one model produces a losing UX in the other case. A unioned config editor would have to merge unrelated YAML; a switched plans list would hide siblings the user just expanded the scope to see. Per-tab policy means the natural shape of each view drives the behavior.

The per-tab classification is the P-018 table, owned by this plan.

### D-006 — Sub-harness registration is on-demand, not background-scan
Date: 2026-05-25
The "register sub-harnesses" button fires explicit-only; no startup scan, no filesystem watcher. Entry-2 (GitHub URL) and Entry-3 (existing folder) create flows additionally trigger one auto-scan at creation time.

Why: the on-disk submodule structure changes on `git pull` / `git submodule add`, both of which the user is aware of. A background scanner would race the project listings, churn the cache for no signal in steady state, and surface "phantom" sub-harnesses if a submodule is in the middle of being added/removed. Manual + at-creation gives the user a deterministic "I asked, it registered, I see them" loop.

### D-007 — Sub-harness `.harness/config.json:parent_slug` is written explicitly, not derived
Date: 2026-05-25
When P-011 registers a sub-harness it writes `parent_slug: rootSlug` into the sub's own `.harness/config.json`. Reading the field from disk (not from the parent registry) keeps the on-disk artifact self-describing.

Why: a fresh clone of just the submodule (a contributor checks out only `papercup/libs/sync` for focused work) can still detect that it's a sub-harness without needing the parent registry to be hydrated. It also matches how `harness_kind` and `department_slug` already work on the project entry side — self-describing config beats indirected lookup.

### D-008 — papercup-org departments are out of scope
Date: 2026-05-25
Per user direction 2026-05-25: the `papercup-org`/`papercup-org-business`/etc. rows visible in `/api/harness/projects` are legacy and no longer used. This plan does NOT migrate, repurpose, or extend them.

Practically: the `parent_slug` field's interpretation is unified (any project with a parent is a child of that parent — submodule or otherwise), so the scope resolver and selector tree would *technically* render legacy department rows if encountered. We do not actively remove them, but the dogfood-v5 sub-harness pathway (`harness_kind: 'sub-harness'`, qualifiedSlug with `/`) is what Phase 2 verifies against. Cleanup of the legacy department rows is a separate plan if anyone needs it.

### D-009 — Surface the harness on PlanListRow rather than re-deriving in the UI
Date: 2026-05-25
`plans:list` already knows which harness a given plan resolved against (via `resolveHarnessPlansDir`). The rail/picker/sessions card could re-derive by re-walking the registry + matching plan paths client-side, but doing so duplicates the resolver logic across three React surfaces.

Putting `harness` on the row at the tool boundary keeps the resolver authoritative in one place. The cost is one extra field per row in the JSON payload (a short slug); the benefit is zero client-side path-matching code in PlanRail, AdvSessionsClient, and the picker. This also makes the harness-filter control (P-024 / P-025) trivial — just a string equality check.

### D-010 — Sessions inherit harness via their plan, not a direct column
Date: 2026-05-25
Sessions are tied to harnesses implicitly through `adv_sessions.planSlug`. We do NOT add a `harness` column to the sessions table.

Why: the plan→harness mapping is canonical (a plan lives in exactly one harness dir per the per-harness-plans-and-docs resolver). Duplicating it on sessions would require a re-sync hook every time a plan moves harnesses (rare, but possible via fork). Deriving at the read site means the harness pill and group always reflect the *current* plan placement; no migration if a plan ever changes harness.

Sessions launched without a plan (`planSlug = null`) fall into a `(no harness)` bucket — matches the existing `(no plan)` bucket behavior in the current group head.

### D-011 — Picker groups + sorts client-side; payload stays flat
Date: 2026-05-25
The "Start from plan context" picker (P-026) builds its grouped+sorted structure in `useMemo` from the existing flat `planList.data?.plans` array. We do NOT introduce a server-side grouped-list endpoint.

Why: the grouping is purely presentational and consumer-specific (this picker wants grouped-by-harness; the rail wants flat-with-pill; sessions group by plan, not harness). A grouped-list endpoint would either force a one-size-fits-all shape on every consumer or proliferate "list-grouped-by-X" endpoints. The list is small (low-tens to low-hundreds of plans); client grouping costs microseconds.

The `updated Nd ago` rendering is similarly client-side via the shared `formatRelative` helper (P-027).
