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

**State:** Rev5. Three review rounds + user feedback + an endpoint-scoping audit. Resolutions: **Q-1** — the no-harness `docs:*` error is **intended** (harness-scoped: you select a harness to work on it), NOT a bug; so the fix is a prompt correction (P-008), and the playbook's "superuser gets Papercusp's own engineering docs via `docs:*`" claim is the wrong bit. The **endpoint-scoping audit found no real cross-harness leaks** — every per-harness tool is slug-required / guarded / caller-bound, with workspace RLS as the floor (D-005). **Q-3** — `AGENT_ROLES` (role-config.ts) is the canonical source of truth, but it is incomplete (missing `tester`) and `KNOWN_ROLES` (role.ts) is a drifted hand-list that should be derived (D-006 → P-017, a code fix). **Q-2** — the fossil playbook block was deleted from `~/.claude/AGENTS.md` (545→79 lines); P-018 adds an installer strip so it can't recur. Governing rule stays **pointers, not duplication** (D-001).

**Next:** human approves rev5; an agent starts Phase 1 (P-008 prompt correction + P-001 role-fact). The code fixes (Phase 6) can be their own PRs.

## Background

The SU prompt is assembled by `install-standalone-mcp.sh` from a base playbook (`papercusp-su-engineer.tools.md`, `-power`) + a client overlay. Three reviews + a live endpoint audit cross-checked every claim against the codebase; this is the corrected set. Repo root `AGENTS.md → CLAUDE.md` symlink, so claude-su/codex-su working in papercup already get the repo conventions — so several "missing" systems live in `CLAUDE.md` and the playbook only links them (D-001). Most prompt fixes are engineer-playbook-only (D-003).

## Phase 1 — Highest-value prompt corrections (lead)

- **P-008** `todo` Correct the docs + harness-scoping guidance. The no-harness `docs:outline`/`docs:search` → `harness_not_registered` (`slug:"*"`) is **intended** — harness-scoped endpoints require a selected/specified harness (Q-1, D-005). Fixes to the engineer playbook: (a) **remove the false "Superuser callers also get access to Papercusp's own engineering docs via `docs:*`"** claim (§Working context); (b) state plainly that harness-scoped endpoints (`docs:* features:* issues:* plans:* agent_chats:* messages:* experts:* intel:*` …) require a harness — select one / pass the slug, or use `cross_harness:*`; (c) for the Papercusp **framework** engineering docs at operator scope (working on the codebase), read `apps/operator-docs/src/content/docs/**.mdx` directly or `curl :3070/llms-full.txt` (verified-reliable). Confirm during impl whether selecting a harness exposes the framework docs via `docs:*`. (Supersedes the old "investigate bug" framing + P-009.)
- **P-001** `todo` Role list — drop the brittle "**the 10** are …" count AND the false "Each has its own `persona.md` + `tools.md`" claim; point at `AGENT_ROLES` (`role-config.ts`) as the source of truth (same treatment as P-005). Verified: `AGENT_ROLES` = 19, no `tester`; `KNOWN_ROLES` = 18, has `tester`, omits operator/oracle; only operator/oracle have `persona.md`. See D-004/D-006. §"Core nouns".
- **P-009** `dropped` Merged into P-008 — the docs behavior is intended, so there is no tool-fix fork; the change is purely the prompt correction. See D-005.

## Phase 2 — Other verified inaccuracy fixes (engineer base playbook)

- **P-002** `todo` Remove retired `bin/prod`/`bin/dev` refs; fix the docs port to **`:3070`** (Hono host serves `/internal/docs`), not `:3055`. §"Write / update documentation".
- **P-003** `todo` Correct "Tracked in `harness_shared.spawns`" → **`harness_shared.spawned_agents`** (`049-spawned-agents.sql`; spawn-tree views `048-intel-views.sql`). The "no DDL exists" rationale was itself wrong (a `\bspawns\b` grep missed it; also why v2-coord G1 "couldn't confirm spawns"). §"Core nouns".
- **P-004** `todo` "audit rows + **Zero deltas**" → "audit rows + sync invalidation (SSE / `pg_notify`)". §"Where not to go".
- **P-005** `todo` Drop the hard "**~96**" count; fix the scope list (omits `coord:* locks:* plans:*` + `tasks:* flags:* backup:* design-phase:* roles:* cross_harness:*` …). Prefer "see `agent_tools:list`". §"What papercusp-su gives you".
- **P-006** `todo` (low-value) Clarify the API/MCP layer is **Hono** (`bin/hono-host.ts`, :3070), not "Next.js". Drop the "overmind" nit. §"What Papercusp is".
- **P-007** `todo` Scan `agent-policies.mdx` for the same stale facts (role count, ports, bin/*). **Expected low-yield** (a grep found none).

## Phase 3 — Verification method + operator topology

- **P-010** `todo` Give the verification mandate a method by **linking** (not re-specifying, per D-001): point at CLAUDE.md's four canonical test homes + `npm run test:affected` / `/internal/docs/testing`; power playbook → "verify via the project's own test command / TESTING.md".
- **P-011** `todo` Document the operator runtime reality, scoped precisely (D-002): only the **:3070 Hono host** (server-side handlers + the `lib/**` they import) lacks hot-reload — restart to pick up changes; the **:3055 Next layer hot-reloads**. CLAUDE.md gets the general server-side-restart invariant; the box-specific `systemctl --user restart papercup-dev-api.service` + the "probe where the write lands" tell go in a memory note + an `agent-insights/` MDX scoped to the standing dev box. Engineer playbook → one-line pointer.

## Phase 4 — Missing-system pointers (not duplication)

- **P-012** `todo` Engineer-playbook pointer: "Working on the Papercusp codebase? The repo `CLAUDE.md` is authoritative for run-the-app (Tauri desktop; never browse `:3055`/`:3070`; verdict for browser checks), testing, storage policy, feature-flag gating, nuqs, and context7 — read it." No copying (D-001).
- **P-013** `todo` Confirm P-012's pointer covers feature-flags + storage policy without duplication; add a one-liner only if insufficient. blocked-by: P-012

## Phase 5 — Verify + adjacent fixes

- **P-014** `todo` Re-render the playbook (bash `render_playbook` + the shared TS helper `lib/desktop-install/splice-tooling-overlay.ts`, consumers `papercusp-files.ts`/`agent-bundle.ts` — don't re-DRY); run the Vitest **`apps/operator/lib/__tests__/tools-md-sync.test.ts`** (no `__tests__/integration/tools-md-sync.mjs`); confirm no backtick tool refs point at non-existent tools. Rebase all edit items on current prompt content (last edited today by `1241865a`). blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-010, P-011, P-012, P-013
- **P-015** `todo` Remove the stale `papercusp-su-*.tools.md.bak-*` backup files if confirmed dead.
- **P-016** `todo` Fix CLAUDE.md "Adding a tool" §5 (≈L448), which cites the dead `__tests__/integration/tools-md-sync.mjs` → point at the Vitest test.

## Phase 6 — Code fixes surfaced by the audit (separable PRs)

- **P-017** `todo` Role registry (Q-3, D-006). `AGENT_ROLES` (role-config.ts) is the canonical source of truth, but: (i) **add `tester`** to it (+ create `libs/papercusp/packages/harness/prompts/tester.md`) to finish the tester promotion — `tester` has `tester.tools.md` and is in `KNOWN_ROLES` but is absent from `AGENT_ROLES` and has no role prompt; (ii) **derive `KNOWN_ROLES`** (role.ts) instead of hand-keeping it — it currently accepts `tester` (no `.md` → `agent:role` throws) and rejects `plan-gate`/`scanner`/`synthesizer` (which DO have `.md`). Derive from `AGENT_ROLES` ∩ on-disk `<role>.md`, or drop the pre-validation and let the existing file-read be the check. Code change; own PR ok.
- **P-018** `todo` (Q-2) Add an installer cleanup step to `install-standalone-mcp.sh` that strips a legacy `<!-- BEGIN papercusp-su playbook … -->` managed block from `~/.claude/AGENTS.md` (mirroring the `~/.omp/agent/CLAUDE.md` strip at step 4a), so the fossil can't recur. The current block was deleted manually 2026-05-30.
- **P-019** `todo` (endpoint audit) `issues:list` guidance/schema mismatch: `guidance.when` says "pass a slug to scope" but the args schema has no slug and the handler stubs `[]`. Not a scoping leak — a guidance-accuracy fix (same class as this plan): either finish cross-harness consolidation or align the guidance to the stub.

## Decisions

### D-001 — Pointers, not duplication
Date: 2026-05-30
The cross-harness playbook loads for every SU session regardless of cwd; `CLAUDE.md` loads only in the papercup repo (reaching Codex via `AGENTS.md`→`CLAUDE.md`). Papercup-repo conventions stay in `CLAUDE.md`; the playbook links them. Duplicating them is what drifted the personal `~/.claude/AGENTS.md` copy to the pre-Starlight fumadocs layout — not reintroduced.

### D-002 — Operator runtime topology: general (server-side) fact in CLAUDE.md, box-specifics in memory/insight
Date: 2026-05-30
Only the **:3070 Hono host** (server-side handlers + the `lib/**` they import) lacks hot-reload; the **:3055 Next layer hot-reloads**. CLAUDE.md gets the scoped general fact (server-side / :3070 changes need a restart — reload the Tauri shell, or on the standing systemd dev box `systemctl --user restart papercup-dev-api.service`). The specific command + the "probe where the write lands" tell live in the memory note + an `agent-insights/` MDX, scoped to the standing dev setup; the unit name is not a repo invariant (the unit files aren't in the repo).

### D-003 — Prompt inaccuracy fixes are engineer-playbook-only
Date: 2026-05-30
The power playbook has no role list / write-docs section / "Zero deltas" / "~96 tools", so the §1 corrections touch only the engineer base; the power playbook gets only the §2/§3 pointer-level changes.

### D-004 — Role list in the playbook: point at AGENT_ROLES, don't enumerate or hard-count
Date: 2026-05-30
The original "10 → 11 + tester" was wrong and inconsistent with P-005. `AGENT_ROLES` (role-config.ts) = 19 (no tester); `KNOWN_ROLES` (role.ts) = 18 (tester, no operator/oracle); only operator/oracle have `persona.md`. The playbook points at `AGENT_ROLES`, doesn't enumerate. The list inaccuracies themselves are a code bug (D-006 / P-017).

### D-005 — The no-harness docs:* error is intended; no scoping leaks in the catalog
Date: 2026-05-30
Per the user: harness-scoped endpoints require a selected harness, so `docs:*` returning `harness_not_registered` at operator scope is by design — not a bug. The fix is the prompt (P-008: drop the false "superuser gets framework docs via docs:*" claim, explain harness-scoping). A live endpoint-scoping audit confirmed there are **no per-harness tools that operate on the wrong/leaked harness**: every per-harness tool resolves the harness by a required slug, a guarded `arg→ctx→throw`, or caller-identity binding, with workspace-level RLS (`009-/010-workspace-scoping*.sql`) as the floor. Two non-leak notes: `issues:list` guidance/schema mismatch (P-019), and the intentional `plans:*` "default to the primary harness when no slug" fallback (D-004R) — a strictness choice, left as-is.

### D-006 — Role source of truth is AGENT_ROLES; KNOWN_ROLES should be derived, not hand-kept
Date: 2026-05-30
`AGENT_ROLES` (role-config.ts) is canonical by design (it shapes the `AgentRole` type, tool `roles:` allowlists, and `rolesQuota`; doc-comment: "single runtime source of truth"). `KNOWN_ROLES` (role.ts) is a local validation list for the `agent:role` prompt tool only and has drifted from both `AGENT_ROLES` and the on-disk `harness/prompts/<role>.md` set (accepts `tester` with no prompt; rejects `plan-gate`/`scanner`/`synthesizer` which have prompts). Fix (P-017): complete `AGENT_ROLES` (add `tester` + its prompt) and derive `KNOWN_ROLES` rather than hand-keep it — matching role-config.ts's own "no hand-kept second list to drift" principle.

## Open questions

- **Q-2** RESOLVED — the `~/.claude/AGENTS.md` fossil block was deleted (2026-05-30); P-018 makes the installer strip it idempotently so it can't recur.

## Rejected alternatives

- **Copy the testing/storage/run/flags conventions into the playbook.** Rejected (D-001) — duplicating `CLAUDE.md` is what drifted `~/.claude/AGENTS.md`.
- **Enumerate or hard-count the role list in the playbook.** Rejected (D-004) — the canonical lists diverge and churn; point at `AGENT_ROLES`.
- **Drop the `harness_shared.spawns` reference entirely.** Rejected (P-003) — the table exists as `spawned_agents`; correct the name.
- **Treat the no-harness `docs:*` error as a tool bug to fix.** Rejected (D-005) — it is intended harness-scoping; the fix is the prompt (P-008).
- **Pick `KNOWN_ROLES` as the role source of truth, or keep both as parallel hand-lists.** Rejected (D-006) — `AGENT_ROLES` is canonical; `KNOWN_ROLES` should be derived.
- **Put the `systemctl … papercup-dev-api.service` unit name in CLAUDE.md as a universal step, or claim "the operator has no file-watch" wholesale.** Rejected (D-002) — box-specific + imprecise (:3055 hot-reloads).
