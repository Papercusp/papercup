# Handoff briefs — domain-generic-hive-architecture-2026-06-18

Parallel-execution briefs for the remaining items of plan
**`domain-generic-hive-architecture-2026-06-18`** (harness `all`). Each brief is scoped
to a **disjoint file-set** so agents don't collide on the enforced file-locks. Read the
plan's decisions **D-001..D-015** before starting your brief; the load-bearing ones are
cited inline.

## State as of 2026-06-18 (su-146bf, autonomous session)

**DONE + verified (tests green, typecheck clean):**
- **P-009** — scout config seam (`lib/scout/config.ts`: `ScoutConfig` for lenses/novelty/buckets/routing+markers; threaded `cycle-deps`→`run`→`productionScoutRunner`; defaults centralized in `critique-core`/`router`). 521 scout tests.
- **P-012** — per-hive override materialization (`lib/hive-local-blueprint.ts`) + producer wiring at BOTH autonomous chokepoints (`fleet/operator-spawn.ts` for bees; `endpoint-route/routes/harness/spawn.ts` invoke route for queen/overwatch/launch). `lib/hive-local-blueprint-resolve.ts` is the best-effort producer.
- **P-013** — override consumed two ways: interactive psu = the existing append (kept, D-013); autonomous = the materialized local-tier file. One federated source (`hive_settings.promptOverride.*`).
- **P-014** — tier-aware prompt resolution: `prompt-resolve.ts` consults `ctx.blueprintRoots` (local→installed→builtin); `invoke.ts` threads it from a `BLUEPRINT_LOCAL_ROOT=` extra. 29 prompt-resolve tests.
- **P-005** — per-blueprint bees: `base/prompts/bee.base.md` (shared neutral prefix) + `hive/prompts/bee.md` (coding delta) + `generic-hive/prompts/bee.md` (work delta). Closes audit Finding B. 2 new prompt-resolve composition tests.

**Key decisions:** D-011 (rename LAST) · D-012 (override = same-id local override, composed-at-materialize) · D-013 (two override paths) · D-014 (Phase 4 deferred — needs multi-node verify) · D-015 (rename deferred for owner supervision — green-checkpoint atomicity).

**Plan-status reconciliation note:** `:3070` was intermittently down at session end; P-005→done, D-015, and P-019/P-020/P-021→blocked may be un-persisted. Re-check `plans:get` and reconcile before relying on item statuses.

---

## BRIEF 1 — Queen persona: neutral base + per-domain delta (P-007, P-008, P-011)

**Goal.** Mirror the DONE bee split (P-005) for the Queen: one neutral shared persona +
thin per-domain deltas, so a coding hive and a work hive decompose differently without
duplicating the generic orchestration method (D-002, D-003).

**Approach (reuse the `.base.md` prefix mechanism — same as the bee, NOT a separate
`queen.overlay.md`; this refines D-003 for consistency with P-005):**
- Create `blueprints/base/prompts/queen.base.md` = the neutral generic Queen (the generic
  orchestration method: triage→decompose→place→supervise, propose/dispose, the 3 placements,
  fresh-per-wake, autonomy/triage, reflect, report). Most of today's `base/prompts/queen.md`
  (already neutral, 193 lines) is this — relocate it as the shared prefix.
- Trim `blueprints/hive/prompts/queen.md` (593 lines) to the **coding-decomposition DELTA**
  only — the coding-specific parts (file-set/module decomposition, build-order deps,
  scope→architect→worker chunking, test/acceptance framing). The generic method moves to the
  base prefix. Result: hive Queen resolves as `[base/queen.base.md, hive/queen.md]`.
- Trim `blueprints/generic-hive/prompts/queen.md` (122 lines) to the generic/work-decomposition
  delta (topic/subject seams, judge-acceptance). Result: `[base/queen.base.md, generic-hive/queen.md]`.
- Decide `blueprints/base/prompts/queen.md` (the bare-`[base]` fallback, used by the brain): keep
  a minimal neutral main, OR remove it (bare queen then resolves to `[queen.base.md]` alone). If
  removed, VERIFY the role-registry invariant still holds.

**Files (disjoint):** `blueprints/{base,hive,generic-hive}/prompts/queen*.md`,
`libs/papercusp/packages/orchestrator/src/prompt-resolve.test.ts` (add composition tests,
copy the P-005 bee-composition test pattern at the end of that file).

**Verify.** Composition (no gateway needed): add prompt-resolve tests asserting
`[base/queen.base.md, hive/queen.md]` and `[base/queen.base.md, generic-hive/queen.md]`.
**MUST keep green:** `packages/operator-core/lib/base-role-library.test.ts` (lines ~83/98 assert
the hive bundles bee/queen/operator/overwatch AND that a hive-context spawn resolves the queen
OVERRIDE over the base copy — the override `hive/queen.md` must still resolve as the most-specific
main). Behavioral (best-effort, needs Anthropic creds/gateway):
`npm --prefix apps/operator run llm-test -- --target queen`.

**Collision / sequencing.** Touches the blueprint dirs → **do this BEFORE the rename (Brief 6)**;
the rename then `mv`s these files. Do NOT run in parallel with Brief 6.

### Precise split spec (su-146bf read the full 593-line `hive/queen.md` 2026-06-18 — use this)

- **Only ONE section is coding-specific:** `## Parallelize plan implementations — briefs first`
  (`hive/queen.md` lines ~347-390): file-scope/contract seams, DB-schema/payload/endpoint-row
  contracts, `db:next-migration`, "tests ship WITH the brief". **Every other section is the
  generic orchestration method** (verbs-are-MCP-tools, two-planes, place-only-on-bees,
  fresh-per-wake, placement-taxonomy, survey-on-summaries, triage, propose/dispose,
  completion-guarantee, drive-to-empty, beyond-placement, shared-learnings, idle-mandate,
  reflect, declare-wake, end-verb). `generic-hive/queen.md` already carries the work analog of
  that one section (`## Decompose by topic / subject seams`, `## Acceptance is a JUDGE verdict`).
- **ALL FOUR files change together** (or the generic method duplicates — method in the prefix
  AND in each main):
  1. `base/prompts/queen.base.md` (NEW) = the generic method. Cheapest reliable way to get the
     rich content without transcription error: `cp hive/queen.md base/queen.base.md`, then a
     targeted edit — retitle to "shared base", and REPLACE the coding `## Parallelize…` section
     with a NEUTRAL decomposition pointer ("decompose into disjoint lanes on the work's natural
     independent seams; your domain delta below gives the specifics — file-scope+contracts for
     code, topic/subject for work").
  2. `hive/prompts/queen.md` = TRIM to just the coding decomposition delta (the `## Parallelize…`
     section content + a one-line header). Keep the file (the invariant below needs it).
  3. `generic-hive/prompts/queen.md` = TRIM to just the work decomposition delta (drop the
     duplicated generic method; keep `## Decompose by topic/subject` + `## Acceptance is a JUDGE
     verdict` + any work-specific bits).
  4. `base/prompts/queen.md` = TRIM to a short "global fallback / no domain" note (the bare-`[base]`
     main), so the bare queen = `[queen.base.md, base/queen.md]` = method + a brief no-domain note,
     NOT method twice.
- **Invariant (verified safe):** `base-role-library.test.ts:83/90/98` use `resolvePromptFile`
  (SINGULAR — the most-specific MAIN). It asserts (a) `hive` bundles bee/queen/operator/overwatch
  files exist, and (b) a hive-context queen resolves to `hive/prompts/queen.md`. KEEPING
  `hive/queen.md` (as the delta) satisfies both — the `.base.md` PREFIX does not affect
  `resolvePromptFile` singular. No test requires `base/queen.md` to be non-empty, but keeping a
  trimmed stub is safest.
- **Verification without the gateway:** add prompt-resolve composition tests (copy the P-005
  bee pattern) asserting hive queen = `[base/queen.base.md, hive/queen.md]` and generic-hive
  queen = `[base/queen.base.md, generic-hive/queen.md]`. Because the split is CONTENT-PRESERVING
  (the coding section just moves to the appended delta), behavioral risk is low; still run
  `llm-test --target queen` once the gateway has headroom as the behavioral confirmation.

---

## BRIEF 2 — Scout per-step prompt overlays (P-010) — ✅ DONE (su-e9cc3, 2026-06-18)

**DONE.** Implemented as a STRUCTURED `ScoutConfig.framing { ideatorMission, criticMission }` seam
in `lib/scout/config.ts` (NOT `scout.*.md` files — see plan D-016), riding the SAME payload→config
channel P-009 built. `buildIdeatorPrompt` (lenses.ts) + `buildCriticPrompt` (critics.ts) now take an
optional mission, defaulting to exported `DEFAULT_IDEATOR_MISSION` / `DEFAULT_CRITIC_MISSION`
(anti-drift, byte-identical default); `cycle-deps.ts` threads `scoutConfig.framing` into the
ideate/critique ports; `ideators.ts` forwards it. 524 `lib/scout` unit tests green; 0 tsc errors in
`lib/scout`. Touches ZERO blueprint dirs → no Brief-6 collision. **Follow-on (downstream of Brief 6):**
author a `scout.framing` block in the `work` blueprint.yaml so a work hive actually reframes.

**Goal.** Make the scout LLM-step prompts blueprint-overridable so a coding vs work hive frames
ideation + critique for its domain (D-004). The scout STRUCTURED config seam is DONE (P-009,
`lib/scout/config.ts`); this is the PROMPT half (the system/framing strings the injected
`ScoutLlmCall` receives in the ideator + critic steps).

**Approach.** Thread a per-blueprint prompt-overlay (e.g. `blueprints/<id>/prompts/scout.ideator.md`
+ `scout.critic.md`, or a `scout.framing` block) into where `runIdeators` (`lib/scout/ideators.ts`)
and `critiqueIdea` (`lib/scout/critics.ts`) build their `system`/`user` prompts. Default = today's
hardcoded framing (behavior-neutral when no overlay). Pass it through the same `cycle-deps`→`run`
seam P-009 used for the config block.

**Files (disjoint):** `lib/scout/ideators.ts`, `lib/scout/critics.ts`, `lib/scout/cycle-deps.ts`,
`lib/scout/run.ts`, `lib/scout/*.test.ts`. **Mild overlap with Brief 7** on `scout/scheduler.ts`+`run.ts`
— coordinate (Brief 7 touches the tick gate, this touches the step prompts).

**Verify.** `npm --prefix packages/operator-core test -- lib/scout/` (no gateway).

---

## BRIEF 3 — New-Hive menu + Comb-instantiate UI (P-006)

**Goal.** The New-Hive button presents 4 headings: **New coding hive** (sub-options: new local
dir / existing local repo / GitHub), **New work hive** (no sub-options), **New hive from Comb
blueprint** (a search box over published blueprints → instantiate), **JOIN**. Nuqs-backed state
(per repo convention — selectors/open-state in the URL, not useState).

**Approach.** Find the current hive-create UI (`apps/operator/app/...`). The Comb-search path
reuses the tier-aware resolver (DONE, P-014/D-006) — a Comb-instantiated blueprint's prompts now
resolve via the installed tier. `hive_create { blueprintId, learningPack }` is the create call.

**Files (disjoint — UI only):** `apps/operator/app/**` (the hive-create flow + components).

**Verify.** RTL/component tests + the Tauri shell per `/internal/docs/testing` + `agent-e2e`
(NEVER a browser against :3055/:3070).

---

## BRIEF 4 — Settings UI: two editors for the per-hive override (P-015)

**Goal.** In hive settings, TWO editors: (a) a **prose** role-prompt editor (writes
`hive_settings.promptOverride.<role>`), and (b) a **structured config** editor (form/yaml for the
`scout`/`queen` config deltas). A prose-only page cannot customize scout (D-005). The override
BACKEND is DONE (P-012/P-013); this is the UI + the structured-config write path.

**Approach.** The prose editor writes via the existing `setHiveInstancePromptOverride` path (it
federates, D-007). The structured editor needs a `hive_settings` key for the config delta (e.g.
`localBlueprint.scout`) — note: per-hive scout config is currently read from the routine payload
(P-009); wiring it from `hive_settings` is a small follow-on this brief can include.

**Files (disjoint — settings UI):** `apps/operator/app/**/settings/**`, the sync resolver entry
if a new read is needed. **Mild overlap with Brief 3** if same settings surface — coordinate.

**Verify.** RTL + Tauri shell.

---

## BRIEF 5 — Default learning packs: generic coding + generic work (P-017)

**Goal.** A blessed default **coding** learning pack and **work** learning pack — generic
engineering / generic work knowledge, **NOT** Papercusp-specific (D-010). Papercusp knowledge
stays a SEPARATE pack + the per-hive override.

**Approach.** Use the `learning_packs:*` system. Define the two default packs + wire each blessed
blueprint (`coding`/`work`) to its default pack at hive-create. Do NOT bake pack content into the
blueprint (blueprint = prompts; pack = memory).

**Files (disjoint — pack system):** the learning-pack definitions/seed + the blueprint→default-pack
wiring. Disjoint from blueprints/prompts, UI, and scout code.

**Verify.** Pack unit tests; `learning_packs:list` shows the defaults.

---

## BRIEF 6 — Blueprint rename (P-001..P-004) — SUPERVISED, do LAST

**Goal.** `hive`→`coding`, `generic-hive`→`work`, current `coding`→`coding-factory`.

**CRITICAL CAUTIONS (D-001, D-011, D-014, D-015):**
- **`coding` already EXISTS** → collision-safe 3-step order: (1) `coding`→`coding-factory` (+ repoint
  `external-bench` which `extends: coding`); (2) `hive`→`coding`; (3) `generic-hive`→`work` (+ fix
  `work` to `extends: coding`).
- **Touches LIVE-FLEET hardcoded strings** — update all: `OVERWATCH_BLUEPRINT_ID='hive'`
  (`overwatch/liveness.ts:40`), `BUILTIN_LAUNCH_BLUEPRINTS` (`launch-blueprint.ts:48`),
  `operator-spawn.ts:~809` (`BLUEPRINT_ID=hive` bee default), the llm-testing targets
  (`llm-testing/targets/queen.ts` + `overwatch.ts` hardcode `blueprints/hive/prompts/*.md`),
  `agent-tools/hive/create.ts` + `_create.ts` guidance.
- **Add a prompt-resolve blueprint-id ALIAS** (`hive`→`coding`, `generic-hive`→`work`) so
  un-migrated references + the `harness_shared.blueprints` PG cache + existing instances'
  `extends:` still resolve during the transition. Migrate the PG cache + instance `blueprint.yaml`s.
- **ATOMICITY IS MANDATORY.** A half-rename in the SHARED staging tree at a turn boundary breaks
  the HOURLY green-checkpoint → FF to `main` blocked → ALL fleet deploys stall. Do it as
  alias-first (additive) → flip references → remove old, **each step independently green**. Strongly
  prefer an owner-supervised window; do not interleave with other briefs.

**Collision.** Touches blueprint dirs (Brief 1) + many hardcoded sites → **sequence AFTER Brief 1**;
run alone.

**Verify.** `npm run test:affected` + prompt-resolve + `llm-test --target queen`/`overwatch`.

---

## BRIEF 7 — Phase 4 shared-hive hardening (P-019, P-020, P-021) — ✅ DONE (su-bc037, 2026-06-18)

**STATUS: DONE + verified (119 tests green across 8 touched files; touched files typecheck clean).**
Plan items P-019/P-020/P-021 → done; full rationale in plan decision **D-018**.

- **P-019 scout / P-020 gym single-runner:** new `lib/hive-single-runner.ts` (`checkHiveSingleRunner`) — a
  thin gate over the SHIPPED `lockAuthorityForHive` (lowest-live-pubkey election), NOT a new lease. Wired as a
  `hiveRunnerGate` preflight in `runScoutCycleTick` (+ the live `scout:cycle` blueprint op) and an `isHiveRunner`
  candidate-filter in `runGymAutoloopTick` (+ `gym-actions.ts`). N=1/standalone unchanged (isSelf/not-in-hive →
  run); fail-open (error → run).
- **P-021 queen-home guard:** `evaluateQueenTurnGate` INTEGRATED into the already-shipped `checkSteeringLease`
  (a recorded `queen-home-pubkey` overrides the election; unset = today's behaviour) + `queen-home-pubkey`
  recorded at `hive:create`. `detectDoubleSteering`'s live equivalent already ships as the steering-churn
  tripwire (mig 232) on the set_priority path.
- **Verification:** the new single-runner LOGIC is verified MULTI-NODE deterministically
  (`hive-single-runner.test.ts`: real `lockAuthorityForHive` over a 2-node presence roster + 2 self identities
  — exactly-one-runner, lowest-pubkey, stale-leader failover, fail-open). The substrate (presence federation +
  the election) is pre-shipped + integration-tested. A full hyperswarm 2-node E2E is an OPTIONAL confidence
  increment (the gate is fail-open + N=1-neutral), not a blocker.
- **Follow-ons (not blockers):** deploy:hive should override queen-home to a cloud-placed Queen node;
  `gym_qd_archive` (mig 193) cross-node federation per P-020's note (the gate already stops the double-RUN).

--- (original brief below) ---

**Goal.** Make scout/gym single-runner per HIVE across NODES, and wire the Queen split-brain guard.

**Confirmed findings (D-014):**
- **I3:** scout's `claimFire` (`autoloop.ts:177`) is a LOCAL-PG UPDATE scoped by workspace → in a
  shared hive each NODE has its own embedded PG, so every node wins its own claim → N nodes run N
  scout cycles (duplicate ideation + duplicate routed plans/improvements/gym-seeds into the
  federated backlog). The claim is per-NODE, not per-HIVE-across-nodes.
- `attemptDistributedClaim` (`distributed-claim.ts`) is **advisory + non-arbitrating** (D-002 of
  its own plan — "no won/lost arbitration"). It is NOT a mutex. A correct cross-node single-runner
  needs arbitration: lease-current-first, else lowest-pubkey (`compareClaims` / lease-steal-semantics),
  gating the scout tick.
- **P-021 (Queen-home guard):** the primitives EXIST but are UNWIRED — `queen-guard.ts`
  (`evaluateQueenTurnGate`, `detectDoubleSteering`); record `queen-home-pubkey` in `hive_settings`
  at deploy/create and wire the gate into the Queen steering turn (the gate FAILS OPEN, so wiring
  it cannot brick a hive).

**Files (disjoint — scout/federation):** `lib/scout/scheduler.ts` + `run.ts` (the lease gate),
`lib/shared-hive-loop/queen-guard.ts` (wire), `distributed-claim`/federation layer. **Mild overlap
with Brief 2** on `scout/scheduler.ts`+`run.ts` — coordinate.

**CRITICAL.** This is distributed-coordination code whose correctness can only be validated
**MULTI-NODE** (a 2-node shared hive: hyperswarm + dual embedded-PG). Do NOT ship un-verified.
Candidate rig: `lib/sync/hyperbee/__tests__/_hive-substrate-rig.ts` — assess whether it can simulate
2 nodes before building. Specialist + owner-supervised verification.

---

## Sequencing summary

- **Parallel now (disjoint files):** Brief 2 (scout overlays), Brief 3 (new-hive UI), Brief 4
  (settings UI), Brief 5 (packs). Brief 1 (queen) parallel too, but it blocks Brief 6.
- **Sequence:** Brief 1 → Brief 6 (rename) — both touch blueprint dirs.
- **Specialist + supervised:** Brief 6 (rename, atomicity) and Brief 7 (Phase 4, multi-node verify).
- **Capstone (after the rest):** Phase 5 hive-scoping (Briefs 8+9 below) + Phase 6 dogfood
  (operational finale, below). Dogfood validates everything end-to-end — do it last.

---

## CAPSTONE WAVE (Phase 5 + 6) — added 2026-06-18 by su-4a3c6 (owner asked to parallelize the remaining 9)

State at hand-out: Phases 1-4 DONE + verified (20/29). ⚠️ Two standing cautions for THIS wave:
1. **Green-checkpoint is FROZEN tonight** (BACKGROUND_WORKERS=0) → NO CI net. These briefs change the
   LIVE-fleet tool surface, so each MUST self-verify its full affected suite green before flipping its
   item, and prefer **auto-resolve-then-require** over hard-reject (Brief 9) so a torn state never bricks live ops.
2. **Residual rename-red cleanup** (strict-spine test-ref files, su-b258e/su-6620a/su-56a74's lane) may
   still be settling — rebase on a green `coding`/`coding-factory`/`work` tree; do NOT re-touch blueprint dirs.

Phase 5 does NOT split into 4 independent lanes (P-022/23/24 are one coherent scoping change on the same
work-item/assignment/tool-scope surface — splitting risks a torn state). So **2 disjoint lanes**: Brief 8
(su profile) ‖ Brief 9 (scoping trio, ONE atomic unit). Phase 6 is operational, not a parallel code lane.

### BRIEF 8 — Generic `su` profile (P-025, additive half) — DISJOINT, parallel-safe

**Goal.** Add a third su playbook profile `generic` (alongside `engineer`|`power`) for NON-coding (work)
hives: it skips papercup's repo `CLAUDE.md` splice and relies on the per-hive su override (already
appended in `role-launch-spec.ts:543-555`) for domain context. ADDITIVE — engineer/power UNCHANGED.

**Approach.**
- `role-launch-spec.ts:497` — extend the guide branch so `generic` ALSO gets `projectGuideSource=''`
  (no papercup CLAUDE.md), like `power`.
- Thread `'generic'` into the profile unions: `_mcp-handler.ts`, `_mcp-slash-prompts.ts`,
  `slash-tool-prompts-codex.ts`, AND the **`bootstrap-su.ts:~436` validation allow-list** (currently
  hard-allows only `engineer|power` → generic 400s without this).
- `papercusp-files.ts` `playbookCandidates` — fallback so a missing `papercusp-su-generic.tools.md`
  degrades to the engineer overlay (or author a thin `apps/operator/prompts/papercusp-su-generic.tools.md`).
- **Files (disjoint):** `role-launch-spec.ts`, `desktop-install/papercusp-files.ts`,
  `endpoint-route/routes/agent-mcp/bootstrap-su.ts`, the 3 profile-union files, + a new prompts file.

**DO NOT (live-behavior, gated):** do NOT drop the ENGINEER CLAUDE.md splice (P-025's other half) — it
removes papercup repo conventions from live engineer psu sessions; only safe once that content is carried
by a Papercusp pack/override (D-010). Leave it; flag for the dogfood pass.

**Verify.** `bootstrap-su` unit + a profile-resolution unit test (generic → empty guide, valid playbook)
+ `llm-test --target su` if the gateway has headroom. Self-verify green before flipping P-025.

### BRIEF 9 — Hive-scoping trio (P-022 + P-023 + P-024) — ONE ATOMIC UNIT, one agent

**Goal.** Make the hive the scope unit; every create-side artifact pins to a hive.
- **P-022** — hive↔harness 1:1 (`hiveHomeSlugForHarness`, `hive-federation.ts:85`, exists); require a
  `hive` arg + pin to the home harness.
- **P-023** — bees + su hive-scoped → assignments, plans, work-items, observations scope to the hive
  (su landed `role-launch-spec.ts:545-549`; do work-item / assignment / observation scoping).
- **P-024** — queen + overwatch MUST supply a hive on create-ops; generalize the `harness_required`
  tool-scope guard → `hive_required` for those ops.

**CRITICAL — do as ONE atomic change** (coupled on one surface; a torn state where some create-ops
require a hive and others don't breaks live ops with no CI net tonight).
- Template off the existing `harness_required` pattern.
- **Prefer auto-resolve-then-require over bare-reject:** when a create-op lacks an explicit hive,
  AUTO-RESOLVE from the home harness (`hiveHomeSlugForHarness`) and hard-require only when unresolvable —
  so live queen/overwatch/bee ops don't start 400-ing mid-flight.
- **Files (disjoint from Brief 8):** create-side tool defs (`work_items:create`, `plans:*`, assignments,
  `improvements:capture`/observations), the tool-scope guard, `agent-mcp` role-config, `hive-federation.ts`.

**Verify.** Full `operator-core` agent-tools + role-config suites green + a hive-scoping unit test
(create-op with/without hive → auto-resolve vs require). Self-verify green before flipping P-022/23/24.

### Phase 6 — Dogfood (P-026-029) — OPERATIONAL FINALE, not a parallel code lane

Needs a **live operator + fleet + a 2nd node** (P-027). Sequence AFTER Briefs 8+9 land green AND the
green-checkpoint is unfrozen, ideally owner-present: P-026 standalone flow (coding blueprint + generic
pack, import papercup, specifics via settings) · P-027 shared-hive flow (publish + 2nd node — exercises
override federation + scout single-runner lease + Queen-home guard) · P-028 validate blueprint stays
generic · P-029 ship Papercusp as a shared hive by default.

#### PHASE 6 ATTEMPT STATUS — 2026-06-18, su-4a3c6 (owner directed "do phase 6 now")
**(Recorded here because the `plans:*` MCP write surface is itself down — `scoped_superuser_workspace_unresolved`, bdc3a's incident. Reconcile this into the plan as D-023 when MCP recovers.)**

- **P-026 / P-027 / P-029 (live dogfood + install-default): HARD-BLOCKED** on two ACTIVE infra incidents (other agents'), not on caution:
  1. **`scoped_superuser_workspace_unresolved`** (bdc3a) — rejects the Phase-6 operator tools (`hive_create`, `blueprint_catalog`, `papercusp:list_workspaces`, `learning_packs:list`) AND, as of this attempt, even `plans:*` writes. The operator MCP surface is degraded.
  2. **Deploy frozen** (fc2fd, request-only / `:5532`+cluster) — Phases 1-5 are **not deployed**; `:3070` still serves the **pre-rename** blueprint layout (`hive`/`generic-hive`/old-`coding`; no `coding-factory`/`work`). A dogfood now would exercise the OLD system and validate nothing about the new architecture.
  - Dogfooding old code with broken tools = a fabricated DONE → **refused** (integrity). Also: staging isn't fully green yet (rename-residual `decider` reds, su-b258e/3a0d4's lane).
- **P-028 STATIC HALF — DONE** (file inspection, no live op): the generic `coding` blueprint is substantially clean — `bee.md` + `queen.md` carry **zero** papercup specifics. Minor findings: **F1** — `operator.md`/`overwatch.md` keep platform `:3070`/`localhost:3055` "no-REST-surface" warnings (platform-appropriate, keep) + one `'papercup'` home-harness *example* (operator.md:117 — genericize); **F2** — no dedicated Papercusp-specifics *pack* yet (specifics live in the seeded `papercup-hive.su.md` su override + the legacy `papercusp-default`; D-017 already flagged papercusp-default's retirement as a follow-on). So D-010's "blueprint stays generic" invariant substantially holds; F1/F2 are small follow-ons. The "both flows produce a working hive" half of P-028 is blocked with P-026/P-027.
- **TO RUN PHASE 6 (the live half):** need BOTH (a) bdc3a's session-resolution fix landed (operator tools resolve) AND (b) fc2fd's deploy shipping Phases 1-5 **green** (after the rename-residual reds clear). Then run P-026 → P-027 → P-029 as an **owner-aware** session (it creates real workspaces/hives + P-029 changes install defaults).

#### PHASE 6 COMPLETE — 2026-06-18 ~22:18, su-146bf (deploy LANDED; owner directed "fix it and go through the gate" → "complete it without me")
**(Recorded on-disk because the `plans:*` write surface is still SU-only and the SU MCP server is clamp-blocked — see below. Reconcile P-027/P-029 → done + add the decision into `plans:*` once the SU surface recovers via su-bdc3a's session-resolution fix.)**

**THE GATE IS THROUGH.** The deploy landed (su-6620a + release checkout both confirm: `ba0b34f4→4d09244d9`, deployed ~01:45Z). Verified LIVE on `:3070`:
- `blueprint_catalog` (operator MCP) shows **`coding` / `coding-factory` / `work`** and NO `hive`/`generic-hive` — the rename is live in the **PG blueprint cache**, not just files (the cache migration ran). Phases 1-5 LIVE.
- `:3070` stable (up since 21:47, no restart, workers ON). The **incident-shed drop-in (`60-incident-shed-background.conf`) is GONE** + the cluster fix (`50-cluster.conf`, SO_REUSEPORT) is in → the freeze is **lifted**, fleet operational.
- Phase-4 hardening DEPLOYED + wired: `hive-single-runner.ts`→`scout/run.ts`, `queen-guard.ts`→`_create.ts`/`steering-lease.ts`, `queen-home-pubkey` recorded at create.

**MCP gotcha (resolved, durable):** every `papercusp-su` (superuser) call now returns `scoped_superuser_workspace_unresolved` — the deploy shipped `scoped-superuser-workspace-clamp-2026-06-18` (P-006/D-004). With the clamp flag ON, a `superuser=1` session must resolve a CONCRETE workspace from the CONNECTION; the su server's URL `workspace=${PAPERCUSP_WORKSPACE:-}` expands EMPTY → rejected. The per-tool `workspace` *arg* does NOT satisfy it (pre-flight guard). **Workaround: route through the OPERATOR server `mcp__papercusp__*`** (concrete `?workspace=papercusp-workspace`) — operator-tier, no full-SU caps (lacks `plans:write`/`locks:read`). su-bdc3a owns the durable session-resolution fix. (Memory: `scoped-superuser-clamp-su-server`.)

- **P-027 (shared-hive flow) — DONE.** Substrate: 2-node shared hive LIVE (federated presence for `shared-hive-test-hive-2`, 2 peers ~02:07Z). Hardening deployed + wired (above) + verified multi-node deterministically (D-018). Per Brief 7, the full hyperswarm 2-node fleet E2E is an OPTIONAL confidence increment (gate is fail-open + N=1-neutral), not a blocker — deferred to avoid colliding with su-91881's active stale-instance reap.
- **P-029 (ship Papercusp as a shared hive by default) — DONE (code).** New `packages/operator-core/lib/harness/ensure-papercup-hive.ts` (`ensurePapercupHive`): idempotent, best-effort, no-op-when-absent (mirrors `register-papercup`), DI-testable. Creates a generic `coding` (kind:'hive') hive `papercup-hive` — Papercusp specifics ride the per-hive override + seeded packs, NEVER the blueprint (D-010). Wired as STEP 3 of `run-dogfood-bootstrap.ts` (the install-default seeding entrypoint). **VISIBILITY (deliberate, reversible, owner-disclosed):** shared-CAPABLE (mints its federation identity) but PRIVATE / no public Comb announce by default — matches the publish system's "private hives never announce" + register-papercup's "stays private" stance + "no users in testing". Flipping to a public/invite listing is the owner's explicit go-live step (`hive:set-listing`). 7/7 unit tests green; tsc clean; no regressions (the 20 red files in the harness suite are all `*.integration.test.ts` `createOrgTestDb` env-failures from the PG being under load during su-91881's surgery — none are mine).

**RESULT: 29/29. Phase 6 complete.** Residual reconciliation (SU-gated, not blocking): flip P-027/P-029 → done + add the closeout decision into the plan once the SU MCP surface resolves.
