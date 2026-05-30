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

**State:** Revised after a second peer review that re-verified every claim against the live codebase. The review corrected a real miss — the original P-001 ("roles 10 → 11, add tester") was wrong: `AGENT_ROLES` (`role-config.ts`, the runtime source of truth) has **19** roles and **no `tester`**, while `KNOWN_ROLES` (`role.ts`) has **18**, includes `tester`, and omits operator/oracle; and "each role has persona.md + tools.md" is false (only operator/oracle have `persona.md`). So P-001 now mirrors P-005 (drop the brittle count, point at the source) per D-004. P-008 (the `docs:*` operator-scope failure — reproduced live) is promoted to lead. The governing rule stays **pointers, not duplication** (D-001). Nothing is edited yet.

**Next:** human reviews/approves this revised plan; then an agent starts Phase 1 — P-008 (docs-bug investigation → fix) and P-001 (the wrong-fact role correction), which lead because they are the real defects, ahead of the cosmetic copy edits.

## Background

The prompt SU agents run under is assembled by `install-standalone-mcp.sh` from a base playbook (`papercusp-su-engineer.tools.md` for the engineer profile, `-power` for the workspace-scoped power user) plus a client overlay spliced at the `CLIENT-TOOLING-OVERLAY` marker. Two audits (the original, then a skeptical re-verification) cross-checked every factual claim against the live codebase; this plan reflects the corrected set.

Framing for scope:
- Repo root `AGENTS.md` is a symlink to `CLAUDE.md`, so claude-su AND codex-su working *inside papercup* already receive the repo conventions (testing, storage, nuqs, run-the-app, flags, context7). Several "missing" systems are therefore not missing for the in-repo case — they live in `CLAUDE.md`. The genuine gaps are (a) facts absent from `CLAUDE.md` too (operator runtime topology), and (b) a verification *mandate* with no *method*.
- Most inaccuracy fixes are **engineer-playbook-only** (D-003).

## Phase 1 — Highest-value defects (lead)

- **P-008** `todo` `docs:*` operator-scope failure — investigate + fix. At operator scope (no `harnessSlug`) `docs:outline`/`docs:search` return `harness_not_registered`, yet the tool's own description says it serves "the Papercusp framework engineering reference (papercusp-su callers only)" — i.e. exactly this caller. The engineer playbook leads with a `docs:*`-first workflow the SU engineer literally cannot use. Evidence favors the **bug** fork (D-005); confirm the root cause in the `docs:*` handler's scope resolution and fix it.
- **P-009** `todo` Correct the docs workflow per P-008's outcome: if the tool is fixed, leave the workflow; if it stays scoped, make the playbook lead with the reliable operator-level path (read `apps/operator-docs/src/content/docs/**.mdx` directly, or `curl :3070/llms-full.txt`) and mark `docs:*` harness-scoped. blocked-by: P-008
- **P-001** `todo` Role list — drop the brittle "**the 10** are …" count AND the false "Each has its own `persona.md` + `tools.md`" claim; point at `AGENT_ROLES` (`role-config.ts`) as the source of truth instead of enumerating (same treatment as P-005). Corrected facts (verified): `AGENT_ROLES` = 19, no `tester`; `KNOWN_ROLES` = 18, has `tester`, omits operator/oracle; only operator/oracle have `persona.md`; `*.tools.md` is a 9-file subset (has `tester`, lacks curator/documenter). See D-004. Engineer playbook §"Core nouns".

## Phase 2 — Other verified inaccuracy fixes (engineer base playbook)

- **P-002** `todo` Write-docs section: remove the retired `bin/prod`/`bin/dev` references and fix the docs port — `/internal/docs` is served by the Hono host on **`:3070`**, not `:3055` (verified: `apps/operator/bin/` has no dev/prod; `host-docs.ts`; CLAUDE.md L82). §"Write / update documentation".
- **P-003** `todo` Drop the `harness_shared.spawns` table name (be decisive — no `spawns` DDL exists in `libs/papercusp/libs/db/sql`; the v2 coord plan's audit G1 also couldn't confirm it). Describe runs/spawns without naming a table. §"Core nouns".
- **P-004** `todo` "audit rows + **Zero deltas**" → "audit rows + sync invalidation (SSE / `pg_notify`)" — Zero is legacy/retired. §"Where not to go".
- **P-005** `todo` Drop the hard "**~96**" count and fix the scope list, which omits core SU surfaces the doc itself later documents (`coord:* locks:* plans:*` plus `tasks:* flags:* backup:* design-phase:* roles:* cross_harness:*` …). Prefer "see `agent_tools:list`" over an enumerated count. §"What papercusp-su gives you".
- **P-006** `todo` (low-value) Clarify the one-line intro that the operator's API/MCP layer is **Hono** (`bin/hono-host.ts`, :3070), not "Next.js" — useful context for P-011. **Drop the "overmind" nit** (it is an illustrative process-control example, not a misstatement). §"What Papercusp is".
- **P-007** `todo` Scan `agent-policies.mdx` for the same stale facts (role count, ports, bin/*) and fix any in step. **Expected low-yield** — a grep already found none of them; keep as a cheap belt-and-suspenders pass.

## Phase 3 — Verification method + operator topology

- **P-010** `todo` Give the verification mandate a method: the engineer playbook's "Don't ship without verification" should name the mechanism (`npm run test:affected`, the four canonical test homes, `/admin/testing`) or hard-point to `/internal/docs/testing`; the power playbook should say "verify via the project's own test command / TESTING.md".
- **P-011** `todo` Document the operator runtime reality (the fact that bit the coord cutover): the operator process has **no file-watch**, so `apps/operator/lib/**` edits only go live after the operator is restarted. Per amended D-002, the **general** fact (restart the operator however it is supervised) is the part that touches CLAUDE.md, framed generally; the **box-specific** mechanism (`systemctl --user restart papercup-dev-api.service`) lives in a memory note + the agent-insight scoped "on the standing systemd dev box," NOT as a repo invariant. Engineer playbook gets a one-line pointer.

## Phase 4 — Missing-system pointers (not duplication)

- **P-012** `todo` Add a short engineer-playbook pointer: "Working on the Papercusp codebase? The repo `CLAUDE.md` is authoritative for run-the-app (Tauri desktop; never browse `:3055`/`:3070`; verdict for browser checks), testing, storage policy, feature-flag gating, nuqs, and context7 — read it." No copying of that content into the playbook (D-001).
- **P-013** `todo` Confirm the P-012 pointer covers feature-flags (`libs/flags`, `requireFlag`/`gateApiRoute`, `/admin/features`) and storage policy without playbook duplication; add a one-liner only if the pointer is insufficient. blocked-by: P-012

## Phase 5 — Verify + adjacent fixes

- **P-014** `todo` Re-render the playbook and verify. Note `render_playbook` renders in **three** places (the bash fn in `install-standalone-mcp.sh`, the Node port in `lib/desktop-install/`, and the agent-bundle route) — re-render/check across them. Run the real test: the Vitest **`apps/operator/lib/__tests__/tools-md-sync.test.ts`** (there is no `__tests__/integration/tools-md-sync.mjs`; `.mjs` integration scripts are also banned by CLAUDE.md). Confirm no backtick tool refs point at non-existent tools. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-009, P-010, P-011, P-012, P-013
- **P-015** `todo` Remove the stale `papercusp-su-*.tools.md.bak-*` backup files (2026-05-25) if confirmed dead.
- **P-016** `todo` Fix CLAUDE.md "Adding a tool" §5, which also cites the dead `apps/operator/__tests__/integration/tools-md-sync.mjs` — point it at the Vitest `apps/operator/lib/__tests__/tools-md-sync.test.ts` (surfaced by the review while verifying P-014).

## Decisions

### D-001 — Pointers, not duplication
Date: 2026-05-30
The cross-harness playbook is loaded for every SU session regardless of cwd; `CLAUDE.md` is loaded only when the cwd is the papercup repo (and reaches Codex via the `AGENTS.md`→`CLAUDE.md` symlink). Papercup-repo conventions (run-the-app, testing, storage, flags, nuqs, context7) stay in `CLAUDE.md`; the playbook only links to them. Duplicating repo conventions into the playbook is precisely what let the personal `~/.claude/AGENTS.md` copy drift to the pre-Starlight fumadocs/`content/internal-docs` layout — we will not reintroduce that failure mode.

### D-002 — Operator runtime topology: general fact in CLAUDE.md, box-specifics in memory/insight (amended)
Date: 2026-05-30
Amended after review: the box-specific systemd unit name (`papercup-dev-api.service`) is this dev machine's local supervision — the unit files are not in the repo, and CLAUDE.md's canonical run model is the Tauri desktop spawning the operator. So baking `systemctl --user restart papercup-dev-api.service` into repo-shared CLAUDE.md as a universal step would be wrong for a desktop-spawned operator. CLAUDE.md gets only the **general** invariant (the operator has no hot-reload; restart it to pick up `lib/**` edits — by reloading the Tauri shell, or on the standing systemd dev box `systemctl --user restart papercup-dev-api.service`). The specific command + the "probe where the write lands to confirm fresh code" tell live in the memory note + an `agent-insights/` MDX, scoped to the standing dev setup.

### D-003 — Inaccuracy fixes are engineer-playbook-only
Date: 2026-05-30
The power playbook has no role list, no write-docs/bin-* section, no "Zero deltas" phrasing, and no "~96 tools" claim, so the §1 corrections touch only the engineer base. The power playbook receives only the §2/§3 pointer-level changes (verify-via-project-TESTING.md; the CLAUDE.md pointer is engineer-only since power users work on other projects).

### D-004 — Role list: point at AGENT_ROLES, don't enumerate or hard-count
Date: 2026-05-30
The original "10 → 11 + tester" was wrong and internally inconsistent (it bumped-and-kept a role count while P-005 dropped the tool count). The two role lists diverge: `AGENT_ROLES` (`role-config.ts`, runtime source of truth) = 19 with no `tester`; `KNOWN_ROLES` (`role.ts`) = 18 with `tester` but no operator/oracle. The playbook must not enumerate or hard-count roles, nor claim every role has persona+tools files (only operator/oracle have `persona.md`). It points at `AGENT_ROLES`. The `AGENT_ROLES`/`KNOWN_ROLES` divergence is a separate code issue (Q-3), out of scope for the prompt fix.

### D-005 — P-008 (docs bug) is the lead item; evidence favors the bug fork
Date: 2026-05-30
`docs:*` is reproducibly broken for the operator-scope SU caller (`harness_not_registered`), yet the tool's own description says it serves the framework reference for "papercusp-su callers only" — exactly this caller. That contradiction points at a tool bug, not intended behavior, and it disables the playbook's primary docs workflow. It leads Phase 1 ahead of the cosmetic copy edits.

## Open questions

- **Q-1** Is the `docs:*` operator-scope error a bug or intended? Evidence now favors **bug** (the tool description scopes itself to papercusp-su callers). P-008 confirms the root cause; P-009 forks on it (repair the tool vs. document the fallback).
- **Q-2** Re-sync the user's personal `~/.claude/AGENTS.md` (embeds an older fumadocs-era copy of this playbook)? Out of repo scope — the user's personal file; flagged, not actioned here.
- **Q-3** `AGENT_ROLES` (19, no tester) and `KNOWN_ROLES` (18, tester, no operator/oracle) diverge — a real code inconsistency (two "source of truth" role lists that disagree). File separately; out of scope for this prompt-doc plan.

## Rejected alternatives

- **Copy the testing/storage/run/flags conventions into the playbook so all clients see them regardless of cwd.** Rejected (D-001) — duplicates `CLAUDE.md`; duplication is the documented cause of the `~/.claude/AGENTS.md` drift.
- **Enumerate or hard-count the role list in the playbook.** Rejected (D-004) — the two canonical lists diverge and the set churns; point at `AGENT_ROLES`.
- **Put the `systemctl … papercup-dev-api.service` unit name in CLAUDE.md as a universal step.** Rejected (D-002) — box-specific, not a repo invariant; CLAUDE.md gets only the general "restart the operator" fact.
- **Delete the `docs:*`-first workflow.** Rejected — `docs:*` is correct when harness-scoped; the fix is the tool bug (P-008) and operator-level fallback guidance (P-009), not removal.
