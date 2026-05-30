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

**State:** Phases 1–5 + the small/moderate Phase 6 items are DONE & committed: P-001–P-013, P-015–P-019 (P-009 dropped). Commits this arc: bf93efa9 (engineer playbook), bcb6e969 (CLAUDE.md), 586d462b (verification/pointer/insight + .bak), 9dbb30cc (issues:list + installer strip), 1a9fdde6 (role registry). tools-md-sync 42/42 throughout; role.ts/issues.ts tsc-clean for changed files. P-014 is verification-green; its deploy tails remain (re-run install-standalone-mcp.sh to push the updated playbook into ~/.papercusp; `cd apps/operator-docs && npm run build` to regenerate the docs mirror for the new agent-insight). Only the TWO big framework/launch features remain: P-020 (declarative `harness:` scope dimension on `defineTool` + uniform "harness required" error — touches the framework ~250 tools share) and P-021/P-022 (the `bootstrap-su` launch-context composer: scope + bound-plan addenda via the `*-su` wrappers).

**Next:** Tackle P-020 + P-021/P-022 as a dedicated, separately-tested pass (framework + launch-path code — design, tests, verify); run the P-014 deploy steps (installer re-render + astro docs build) when ready to ship the prompt fixes live.

## Background

The SU prompt is assembled by `install-standalone-mcp.sh` from a base playbook (`papercusp-su-engineer.tools.md`, `-power`) + a client overlay. Three reviews + a live endpoint audit cross-checked every claim against the codebase; this is the corrected set. Repo root `AGENTS.md → CLAUDE.md` symlink, so claude-su/codex-su working in papercup already get the repo conventions — so several "missing" systems live in `CLAUDE.md` and the playbook only links them (D-001). Most prompt fixes are engineer-playbook-only (D-003).

## Phase 1 — Highest-value prompt corrections (lead)

- **P-008** `done` Rewrite the playbook's **"Working context" no-harness guidance** to be accurate and comprehensive across the WHOLE harness-scoped surface — not just `docs:*`. The current bullet is wrong on two counts (Q-1, D-005): "no harness scope → the same tools fall through to workspace-wide views" (they mostly don't), and "superuser callers also get Papercusp's own engineering docs via `docs:*`" (errors at operator scope). Replace with: (a) **workspace-global** tools work fine with no harness (`harness:list`, `search:*`, `memory:*`, `coord:*`, `locks:*`, `audit:*`, `goals:*`, `snapshots:*`, `operator:*`, `flags:*`); (b) **harness-scoped** tools need a harness — most **require the slug and error without it** (`features:* issues:* agent_chats:* experts:* intel:* architect:chat harness:get/status/health/escalation/list_features/pending_reviews`), `docs:*` errors at operator scope (`harness_not_registered`), and `plans:*` falls back to the primary harness; (c) to work on a harness: `harness:list` → pass its slug (or set the scope), or `cross_harness:*` for cross-harness reads; (d) the Papercusp **framework** engineering docs at operator scope come from the filesystem (`apps/operator-docs/src/content/docs/**.mdx`) or `curl :3070/llms-full.txt`, not `docs:*`. (Supersedes the docs-only framing + P-009.) (Interim fix applied: replaced the false "fall through to workspace-wide views" + "superuser gets framework docs via docs:*" with accurate no-harness guidance require-slug / docs errors / plans→primary; harness:list + cross_harness; framework docs via filesystem. P-021/P-022 will later move the per-mode specifics to launch-time addenda.)
- **P-001** `done` Role list — drop the brittle "**the 10** are …" count AND the false "Each has its own `persona.md` + `tools.md`" claim; point at `AGENT_ROLES` (`role-config.ts`) as the source of truth (same treatment as P-005). Verified: `AGENT_ROLES` = 19, no `tester`; `KNOWN_ROLES` = 18, has `tester`, omits operator/oracle; only operator/oracle have `persona.md`. See D-004/D-006. §"Core nouns".
- **P-009** `dropped` Merged into P-008 — the docs behavior is intended, so there is no tool-fix fork; the change is purely the prompt correction. See D-005.

## Phase 2 — Other verified inaccuracy fixes (engineer base playbook)

- **P-002** `done` Remove retired `bin/prod`/`bin/dev` refs; fix the docs port to **`:3070`** (Hono host serves `/internal/docs`), not `:3055`. §"Write / update documentation".
- **P-003** `done` Correct "Tracked in `harness_shared.spawns`" → **`harness_shared.spawned_agents`** (`049-spawned-agents.sql`; spawn-tree views `048-intel-views.sql`). The "no DDL exists" rationale was itself wrong (a `\bspawns\b` grep missed it; also why v2-coord G1 "couldn't confirm spawns"). §"Core nouns".
- **P-004** `done` "audit rows + **Zero deltas**" → "audit rows + sync invalidation (SSE / `pg_notify`)". §"Where not to go".
- **P-005** `done` Drop the hard "**~96**" count; fix the scope list (omits `coord:* locks:* plans:*` + `tasks:* flags:* backup:* design-phase:* roles:* cross_harness:*` …). Prefer "see `agent_tools:list`". §"What papercusp-su gives you".
- **P-006** `done` (low-value) Clarify the API/MCP layer is **Hono** (`bin/hono-host.ts`, :3070), not "Next.js". Drop the "overmind" nit. §"What Papercusp is".
- **P-007** `done` Scan `agent-policies.mdx` for the same stale facts (role count, ports, bin/*). **Expected low-yield** (a grep found none). (Scanned agent-policies.mdx for the role count / :3055 / bin/prod|dev / ~96 / Zero-delta / overmind / spawns / per-role-persona claims — none present. Low-yield as predicted; no edit needed.)

## Phase 3 — Verification method + operator topology

- **P-010** `done` Give the verification mandate a method by **linking** (not re-specifying, per D-001): point at CLAUDE.md's four canonical test homes + `npm run test:affected` / `/internal/docs/testing`; power playbook → "verify via the project's own test command / TESTING.md".
- **P-011** `done` Document the operator runtime reality, scoped precisely (D-002): only the **:3070 Hono host** (server-side handlers + the `lib/**` they import) lacks hot-reload — restart to pick up changes; the **:3055 Next layer hot-reloads**. CLAUDE.md gets the general server-side-restart invariant; the box-specific `systemctl --user restart papercup-dev-api.service` + the "probe where the write lands" tell go in a memory note + an `agent-insights/` MDX scoped to the standing dev box. Engineer playbook → one-line pointer. (CLAUDE.md general server-side-restart fact ✓, memory note ✓, engineer-playbook pointer ✓, agent-insight MDX operator-3070-host-no-hot-reload ✓ source. Docs-mirror public/internal/docs regenerates on the next astro build — not rebuilt this commit.)

## Phase 4 — Missing-system pointers (not duplication)

- **P-012** `done` Engineer-playbook pointer: "Working on the Papercusp codebase? The repo `CLAUDE.md` is authoritative for run-the-app (Tauri desktop; never browse `:3055`/`:3070`; verdict for browser checks), testing, storage policy, feature-flag gating, nuqs, and context7 — read it." No copying (D-001).
- **P-013** `done` Confirm P-012's pointer covers feature-flags + storage policy without duplication; add a one-liner only if insufficient. blocked-by: P-012 (Satisfied by P-012's pointer — it names feature-flag gating + storage policy as CLAUDE.md-authoritative; no playbook duplication needed.)

## Phase 5 — Verify + adjacent fixes

- **P-014** `todo` Re-render the playbook (bash `render_playbook` + the shared TS helper `lib/desktop-install/splice-tooling-overlay.ts`, consumers `papercusp-files.ts`/`agent-bundle.ts` — don't re-DRY); run the Vitest **`apps/operator/lib/__tests__/tools-md-sync.test.ts`** (no `__tests__/integration/tools-md-sync.mjs`); confirm no backtick tool refs point at non-existent tools. Rebase all edit items on current prompt content (last edited today by `1241865a`). blocked-by: P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-010, P-011, P-012, P-013
- **P-015** `done` Remove the stale `papercusp-su-*.tools.md.bak-*` backup files if confirmed dead.
- **P-016** `done` Fix CLAUDE.md "Adding a tool" §5 (≈L448), which cites the dead `__tests__/integration/tools-md-sync.mjs` → point at the Vitest test.

## Phase 6 — Code fixes surfaced by the audit (separable PRs)

- **P-017** `done` Role registry (Q-3, D-006). `AGENT_ROLES` (role-config.ts) is the canonical source of truth, but: (i) **add `tester`** to it (+ create `libs/papercusp/packages/harness/prompts/tester.md`) to finish the tester promotion — `tester` has `tester.tools.md` and is in `KNOWN_ROLES` but is absent from `AGENT_ROLES` and has no role prompt; (ii) **derive `KNOWN_ROLES`** (role.ts) instead of hand-keeping it — it currently accepts `tester` (no `.md` → `agent:role` throws) and rejects `plan-gate`/`scanner`/`synthesizer` (which DO have `.md`). Derive from `AGENT_ROLES` ∩ on-disk `<role>.md`, or drop the pre-validation and let the existing file-read be the check. Code change; own PR ok. (Derived KNOWN_ROLES away: role.ts validates id-shape + lets the on-disk <role>.md read be the existence check agent:role now works for plan-gate/scanner/synthesizer. role.ts tsc-clean. DEFERRED: add tester to AGENT_ROLES + author tester.md — owned by the tester-promotion plan Q-3, not authored blind.)
- **P-018** `done` (Q-2) Add an installer cleanup step to `install-standalone-mcp.sh` that strips a legacy `<!-- BEGIN papercusp-su playbook … -->` managed block from `~/.claude/AGENTS.md` (mirroring the `~/.omp/agent/CLAUDE.md` strip at step 4a), so the fossil can't recur. The current block was deleted manually 2026-05-30.
- **P-019** `done` (endpoint audit) `issues:list` guidance/schema mismatch: `guidance.when` says "pass a slug to scope" but the args schema has no slug and the handler stubs `[]`. Not a scoping leak — a guidance-accuracy fix (same class as this plan): either finish cross-harness consolidation or align the guidance to the stub.
- **P-020** `todo` (systemic — the clean form of "change the MCP spec for no-harness agents") Add a declarative `harness: 'required'|'optional'|'none'` dimension to `defineTool` (today scoping is ad-hoc per-handler; `tool-projection.ts` already carries `ctx.harnessSlug`). A `harness:'required'` call with no slug + no ctx returns a UNIFORM "harness required — pass a slug or run harness:list" error (replacing the error/require-slug/plans→primary/stub grab-bag). Do NOT blanket-hide harness-scoped tools — most take an explicit slug and an SU session may be operator-scope (so it works on any harness by passing the slug); only ctx-only (no-slug) tools are candidates to hide. Lets P-008's prose shrink. Code; own PR; subsumes the uniform-error idea.
- **P-021** `todo` Inject **scope-tailored** harness guidance at the `psu`/`bootstrap-su` launch step (it already picks + knows `harnessSlug`; `bootstrap-su` builds the envelope with `slug: harnessSlug`). Harness launch → "scoped to <slug>; `docs:*`/`features:*`/`plans:*` serve it." No-harness launch → "operator scope; harness-scoped tools need a slug — `harness:list` then pass it (or `cross_harness:*`); framework docs from the filesystem." Mechanism: `bootstrap-su` returns the scope variant (a promptAddendum / appendFile) and the `*-su` wrapper `--append-system-prompt`s it over the base playbook (which then keeps only mode-agnostic orientation). Complements P-020 (server-side uniform "harness required"); see D-008. Code; own PR.
- **P-022** `todo` Extend the launch-context addendum (P-021's mechanism) to the rest of what `psu` knows: (i) **plan-bound launch** — inject the bound plan's `## Now` (state + next) + slug + "keep it current via `plans:set-now`/`plans:set-status`", so the agent starts on the cold-resume anchor instead of discovering it (`bootstrap-su` already has `planSlug` → `plans:get` its Now). Today the plan is recorded in `adv_sessions` but never surfaced to the agent — the single highest-value missing injection. (ii) **`--resume`** — inject the resumed session's last `coord:handoff`/successor-brief + plan Now, for continuity. Low-value/optional: a no-plan launch nudge ("ad-hoc — `plans:new` if this grows") and a workspace pointer (mostly redundant; cwd already loads the repo `CLAUDE.md`). Code; rides P-021's `bootstrap-su`→addendum→wrapper path.

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

### D-005 — The no-harness behavior is intended; no scoping leaks; the playbook's whole no-harness bullet is wrong
Date: 2026-05-30
Per the user: harness-scoped endpoints require a selected harness, so `docs:*` returning `harness_not_registered` at operator scope is by design — not a bug. But the playbook's "Working context" no-harness bullet is inaccurate beyond the docs clause: it claims "the same tools fall through to workspace-wide views," whereas most harness-scoped tools **require the slug and error without it** (only some are workspace-global, `plans:*` falls back to the primary harness, `docs:*` errors). P-008 therefore rewrites the whole bullet, comprehensively, not just the docs line. A live endpoint-scoping audit separately confirmed **no per-harness tool operates on the wrong/leaked harness** — every one resolves the harness by a required slug, a guarded `arg→ctx→throw`, or caller-identity binding, with workspace RLS (`009-/010-workspace-scoping*.sql`) as the floor. Two non-leak notes: `issues:list` guidance/schema mismatch (P-019), and the intentional `plans:*` primary-harness fallback (D-004R), left as-is.

### D-006 — Role source of truth is AGENT_ROLES; KNOWN_ROLES should be derived, not hand-kept
Date: 2026-05-30
`AGENT_ROLES` (role-config.ts) is canonical by design (it shapes the `AgentRole` type, tool `roles:` allowlists, and `rolesQuota`; doc-comment: "single runtime source of truth"). `KNOWN_ROLES` (role.ts) is a local validation list for the `agent:role` prompt tool only and has drifted from both `AGENT_ROLES` and the on-disk `harness/prompts/<role>.md` set (accepts `tester` with no prompt; rejects `plan-gate`/`scanner`/`synthesizer` which have prompts). Fix (P-017): complete `AGENT_ROLES` (add `tester` + its prompt) and derive `KNOWN_ROLES` rather than hand-keep it — matching role-config.ts's own "no hand-kept second list to drift" principle.


### D-007 — Clean no-harness fix is a declarative harness-scope dimension + uniform error, not prose or blanket-hiding
Date: 2026-05-30
The user's instinct (let the system, not the prompt, prevent no-harness misuse) is right, shaped by two facts. (1) There is NO harness-scope dimension on `defineTool` today — gating is by principal/role/capability/auth, not harness — so "change the MCP spec for no-harness agents" needs a new primitive (P-020), not a config flip. (2) Blanket-hiding harness-scoped tools from no-harness sessions is WRONG: most take an explicit slug, and the SU engineer is always operator-scope (it works on any harness by passing the slug per call), so hiding them would remove that ability. The clean fix (P-020): declare `harness: required|optional|none`; for required-without-slug return a uniform "harness required — pass a slug / run harness:list" error (self-documenting); hide or grow-a-slug-arg only for the rare ctx-only (no-slug) tools. A per-launch-mode FORKED prompt is also rejected: the static `--append` playbook is identical regardless of runtime scope, and the SU engineer has no session harness anyway. P-008 stays as the immediate accurate-guidance fix; once P-020 lands the prose shrinks to "tools tell you when they need a slug."
Related: P-008, P-020


### D-008 — Scope is psu-selected → compose the scope-tailored prompt at the launch step (corrects "always operator-scope")
Date: 2026-05-30
Corrects D-005/D-007's "the SU engineer is always operator-scope" — that's wrong. `psu` explicitly picks workspace → harness (or "workspace root — no harness") → plan, and `bootstrap-su` builds the session envelope with `slug: harnessSlug` (`buildConsoleEnvelope`). So a harness launch IS harness-scoped (`docs:*`/`features:*` auto-serve it) and a no-harness launch is operator-scope; the scope is chosen at the launch step, not fixed. Because the launcher knows the scope, the scope-appropriate prompt should be COMPOSED THERE (P-021): `bootstrap-su` returns the harness-scoped vs operator-scope addendum and the `*-su` wrapper `--append-system-prompt`s it — each session gets exactly its mode's guidance instead of one static block covering both in prose. This makes a per-mode prompt natural (contra D-005's dismissal of a "forked prompt"): the lever is the launch composer (`psu`/`bootstrap-su`/wrappers), not the install-time static file. P-008 is therefore reduced to the interim fix — delete the two outright-false claims from the static playbook ("fall through to workspace-wide views"; "superuser gets framework docs via `docs:*`") and keep only mode-agnostic orientation; P-021 is the real fix; P-020 (server-side uniform "harness required") is the complementary server half.
Related: P-008, P-020, P-021

## Open questions

- **Q-2** RESOLVED — the `~/.claude/AGENTS.md` fossil block was deleted (2026-05-30); P-018 makes the installer strip it idempotently so it can't recur.

## Rejected alternatives

- **Copy the testing/storage/run/flags conventions into the playbook.** Rejected (D-001) — duplicating `CLAUDE.md` is what drifted `~/.claude/AGENTS.md`.
- **Enumerate or hard-count the role list in the playbook.** Rejected (D-004) — the canonical lists diverge and churn; point at `AGENT_ROLES`.
- **Drop the `harness_shared.spawns` reference entirely.** Rejected (P-003) — the table exists as `spawned_agents`; correct the name.
- **Treat the no-harness `docs:*` error as a tool bug to fix.** Rejected (D-005) — it is intended harness-scoping; the fix is the prompt (P-008).
- **Fix only the docs clause of the no-harness guidance.** Rejected (D-005) — the whole "fall through to workspace-wide views" bullet is inaccurate for the harness-scoped surface; P-008 rewrites all of it.
- **Pick `KNOWN_ROLES` as the role source of truth, or keep both as parallel hand-lists.** Rejected (D-006) — `AGENT_ROLES` is canonical; `KNOWN_ROLES` should be derived.
- **Put the `systemctl … papercup-dev-api.service` unit name in CLAUDE.md as a universal step, or claim "the operator has no file-watch" wholesale.** Rejected (D-002) — box-specific + imprecise (:3055 hot-reloads).
