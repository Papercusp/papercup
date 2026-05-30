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

**State:** Drafted from an audit of the SU agent prompts (`apps/operator/prompts/papercusp-su-engineer.tools.md`, `papercusp-su-power.tools.md`, and the `.claude`/`.codex`/`.omp` overlays). The overlays are current; the bases carry 6 verified-stale facts, 3 "agents are pointed at a tool/step that doesn't work for them" gaps, and several missing-system pointers. The governing design rule is **pointers, not duplication** (D-001): papercup-repo conventions stay in `CLAUDE.md` and the cross-harness playbook only links them — duplicating them is exactly what drifted the personal `~/.claude/AGENTS.md` copy into the pre-Starlight fumadocs layout. Nothing is edited yet.

**Next:** human reviews/approves this plan; then an agent starts Phase 1 (the safe, verified-inaccuracy fixes in the engineer playbook).

## Background

The prompt SU agents run under is assembled by `install-standalone-mcp.sh` from a base playbook (`papercusp-su-engineer.tools.md` for the engineer profile, `-power` for the workspace-scoped power user) plus a client overlay spliced at the `CLIENT-TOOLING-OVERLAY` marker. The audit (session 2026-05-30, alongside the coord FS→PG port) cross-checked every factual claim against the live codebase.

Key framing for scope:
- The repo root `AGENTS.md` is a symlink to `CLAUDE.md`, so claude-su AND codex-su working *inside papercup* already receive the repo conventions (testing, storage, nuqs, run-the-app, flags, context7). So several "missing" systems are not missing for the in-repo case — they live in `CLAUDE.md`. The genuine gaps are (a) facts absent from `CLAUDE.md` too (operator runtime topology), and (b) the playbook giving a verification *mandate* with no *method*.
- Most §1 inaccuracies are **engineer-playbook-only** (D-003): the power playbook has no role list, no bin/* docs section, no "Zero deltas", no "~96 tools" claim.

## Phase 1 — Verified inaccuracy fixes (engineer base playbook)

- **P-001** `todo` Role list "**the 10** are: operator … curator" → **11**, add `tester` (verified: `AGENT_ROLES` in `role-config.ts` + `KNOWN_ROLES` in `role.ts`). Engineer playbook §"Core nouns".
- **P-002** `todo` Write-docs section: remove the retired `bin/prod`/`bin/dev` references and fix the docs port — `/internal/docs` is served on **`:3070`**, not `:3055` (verified: `apps/operator/bin/` has no dev/prod; CLAUDE.md L82). Engineer playbook §"Write / update documentation".
- **P-003** `todo` "Run / spawn … Tracked in `harness_shared.spawns`" — verify the real table and correct it, or drop the specific table name (verified: no `spawns` DDL in `libs/papercusp/libs/db/sql`; the v2 coord plan's audit G1 already flagged it unconfirmed). Engineer playbook §"Core nouns".
- **P-004** `todo` "they emit audit rows + **Zero deltas**" → "audit rows + sync invalidation (SSE / `pg_notify`)" — Zero is legacy/retired. Engineer playbook §"Where not to go".
- **P-005** `todo` Refresh the tool inventory: drop/soften the hard "**~96**" count and fix the scope list, which omits the core SU surfaces the doc itself later documents (`coord:*`, `locks:*`, `plans:*`, plus `tasks:* flags:* backup:* design-phase:* roles:* cross_harness:*` …). Prefer "see `agent_tools:list`" over an enumerated count. Engineer playbook §"What papercusp-su gives you".
- **P-006** `todo` Minor accuracy: "Next.js operator" → "Hono sidecar (`bin/hono-host.ts`, :3070) + Next (:3055 content) + Vite"; the "overmind stack" process-control example → systemd/process-manager-agnostic (papercup uses `systemd --user`, not overmind). Engineer playbook §"What Papercusp is" + §"does not give you".
- **P-007** `todo` Scan `apps/operator-docs/src/content/docs/agent-policies.mdx` (the binding doc the playbook points to) for the same stale facts (role count, ports, bin/*) and fix any in step.

## Phase 2 — Use the systems as intended

- **P-008** `todo` Investigate the `docs:*` operator-scope failure: at operator level (no `harnessSlug`) `docs:outline`/`docs:search` return `harness_not_registered`, yet the playbook claims superuser callers get engineering docs via `docs:*`. Determine whether this is a tool bug (the `?superuser=1` engineering-docs path is broken) or intended. Record the finding.
- **P-009** `todo` Based on P-008, correct the docs workflow: if a tool bug, fix it; if intended, make the playbook lead with the reliable operator-level path (read `apps/operator-docs/src/content/docs/**.mdx` directly, or `curl :3070/llms-full.txt`) and mark `docs:*` as harness-scoped. blocked-by: P-008
- **P-010** `todo` Give the verification mandate a method: the engineer playbook's "Don't ship without verification" should name the mechanism (`npm run test:affected`, the four canonical test homes, `/admin/testing`) or hard-point to `/internal/docs/testing`; the power playbook should say "verify via the project's own test command / TESTING.md".
- **P-011** `todo` Document the operator runtime topology + restart (the fact that bit the coord cutover): `:3070` is the `papercup-dev-api.service` systemd --user unit running `tsx bin/hono-host.ts` with **no file-watch**, so `apps/operator/lib/**` edits only go live after `systemctl --user restart papercup-dev-api.service`. Per D-002 this lands in CLAUDE.md + an agent-insight, with a one-line pointer in the engineer playbook.

## Phase 3 — Missing-system pointers (not duplication)

- **P-012** `todo` Add a short engineer-playbook pointer: "Working on the Papercusp codebase? The repo `CLAUDE.md` is authoritative for run-the-app (Tauri desktop; never browse `:3055`/`:3070`; verdict for browser checks), testing, storage policy (PG-by-default + migrations dir), feature-flag gating, nuqs, and context7 — read it." No copying of that content into the playbook (D-001).
- **P-013** `todo` Confirm the P-012 pointer covers the feature-flag system (`libs/flags`, `requireFlag`/`gateApiRoute`, `/admin/features`) and storage policy so they are discoverable to SU agents without playbook duplication; add a one-liner only if the pointer is insufficient. blocked-by: P-012

## Phase 4 — Verify

- **P-014** `todo` Re-render the playbook (`render_playbook` / re-run `install-standalone-mcp.sh`) and run `node apps/operator/__tests__/integration/tools-md-sync.mjs` green; confirm no backtick tool refs in the prompts point at non-existent tools. blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-009, P-010, P-011, P-012, P-013
- **P-015** `todo` Remove the stale `papercusp-su-*.tools.md.bak-*` backup files (2026-05-25) if confirmed dead.

## Decisions

### D-001 — Pointers, not duplication
Date: 2026-05-30
The cross-harness playbook is loaded for every SU session regardless of cwd; `CLAUDE.md` is loaded only when the cwd is the papercup repo (and reaches Codex via the `AGENTS.md`→`CLAUDE.md` symlink). Papercup-repo conventions (run-the-app, testing, storage, flags, nuqs, context7) therefore stay in `CLAUDE.md`; the playbook only links to them. Duplicating repo conventions into the playbook is precisely what let the personal `~/.claude/AGENTS.md` copy drift to the pre-Starlight fumadocs/`content/internal-docs` layout — we will not reintroduce that failure mode.

### D-002 — Operator runtime topology lives in CLAUDE.md + an insight
Date: 2026-05-30
The "`:3070` hono-host has no hot-reload; `systemctl --user restart papercup-dev-api.service` to make `lib/**` edits live" fact is genuinely undocumented (not in the playbook or CLAUDE.md). It is papercup-repo-specific, so it goes in CLAUDE.md and an `agent-insights/` MDX (with the "probe where the write lands to confirm fresh code" tell), and the engineer playbook gets only a one-line pointer (D-001).

### D-003 — §1 fixes are engineer-playbook-only
Date: 2026-05-30
The power playbook (`papercusp-su-power.tools.md`) has no "the 10 roles" list, no write-docs/bin-* section, no "Zero deltas" phrasing, and no "~96 tools" claim, so the §1 corrections touch only the engineer base. The power playbook receives only the §2/§3 pointer-level changes (verification-via-project-TESTING.md, the CLAUDE.md pointer is engineer-only since power users work on other projects).

## Open questions

- **Q-1** Is superuser `docs:*` at operator level (returns `harness_not_registered`) a tool bug or intended behavior? P-008 decides; the fix in P-009 forks on the answer (repair the tool vs. document the `.mdx`/`llms-full.txt` fallback).
- **Q-2** Re-sync the user's personal `~/.claude/AGENTS.md`? It embeds an older fumadocs-era copy of this playbook. Out of repo scope (it is the user's personal file), so it needs the user — flagged, not actioned by this plan.

## Rejected alternatives

- **Copy the testing/storage/run/flags conventions into the playbook so all clients see them regardless of cwd.** Rejected (D-001) — it duplicates `CLAUDE.md`, and duplication is the documented cause of the `~/.claude/AGENTS.md` drift. Pointers keep one source of truth.
- **Delete the `docs:*`-first workflow.** Rejected — `docs:*` is correct when harness-scoped; the fix is operator-level fallback guidance (P-009), not removal.
