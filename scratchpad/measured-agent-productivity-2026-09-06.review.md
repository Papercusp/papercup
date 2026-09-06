# Draft: Faster verified agent progress

Review snapshot of canonical plan `plan://papercusp/measured-agent-productivity-2026-09-06`. Draft only; implementation awaits Avi's review. This copy is for convenient reading; the shared plan store is authoritative.

## Now

**State:** DRAFT FOR AVI REVIEW. Implementation of the new productivity/context changes is paused. No plan start, activation, new fleet, model/account/carry change, or additional compaction-limit increase is authorized by this draft. The existing P203 release repair and independent release review continue; the already-assigned P524 evaluator correctness repair remains part of the original release work.

**Next:** Review the design choices below, especially the higher-context trial and what counts as a useful work result. After Avi approves a route, audit the full source conversation, resolve any changed requirements, then activate only the approved scope.

## Background

Avi asked what remains before the P2P release ships, whether the past two days produced real progress, and how to prevent slow progress. He then explicitly requested a plan for discussion BEFORE implementing these improvements. He challenged the initial framing of startup-context reduction: relevant preload can avoid expensive tool calls, and raising the context limit may be preferable. This plan adopts that correction.

Measured on 2026-09-06:
- The global fleet-member default was already raised to250,000 on2026-09-02 (WI-2142006, commit da4faafb08b); current source explicitly says not to reduce it back. Registry read at22:42Z found unintended200,000 overrides on this release fleet. All three were corrected to250,000 and independently read back; leader remains400,000. Approved250k is the settled baseline, with existing smaller-model capacity guards preserved.
- Earlier reviewer configuration was90,000 while fresh native requests started around104,000 input tokens. This mismatch can trigger recovery before substantive work. The reviewer was raised to200,000 before this review gate; no further increase is proposed as already executed.
- Native source-worker/reviewer records show repeated carries whose useful output was identity/claim verification and re-reading the same checkpoint. Other periods did produce code/tests: this is not a claim that all recovery or investigation is waste.
- Live MCP wrapper metadata contains roughly188k characters of shared initialization text including an unfiltered runbook index. Source renderInsightsPrelude maps all visible entries without a total bound. We have NOT proved that all wrappers enter every prompt independently, that all this material is irrelevant, or the completion-time benefit of removing it. Measure the actual request before deciding.
- A separate quota latch blocked valid worker wakes. Manual identity-preserving recovery restored pickup; automatic recovery remains unfinished.
- The P524 evaluator ignores stronger targeted L4 proof when checking an L3 floor. The current source defect is confirmed; P523 still needs its separate semantic requirement census.

Evidence: WI-2037678 posts199503/199509; WI-2147007 post199497; EI-22551484563306678; EI-22468214065196523; EI-22552545539859127. EI-22552602791917468 is an observation linked to the evaluator bug, not a second implementation task. Planning work is WI-10000322.

## Requirements

1. Optimize time and cost to a correct, independently checkable result. Fewer tokens or fewer tool calls alone is not success.
2. Preserve useful, relevant preload. Remove duplicate or irrelevant material only with evidence that it is unnecessary for the selected task.
3. Preserve mandatory owner instructions, authorization, identity, locks, held work, unresolved questions, corrections and acceptance constraints deterministically. Never trim them silently to fit a target.
4. Compare higher compaction targets fairly against relevance/deduplication changes; no preselected winner.
5. Treat startup payload, transcript growth, compaction policy and the model/CLI context ceiling as separate quantities.
6. Reuse current docs/search, carry/checkpoint, event/wake, fleet/claim and test-evidence primitives. Extend existing mechanisms; no parallel scheduler, memory store, monitoring service or new model-routing system.
7. Detect repeated lack of useful progress without penalizing legitimate investigation, independent review, an external wait, or an already-owned blocker. A new discriminating finding can be useful progress without a code edit.
8. Preserve reviewer independence, exact evidence freshness, physical acceptance, independent GO, the actual72-hour canary and final shipment checks.
9. Draft-only until review. Do not alter fleet-wide defaults, role caps, carry mode or automatic recovery authority before approval.

## Definitions

A recovery-only cycle means a resumed work period consumes its budget verifying identity, reclaiming already-assigned work, rereading prior records and writing another recovery checkpoint, without a new tested change, discriminating observation, completed review/census, or acceptance decision. One necessary recovery is normal. Repeating the same cycle is the failure to detect.

Startup context means the instructions, current state, tool metadata and reference material present in the FIRST model request. It is distinct from output produced later in the turn. The soft compaction target is when this workspace asks a session to rebuild its context; raising it does not enlarge the model's maximum input window.

## Design

### 1. Measure before selecting a context strategy

Break down actual first-request tokens into mandatory instructions, task-specific preload, shared tool metadata, repeated material, runbook index, carried history and current state. Inspect the current writer and provider/CLI reporting for each metric. Use one representative coding task, one independent review task and one investigation task, with stable acceptance checks. Record time to first useful result and final verified result, retrieval round trips/latency, compactions, repeated recovery, cached/uncached input and actual cost when available. Failed or stalled runs remain in the comparison; do not cherry-pick.

### 2. Run a bounded comparison

Compare: current relevant preload/current target; the SAME preload with a higher target; relevance/deduplication changes at the original target; and the combined option.

250k is already Avi's approved default for all fleet members, not a new experimental choice. First measure performance at that baseline with the same useful preload. Compare a higher target such as400k only after effective CLI/model-window verification and explicit review of the existing member-cap policy. Do not benchmark by silently reverting members to200k or ask Avi to approve250k again.

Useful preload stays in every variant. Fetching frequently-needed material repeatedly can make a smaller prompt worse. Select by verified completion time/cost/quality, not prompt size. Abort any variant that loses a required instruction, unresolved owner message, provenance, evidence coverage or safe tool behavior.

### 3. Improve relevance and eliminate repetition if the measurements support it

Deduplicate shared instructions at the actual delivery layer only after confirming duplication in the real prompt. Preserve task-linked runbooks and proven frequently-used references. Replace an unfiltered encyclopedia with task-selected references plus a compact discoverable catalog, explicit omission information and exact retrieval links. Do not use alphabetical first-N truncation as relevance selection.

Carry the latest useful state, next concrete action, existing evidence references and unresolved issues once. Older history remains searchable. Test retrieval misses and rare but important rules. If the mandatory context alone leaves insufficient working space, surface that configuration mismatch and choose more headroom rather than deleting mandatory material.

### 4. Recover real failures and stop repeating unsuccessful cycles

Extend the existing quota-NACK/carry recovery path with measured eligibility and same-owner preservation. Missing provenance, missing capability or ambiguous owner input remains fail-closed. Rate-limit and deduplicate recovery attempts; prove real pickup rather than counting queued delivery.

Proposed operating threshold for review: two consecutive recovery-only cycles trigger one diagnostic intervention by the registered leader. Repeated recovery is not an automatic reason to kill a live worker or widen permissions. Reuse current fleet health/events; inspect the actual blocker and the last useful artifact, then repair, re-scope or park on a real event with a bounded timeout. This threshold is a proposal, not an implemented global rule.

### 5. Make acceptance and handoff cheaper

Validate evaluator behavior with small positive/negative fixtures before expensive evidence assembly. Preserve immutable evidence when its relevant inputs are unchanged. Re-run only after pertinent input changes, failures or unresolved concerns. Maintain an explicit requirement-to-proof census so narrow mutation evidence cannot masquerade as full intent coverage.

Keep one active atomic unit per worker and make handoffs include the current result, next action and stop condition. Use the existing durable assignment/scope mechanism and confirm pickup. Prioritize blockers of the current release; record other findings without turning each one into another simultaneous mission.

## Phase 1 — Baseline and decision

- **P-001** `todo` Measure actual startup/transcript/compaction composition and productive-result baseline across coding, review and investigation examples; verify metric writers, effective windows and current role caps. Reuse EI-22551484563306678 evidence. importance: high
- **P-002** `todo` Compare higher-context, relevance/deduplication and combined strategies on the same bounded tasks; present the result and recommended target/preload policy to Avi before any fleet-wide default change. blocked-by: P-001 importance: high

## Phase 2 — Approved repairs

- **P-003** `todo` Implement only the selected context/preload/limit policy using current rendering and configuration seams; test relevant preload retention, mandatory-rule preservation, retrieval fallback, actual boot size and restart persistence. Reuse EI-22551484563306678. blocked-by: P-002 importance: high
- **P-004** `todo` Complete bounded quota recovery in the existing wake/carry mechanism with same-owner, eligibility, deduplication and confirmed-pickup tests. Reuse EI-22468214065196523; retain any already-written atomic work as evidence. blocked-by: P-001 importance: high
- **P-005** `todo` Add the approved repeated-recovery intervention to existing fleet health/events, with tests distinguishing useful investigation from recovery-only activity and preventing duplicate supervisors or takeovers of progressing peers. blocked-by: P-003 importance: high
- **P-006** `todo` Verify cheap acceptance preflight, exact evidence reuse and complete requirement census through existing grading/ledger surfaces; consume EI-22552545539859127 instead of duplicating its release repair. blocked-by: P-001 importance: high

## Phase 3 — Limited rollout

- **P-007** `todo` Run the approved approach on the existing release fleet, compare against the baseline, independently verify quality and preserved guardrails, and propose broader rollout only if completion improves. Record cost/latency uncertainty and a tested rollback to the approved250k baseline and original preload. blocked-by: P-003, P-004, P-005, P-006 importance: high

## Acceptance

A successful trial yields faster verified completion or lower cost at unchanged completion quality, with fewer repeated recovery-only cycles; state the measured effect and uncertainty. A lower token count with more retrieval, more missing context, lower coverage or slower completion fails. Mandatory instructions and unresolved owner questions survive the launch/carry tests; quota recovery preserves identity and reaches a real tool call; recovery detection does not punish productive investigations or duplicate an existing leader.

## Launch configuration and soft-target proposal

Avi's latest requested design is incorporated here for review:

- The defaults are400k for fleet leaders and250k for fleet members. The approved minimum member target is250k. Offer250k,300k,350k,400k launch presets as explicit task-based overrides; do not confuse these selectable overrides with the role defaults or offer200k as a routine member choice.
- A launching leader chooses the fleet's member default for the task; allow an explicit per-member choice from the same presets. Configure the leader's own target independently. Existing400k leader settings are not reduced automatically.
- Suggested starting guidance:250k for focused fixes/reviews,300k for moderate multi-file work,350k for broad integration,400k for wide audits or sustained coordination. These are selectable heuristics, not measured guarantees.
- Reuse the existing compactionLimit field on fleet:launch-on-plan and its per-member overrides, plus fleet:reconfigure-member. Extend its validation/preset UI rather than creating a second settings system.
- The present250k member ceiling must permit owner-approved300k–400k selections. Preserve the actual model/CLI capacity and output/headroom checks. If a model cannot support the chosen minimum, report incompatibility explicitly rather than silently choosing a smaller target.
- Show effective target, global default, any override, who set it and why. Prevent an agent or inherited stale checkpoint from silently pinning a routine fleet member below250k. Test launch, carry, recovery and runtime reconfiguration persistence.
- A soft target should signal a clean stopping point, not interrupt useful work automatically at the first warning. Reuse the existing20% overshoot concept: permit completion of the current bounded atomic step, then checkpoint and compact; do not begin a new unit beyond the target. The real context/output-reserve ceiling still wins. Align agent prompts, watchdog and configuration calculations so they do not give conflicting rules.
- Current leader recommendation: retain400k for this release and permit controlled completion headroom; no measured evidence yet justifies increasing its base above400k. A later larger-window experiment is an explicit choice.
- Why the earlier override happened: repeated compaction warnings and inherited200k checkpoints were treated as the operating target, while250k was treated only as a cap. That was an agent error: current source had already adopted Avi's Sep2 default and explicitly warned against lowering it. Configuration provenance and minimum validation should make that error visible/refusable.

This extends P-002's comparison, P-003's selected launch/config implementation and P-007's end-to-end acceptance; it does not authorize implementation before review.

## Review choices

- Whether a further400k worker pilot is worth testing after effective-window verification;250k is already approved and is not an open question.
- Whether two consecutive recovery-only cycles is an appropriate diagnostic threshold.
- Which task evidence belongs in guaranteed preload; measurements must include the retrieval cost of moving it out.
- Execution remains the existing fleet unless Avi chooses another route; no new fleet/model/account/carry choice is inferred.

## Decisions

### D-001 — Owner-directed review boundary

 this is a draft for discussion, not authorization to execute the productivity program.
### D-002 — Preserve useful preload

 useful relevant startup context may improve speed by avoiding tool calls. Relevance and total task performance govern; shrinking alone is not the objective.
### D-003 — Reuse and scope

 reuse existing release bugs and the shipped fleet-worker-lifecycle-convergence-2026-08-26 mechanisms. This is a new measured follow-up, not reopening that shipped plan or replacing the P2P release plan.


## Related work and duplication boundary

Read drain-control-plane-resilience-2026-08-13 Requirements and Now before creating this draft: it is approved/in execution and owns broad transport bounds, managed task continuity, canonical queue recovery and fleet acceptance. Do not modify or reopen it from this draft. This is a distinct owner-requested performance comparison of context targets, relevance and productive task completion; reuse that plan's mechanisms and verification. Before activation, adopt/link existing EI work rather than minting parallel implementation tasks. P-004 and P-006 integrate and verify already-owned repairs. Broader defaults remain owner-gated.

OpenAI's fetched GPT-5.6 Sol model documentation advertises a1,050,000-token window: https://developers.openai.com/api/docs/models/gpt-5.6-sol . The effective CLI/provider configuration must still be measured before a higher-limit pilot. Codex documents model_context_window separately from model_auto_compact_token_limit and its scope: https://learn.chatgpt.com/docs/config-file/config-reference . This draft changes neither setting.
