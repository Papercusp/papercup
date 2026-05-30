---
title: SU agent prompt audit fixes
slug: su-prompt-audit-fixes-2026-05-30
status: draft
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
related: [papercusp-su-memory-2026-05-25, coord-channels-pg-port-2026-05-30]
---

# SU agent prompt audit fixes

## Now

**State:** Rev3, after two rounds of skeptical re-verification against the live codebase. Round 2 corrected the original P-001 (role count was wrong → point at `AGENT_ROLES`, D-004) and promoted the `docs:*` bug (P-008) to lead. Round 3 fixed two more: P-003 was itself inaccurate — there IS a table, named `harness_shared.spawned_agents` (not `spawns`), so the fix is to **correct** the name, not drop it; and P-011/P-014 wording was scoped/de-staled. Governing rule stays **pointers, not duplication** (D-001). Nothing is edited in the prompts yet.

**Next:** human reviews/approves rev3; then an agent starts Phase 1 — P-008 (the `docs:*` operator-scope bug, a tool/handler+test code change) and P-001 (the role-fact correction), which lead because they are the real defects. Rebase all edit items on current prompt content at implementation time (the SU prompts were last edited today by the three-client-lock commit `1241865a`).

## Background

The prompt SU agents run under is assembled by `install-standalone-mcp.sh` from a base playbook (`papercusp-su-engineer.tools.md` for the engineer profile, `-power` for the workspace-scoped power user) plus a client overlay spliced at the `CLIENT-TOOLING-OVERLAY` marker. Three reviews cross-checked every factual claim against the live codebase; this plan reflects the twice-corrected set.

Framing for scope:
- Repo root `AGENTS.md` is a symlink to `CLAUDE.md`, so claude-su AND codex-su working *inside papercup* already receive the repo conventions (testing, storage, nuqs, run-the-app, flags, context7). Several "missing" systems are therefore not missing for the in-repo case — they live in `CLAUDE.md`. The genuine gaps are (a) facts absent from `CLAUDE.md` too (operator runtime topology), and (b) a verification *mandate* with no *method*.
- Most inaccuracy fixes are **engineer-playbook-only** (D-003).

## Phase 1 — Highest-value defects (lead)

- **P-008** `todo` `docs:*` operator-scope failure — investigate + fix (a tool/handler + test code change, NOT a prompt edit; it leads correctly but may warrant its own issue/PR — the prompt-side fix is P-009). At operator scope (no `harnessSlug`) `docs:outline`/`docs:search` return `{"error":"harness_not_registered","slug":"*"}`, yet the tool's own description says it serves "the Papercusp framework engineering reference (papercusp-su callers only)" — exactly this caller. **Root-cause lead:** the `slug:"*"` signature means the handler resolves the no-harness wildcard `"*"` as a real harness instead of routing to the framework docs (or `PAPERCUSP_PROJECT_DOCS_ROOT`) — that is where the fix lives. Evidence favors the bug fork (D-005).
- **P-009** `todo` Correct the docs workflow per P-008's outcome: if the tool is fixed, leave the workflow; if it stays scoped, make the playbook lead with the reliable operator-level path (read `apps/operator-docs/src/content/docs/**.mdx` directly, or `curl :3070/llms-full.txt`) and mark `docs:*` harness-scoped. blocked-by: P-008
- **P-001** `todo` Role list — drop the brittle "**the 10** are …" count AND the false "Each has its own `persona.md` + `tools.md`" claim; point at `AGENT_ROLES` (`role-config.ts`) as the source of truth instead of enumerating (same treatment as P-005). Corrected facts (verified): `AGENT_ROLES` = 19, no `tester`; `KNOWN_ROLES` = 18, has `tester`, omits operator/oracle; only operator/oracle have `persona.md`; `*.tools.md` is a 9-file subset (has `tester`, lacks curator/documenter). See D-004. Engineer playbook §"Core nouns".

## Phase 2 — Other verified inaccuracy fixes (engineer base playbook)

- **P-002** `todo` Write-docs section: remove the retired `bin/prod`/`bin/dev` references and fix the docs port — `/internal/docs` is served by the Hono host on **`:3070`**, not `:3055` (verified: `apps/operator/bin/` has no dev/prod; `host-docs.ts`; CLAUDE.md L82). §"Write / update documentation".
- **P-003** `todo` Correct "Tracked in `harness_shared.spawns`" → **`harness_shared.spawned_agents`** — the real table (`049-spawned-agents.sql`; spawn-tree views in `048-intel-views.sql`). The original "drop it, no DDL exists" rationale was itself wrong (a word-boundary grep missed `spawned_agents`); there IS a table, under a different name — which is also why the v2-coord audit G1 "couldn't confirm `spawns`." §"Core nouns".
- **P-004** `todo` "audit rows + **Zero deltas**" → "audit rows + sync invalidation (SSE / `pg_notify`)" — Zero is legacy/retired. §"Where not to go".
- **P-005** `todo` Drop the hard "**~96**" count and fix the scope list, which omits core SU surfaces the doc itself later documents (`coord:* locks:* plans:*` plus `tasks:* flags:* backup:* design-phase:* roles:* cross_harness:*` …). Prefer "see `agent_tools:list`" over an enumerated count. §"What papercusp-su gives you".
- **P-006** `todo` (low-value) Clarify the one-line intro that the operator's API/MCP layer is **Hono** (`bin/hono-host.ts`, :3070), not "Next.js". **Drop the "overmind" nit** (an illustrative example, not a misstatement). §"What Papercusp is".
- **P-007** `todo` Scan `agent-policies.mdx` for the same stale facts (role count, ports, bin/*) and fix any in step. **Expected low-yield** — a grep already found none of them; cheap belt-and-suspenders pass.

## Phase 3 — Verification method + operator topology

- **P-010** `todo` Give the verification mandate a method by **linking** (not re-specifying, per D-001): the engineer playbook's "Don't ship without verification" should point at CLAUDE.md's four canonical test homes + `npm run test:affected` (and `/internal/docs/testing`); the power playbook should say "verify via the project's own test command / TESTING.md".
- **P-011** `todo` Document the operator runtime reality (the fact that bit the coord cutover), scoped precisely: the **:3070 Hono host** — the MCP tools, endpoint-route handlers, and the `lib/**` they import — has **no file-watch** (`start = tsx bin/hono-host.ts`, no nodemon), so server-side edits only go live after a restart; the **:3055 Next layer hot-reloads** its own routes/components. Per amended D-002, CLAUDE.md gets the general invariant (server-side / :3070 handlers don't hot-reload — restart to pick up `lib/**`); the box-specific `systemctl --user restart papercup-dev-api.service` + the "probe where the write lands to confirm fresh code" tell live in a memory note + the agent-insight, scoped to the standing systemd dev box. Engineer playbook gets a one-line pointer.

## Phase 4 — Missing-system pointers (not duplication)

- **P-012** `todo` Add a short engineer-playbook pointer: "Working on the Papercusp codebase? The repo `CLAUDE.md` is authoritative for run-the-app (Tauri desktop; never browse `:3055`/`:3070`; verdict for browser checks), testing, storage policy, feature-flag gating, nuqs, and context7 — read it." No copying of that content into the playbook (D-001).
- **P-013** `todo` Confirm the P-012 pointer covers feature-flags (`libs/flags`, `requireFlag`/`gateApiRoute`, `/admin/features`) and storage policy without playbook duplication; add a one-liner only if the pointer is insufficient. blocked-by: P-012

## Phase 5 — Verify + adjacent fixes

- **P-014** `todo` Re-render the playbook and verify. The splice renders in **two** code paths — the bash `render_playbook` in `install-standalone-mcp.sh` and one shared TS helper `lib/desktop-install/splice-tooling-overlay.ts` (consumed by `papercusp-files.ts` + `agent-bundle.ts`, consolidated today) — re-render/check across both; do NOT re-DRY the already-shared helper. Run the real test: the Vitest **`apps/operator/lib/__tests__/tools-md-sync.test.ts`** (there is no `__tests__/integration/tools-md-sync.mjs`; `.mjs` integration scripts are banned by CLAUDE.md). Confirm no backtick tool refs point at non-existent tools. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-009, P-010, P-011, P-012, P-013
- **P-015** `todo` Remove the stale `papercusp-su-*.tools.md.bak-*` backup files (2026-05-25) if confirmed dead.
- **P-016** `todo` Fix CLAUDE.md "Adding a tool" §5 (≈L448), which also cites the dead `apps/operator/__tests__/integration/tools-md-sync.mjs` — point it at the Vitest `apps/operator/lib/__tests__/tools-md-sync.test.ts`.

## Decisions

### D-001 — Pointers, not duplication
Date: 2026-05-30
The cross-harness playbook is loaded for every SU session regardless of cwd; `CLAUDE.md` is loaded only when the cwd is the papercup repo (and reaches Codex via the `AGENTS.md`→`CLAUDE.md` symlink). Papercup-repo conventions (run-the-app, testing, storage, flags, nuqs, context7) stay in `CLAUDE.md`; the playbook only links to them. Duplicating repo conventions into the playbook is precisely what let the personal `~/.claude/AGENTS.md` copy drift to the pre-Starlight fumadocs/`content/internal-docs` layout — we will not reintroduce that failure mode.

### D-002 — Operator runtime topology: general (server-side) fact in CLAUDE.md, box-specifics in memory/insight (amended)
Date: 2026-05-30
Amended twice. The box-specific systemd unit name (`papercup-dev-api.service`) is this dev machine's local supervision — not in the repo; CLAUDE.md's canonical run model is the Tauri desktop spawning the operator. And the invariant must be precise: only the **:3070 Hono host** (server-side handlers + the `lib/**` they import) lacks hot-reload; the **:3055 Next layer hot-reloads**. So CLAUDE.md gets the scoped general fact (server-side / :3070 changes need a restart — reload the Tauri shell, or on the standing systemd dev box `systemctl --user restart papercup-dev-api.service`; the Next :3055 layer hot-reloads). The specific command + the "probe where the write lands" tell live in the memory note + an `agent-insights/` MDX, scoped to the standing dev setup.

### D-003 — Inaccuracy fixes are engineer-playbook-only
Date: 2026-05-30
The power playbook has no role list, no write-docs/bin-* section, no "Zero deltas" phrasing, and no "~96 tools" claim, so the §1 corrections touch only the engineer base. The power playbook receives only the §2/§3 pointer-level changes (verify-via-project-TESTING.md; the CLAUDE.md pointer is engineer-only since power users work on other projects).

### D-004 — Role list: point at AGENT_ROLES, don't enumerate or hard-count
Date: 2026-05-30
The original "10 → 11 + tester" was wrong and internally inconsistent (it bumped-and-kept a role count while P-005 dropped the tool count). The two role lists diverge: `AGENT_ROLES` (`role-config.ts`, runtime source of truth) = 19 with no `tester`; `KNOWN_ROLES` (`role.ts`) = 18 with `tester` but no operator/oracle. The playbook must not enumerate or hard-count roles, nor claim every role has persona+tools files (only operator/oracle have `persona.md`). It points at `AGENT_ROLES`. The divergence itself is a separate code bug (Q-3).

### D-005 — P-008 (docs bug) is the lead item; evidence favors the bug fork
Date: 2026-05-30
`docs:*` is reproducibly broken for the operator-scope SU caller (`harness_not_registered`, `slug:"*"`), yet the tool's own description says it serves the framework reference for "papercusp-su callers only" — exactly this caller. That points at a tool bug (the wildcard `"*"` resolved as a real harness), not intended behavior, and it disables the playbook's primary docs workflow. It leads ahead of the cosmetic copy edits.

## Open questions

- **Q-1** Is the `docs:*` operator-scope error a bug or intended? Evidence favors **bug** (the tool scopes itself to papercusp-su callers; `slug:"*"` is the no-harness wildcard mis-resolved). P-008 confirms; P-009 forks on it.
- **Q-2** Re-sync the user's personal `~/.claude/AGENTS.md` (embeds an older fumadocs-era copy of this playbook)? Out of repo scope — the user's personal file; flagged, not actioned here.
- **Q-3** `AGENT_ROLES` (19, no tester) vs `KNOWN_ROLES` (18, tester, no operator/oracle) diverge — **a real latent bug**, not cosmetic: two disagreeing sources of truth for role-gating/validation. File its **own issue** (separate from this prompt-doc plan); out of scope here.

## Rejected alternatives

- **Copy the testing/storage/run/flags conventions into the playbook so all clients see them regardless of cwd.** Rejected (D-001) — duplicates `CLAUDE.md`; duplication is the documented cause of the `~/.claude/AGENTS.md` drift.
- **Enumerate or hard-count the role list in the playbook.** Rejected (D-004) — the two canonical lists diverge and the set churns; point at `AGENT_ROLES`.
- **Drop the `harness_shared.spawns` reference entirely.** Rejected (P-003) — the table exists as `spawned_agents`; correct the name rather than delete a useful pointer.
- **Put the `systemctl … papercup-dev-api.service` unit name in CLAUDE.md as a universal step, or claim "the operator has no file-watch" wholesale.** Rejected (D-002) — box-specific + imprecise (the :3055 Next layer hot-reloads); CLAUDE.md gets only the scoped server-side restart fact.
- **Delete the `docs:*`-first workflow.** Rejected — `docs:*` is correct when harness-scoped; the fix is the tool bug (P-008) and operator-level fallback guidance (P-009), not removal.
