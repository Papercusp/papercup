# BRIEF INDEX — 16 parallel-agent work briefs (2026-06-07)

**Generated 2026-06-07** from `plans:items` (effectiveStatus=todo + blocked) across all plans, minus the exclusions below. **83 items** are briefed across **16 briefs**, clustered by subsystem / file-surface affinity so all 16 agents can run **simultaneously** on the one shared `staging` checkout with disjoint primary file surfaces (two pairs are *explicitly sequenced* on a shared hot file — see the notes).

> **How to launch one agent per brief:** `psu` (the unified launcher), then paste the entire contents of the brief's `.md` file as the agent's task. Each brief carries its own collision contract + ground rules + verification. The two sequenced pairs (Brief 1<-2 on `fleet/`+budget; Brief 9<-10 on `HarnessDockShell.tsx`) must coordinate landing order via `coord:*` — they can still run in parallel, just not edit the shared file at the same instant.

## The 16 briefs

### Unify agent spawns on one chokepoint  ·  18 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-spawn-chokepoint-unify-2026-06-07.md`
- **Primary surface:** packages/operator-core/lib/fleet/{operator-spawn,spawn-reclaim,nursery}.ts, harness-invoke-once.ts, the 3 raw-spawn bypasses, new_subagent tools, events/await/engine.ts (admission accounting), blueprint single-agent
- **Launch:** `psu` then paste the full contents of the brief file above.

### Swarm coordination — brain as slot-scheduler  ·  12 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-swarm-coordination-brain-scheduler-2026-06-07.md`
- **Primary surface:** fleet/{assignments,governor}.ts, work-items.ts (rank), brain scheduler loop, Phase-0/Phase-2 decision records (budget primitive SEQUENCED behind Brief 1)
- **Launch:** `psu` then paste the full contents of the brief file above.

### Archive legacy orchestrator run-loop dead-code  ·  15 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-archive-legacy-orchestrator-deadcode-2026-06-07.md`
- **Primary surface:** libs/papercusp/.../orchestrator/src/* -> _retired/, the barrel + package.json, sync-resolver/table-to-query-names, zero-harness/queries, dbos/bootstrap.ts, harness-core.ts, OperatorConversationProvider.tsx:1344
- **Launch:** `psu` then paste the full contents of the brief file above.

### App-wide test coverage (Wave-1 stable)  ·  5 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-app-wide-test-coverage-2026-06-07.md`
- **Primary surface:** NEW TEST FILES only: packages/agent-mcp/src/**/*.test.ts, packages/operator-core/lib/**/*.test.ts (stable clusters), apps/operator/e2e/*.spec.ts + app/**/*.test.tsx
- **Launch:** `psu` then paste the full contents of the brief file above.

### Voice operator persona — production readiness  ·  5 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-voice-persona-production-readiness-2026-06-07.md`
- **Primary surface:** voice persona/playbook prompt .md (operator-core prompt-assembly inputs) + apps/operator/lib/llm-testing/scenarios/<role>/
- **Launch:** `psu` then paste the full contents of the brief file above.

### Holepunch voice channels — transport + desktop parity  ·  4 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-voice-channels-transport-desktop-parity-2026-06-07.md`
- **Primary surface:** apps/tui/src voice (Cargo), desktop-voice-ws.ts, operator-vite voice capture/playback component, webrtc-audio-processing/RNNoise native dep
- **Launch:** `psu` then paste the full contents of the brief file above.

### Promote wave spawns a child harness  ·  4 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-promote-spawn-child-harness-2026-06-07.md`
- **Primary surface:** apps/operator/lib/agent-tools/coordination/tools/promote.ts, promote-policy module, plan-template ## Promote block
- **Launch:** `psu` then paste the full contents of the brief file above.

### Coord channels FS->PG — gated cleanup tail  ·  4 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-coord-channels-pg-cleanup-gated-2026-06-07.md`
- **Primary surface:** coordination/.../paths.ts (dead FS helpers), the coord/ channel dirs, @papercusp/coordination README/example (ALL 4 BLOCKED; destructive step owner-gated on P-014)
- **Launch:** `psu` then paste the full contents of the brief file above.

### Desktop workbench — live E2E verify + close  ·  2 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-desktop-workbench-verify-close-2026-06-07.md`
- **Primary surface:** apps/operator/app/harness/dock/**, HarnessDockShell.tsx (FIRST on it), dock-layouts seed, operator-docs page, isolated-Tauri E2E
- **Launch:** `psu` then paste the full contents of the brief file above.

### SPEC.md UI cleanup — harness-home empty-state  ·  2 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-spec-md-ui-empty-state-cleanup-2026-06-07.md`
- **Primary surface:** HarnessDockShell.tsx (SEQUENCED behind Brief 9) + InsightsFirstVisitGate.tsx, spec redirect routes (app + operator-vite)
- **Launch:** `psu` then paste the full contents of the brief file above.

### Dogfood — wire ShareWizard finalize route  ·  2 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-dogfood-sharewizard-finalize-2026-06-07.md`
- **Primary surface:** ShareWizard.tsx (read fully — 649 lines, prior tool-read blocker) + the finalize wiring + substrate-reboot trigger
- **Launch:** `psu` then paste the full contents of the brief file above.

### Per-window workspace context + apply compaction migration  ·  3 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-per-window-workspace-context-and-compaction-migration-2026-06-07.md`
- **Primary surface:** per-window background-reader threading / packaged shared-PG-RLS (Phase E) + manual migration apply to native :5432
- **Launch:** `psu` then paste the full contents of the brief file above.

### Promote policy — first cross-repo dogfood (Restart)  ·  1 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-promote-policy-restart-dogfood-2026-06-07.md`
- **Primary surface:** /home/marsh-office/Restart plan universal-schema-2026-05-30 (cross-repo; collision-free vs papercup)
- **Launch:** `psu` then paste the full contents of the brief file above.

### Self-learning central — reflection/change-feed tests  ·  1 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-self-learning-reflection-tests-2026-06-07.md`
- **Primary surface:** NEW TEST FILES on the self-learning/idea-queue/reflection modules
- **Launch:** `psu` then paste the full contents of the brief file above.

### SU scenario suite (run-on-headroom) + docs/memory prompt gate  ·  2 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-su-scenario-suite-and-docs-memory-gate-2026-06-07.md`
- **Primary surface:** SU llm-testing scenarios (run-and-record) + the gated docs/memory prompt rewrites (HELD — do not edit)
- **Launch:** `psu` then paste the full contents of the brief file above.

### Linux test VM federation — gated tail  ·  3 item(s)
- **File:** `apps/operator/docs/agent-briefs/BRIEF-linux-test-vm-federation-gated-2026-06-07.md`
- **Primary surface:** VM provisioning scripts + vms.md (ALL 3 BLOCKED on P-009, claimed by live owner su-d82af620)
- **Launch:** `psu` then paste the full contents of the brief file above.

**Total briefed: 83 items across 16 briefs.**

### Two sequenced hot-file pairs (the only intra-set collisions, by design)
- **Brief 1 (spawn-chokepoint) ← Brief 2 (swarm-coordination)** share `packages/operator-core/lib/fleet/operator-spawn.ts` + the authority **budget primitive**. Brief 1 owns admission + the deterministic ceiling/pacing floor + nursery reclaim; Brief 2 does its work-list/`rank`/scheduler/Phase-2-design work first (disjoint) and lands the budget-signal piece **behind** Brief 1.
- **Brief 9 (desktop-workbench) ← Brief 10 (spec-md-ui empty-state)** share `apps/operator/app/harness/[slug]/HarnessDockShell.tsx`. Brief 9 goes first (it is mostly verify-only on a built dock); Brief 10 builds the welcome empty-state behind it.

---

## Owner decisions needed (needs-human — NEVER briefed; owner-only hard stops)

These 15 items are `needs-human`. They are listed here for the owner and are **excluded from every brief** — an agent that discovers one mid-work must stop and surface it, never decide it.

- **close-the-self-improvement-loop-2026-06-05 P-007** — ARM the loop (owner-gated, needs-human): flip papercusp-improvement-auto-implement flag ON + set PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS + activate the improvement-implement routine — only per the D-007 runbook, after registering the runner harness. Graduate bug-only first. (owner-gated arming D-004 — runbook in D-007)
- **cloud-deployment-layer-2026-06-06 P-005** — Ratify the four open decisions D-006..D-009 (orchestrator-on-frame, embedded-pg-per-frame, Mug placement, Pot/Swarm naming) before Phase 3/5 design.
- **coord-channels-pg-port-2026-05-30 P-014** — Sign-off before destructive cleanup — confirm PG-only is final (detached coord intentionally dropped) before deleting the `coord/` channel dirs and amending the v2 decisions.
- **dbos-pipeline-prompt-reconciliation-2026-06-01 P-001** — `orchestrator.md`'s fate. It's the retired-loop persona but the loop is the sanctioned revert path (`PAPERCUSP_DBOS_ORCHESTRATOR=0`). Recommendation: **(b) merge-then-archive** — lift its still-true *global-scope* heuristics (issue-conversion, escalation criteria, cross-feature judgment) somewhere appropriate, then `git mv` it to `prompts/_archived/` (preserved for the revert, out of the live load path). NOT hard-delete (would strip the revert path's persona). See D-001.
- **dbos-pipeline-prompt-reconciliation-2026-06-01 P-002** — Pre-loop disposition — **the crux of the directive.** The scoper-`MODE=initial` + reviewer-`MODE=plan` pre-loop is legacy-only and NOT on your cut list. Per "don't deprecate non-acknowledged capabilities," recommendation is now **(b) FILL the gap**: add a DBOS pre-loop equivalent (scoper auto-populates an empty harness; optional plan-gate), then the prompts describe a real capability. (My earlier draft recommended reframing the prompts to "on-demand only" — that would have *deprecated* the auto-populate behavior, contradicting the directive. Corrected.) See D-002.
- **deprecate-harness-config-json-2026-06-06 P-010** — Sign off that config.json is fully deprecated (no live readers; blueprint + workspace-PG are the sole sources) before deleting the loader.
- **docs-and-memory-as-projections-2026-06-05 P-006** — P4 mem0 revive-vs-retire (NEEDS-HUMAN, gates D-005/D-006) — per D-008 mem0 is stillborn (0 embeddings, the pipeline never ran) and 100% of injected memory is the Claude auto-memory. Decide: REVIVE (seed mem0 with the ~194 auto-memory files + fix why embeddings never ran — likely broken, not just unused) or RETIRE (accept per-client memory, like PLUR was retired). The deciding measurement (from D-008): write a test `memory:remember` and check whether it lands + embeds. D-005 (mem0 = sole semantic store) and D-006 (full mem0/coord/insights layering) stay DEFERRED until this is resolved. The safe code hygiene parts already shipped in P-003.
- **fleet-coordination-painpoints-2026-06-02 P-012** — Investigate the reported bug: a FULL agent spawn (MCP + subagents + persona) writes EMPTY config stubs (`package.json`, `bunfig.toml`, `.env.*`). Reproduce, root-cause, fix; may spin out into its own plan. (ROOT-CAUSED live strace: NOT a Papercusp bug — claude-code's plugin-marketplace git auto-update checks its plugin tree out into the worker cwd O_CREAT|O_EXCL ⇒ only-missing files on a mid-spawn refresh. Fix our side: DISABLE_AUTOUPDATER=1 + isolated CLAUDE_CONFIG_DIR in the claude spawn env orchestrator invoke.ts. Not applied — load-bearing submodule path; needs go-ahead.) (FIXED + committed submodule 17c1f93, superproj 45d6a3695: claudeSpawnEnvHardening sets DISABLE_AUTOUPDATER=1 for claude-code fleet spawns — removes the marketplace git-checkout that leaked stubs into the worker cwd. 2 unit tests + invoke.test.ts 98/98 green. Optional follow-up: file upstream claude-code bug.) (CORRECTION 2026-06-03 audit: prior DISABLE_AUTOUPDATER fix INEFFECTIVE gates binary updater, not marketplace refresh. Real fix landed: plugin-free CLAUDE_CONFIG_DIR per claude spawn — submodule 10bafcf, pointer e6d6e1bc0, behavioral test + live repro, 599/599. Upstream anthropics/claude-code#65131. Residual: optional live e2e.)
- **harness-tests-tab-and-tester-promotion-2026-05-26 P-070** — End-to-end on `papercup`: author a new small feature as one plan item carrying one inline `[VAL-…]` bullet → `plans:promote` (writes `feature.claims` + a `harness_plan_assertions` row at `status=todo`) → worker implements → tester writes a test with `coversVALs=[that VAL]` → snapshot stamps plan linkage + flips the assertion to `validating` → validator runs it → assertion `passed`, the plan item shows a passing-test badge (P-083), feature `passed`. Capture round-trip cost + duration. (Live e2e — needs a real autonomous harness run promote an inline-VAL plan on papercup → worker → tester → validator, which only the user can drive. All the code it exercises is built + unit-verified; this is the end-to-end behavioral confirmation.)
- **self-contained-migration-baseline-2026-06-02 P-010** — Re-verify: Tauri desktop boot + core-flow smoke per `/internal/docs/testing` + `agent-e2e` (the app works with no lazy ensures); `npm run test:affected`. Acceptance: desktop boots, core flows green. blocked-by P-008, P-009. (Owner follow-up split Brief 64. Tauri desktop boot smoke under Xvfb — heavy/env-dependent + supervised. The boot's migration path applyPendingMigrations over the same sql/ dir is already validated by verify-baseline + the strict gate + the full integration run, so this is confirmatory; not a blocker for shipping the baseline.)
- **self-contained-migration-baseline-2026-06-02 P-012** — Refresh Drizzle via `pull-schema.mjs` against a baseline-built DB; expect ≈ no-op diff; commit refreshed `schema.ts`/`generated.reference.sql`. Acceptance: types compile, diff explained. blocked-by P-006. (Owner follow-up split Brief 64. Drizzle regen pull-schema.mjs — deliberately deferred to a SUPERVISED session: the env's live DB is drifted, so regenerating from it would make schema.ts worse; doing it right needs a clean baseline-built DB + reviewing a large generated diff. Owner-gated.)
- **spec-md-ui-deprecation-cleanup-2026-05-30 P-010** — Decide whether harness templates migrate from SPEC.md to plan-based seeds. `TemplatesModal.tsx` (lines 46-163) still reads/previews `SPEC.md` from templates, the on-disk template projects still ship `SPEC.md`, and the save-as-template recipe text (HarnessDashboard 1109/1178/3844) lists it. This is a larger separate question and should be its own plan, not folded into this cleanup. See D-001.
- **test-coverage-rest-non-critical-2026-05-30 P-025** — [needs-human on the retirement calls] Confirm + **delete, not (The lone remaining item — Phase F legacy retirement/deletion calls holepunch-spike, papercusp-db, papercusp-shared *View.tsx. Item text itself flags "[needs-human on the retirement calls]"; a hard human-decision stop, not autonomously executable. Correcting stored status todo→needs-human.)
- **tui-glyph-vocabulary-2026-06-05 P-001** — Owner ratifies the proposed vocabulary table above (or vetoes individual glyphs — each is a one-line edit in `glyph.rs` thanks to centralization). NON-BLOCKING for P-002..P-009: the sweep ships the proposed defaults; this item tracks the sign-off and any post-hoc swaps. (D-005)
- **voice-realtime-tui-2026-06-05 P-010** — Live smoke on this box (supervised-audio rules): own pui instance (NEVER the user's, per feedback memory), PipeWire **null-sink** isolation (`module-null-sink` + `PUI_VOICE_INPUT`/`PUI_VOICE_OUTPUT` overrides per the isolated-audio memory): real ws-init → real EL session connects → agent greets (audio frames played to the null sink) → mic-path silence/VAD sanity → barge-in stops playback → transcript turns persisted in the shared thread → lease blocks a second listener. Capture evidence. (Smoked to the credential boundary: live tmux pui run proves V→session→ws-init→error-toast end-to-end against the real operator; route live-smoked on :3170. The REAL EL session needs OWNER CONFIG — this box has fullAgentEngine=off and NO elevenLabsAgentId /settings/voice. Owner: set both, then press V in the pui.)

---

## Blocked on EI-79 residual (the hyperbee merge-engine rewrite)

An agent is mid-rewrite of the merge engine at `packages/operator-core/lib/sync/hyperbee/**` (EI-79 residual). The following **22 items across 2 plans** either create/edit files in that directory or are downstream-blocked on items that do, so they are **parked** until the rewrite lands. (`fleet-federation-reanchor` is the federation re-key of that very engine — its substrate/outbox/boot/contributors core (`outbox-drain.ts`, `boot.ts`/`boot-all.ts`, `peer-log.ts`, `revoke-*.ts`, the projection registry) sits squarely in the rewrite surface, and splitting it into hyperbee/non-hyperbee fragments would leave incoherent late-phase items blocked on parked early-phase ones — so the whole plan parks as a coherent block. `p2p-pot-directory` P-001/P-002 create new `lib/sync/hyperbee/*` files and the rest of the plan chains on them.)

- **fleet-federation-reanchor-2026-06-06 P-002** — **The federation key shape.** Lean: keep the existing `(workspace_id, harness_slug)` outbox/notify columns with `harness_slug` NULLABLE and **NULL = the fleet domain** — minimal migration; the drain routes NULL-slug rows to the pot's one handle; harness-tagged rows keep their tag as content. Alternative: a `'fleet'` papercup or a separate domain column. Decide + record.
- **fleet-federation-reanchor-2026-06-06 P-003** — **Inventory the re-key surface:** every capture trigger (migs 145/149/150 + the baseline `capture_substrate_outbox`), every `PEER_LOG_TAG_TO_TABLE` projection tag, the drain consumer's `pg_notify` routing, AND every `harnessSlug` parameterization in `lib/authority/*` (`lockAuthorityFor`, the remote-peers cache keyed by slug) — the exact list Phases 1+6 edit.
- **fleet-federation-reanchor-2026-06-06 P-010** — **Migrations (allocate via `db:next-migration`):** extend the capture guards so **operator-scope rows on the federated surfaces ALSO enqueue** (the fleet domain) — coord_event_log (messages/handoffs/escalations with `harness_slug IS NULL`), conversations/threads/posts with `scope='operator'` — preserving the `origin` echo-guard + the `notify_kind` fan-out exclusion exactly. `harness_slug` rides along as a content tag where set.
- **fleet-federation-reanchor-2026-06-06 P-011** — **Outbox + notify routing:** NULL-slug rows notify the fleet channel; the drain consumer routes them onto the pot's substrate handle; projections apply them with the same LWW/`ON CONFLICT` + echo-guard semantics.
- **fleet-federation-reanchor-2026-06-06 P-020** — Boot the substrate **once per pot/workspace** (identity = the device keypair), not per `(workspace, harness)`; the fleet domain + all harness-tagged content ride the one handle. **Retire per-harness boots outright** (pre-alpha — no shim; D-008). `getBootedHarness(workspaceId, harnessSlug)` → a pot/fleet handle accessor.
- **fleet-federation-reanchor-2026-06-06 P-030** — **Re-key `contributors` to `(workspace_id, github_user_id)`** (migration; preserve `device_attestations` + `revoked_pubkeys`, unioned at fleet scope). Admission re-verify unions at fleet scope; the join flow = join the **workspace/fleet**; `substrate:revoke_contributor` / `revoke_self_device` drop the `harnessSlug` arg. (Better security semantics too: you revoke a device from your fleet, not one harness at a time.)
- **fleet-federation-reanchor-2026-06-06 P-031** — `harness:membership` demotes to registry bookkeeping (which workspaces list a project) — no federation role.
- **fleet-federation-reanchor-2026-06-06 P-040** — **`spawned_agents.harness_slug` → NULLABLE** — a pot-level cup has no harness; the project/cwd becomes a tag. Update `fleet:spawn`/`fleet:tree` + the reclaim sweep for the NULL path.
- **fleet-federation-reanchor-2026-06-06 P-041** — **Operator-scope signed-URL variant** for bootstrap-role / the role-scoped MCP URL (no harness binding) — what a cup launch uses; the harness-bound form stays for pipeline roles.
- **fleet-federation-reanchor-2026-06-06 P-042** — **Record (no code): feature-family stays harness-keyed.** Features are the opt-in pipeline's currency; the pot's federated queue rides the **issue/task family** (already scope-parameterized + harness-free). Don't force features harness-free.
- **fleet-federation-reanchor-2026-06-06 P-050** — Reclassify for the fleet peer-log: the **work-queue** (operator-scope issue/task rows — previously COULD NOT federate), **claim-leases**, **membership/revocation** (contributors), **presence** (decide: unify `coord_presence` vs `shared_presence` — one presence surface at fleet scope), and (when Track B lands) the **budget signal**. Assert with a test that per-slot work-lists + rich local state stay `sync:'none'`, and the SECURITY set still never enqueues. This is swarm-coordination's federate-the-minimum, realized in the registry.
- **fleet-federation-reanchor-2026-06-06 P-060** — **Re-key the BUILT authority to fleet scope + do the pending live cutover:** `lib/authority/*` (`lockAuthorityFor`, `hardened-authority`, the remote-peers cache) re-keys `harnessSlug` → the fleet domain (one authority = lowest-live-device-pubkey across the workspace's live pots); then cut file locks + plan-item claims onto the real resolver via `setClaimAuthority()` AT FLEET SCOPE (the cutover the old plan left hardware-gated); queue claim-leases reclaim on peer death (membership liveness). **N=1 must behave byte-identically to `LocalClaimAuthority`** (the single-pot invisibility guarantee).
- **fleet-federation-reanchor-2026-06-06 P-061** — **The compact budget signal** (permit/throttle — the swarm umbrella's budget-primitive fork) with the partition posture: content fail-open / budget fail-safe. Resolver + tests land single-machine; live multi-machine verification is hardware-gated on a 2nd machine.
- **fleet-federation-reanchor-2026-06-06 P-070** — **Unit/integration:** operator-scope row capture→outbox→projection round-trip on the fleet domain (echo-guard intact); one-handle-per-pot boot; the contributors re-key migration preserves attestations/revocations; the `spawned_agents` NULL path; N=1 authority equivalence; security tables still never enqueue.
- **fleet-federation-reanchor-2026-06-06 P-071** — **Live smoke (N=1):** the re-anchor must be **invisible at single pot** — everything behaves as today, EXCEPT operator-scope queue/coord rows now enqueue to the outbox (previously impossible). Verify on staging per the two-host model.
- **p2p-pot-directory-2026-06-06 P-001** — `lib/sync/hyperbee/pot-announce.ts` — signed pot announce `{hiveId, title, description, ownerGithubLogin, ownerDevicePubkey, memberTopics[], createdAt, ts, sig}`, signed with the owner device keypair; reuse `announce.ts` sign/verify + the Ed25519 plumbing as-is.
- **p2p-pot-directory-2026-06-06 P-002** — `lib/sync/hyperbee/derive-pot-topic.ts` — ONE deterministic well-known directory topic (`sha256("papercusp-pot-v1:directory")`), reusing `derive-swarm-topic.ts`; every participating peer joins it to announce + listen.
- **p2p-pot-directory-2026-06-06 P-003** — `packages/operator-core/lib/hive-directory.ts` — on substrate boot join the directory topic; verify inbound announces (signature + attestation); keep the discovered set in memory with a PG-cached copy for offline listing (cache, not transport); expose `listDiscoveredHives()` / `announceLocalHive(hiveId)`. Re-announce on a timer + on pot metadata change.
- **p2p-pot-directory-2026-06-06 P-004** — Pot create/edit surface carries `title` + `description`; creating (or opting-in) a pot announces it. Opt-in flag per pot — private pots never announce.
- **p2p-pot-directory-2026-06-06 P-005** — Operator endpoint (defineTool) serving the discovered-pot list to UI surfaces.
- **p2p-pot-directory-2026-06-06 P-006** — Repoint the pui `apiary-pane` from the Cupboard tab to the pot directory list (title description owner peers + a Join CTA); joining runs the existing `join-shared-harness` orchestration per member harness.
- **p2p-pot-directory-2026-06-06 P-007** — Desktop `HiveDirectoryPanel` (panel-registry, `discovery:pots`) over the same endpoint.

---

## Excluded (with counts)

| Reason | Count | Notes |
|---|---|---|
| **Plan `apiary-2026-06-06`** (owner exclusion) | 17 | The entire Apiary plan — owner's explicit exclusion. |
| **Claimed items** (`claims.txt`) | 2 | Of the 25 claimed rows, 2 fell within the actionable todo/blocked set (the rest belong to already-excluded plans). |
| **Live-plan items** (agents on them now) | 13 | Plans `local-pot-orchestration-2026-06-06`, `p2p-performance-suite-2026-06-07`, `mem0-extraction-via-claude-session-2026-06-06`, `legacy-docs-audit-revival-2026-06-06`. |
| **Stale (shipped/superseded leftover items)** | 32 | Shipped: admin-testing-tab-restructure, adv-harness-tab-migration, dbos-retire-legacy-orchestrator, find-in-page-ctrl-f, git-sync-auto-commit, holepunch-video-shared-harnesses, psu-only-launch-unification, scout-convergence, self-contained-migration-baseline, test-coverage-rest-non-critical, close-the-self-improvement-loop, fleet-coordination-painpoints, harness-tests-tab-and-tester-promotion. Superseded: b12-link-verification, brief31-release-e2e-verify, dbos-pipeline-prompt-reconciliation. |
| **EI-79 residual (parked)** | 22 | `fleet-federation-reanchor-2026-06-06` (15) + `p2p-pot-directory-2026-06-06` (7) — see the section above. |
| **needs-human** | 15 | Listed under "Owner decisions needed" above. |

**Reconciliation:** 143 todo + 26 blocked = 169 actionable items. Minus 17 apiary, 13 live, 32 stale (todo+blocked combined), 2 claimed = **105 in-scope**; minus 22 EI-79-parked = **83 briefed**. The 15 needs-human items are a separate input file (not part of the 169) and are owner-only.
