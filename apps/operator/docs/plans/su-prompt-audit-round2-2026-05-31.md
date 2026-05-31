---
title: SU prompt audit round 2 — accuracy fix + high-value system guidance
slug: su-prompt-audit-round2-2026-05-31
status: shipped
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
related: [su-prompt-audit-fixes-2026-05-30]
---

## Now

**State:** SHIPPED. All round-2 items (P-001–P-010) were folded into the two from-scratch SU-playbook rewrites done later in the same session — engineer `56b7e994b` (commit msg: "fold in round-2 audit") and power `0967b6e28`. Verified 2026-05-31 against the current source playbooks: `features:update` removed (P-001); `design-phase:*` present in engineer + listed in power (P-002/P-003); `delegates:*`+`autoloop:*` in engineer (P-004/P-005); `notifications:recent`+`processes:kill` in both (P-006/P-007); plugin status reconciled — repomix/fetch-plus work, firecrawl needs `FIRECRAWL_API_KEY`, gitnexus caveated as down (P-008); `agent_tools:list` pointer present, no `hindsight:recall` (P-009). `tools-md-sync` green (42/42). DEPLOY MODEL (verified in code, P-010): there is no separate deploy step — `psu` → `bootstrap-su` → `buildLaunchSpec` → `renderSuPlaybook` reads `prompts/papercusp-su-<profile>.tools.md` fresh from disk on EVERY launch (`fs.readFile`, per-launch `--profile` flag), so committing the source IS the deploy for both engineer and power, with no `install-standalone-mcp.sh` re-render and no `:3070` restart. The `~/.papercusp/*-collaborator*.md` static files are vestigial (retired `*-su`-wrapper era + manual fallback), not read on a psu launch. Only genuinely-open residual is the gitnexus host-PATH env fix (D-002 chose the prompt-caveat path; the actual fix is optional infra) + the firecrawl key.

**Next:** Optional infra only (human call): gitnexus :3070-PATH env fix + firecrawl `FIRECRAWL_API_KEY` vs leaving both honestly caveated in the prompt. No prompt-content or deploy work remains — playbooks are live as of their commits.

## Phase 1 — Accuracy fix (Lens 1)

- **P-001** `done` Fix the nonexistent `features:update` reference. Engineer "Don't write raw SQL" bullet cites `features:update` as a documented verb — but `features:*` are all READ-only (`get`/`search`/`history`/`list_related`/`tag_vocabulary`); there is no SU verb that mutates `harness_features`. Reword: drop `features:update`, keep `messages:feature_send` (real), and state that feature *state* flows through the harness pipeline (validator/reviewer/etc.), not a direct SU write verb. Verify there's genuinely no feature-write tool before final wording. (folded into the from-scratch engineer rewrite 56b7e994b; verified `features:update` removed, `messages:feature_send` + read-only-features framing present)

## Phase 2 — High-value systems missing from the playbooks (Lens 3 + Lens 2)

- **P-002** `done` Add real **`design-phase:*`** guidance to the engineer playbook (it's listed in the catalog at line ~96 with ZERO guidance). ~12 tools: `validate_spec`/`lint_spec`, DTCG `list_tokens`/`read_token`/`search_registry`/`get_registry_component`, `list_memos`/`read_memo`, `get_design_spec`/`get_accepted_spec`, `record_review`. The whole UI design-phase loop (spec → tokens → memo → review). Add when/notWhen/chaining: reach for it on any UI/design feature; check tokens+registry before hand-rolling UI; record reviewer verdicts here. blocked-by:P-001 (design-phase:* guidance present in engineer rewrite verified: 2 refs)
- **P-003** `done` Power playbook: add **`design-phase`** to the plugin list + a one-line note. Currently it lists repomix/gitnexus/firecrawl/fetch_plus as "plugins (if loaded)" but OMITS design-phase, which ships in the base install — implying it's unavailable to power users (designers/reviewers ARE power users of their harness). Fix the omission + give a one-liner. (power playbook lists design-phase + one-liner verified: 2 refs in power rewrite 0967b6e28)
- **P-004** `done` Add **`delegates:*`** guidance (`delegates:list`, `delegates:inbox`). SU agents spawn long-running background sessions (via `operator:delegate`); `delegates:*` is how they enumerate what's running + retrieve completion messages. Without it they'd poll PG / SSH into processes. Add to engineer (+ power if relevant). (delegates:list/inbox guidance present in engineer rewrite power omits by design — leaner subset)
- **P-005** `done` Add **`autoloop:*`** guidance (`autoloop:control`, `autoloop:status`). Pause/resume the operator's background harness-picking loop — a direct user command ("pause the loop"). Not in either playbook. Add to engineer. (autoloop:control/status guidance present in engineer rewrite)
- **P-006** `done` Add **`notifications:recent`** guidance. Reads the app's own recent toast/error log — the primary surface for "why did the app just error?" debugging (complements `toastLog.recent` per memory). Add to the engineer "investigate a failure" workflow. (notifications:recent guidance present in both playbooks verified: 2 refs each)
- **P-007** `done` Add a brief **`processes:kill`** mention (unblock a wedged/runaway process by PID). Engineer only; one line in the unblock/where-not-to-go area. (processes:kill mentioned in both playbooks verified)

## Phase 3 — Plugin accuracy + catalog hygiene

- **P-008** `done` Reconcile the plugin references against verified runtime status (2026-05-31): **repomix** ✅ works (npm-wrapped, no key/binary) → keep; **fetch-plus** ✅ → keep; **firecrawl** ⚠️ loaded but `FIRECRAWL_API_KEY` is **not configured** (tools return "FIRECRAWL_API_KEY not configured") → keep the reference but note it needs the key (or gate the mention on the key being set); **gitnexus** ⚠️ broken via host-PATH gap (see D-002) → keep/caveat/remove per D-002. Prefer the `agent_tools:list` discovery pointer over enumerating the 21 loaded plugins; optionally surface a couple of genuinely-useful working ones (code2prompt, github-repo). (plugin status reconciled in rewrites: repomix/fetch-plus work, firecrawl needs key, gitnexus caveated as down D-002 path b chosen in prompt; env fix still optional)
- **P-009** `done` For the long tail (`projects:*`, `snapshots:*`, `omp:*`, `wiki:backlinks`, `plugins:*`, `pending_events:list`): do NOT enumerate each — strengthen the existing "discover the catalog via `agent_tools:list`" pointer so agents know the catalog is the source of truth. Explicitly do NOT add `hindsight:recall` (deprecated 2026-05-09, no writers). (agent_tools:list discovery pointer present in both playbooks; no hindsight:recall added)

## Phase 4 — Ship

- **P-010** `done` Run `tools-md-sync` after the edits; commit; deploy via `install-standalone-mcp.sh` (engineer profile) to re-render the `~/.papercusp` playbooks. Prompts deploy via the installer re-render (no `:3070` restart needed for prompt-only changes). blocked-by:P-002,P-004,P-005,P-006 (tools-md-sync green 42/42; engineer profile re-rendered to ~/.papercusp current, incl web-search bullet. Power profile not re-rendered — separate decision flips active profile) (tools-md-sync green 42/42. No deploy step exists: psu renders the playbook per-launch from the committed source via renderSuPlaybook fs.readFile, so committing = live. Static ~/.papercusp files are vestigial.)

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

### D-004 — Round-2 items shipped via the from-scratch rewrites, not granular edits
Date: 2026-05-31
After this plan was written, the user asked for a full from-scratch rewrite of both SU playbooks (engineer `56b7e994b`, power `0967b6e28`), explicitly "include the other changes you were going to make." The rewrites absorbed every round-2 item, so P-001–P-010 are done-by-rewrite rather than as separate edits. A 2026-05-31 verification pass against the current source (`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md`) confirmed each item's content is present (or correctly absent, for `features:update`). D-001 (design-phase depth) was resolved by the rewrite choosing a "high-value systems worth knowing" block. D-002 (gitnexus) was resolved in the PROMPT by the caveat path ("treat its tools as down") — the underlying host-PATH env fix remains an optional, separate infra task. The power-profile re-render to `~/.papercusp` was not done because the installer also flips the active `&profile=` in `~/.claude.json` + `~/.omp/agent/mcp.json`, making it a profile-switch decision rather than a pure deploy; the committed power source renders fresh whenever someone next runs `install-standalone-mcp.sh --profile=power`.
Related: P-001, P-008, P-010

### D-005 — Correction to D-004: no deploy step — psu renders the playbook per-launch from committed source
Date: 2026-05-31
D-004 (and an earlier pass) framed the power playbook as "not yet deployed" and warned that re-rendering it via `install-standalone-mcp.sh --profile=power` would flip the active `&profile=` in the client configs. That framing was based on a stale comment in the install-script header and is WRONG for the current launcher. Verified in code (2026-05-31): `psu --profile=<engineer|power>` passes `profile` as a per-launch body param to `POST /api/agent-mcp/console/bootstrap-su`, which calls `buildLaunchSpec({kind:'su',profile})` → `renderSuPlaybook()`, and that does `fs.readFile('apps/operator/prompts/papercusp-su-<profile>.tools.md')` at call-time on EVERY launch (psu-launcher.mjs:59-60 "assembled per-launch now, so it's a launch flag, not a per-install choice"; role-launch-spec.ts:262-268; papercusp-files.ts renderSuPlaybook). Consequences: (1) committing the source `.tools.md` IS the deploy for both profiles — no installer re-render, no `:3070` restart (fs.readFile, not a bundled import); (2) the playbook `--profile` is a per-launch flag, NOT the MCP-URL `&profile=` baking the installer does (that's a separate, legacy tool-SURFACE concern, not how psu picks the playbook); (3) the `~/.papercusp/*-collaborator*.md` static files are vestigial (retired `*-su`-wrapper era + the documented manual escape-hatch), not read on a psu launch. The install script remains needed only for one-time setup (token, MCP registration, lock hooks, installing `psu`). The power playbook has been live since its commit `0967b6e28`.
Related: P-010
