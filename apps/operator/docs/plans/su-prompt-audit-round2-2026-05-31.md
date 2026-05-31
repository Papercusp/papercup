---
title: SU prompt audit round 2 — accuracy fix + high-value system guidance
slug: su-prompt-audit-round2-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [su-prompt-audit-fixes-2026-05-30]
---

## Now

> **State:** Second audit of the SU playbooks (`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md`) complete. Lens 1 (inaccuracy) is nearly empty — the playbooks were heavily audited+fixed in `su-prompt-audit-fixes-2026-05-30` this same session, and a fresh verification pass confirmed tool names / paths / commands / ports / the harness-sentinel + `psu --role` + locking mechanisms are all accurate. The real opportunity is Lens 3: several agent-relevant systems EXIST but have zero (or catalog-only) guidance, so agents don't reach for them or misuse them. Plugin runtime check (`plugins:runtime_status`, 2026-05-31): **repomix** works (no key/binary); **fetch-plus** works; **firecrawl** is loaded but `FIRECRAWL_API_KEY` is not configured (tools return "not configured"); **gitnexus** is loaded but broken — its binary IS installed (`/home/linuxbrew/.linuxbrew/bin/gitnexus`) but isn't on the `:3070` host's PATH, so it `spawn ENOENT`s and its tools never wired. So two of the four currently point agents at non-working tools (env fixes, see D-002 / P-008).
>
> **Next:** Land P-001 (the `features:update` correction — clean + unblocking) first; then the design-phase guidance (P-002/P-003, the biggest gap), then delegates/autoloop/notifications (P-004–P-006). Decisions D-001 (design-phase depth) and D-002 (gitnexus broken — fix the host-PATH/env vs caveat the prompt; firecrawl similarly needs its key) want a quick human call before the affected items.

## Phase 1 — Accuracy fix (Lens 1)

- **P-001** `todo` Fix the nonexistent `features:update` reference. Engineer "Don't write raw SQL" bullet cites `features:update` as a documented verb — but `features:*` are all READ-only (`get`/`search`/`history`/`list_related`/`tag_vocabulary`); there is no SU verb that mutates `harness_features`. Reword: drop `features:update`, keep `messages:feature_send` (real), and state that feature *state* flows through the harness pipeline (validator/reviewer/etc.), not a direct SU write verb. Verify there's genuinely no feature-write tool before final wording.

## Phase 2 — High-value systems missing from the playbooks (Lens 3 + Lens 2)

- **P-002** `todo` Add real **`design-phase:*`** guidance to the engineer playbook (it's listed in the catalog at line ~96 with ZERO guidance). ~12 tools: `validate_spec`/`lint_spec`, DTCG `list_tokens`/`read_token`/`search_registry`/`get_registry_component`, `list_memos`/`read_memo`, `get_design_spec`/`get_accepted_spec`, `record_review`. The whole UI design-phase loop (spec → tokens → memo → review). Add when/notWhen/chaining: reach for it on any UI/design feature; check tokens+registry before hand-rolling UI; record reviewer verdicts here. blocked-by:P-001
- **P-003** `todo` Power playbook: add **`design-phase`** to the plugin list + a one-line note. Currently it lists repomix/gitnexus/firecrawl/fetch_plus as "plugins (if loaded)" but OMITS design-phase, which ships in the base install — implying it's unavailable to power users (designers/reviewers ARE power users of their harness). Fix the omission + give a one-liner.
- **P-004** `todo` Add **`delegates:*`** guidance (`delegates:list`, `delegates:inbox`). SU agents spawn long-running background sessions (via `operator:delegate`); `delegates:*` is how they enumerate what's running + retrieve completion messages. Without it they'd poll PG / SSH into processes. Add to engineer (+ power if relevant).
- **P-005** `todo` Add **`autoloop:*`** guidance (`autoloop:control`, `autoloop:status`). Pause/resume the operator's background harness-picking loop — a direct user command ("pause the loop"). Not in either playbook. Add to engineer.
- **P-006** `todo` Add **`notifications:recent`** guidance. Reads the app's own recent toast/error log — the primary surface for "why did the app just error?" debugging (complements `toastLog.recent` per memory). Add to the engineer "investigate a failure" workflow.
- **P-007** `todo` Add a brief **`processes:kill`** mention (unblock a wedged/runaway process by PID). Engineer only; one line in the unblock/where-not-to-go area.

## Phase 3 — Plugin accuracy + catalog hygiene

- **P-008** `todo` Reconcile the plugin references against verified runtime status (2026-05-31): **repomix** ✅ works (npm-wrapped, no key/binary) → keep; **fetch-plus** ✅ → keep; **firecrawl** ⚠️ loaded but `FIRECRAWL_API_KEY` is **not configured** (tools return "FIRECRAWL_API_KEY not configured") → keep the reference but note it needs the key (or gate the mention on the key being set); **gitnexus** ⚠️ broken via host-PATH gap (see D-002) → keep/caveat/remove per D-002. Prefer the `agent_tools:list` discovery pointer over enumerating the 21 loaded plugins; optionally surface a couple of genuinely-useful working ones (code2prompt, github-repo).
- **P-009** `todo` For the long tail (`projects:*`, `snapshots:*`, `omp:*`, `wiki:backlinks`, `plugins:*`, `pending_events:list`): do NOT enumerate each — strengthen the existing "discover the catalog via `agent_tools:list`" pointer so agents know the catalog is the source of truth. Explicitly do NOT add `hindsight:recall` (deprecated 2026-05-09, no writers).

## Phase 4 — Ship

- **P-010** `todo` Run `tools-md-sync` after the edits; commit; deploy via `install-standalone-mcp.sh` (engineer profile) to re-render the `~/.papercusp` playbooks. Prompts deploy via the installer re-render (no `:3070` restart needed for prompt-only changes). blocked-by:P-002,P-004,P-005,P-006

## Decisions

### D-001 — design-phase gets real per-tool guidance, not just a catalog entry

The single biggest "won't-use-as-intended" gap: `design-phase:*` (the entire UI design loop — IR spec validate/lint, DTCG token+component registry, design memos, reviewer verdicts) is listed in the engineer catalog with zero guidance and absent from the power playbook. An agent doing UI/design work has no signal to use it. Decision: add a proper when/notWhen/chaining block to the engineer playbook and list+one-line it in the power playbook (P-002/P-003). Open question for review: how deep — a short "this exists, here's when" block, or a fuller workflow (spec → validate → tokens → memo → review)?

Related: P-002, P-003

### D-002 — gitnexus is broken by a host-PATH gap (not a missing binary); decide fix-env vs caveat-the-prompt

`plugins:runtime_status` shows `@papercupai/gitnexus-bridge` loaded but its tools failed to wire (`getDynamicTools failed: spawn gitnexus ENOENT`). Corrected diagnosis (2026-05-31): the binary **is** installed — `which gitnexus` → `/home/linuxbrew/.linuxbrew/bin/gitnexus` — but the `:3070` operator process's PATH doesn't include linuxbrew, so the spawn fails. It's an **env fix, not an install**: put linuxbrew on the operator host's PATH (or absolute-path the spawn in the bridge), AND run `npx gitnexus analyze <repo>` once per repo (indexes to `<repo>/.gitnexus/`) before queries work. Decision needed (human): (a) fix the host PATH + run analyze so the code-graph tools work, then keep the reference; or (b) caveat/remove the gitnexus mention until it's fixed. Infra/env question, not prompt wording. P-008 follows the decision.

Related: P-008

### D-003 — catalog is the discovery surface; don't bloat the playbooks

~21 plugins + dozens of tool groups are loaded; enumerating them all in the playbooks would bloat + stale-rot. Decision: name only the HIGH-value systems agents would otherwise miss or misuse (design-phase, delegates, autoloop, notifications:recent, processes:kill), and lean on a strong `agent_tools:list` pointer for the rest. Exclude deprecated tools (hindsight:recall).

Related: P-009
