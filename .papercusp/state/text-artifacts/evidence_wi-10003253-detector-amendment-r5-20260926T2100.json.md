---
rel_path: "evidence/wi-10003253-detector-amendment-r5-20260926T2100.json"
updated_at: 1790456449212
_body: "content"
---

{
  "rubricRef": "acceptance-goal-brief-to-claimed-plan-work-2026-09-23",
  "dryRun": true,
  "criteria": [
    {
      "key": "r-1",
      "title": "Complete, scoped planning-need selection",
      "model": "An active standing goal must identify uncovered outcomes, recurring failures, ineffective current approaches and missing executable work—not infer planning need solely from an empty queue. Its shared brief emits a justified adopt/revise/create-and-start/drain/route/no-new-plan obligation. Empty or terminal-only worklists trigger a scoped gap/frontier review. Existing eligible plans are adopted, not duplicated; other-goal-owned work is routed away.",
      "bar": "An active standing goal must identify uncovered outcomes, recurring failures, ineffective current approaches and missing executable work—not infer planning need solely from an empty queue. Its shared brief emits a justified adopt/revise/create-and-start/drain/route/no-new-plan obligation. Empty or terminal-only worklists trigger a scoped gap/frontier review. Existing eligible plans are adopted, not duplicated; other-goal-owned work is routed away.",
      "barKey": "R-1",
      "barHash": "92422ab3a35fe2ba9b71296a54a8abc350f5226b6852bfdd8ccf0ed8cc45e3e4",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-1, D-003/D-005/D-006, P-001/P-002. REPLICATION DRILL: pin the current tree SHA and run testing:run for packages/operator-core/lib/agent-obligation-planning-demand.integration.test.ts, packages/operator-core/lib/agent-obligation-providers.test.ts and packages/operator-core/lib/goal-planning-obligation-proof.test.ts. Require matched files equal requested files, no route errors/skips and a green verdict before using the runs. Inspect the canonical goal source/worklist revision and supported planning review for uncovered outcomes, failures, existing eligible and terminal-only work. Check adopt/revise/create-and-start/drain/route/no-new-plan dispositions against the source snapshot. FALSIFIED when queue emptiness alone dictates planning, suitable existing work is cloned, foreign-owned work is adopted, or an unreadable source is called no demand. Missing source coverage is unknown. These tree checks do not prove live execution (R-2/R-7). CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.",
      "driftMarkers": "FALSIFIED when queue emptiness alone dictates planning, suitable existing work is cloned, foreign-owned work is adopted, or an unreadable source is called no demand.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/agent-obligation-planning-demand.integration.test.ts",
          "packages/operator-core/lib/agent-obligation-providers.test.ts",
          "packages/operator-core/lib/goal-planning-obligation-proof.test.ts",
          "packages/operator-core/lib/agent-tools/plans/new.workspace-id.test.ts",
          "packages/operator-core/lib/agent-tools/plans/__tests__/new-dedup.test.ts"
        ]
      }
    },
    {
      "key": "r-2",
      "title": "Eligible plans reach real execution",
      "model": "A currently eligible plan must reach an independently led plan fleet, positive plan/plan_item filter, valid delegated lease and actual member claim within two completed eligible decision opportunities after actionable delivery, or expose a current typed blocker with advancing accountable repair. Already-started plans recover their lane rather than creating another plan. This is the primary acceptance bar.",
      "bar": "A currently eligible plan must reach an independently led plan fleet, positive plan/plan_item filter, valid delegated lease and actual member claim within two completed eligible decision opportunities after actionable delivery, or expose a current typed blocker with advancing accountable repair. Already-started plans recover their lane rather than creating another plan. This is the primary acceptance bar.",
      "barKey": "R-2",
      "barHash": "c20fddef39c14ceb41c40eafb493c37348cfac145a8d9c572e5893e375823b00",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "requiredTestLayers": [
        "behavioral",
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: primary R-2, D-003/D-004/D-007, P-003/P-007. REPLICATION DRILL: use P-007's pinned current-build organic trial records; enumerate both origin cases, each delivered eligible obligation and subsequent completed eligible decision opportunities. Join exact goal/plan/item, source generation, independent fleet leader, positive plan/plan_item scheduler filter, delegated lease and work-item member claim identities from canonical fleet/claim records. Require actual member pickup within two completed eligible opportunities, or the current typed blocker plus accountable advancing repair. Inspect already-started-plan recovery for a duplicate fleet. FALSIFIED by leader-only or launch-only evidence treated as pickup, scope/lease mismatch, duplicate execution owner, or two eligible opportunities with neither claim nor progressing repair. Absent demand, exposure, completion or measured admission is unknown, not agent neglect. packages/operator-core/lib/goal-plan-placement-claim-proof.test.ts guards interpretation only; it cannot satisfy this live BAR. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict. RUNTIME: measure the staging operator :3170 and record its served build SHA per Design; :3070 is final shipment only.",
      "driftMarkers": "FALSIFIED by leader-only or launch-only evidence treated as pickup, scope/lease mismatch, duplicate execution owner, or two eligible opportunities with neither claim nor progressing repair.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-plan-placement-claim-proof.test.ts",
          "packages/operator-core/lib/goal-plan-placement-claim.integration.test.ts",
          "packages/operator-core/lib/agent-obligation-providers.test.ts"
        ]
      }
    },
    {
      "key": "r-3",
      "title": "Brief delivery is observable and current",
      "model": "Goal and fleet leader consume the same obligation engine with role-appropriate actions. A source-generation/worklist-revision -> selected obligation -> delivered/non-omitted brief -> decision -> effect trace survives warm turns, cold restart and compaction. Omitted/stale/unmeasured input cannot be reported as ignored by the agent.",
      "bar": "Goal and fleet leader consume the same obligation engine with role-appropriate actions. A source-generation/worklist-revision -> selected obligation -> delivered/non-omitted brief -> decision -> effect trace survives warm turns, cold restart and compaction. Omitted/stale/unmeasured input cannot be reported as ignored by the agent.",
      "barKey": "R-3",
      "barHash": "ad43bda379c21cdc31eddefba0dee6d0b3aaef7b5db5edb0d362a36501e6280a",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "requiredTestLayers": [
        "behavioral",
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-3, D-003, P-001/P-004/P-007. REPLICATION DRILL: for first, warm, cold and compaction turns in the pinned current build, resolve the retained source generation/worklist revision, selected obligation ID, exact delivered non-omitted payload, native completion token and resulting effect. Compare goal and fleet-leader action rendering from the shared engine. Inspect packages/operator-core/lib/goal-placement-turn-receipts.integration.test.ts for PG ACK/native completion controls; require matched files equal requested files and no skipped/error route. FALSIFIED when an omitted/stale/unconfirmed/foreign-session payload is counted as delivered opportunity or an unfinished call as completed neglect. Missing delivery artifacts remain unknown. The deterministic receipt suite supports causal interpretation; healthy on this live BAR requires the actual retained turn traces across the four lifecycle cases. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict. RUNTIME: measure the staging operator :3170 and record its served build SHA per Design; :3070 is final shipment only.",
      "driftMarkers": "FALSIFIED when an omitted/stale/unconfirmed/foreign-session payload is counted as delivered opportunity or an unfinished call as completed neglect.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-placement-turn-receipts.integration.test.ts",
          "packages/operator-core/lib/turn-start-orientation-delivery-proof.test.ts"
        ]
      }
    },
    {
      "key": "r-4",
      "title": "Stalls cause bounded corrective action",
      "model": "Derive no-progress age from canonical effects and completed eligible opportunities, not heartbeat, reads or repeated launches. A live long call, pause, admission restriction, authoritative budget refusal or no demand must not trigger duplicate launches. Diagnose the first refusal; choose another feasible independent lane when permitted. Stop/reassign/escalate through existing authority when the bounded repair makes no progress.",
      "bar": "Derive no-progress age from canonical effects and completed eligible opportunities, not heartbeat, reads or repeated launches. A live long call, pause, admission restriction, authoritative budget refusal or no demand must not trigger duplicate launches. Diagnose the first refusal; choose another feasible independent lane when permitted. Stop/reassign/escalate through existing authority when the bounded repair makes no progress.",
      "barKey": "R-4",
      "barHash": "b78c3ceb0c4dfcdd70df656fb75b71b87baba4e995b1d49ddac45c8a9a852001",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "behavioral",
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-4, D-003/D-004, P-005/P-007. REPLICATION DRILL: run packages/operator-core/lib/goal-placement-progress.test.ts, packages/operator-core/lib/goal-placement-turn-receipts.integration.test.ts and packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts through testing:run; require exact requested-file coverage with no skipped/error route. Inspect first verified effect identity, distinct eligible completed opportunities, fixed repair timestamp and accountable repair action. Exercise duplicate reads/receipts, live unfinished call, pause, denied admission, authoritative budget refusal and independent feasible lane controls. FALSIFIED when reads/heartbeats/repeated launches reset the clock, excluded windows accrue neglect, blocked work triggers duplicate launch, or repair repeats without bounded reassignment/escalation through existing authority. A missing measurement remains unknown, never a zero-age success. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.",
      "driftMarkers": "FALSIFIED when reads/heartbeats/repeated launches reset the clock, excluded windows accrue neglect, blocked work triggers duplicate launch, or repair repeats without bounded reassignment/escalation through existing authority. A missing measurement remains unknown, never a zero-age success.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-placement-progress.test.ts",
          "packages/operator-core/lib/goal-placement-turn-receipts.integration.test.ts",
          "packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts",
          "packages/operator-core/lib/agent-obligation-providers.test.ts",
          "packages/operator-core/lib/goal-placement-turn-receipts.test.ts"
        ]
      }
    },
    {
      "key": "r-5",
      "title": "Budget, liveness and legacy goals retain correct semantics",
      "model": "Unknown spend stays unknown and blocks billable launches. Refusal copy and recommended action match the exact refusal discriminant. Verified tool activity and true silence are distinguished by the existing liveness repair. Legacy worklist values/version are preserved through the existing schema repair.",
      "bar": "Unknown spend stays unknown and blocks billable launches. Refusal copy and recommended action match the exact refusal discriminant. Verified tool activity and true silence are distinguished by the existing liveness repair. Legacy worklist values/version are preserved through the existing schema repair.",
      "barKey": "R-5",
      "barHash": "2e3d5b291710c15d7817e1a7194854cf82dc7880abfd01d5671752f11ef29799",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-5, D-004, P-003/P-005/P-006. REPLICATION DRILL: replay the budget/refusal controls in packages/operator-core/lib/goal-planning-obligation-proof.test.ts and packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts; require matched files equal requested files and no skipped/error route. Resolve the P-003/P-005/P-006 work-item completion evidence and linked budget/liveness/legacy-schema repair records; inspect each cited test and its current source fingerprint before accepting it. Enumerate unknown-spend, measured-overrun, headcount/admission, verified ongoing-tool activity, true silence and legacy worklist value/version cases separately. FALSIFIED when unknown spend becomes zero or permits billing, remedy differs from the refusal discriminant, an active call is treated as silent, or schema repair resets/drops worklist values/version. Unexercised liveness or legacy legs are explicitly unknown; refusal tests alone cannot certify them. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.",
      "driftMarkers": "FALSIFIED when unknown spend becomes zero or permits billing, remedy differs from the refusal discriminant, an active call is treated as silent, or schema repair resets/drops worklist values/version.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-planning-obligation-proof.test.ts",
          "packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts",
          "packages/operator-core/lib/typed-properties.test.ts",
          "packages/operator-core/lib/typed-properties-db.integration.test.ts",
          "packages/operator-core/lib/goal-launch-settings.test.ts",
          "packages/operator-core/lib/agent-tools/coordination/presence.integration.test.ts",
          "packages/operator-core/lib/system-health/goal-holder-respawn.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-6",
      "title": "Rubric judges needed planning and delivery, not output quotas",
      "model": "Preserve the already-ratified five criterion improvements and their keys/checks/scales. Replace the remaining unconditional goal-agent idea-production requirement with evidence of a meaningful scoped gap review: existing plans sufficient is valid, while an evidenced planning need left unaddressed is not. Proposal grades and plan counts cannot satisfy execution demand. Partial repair credit requires fresh causal progress. Historical cards retain their original revisions and instructions.",
      "bar": "Preserve the already-ratified five criterion improvements and their keys/checks/scales. Replace the remaining unconditional goal-agent idea-production requirement with evidence of a meaningful scoped gap review: existing plans sufficient is valid, while an evidenced planning need left unaddressed is not. Proposal grades and plan counts cannot satisfy execution demand. Partial repair credit requires fresh causal progress. Historical cards retain their original revisions and instructions.",
      "barKey": "R-6",
      "barHash": "84ed55d63d5e2c30503fb50cbf311b5f1fe182ebbc30f645d95ebcc81eea383c",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-6, D-006, P-006/P-008. REPLICATION DRILL: read the immutable pre-change and current goal-mode-e2e and work-on-everything-stewardship-health rubric revisions from P-006/P-008 completion refs; compare unchanged criterion keys, checks and scales and resolve historical cards to their original revision/instructions. Run packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts and packages/operator-core/lib/goal-planning-proof.test.ts with full requested-file coverage. Grade supported sufficient-plan/zero-idea review, missing review evidence, recorded-but-neglected need, proposal-only activity and fresh versus repeated partial repair counterexamples separately. FALSIFIED when a new-idea quota remains, output volume substitutes for execution, stale reads earn repair credit, or history/unchanged contracts are rewritten. Missing historical or counterexample evidence is unknown. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.\n\nDETECTOR RESPONSIBILITY: This criterion owns the STANDARD RUBRIC CONTRACT: absence of unconditional idea quotas, preservation of the five ratified improvements and key/check/scale contracts, and immutable historical card instructions. Read the actual named standard-rubric rows plus exact committed-version snapshots. A plan_revisions seq is an audit sequence, never evidence of rubric version identity. An unavailable or ambiguous legacy mapping remains unknown; never silently regrade historical cards using current instructions. The rubric integration suite guards committed-version addressing, equality-proved current legacy reads, rejection of unproven historical aliases and untouched prior snapshots. This suite does not itself prove the live standard-rubric prose or historical card joins; retain those read references separately. Behavioral review and execution-priority decisions belong to R-9; plan authorship and lineage belong to R-8.",
      "driftMarkers": "FALSIFIED when the standard rubrics require a positive new-idea count, accept proposal volume as delegated execution or repeated stale reads as causal repair, rewrite the five preserved contracts without approval, or resolve a historical card to different grading instructions. Unproven legacy version identity is unknown.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts",
          "packages/operator-core/lib/goal-planning-proof.test.ts",
          "packages/operator-core/lib/rubrics.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-7",
      "title": "Behavioral change is measured with both planning origins",
      "model": "After deterministic guards pass and budget permits, run two independent fresh current-build GOAL trials with matched baseline scenarios: one discovers an uncovered need and creates/starts/executes a necessary goal-local plan without a Blender proposal; the other adopts and executes an appropriate Blender plan without cloning it. Each must prove independent member claims and at least one organic end-to-end terminal/verification/feedback/report trace. Also exercise existing-plans-sufficient, terminal/no-demand, blocked-budget, missing-delivery and cross-goal negative controls. Record model/effort, workload, source generation, exact brief exposure, plan/proposal provenance, effects, cost and residual unknowns. No claim of improvement from formatter tests, plan counts, all-terminal trials or unmatched averages.",
      "bar": "After deterministic guards pass and budget permits, run two independent fresh current-build GOAL trials with matched baseline scenarios: one discovers an uncovered need and creates/starts/executes a necessary goal-local plan without a Blender proposal; the other adopts and executes an appropriate Blender plan without cloning it. Each must prove independent member claims and at least one organic end-to-end terminal/verification/feedback/report trace. Also exercise existing-plans-sufficient, terminal/no-demand, blocked-budget, missing-delivery and cross-goal negative controls. Record model/effort, workload, source generation, exact brief exposure, plan/proposal provenance, effects, cost and residual unknowns. No claim of improvement from formatter tests, plan counts, all-terminal trials or unmatched averages.",
      "barKey": "R-7",
      "barHash": "50191521f3a46e046b14308a043ba38de3ff49812fdc3ed0220b09ff54a01251",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "requiredTestLayers": [
        "behavioral"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-7, D-003/D-004/D-007, P-007. REPLICATION DRILL: within existing authoritative budget/admission only, resolve two independent fresh GOAL trials on a pinned current build with matched baseline scenarios: necessary goal-local plan without a Blender proposal, and adoption/execution of a suitable Blender plan without cloning. For each retain model/effort, workload, source generation, exact non-omitted brief, plan/proposal/goal provenance, independent leader/filter/lease/member claim, organic terminal result, verification, feedback and report plus actual measured cost and residual unknowns. Include sufficient-existing-plans, terminal/no-demand, blocked-budget, missing-delivery and cross-goal controls. FALSIFIED by origin duplication, absent independent pickup/organic terminal chain, forbidden budget/admission widening, or improvement inferred from formatter tests, plan counts or unmatched/all-terminal averages. Missing or forbidden billable trials stay unverified; do not launch merely to create telemetry. CHECK COVERAGE: instrument:none is an explicit manual behavioral judgment, not an exemption; the required behavioral clause and every live organic proof obligation remain mandatory. There is no existing instrument that decides this complete matched comparison. RUNTIME: measure the staging operator :3170 and record its served build SHA per Design; :3070 is final shipment only.",
      "driftMarkers": "FALSIFIED by origin duplication, absent independent pickup/organic terminal chain, forbidden budget/admission widening, or improvement inferred from formatter tests, plan counts or unmatched/all-terminal averages.",
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      }
    },
    {
      "key": "r-8",
      "title": "Scope separates planning responsibilities",
      "model": "Blender may generate workspace-level/cross-goal proposals and a goal agent may independently generate plans for its own goal. Both use existing proposal/plan rails. New opportunities do not confer authority over another goal or permit cloning a suitable existing plan. Planning is normally the organizing route; bare work-items remain the exception for self-contained work.",
      "bar": "Blender may generate workspace-level/cross-goal proposals and a goal agent may independently generate plans for its own goal. Both use existing proposal/plan rails. New opportunities do not confer authority over another goal or permit cloning a suitable existing plan. Planning is normally the organizing route; bare work-items remain the exception for self-contained work.",
      "barKey": "R-8",
      "barHash": "19688e6a4cc3ccb0caf4422fd2300a7c91f7e9ccf5f42a8317aa3fea5872304e",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-8, D-005/D-007, P-002/P-008/P-009. REPLICATION DRILL: inspect the canonical GOAL contract and actual retained render refs in P-008; replay packages/operator-core/lib/goal-planning-proof.test.ts, packages/operator-core/lib/agent-obligation-providers.test.ts and packages/operator-core/lib/scout/goal-feedback.integration.test.ts with complete requested-file coverage/no skipped route. Exercise local uncovered-need planning, nonduplicating Blender adoption, supported existing-plans-sufficient review and foreign-goal routing. Confirm original proposal/plan/goal links and one execution owner in the existing records; inspect the plan-organizing versus self-contained bare-item boundary. FALSIFIED by exclusive-Blender authoring, unsupported ownership transfer, cloned suitable plan, new parallel lineage, or a mandatory new-idea quota. These tree controls do not establish P-007's live behavioral outcome. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.\n\nDETECTOR RESPONSIBILITY: This criterion owns SCOPE, AUTHORSHIP AND LINEAGE: both origin routes, one accountable execution owner, adoption or amendment of a suitable plan rather than a clone, retained proposal/plan/goal links, and foreign-goal routing. The actual plans:new handler must return similar_exists before writes for a multi-token duplicate; real plans:edit and Blender feedback must preserve both-origin revision history without increasing the canonical plan census. Review timing and staffing priority are R-9; standard-rubric policy and card-history identity are R-6.",
      "driftMarkers": "FALSIFIED when either scope-appropriate planning origin is prohibited, a suitable canonical plan is cloned instead of adopted or revised, original proposal/plan/goal links or one accountable execution owner are lost, foreign-goal work is appropriated, or bare work items replace necessary organizing plans.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/goal-planning-proof.test.ts",
          "packages/operator-core/lib/agent-obligation-providers.test.ts",
          "packages/operator-core/lib/scout/goal-feedback.integration.test.ts",
          "packages/operator-core/lib/agent-tools/plans/new.workspace-id.test.ts",
          "packages/operator-core/lib/agent-tools/plans/__tests__/new-dedup.test.ts",
          "packages/operator-core/lib/agent-tools/plans/__tests__/edit-handler.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-9",
      "title": "Execution-first priority and meaningful gap review",
      "model": "When suitable executable plans lack workers, staff or repair those lanes before another discretionary ideation pass. When existing plans do not cover the goal's needs, plan the gap. Record a periodic or trigger-driven gap review with evidence and one of the typed dispositions; a reasoned no-new-plan result is valid. No minimum new-idea/feature count and no records fabricated merely to satisfy a quota. Necessary planning, existing-plan progress, owner instructions and genuine blockers determine priority.",
      "bar": "When suitable executable plans lack workers, staff or repair those lanes before another discretionary ideation pass. When existing plans do not cover the goal's needs, plan the gap. Record a periodic or trigger-driven gap review with evidence and one of the typed dispositions; a reasoned no-new-plan result is valid. No minimum new-idea/feature count and no records fabricated merely to satisfy a quota. Necessary planning, existing-plan progress, owner instructions and genuine blockers determine priority.",
      "barKey": "R-9",
      "barHash": "7c2486266c26054700e62a63f69db5f06b3ceefca79c726ab0ef18126a658337",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "tree"
      ],
      "evidencePlane": "tree",
      "requiredTestLayers": [
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-9, D-006, P-002/P-005/P-008. REPLICATION DRILL: run packages/operator-core/lib/agent-obligation-planning-demand.integration.test.ts, packages/operator-core/lib/agent-obligation-providers.test.ts and packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts with exact requested-file coverage and no skipped/error route. Inspect persisted review evidence, current input/worklist fingerprint, periodic/changed-input review trigger and selected obligation ordering. Compare unstaffed eligible plan, uncovered need, supported no-new-plan, stale worklist CAS and blocked draft controls. FALSIFIED when discretionary ideation outranks feasible staffing/repair, unchanged clocks manufacture a new need, uncovered need is silently ignored, or new records are required solely to satisfy a quota. Unknown planning/admission sources stay unknown. R-1 grades selection correctness; this criterion grades priority and the review obligation. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict.\n\nDETECTOR RESPONSIBILITY: This criterion owns EXECUTION PRIORITY AND THE REVIEW DECISION: staff an eligible executable plan before discretionary ideation; establish due-review inputs, delivered opportunities, supported typed review dispositions and handling of a neglected need. A supported sufficient-plans review with zero new ideas passes this review leg. Missing delivery or unreadable scope is unknown, not a skipped-review failure. R-6 separately inspects the standard-rubric policy; R-8 separately inspects authorship and canonical lineage.",
      "driftMarkers": "FALSIFIED when discretionary ideation displaces staffing eligible executable work, a due review is skipped after two proven eligible opportunities, an evidenced planning need is left without a valid disposition, or unsupported review assertions receive credit. Correctly supported existing-plan sufficiency with zero new ideas is valid; unmeasured delivery or review capability is unknown.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/agent-obligation-planning-demand.integration.test.ts",
          "packages/operator-core/lib/agent-obligation-providers.test.ts",
          "packages/operator-core/lib/goal-review-obligation-verdict.integration.test.ts"
        ]
      }
    },
    {
      "key": "r-10",
      "title": "Feedback retains scope and origin",
      "model": "Goal-local recurring problems and observed outcomes feed Blender's broader learning; Blender proposals are routed to the appropriate goal holder. Preserve original proposal IDs, plan refs, goal attribution and amendment/adoption history on existing evidence/routed-idea/outcome surfaces. One accountable execution owner remains visible; feedback or refinement must not silently fork another plan.",
      "bar": "Goal-local recurring problems and observed outcomes feed Blender's broader learning; Blender proposals are routed to the appropriate goal holder. Preserve original proposal IDs, plan refs, goal attribution and amendment/adoption history on existing evidence/routed-idea/outcome surfaces. One accountable execution owner remains visible; feedback or refinement must not silently fork another plan.",
      "barKey": "R-10",
      "barHash": "766dbf05ad46c84d0728ee551fc54432c4deed7a82f4ff11f73e460dd5e18226",
      "role": "outcome",
      "mandatory": true,
      "requiredScope": [
        "live"
      ],
      "evidencePlane": "live",
      "requiredTestLayers": [
        "behavioral",
        "integration",
        "unit"
      ],
      "passRatings": [
        "healthy"
      ],
      "barProvenance": {
        "lifecycle": "pre-implementation",
        "declaredAt": "2026-09-23T05:47:42.106Z",
        "declaredBy": "su-9a43633d-fac7-46a7-b714-7bf50b87dc7b"
      },
      "method": "TRACE: R-10, D-007, P-009/P-007. REPLICATION DRILL: use both P-007 organic terminal traces on the pinned current build; resolve original proposal ID, plan ref, goal holder, routed-idea/goal-evidence/outcome feedback entries and adoption/amendment history before and after feedback. Enumerate both origins plus cross-goal routing and revision, checking one lineage and one accountable execution owner. Replay packages/operator-core/lib/scout/goal-feedback.integration.test.ts with full requested-file coverage as the persisted-writer guard; inspect P-009's ownership and attribution mutation evidence. FALSIFIED by duplicate idea/plan, reassigned original origin/goal, discarded revision history, feedback credited to the wrong holder or terminal evidence not reaching the existing feedback surface. Deterministic integration/mutation passes support the mechanism but cannot replace the required organic live feedback/report chain. Missing live records remain unknown. CHECK COVERAGE: the bound tests mechanically guard the named mechanism only. Healthy also requires every remaining method clause; especially organic runtime, liveness/history and behavioral evidence cannot be replaced by the bound test verdict. RUNTIME: measure the staging operator :3170 and record its served build SHA per Design; :3070 is final shipment only.",
      "driftMarkers": "FALSIFIED by duplicate idea/plan, reassigned original origin/goal, discarded revision history, feedback credited to the wrong holder or terminal evidence not reaching the existing feedback surface.",
      "check": {
        "kind": "tests",
        "files": [
          "packages/operator-core/lib/scout/goal-feedback.integration.test.ts",
          "packages/operator-core/lib/scout/goal-feedback.test.ts",
          "packages/operator-core/lib/agent-tools/plans/__tests__/edit-handler.integration.test.ts"
        ]
      }
    }
  ],
  "expectedRubricRevision": 4,
  "expectedSubjectPlanRevision": 14,
  "idempotencyKey": "su9399-detector-amendment-20260926-r5",
  "reason": "WI-10003253: bind measured missing detectors and partition R6 standard-rubric/history, R8 scope/lineage, and R9 priority/review falsifiers without changing outcomes, planes, mandatory flags or pass ratings. Governed outside-lineage approval and vet required before any evidence refresh."
}
