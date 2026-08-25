---
rel_path: "reports/unshipped-plans-audit/august-non-blender-closeout-70-2026-08-25.json"
updated_at: 1787646091571
_body: "content"
---

{
  "schemaVersion": "august-non-blender-closeout-v1",
  "generatedAt": "2026-08-25T08:09:52.971Z",
  "sourceAudit": "reports/unshipped-plans-audit/latest.json",
  "correction": "70 plans; prior 69 was an arithmetic error",
  "rule": "created in August 2026; nonterminal; category in acceptance-residue/closeout-evidence-missing/closeout-stale-audit/closeout-status-residue; canonical content does not contain frontmatter origin: scout",
  "rows": [
    {
      "slug": "acceptance-rubrics-on-every-plan-2026-08-11",
      "title": "Acceptance rubrics on every plan (rubric kind: standard | acceptance)",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-11",
      "updated": "2026-08-11 19:22:25.972923-04",
      "itemTotal": 8,
      "terminalPlanItems": 7,
      "openPlanItems": 1,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7,
        "todo": 1
      },
      "audit": null,
      "acceptanceRubric": {
        "rubricId": "acceptance-acceptance-rubrics-on-every-plan-2026-08-11",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-001..P-007 done (rubric kind schema + store scoping + linkage + completion gate + 4 class-rubric seeds + docs), verified: lint:tsc green, lint:tool-prompts green, flags tsc green, 164 targeted tests green. P-008 pending the full test:affected sweep now live (pid 1786938, log /tmp/papercusp-affected-tests-1786938-39ecc13d.log; push watcher armed by su-c9283).",
      "nowNext": "su-c9283: on sweep green flip P-008 done; then once dev:pipeline_position shows the schema live on :3070, rubrics:propose the acceptance rubric FOR this plan (kind acceptance, classRef plan-class-feature-ship) and get a NON-implementer to grade it; then report to Avi."
    },
    {
      "slug": "cupboard-plan-rubric-recipe-sharing-2026-08-21",
      "title": "Cupboard sharing for plans, rubrics, and recipes — new listing kinds + plan→rubric dependency gating",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-21",
      "updated": "2026-08-22 15:57:05.233683-04",
      "itemTotal": 16,
      "terminalPlanItems": 15,
      "openPlanItems": 1,
      "workItemTotal": 13,
      "openWorkItems": 2,
      "workItemStates": {
        "done": 10,
        "dropped": 1,
        "open": 2
      },
      "itemCounts": {
        "done": 14,
        "dropped": 1,
        "wip": 1
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-22 08:44:08.125771-04",
        "auditedSha": "a3013d71d3eb16a84bc437e2dd7a551274058ac5",
        "auditedItems": 15
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-cupboard-plan-rubric-recipe-sharing-2026-08-21",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-016 remains the final implementation/verification item; its implementation/focused corpus and exact one-shot affected command are stored on WI-40531. Root HEAD and network origin/staging agree at ac12c47a7c79f1b208b160058fe421d987d5e549 with both stale-index.lock guard commits. Desktop gitlink/HEAD/origin-main agree clean at 8814724ec3b05d7daf7a614231cbbd9a38eedc3b. Freeze remains open: live EI-21165235642497045 owns seven staged plus one unstaged provenance-lint paths, has 195/195 focused proof, and is actively adding/rerunning regressions under a sole lock. Two new untracked observation-fold files appeared at 15:53-15:54 EDT; no current lock or coord/work-item search match identified their owner yet, so they also block clean qualification until published/removed by their live writer. Serializer owner is live, adopted exact gate emission after terminal blockers + two stable clean reads + published tip + idle run-lock, and has launched no checkpoint. Gate harness:papercusp:wi-40086-qualified-current-tip gen 1 remains unfired/null. WI-40648 is terminal done and not awaited.",
      "nowNext": "Keep existing exact-gate await and 60s loop fallback. On event/timeout re-read EI-211652 activity/locks, resolve observation-fold writer if still present, full git status including staged/untracked, root/network/desktop, exact event and release trace. Take over only if progress stops. On fired SHA verify trace, run saved P-016 affected command once, then audit/close residues, refresh plan audit, obtain independent grade, implementer verdict, ship and verify."
    },
    {
      "slug": "drain-control-plane-resilience-2026-08-13",
      "title": "Drain Control Plane Resilience — Verified Recovery and Canonical Work",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-13",
      "updated": "2026-08-14 09:28:27.131624-04",
      "itemTotal": 10,
      "terminalPlanItems": 9,
      "openPlanItems": 1,
      "workItemTotal": 4,
      "openWorkItems": 1,
      "workItemStates": {
        "done": 3,
        "open": 1
      },
      "itemCounts": {
        "done": 9,
        "wip": 1
      },
      "audit": null,
      "acceptanceRubric": {
        "rubricId": "drain-control-plane-resilience-2026-08-13-acceptance",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "APPROVED AND IN EXECUTION. Avi approved start-to-finish implementation on 2026-08-13 and required acceptance grading to launch a fresh dedicated headless non-implementer rather than distract an existing peer. The requirements/design spec triad is complete; P-010 and D-006 encode the grader workflow. WI-38399 is being closed, then Phase 1 begins in dependency order. No implementation claim should skip the lossless-foundations ordering.",
      "nowNext": "Close WI-38399 with plan revision 20 evidence; convert and claim P-001; inspect the universal result-door writer and existing overflow-family work before editing."
    },
    {
      "slug": "email-app-2026-08-23",
      "title": "Email app — standalone papercusp app (own harness) on triggers + Gmail, web + desktop",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-23",
      "updated": "2026-08-24 19:40:41.463249-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 7,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 7
      },
      "itemCounts": {
        "done": 7
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-24 19:45:51.167528-04",
        "auditedSha": "0e1a4bc9b04e18ce1dabe2837b782737cfa073fb",
        "auditedItems": 7
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-email-app-2026-08-23",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "acceptance_ungraded",
        "message": "plan 'email-app-2026-08-23' cannot be marked shipped: its acceptance rubric 'acceptance-email-app-2026-08-23' has no complete grading. A NON-implementer (someone other than 'su-9613bc92-8c36-43d1-a4af-fce37e0502fc') grades it — scorecards:emit { rubricRef:'acceptance-email-app-2026-08-23', ratings:{ <every criterion key> } } with concrete evidence per rating — then the ship succeeds (grader ≠ implementer, plan D-005)."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Owner re-authorized direct implementation in AUTO mode on 2026-08-24. Prior fleet member is ended and holds no claims. The canonical seven-item plan is now owned by su-9613bc92; requirements and design are audited against the full source conversation.",
      "nowNext": "Materialize the `email` app through `templates:new-app` only after verifying the live `skipWorkspaceTx` fix and ensuring no stranded `email` directory or harness registration exists. Then implement P-002 through P-007 in dependency order."
    },
    {
      "slug": "fundraise-automation-2026-08-23",
      "title": "Fundraise automation — agent-run investor outreach (the outreach system IS the demo)",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-23",
      "updated": "2026-08-23 18:54:03.791399-04",
      "itemTotal": 15,
      "terminalPlanItems": 9,
      "openPlanItems": 6,
      "workItemTotal": 15,
      "openWorkItems": 14,
      "workItemStates": {
        "done": 1,
        "open": 8,
        "blocked": 6
      },
      "itemCounts": {
        "needs-human": 2,
        "blocked": 4,
        "done": 9
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": true,
        "typedHuman": true,
        "refs": [],
        "staleHints": []
      },
      "nowState": "IMPLEMENTED 2026-08-23 (owner-directed, AUTO). 9 of 15 items done; the rest are parked on owner data or named external gates, not silently skipped. Built and green (67 tests, changed files tsc-clean): the `pipeline-deal` registry datatype (generic-kind, no migration needed) carrying stages, tiers, warm path and the outreach-approval record — domain-neutral so sales/BD/hiring reuse it, with people and threads referencing canonical `contact`/`email-message`/`calendar-event` rather than investor-flavoured copies; `libs/papercusp/plugins/fundraise-pipeline/`, a 7-target/7-binding/1-edge trigger pack (research, first touch, reply classification, follow-up ladder, meeting prep, post-meeting, weekly review); `packages/operator-core/lib/fundraise/outreach-approval.ts`, the send-approval gate, which fails CLOSED and binds each approval to a specific draftRef so approval cannot transfer to regenerated content; `pipeline-tiering.ts`, the list rule with no way to represent a tier 3; and the runbook at /internal/docs/agent-insights/running-a-fundraise-on-the-product. THE PACK CANNOT SEND MAIL: it requests gmail.compose and deliberately no gmail.send, so every path ends at a draft — a property of the granted scopes rather than of the agent following instructions, guarded by a test that fails if anyone adds a send scope. Nothing here is armed: every binding ships disarmed and installation arms nothing.",
      "nowNext": "OWNER, two things, neither blocked on engineering: (1) supply the actual target names (P-001) and your actual personal network for the intro graph (P-002) — the tiering machinery is built and tested, but no fund list was invented because fabricating fund theses is the worst failure available in this domain; (2) pass live Slack/Gmail acceptance (P-012), the one hard blocker, since every event-driven binding rides live Gmail/Calendar and it needs provider credentials plus a desktop session. P-010/P-011 additionally wait on the byoc-cloud-workspaces lane, and P-013's build-in-public cadence is a content decision. When those clear, arm in this order: install → seed and qualify the list → arm weekly-pipeline-review FIRST so the human review gate exists before the approval queue it governs → research-enrichment → first-touch-outreach → the event-driven reply and meeting bindings last, once drafts are landing and reading well."
    },
    {
      "slug": "iphone-public-release-2026-08-11",
      "title": "iPhone app — public release readiness and delivery",
      "harness": "papercusp",
      "status": "active",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-11",
      "updated": "2026-08-24 23:56:05.421162-04",
      "itemTotal": 5,
      "terminalPlanItems": 4,
      "openPlanItems": 1,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4,
        "needs-human": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": true,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Steward audit 2026-08-25 (goal work-on-everything-0a8163, worklist rank 7): P-001, P-002, P-003 and P-004 are all done — baseline re-audit, product/service blockers, store compliance, and the verification matrix are complete. P-005 (produce the release archive/IPA and submit through the configured Apple delivery path) is needs-human: owner-gated on the Apple delivery decision/credentials. The prior Now was stale — it claimed P-001 in progress under solo driver su-33dd2, but P-001 closed 2026-08-11 (committed) and su-33dd2 no longer exists in the workspace roster (targeted presence lookup, ended included, returns zero rows). No live claims on this plan; nothing here is agent-placeable until the owner acts on P-005.",
      "nowNext": "OWNER acts on P-005 (Apple delivery path/credentials → submit → verify artifact). After that, run the plan-completion flow (per-item code-truth audit + graded acceptance rubric) toward shipped."
    },
    {
      "slug": "learning-loop-identity-and-consumption-2026-08-08",
      "title": "Learning loop: give observations and ideas a stable identity, and make consumption visible",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-08",
      "updated": "2026-08-24 20:43:57.579052-04",
      "itemTotal": 15,
      "terminalPlanItems": 14,
      "openPlanItems": 1,
      "workItemTotal": 15,
      "openWorkItems": 1,
      "workItemStates": {
        "done": 14,
        "blocked": 1
      },
      "itemCounts": {
        "done": 14,
        "blocked": 1
      },
      "audit": {
        "auditSeq": 2,
        "createdAt": "2026-08-22 17:27:42.179056-04",
        "auditedSha": "9fc84e3b5e9ef777ec74f0d194ef1fb0e01c9bef",
        "auditedItems": 11
      },
      "acceptanceRubric": {
        "rubricId": "learning-loop-identity-consumption-acceptance",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": true,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Phase 5 implementation and acceptance validation remain complete. P-016 remains in a VALID continuous post-deploy maturation window. Original start is 2026-08-23T17:39:44.625-04:00; earliest measurement remains 2026-08-30T17:39:44.625-04:00. Intervening deploy 6760f8ec31cc8157f05a223595993b40d6f020da preserved the target: release checkout HEAD exactly matched the event SHA and `git merge-base --is-ancestor 51c52bae1… 6760f8ec…` exited 0. Runtime continuity is confirmed: release HEAD moved at 2026-08-23T23:46:54.053-04:00 and papercup-dev-api is active/running since 23:56:02-04:00. Therefore the clock does NOT reset. The superseded August 22/August 29 window remains invalid. P-016 is the sole residue.",
      "nowNext": "Continue the six-hour monitor plus release:deployed:* await 84953. Revalidate target ancestry/runtime on every intervening deploy; reset only if target inclusion is lost. At or after 2026-08-30T17:39:44.625-04:00, re-read live ancestry/runtime, execute WI-40694's exact D-044 SQL plus same-predicate row-minting comparison, apply sustained-breach rule, publish outcome, and close P-016/WI-40668/WI-40694 and the plan."
    },
    {
      "slug": "official-mobile-app-templates-2026-08-20",
      "title": "Papercusp Official Android and iPhone app templates",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-20",
      "updated": "2026-08-22 01:27:20.360265-04",
      "itemTotal": 20,
      "terminalPlanItems": 19,
      "openPlanItems": 1,
      "workItemTotal": 19,
      "openWorkItems": 1,
      "workItemStates": {
        "done": 18,
        "open": 1
      },
      "itemCounts": {
        "done": 19,
        "todo": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Phases 0-4 complete: both app roots, both shells, papercusp-mobile-base, listings, GUIDEs and the check contracts are authored and in the bundled store. 17 of 19 original items done; P-018 wip, P-019 + P-021 todo. P-018 is PARTLY proven: BOTH platforms are now materialized through the REAL templates:new-app flow — Android `stonebrook-android-20260821` (\"Stonebrook Ledger\") and iPhone `thornbury-iphone-20260821` (\"Thornbury\"). Against the Android greenfield these clauses are VERIFIED: all 12 decision points answered; the 3 resolved manifests retained at exact 0.1.0 pins; the checks union wired, GREEN (2 passed | 4 skipped) and falsifiable; no committed secrets. That proof found EI-21110451200329856 — both app roots shipped checks resolving deps via sibling `../../papercusp-<id>` paths existing only in the repo templates dir, so the union was RED in every materialized app. Fixed via tri-state resolveSiblingClosure across 6 files, and those 6 are now ALL COMMITTED (the earlier \"still uncommitted\" note is superseded). Verifying that fix surfaced its DETECTOR half, EI-21112293570332409: `templates/**` routed only to operator-core, so the recurrence guard — which lives in @papercusp/template-kit — was never selected by a change to the files it guards, meaning a reintroduction would have passed scoped test:affected GREEN and surfaced only at the green-checkpoint hours later. Fixed with a second composing NON_WORKSPACE_PATH_ROUTES entry (verified with control + negative control) and 4 new guard cases (10 -> 14 passing), the 4th a DERIVED ratchet asserting every workspace owning a templates/-scanning test is reachable — a hand-maintained list is what missed this. NOT satisfied: Acceptance #4, an installable emulator/simulator build that actually LAUNCHES (a compile is NOT sufficient), for either platform. Hosts ready: Android SDK with ndk 27.0.12077973 + android-34 + all 4 Rust targets; macOS VM on ssh 127.0.0.1:2222, Xcode 16.4, simulator booted.",
      "nowNext": "Fleet `mobile-greenfield-build` (leader su-b8d5f) is executing the app-build half of P-018 — su-2590ac9b on WI-40367 (Android/Stonebrook), su-ca7336d6 on WI-40368 (iPhone/Thornbury) — and both must land install+LAUNCH evidence, not compile logs; the leader then takes P-019 (acceptance matrix, listings, storefront discovery, release decision) and P-021 (public releases), before the ship gate: per-item plans:audit code-truth -> acceptance rubric authored -> consult vet -> independent non-implementer grade -> implementer verdict -> plans:set-plan-status shipped."
    },
    {
      "slug": "serialize-and-slow-kopia-backups-2026-08-20",
      "title": "Serialize Kopia backups and reduce hot-backup cadence",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-21",
      "updated": "2026-08-22 05:59:23.111053-04",
      "itemTotal": 7,
      "terminalPlanItems": 6,
      "openPlanItems": 1,
      "workItemTotal": 7,
      "openWorkItems": 1,
      "workItemStates": {
        "done": 6,
        "blocked": 1
      },
      "itemCounts": {
        "done": 6,
        "todo": 1
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-21 09:44:56.73547-04",
        "auditedSha": "53a3d072d6a9fd4b63fde92907e90f31f30b542c",
        "auditedItems": 4
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-serialize-and-slow-kopia-backups-2026-08-20",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "IMPLEMENTATION COMPLETE + LIVE; plan remains READY only for the mandatory acceptance-review sequence. Code-truth audit #1 passed 4/4 with 17 citations. Acceptance rubric acceptance-serialize-and-slow-kopia-backups-2026-08-20 is active/current/complete (4 criteria, methodRef, drift markers, relevant test bindings). Fresh critique consult conv-mt309uz6-0000-5ebe1d11e6a74156944778167faa3d0a is awaiting responder su-1d899d11. After critique: emit current-revision meta-acceptance vetting scorecard, invoke shipped gate to launch/discover a non-implementer grader, await its complete grade, record author acceptance, and mark shipped. All source locks released; runtime idle; next backup 10:00.",
      "nowNext": "Read consult conv-mt309uz6-0000-5ebe1d11e6a74156944778167faa3d0a; reconcile any critique, vet current rubric revision, drive independent grading + author acceptance, then set status shipped and end the continuation loop."
    },
    {
      "slug": "sidestage-seller-copilot-mission-2026-08-14",
      "title": "Make SideStage Copilot fulfill the live-selling seller mission",
      "harness": "sidestage",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-14",
      "updated": "2026-08-15 00:36:16.20448-04",
      "itemTotal": 18,
      "terminalPlanItems": 17,
      "openPlanItems": 1,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 17,
        "todo": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Original seller-Copilot implementation P-001–P-008 is complete and P-009 acceptance residue remains open. Avi identified a real reply-tone gap; P-010–P-013 now cover distinct provider-independent semantics, production configuration, regression guards, and end-to-end verification. AUTO execution is active in this session.",
      "nowNext": "Claim and execute P-010 through P-013 while leaving P-009's independent acceptance lane untouched."
    },
    {
      "slug": "sidestage-standout-features-2026-08-13",
      "title": "SideStage standout features: engagement meter + slate #1-#6 [owner:Avi 2026-08-13]",
      "harness": "sidestage",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-13",
      "updated": "2026-08-20 00:44:20.801846-04",
      "itemTotal": 17,
      "terminalPlanItems": 13,
      "openPlanItems": 4,
      "workItemTotal": 17,
      "openWorkItems": 4,
      "workItemStates": {
        "done": 13,
        "blocked": 3,
        "open": 1
      },
      "itemCounts": {
        "todo": 1,
        "done": 13,
        "blocked": 3
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": true,
        "typedHuman": false,
        "refs": [
          "P-001"
        ],
        "staleHints": []
      },
      "nowState": "ACTIVE - implementation wave launching. P-001 engagement core + P-005 voice-staging + P-006 replay chapters + P-009 chat answers OPEN NOW in parallel. P-002 mockups: leader (su-c18ba) building for Avi.",
      "nowNext": "P-003/P-004/P-010 open when P-001 lands; P-007 when P-006 lands; P-008 waits on checkout plan P-112 port (D-005). Acceptance rubric authored AFTER implementation, before ship."
    },
    {
      "slug": "unified-app-template-2026-08-23",
      "title": "Collapse the web/desktop app templates into one target-parameterised root",
      "harness": "papercusp",
      "status": "draft",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-23",
      "updated": "2026-08-24 00:28:16.929578-04",
      "itemTotal": 7,
      "terminalPlanItems": 6,
      "openPlanItems": 1,
      "workItemTotal": 7,
      "openWorkItems": 1,
      "workItemStates": {
        "done": 6,
        "blocked": 1
      },
      "itemCounts": {
        "done": 6,
        "blocked": 1
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-23 22:13:04.354916-04",
        "auditedSha": "e5ac858c43e4d0f8658e71ba586148375921627d",
        "auditedItems": 6
      },
      "acceptanceRubric": {
        "rubricId": "unified-app-template-acceptance",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": true,
        "typedHuman": false,
        "refs": [],
        "staleHints": [
          "stored status is 'blocked' but every blocked-by dependency (P-002) has already resolved (done/dropped) — effectiveStatus stays 'blocked' because the stored token is sticky (reserved for external blockers) until someone clears it. If this block was purely blocked-by-derived, clear it with plans:set-status; if it is deliberately still blocked for another reason, record that in a plan Decision."
        ]
      },
      "nowState": "NOT COMPLETE — P-006 is the sole remaining blocked item. The six finished engineering items are code-truth audited and independently accepted: audit seq 1 at sha e5ac858c resolved 17/17 citations and verified 6/6 items; scorecard EI-21306988106058735 grades all six `unified-app-template-acceptance` criteria healthy (score10=10, missingKeys=[], fresh generation). D-009 records that verdict. P-006 remains blocked, not dropped: it depends on `byoc-cloud-workspaces-gcp-aws-azure-2026-08-22`, which is still status ready and actively led by su-4e6f9f44 on fleet byoc-alpha-max-2026-08-23. WI-41158 remains the durable P-006 work-item. The earlier no-lane premise remains retracted by D-008.",
      "nowNext": "Advance P-006 only when `byoc-cloud-workspaces-gcp-aws-azure-2026-08-22` actually lands. Until then, monitor the live successor fleet and WI-41158 without re-dropping or force-shipping this plan. When the dependency is terminal, claim WI-41158/P-006, implement and verify the cloud tab-shell, run the plan completion gate, then ship the plan."
    },
    {
      "slug": "unshipped-plans-live-reconciliation-audit-2026-08-20",
      "title": "Live reconciliation audit of unshipped plans",
      "harness": "papercusp",
      "status": "ready",
      "category": "acceptance-residue",
      "reason": "Implementation appears substantially complete, but acceptance/closeout work remains.",
      "recommendation": "Finish the current audit/rubric/verdict evidence, then close or supersede.",
      "created": "2026-08-21",
      "updated": "2026-08-24 15:34:29.542904-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 8,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 8
      },
      "itemCounts": {
        "done": 8
      },
      "audit": {
        "auditSeq": 3,
        "createdAt": "2026-08-24 16:04:28.065391-04",
        "auditedSha": "709e5574d5e5ca2fd876b3f92f04ee25d368599e",
        "auditedItems": 8
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-unshipped-plans-live-reconciliation-audit-2026-08-20",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "acceptance_ungraded",
        "message": "plan 'unshipped-plans-live-reconciliation-audit-2026-08-20' cannot be marked shipped: its acceptance rubric 'acceptance-unshipped-plans-live-reconciliation-audit-2026-08-20' has no complete grading. A NON-implementer (someone other than 'su-d6ae254f-c20e-4bb1-84d4-3dea87edd67f') grades it — scorecards:emit { rubricRef:'acceptance-unshipped-plans-live-reconciliation-audit-2026-08-20', ratings:{ <every criterion key> } } with concrete evidence per rating — then the ship succeeds (grader ≠ implementer, plan D-005)."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-006 WIP route A. Seven evidence-safe lifecycle outcomes applied: four stale empty shells and one explicitly unapproved/replaced proposal superseded; validation-contract plan has all 17 items terminal, completion audit seq 2 current at f3203e9 with 34 resolving citations, and fresh 94/94 tests green. No live-owned target was changed. D-003 governs: classifier bands are triage only.",
      "nowNext": "Finish the existing meta-rubric vetting consult conv-mt7jzqiq-0000-2e4b5eda4c474fbdb641a9abc4fb4460 (do not duplicate); then ship first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 expectedCurrent=ready. Continue evidence-safe closeouts, P-007 blocker revalidation, and P-008 regeneration."
    },
    {
      "slug": "abrupt-codex-session-termination-incident-2026-08-12",
      "title": "Investigate repeated abrupt Codex fleet-leader session termination",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-12",
      "updated": "2026-08-12 08:58:33.667574-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Incident reconstruction and recurrence prevention are complete. Codex wake resumes now use --json and require an explicit turn.completed terminal event; turn.failed and missing terminal markers reopen as retryable failures. Focused verification: 231/231 tests across wake executor/outcome/engine/loop plus scoped TypeScript clean. WI-38160, WI-38165, WI-38186, and WI-38187 are done; commits 566f9481e9 and 624aef2366 contain the guard and end-to-end coverage.",
      "nowNext": "A fresh shared checkpoint run is active on candidate 13a91a1b. On a green verdict, trigger the safe deploy; on a red verdict, diagnose and fix the current failing tests. Then resume WI-38130 non-P2P queue dedupe/root-cause audit."
    },
    {
      "slug": "agent-launch-verification-and-spawn-env-2026-08-11",
      "title": "Agent launch: verify the launch, and make the spawned terminal's env self-sufficient (cross-platform)",
      "harness": "papercusp",
      "status": "draft",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-11",
      "updated": "2026-08-11 20:38:56.430841-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "RESOLVED, with the credit NOT mine. Both previously-red suites now pass on the working tree (launch-agent.test.ts + terminal.test.ts, TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed). lint:tsc on all 7 edited files is exit=0 status=clean.\n\nsu-790ce4f8's 15 reds were REAL — do not record them as a stale-tree false alarm. Established timeline: the preflight SOURCE landed c8c1115cfa 23:34:21Z; their run started 23:49:37Z; the test-side adaptation that makes the suites pass (a vi.mock of backend-bin-resolve.mjs stubbing preflightBackendLaunch → { ok:true }) was absent then — git status at 00:13Z showed launch-agent.test.ts CLEAN against a 2026-07-20 commit, and ade0e86dc^ contains ZERO occurrences of 'backend-bin-resolve'. It appeared between 00:13Z and 00:24Z, swept into ade0e86dc at 00:29:23Z. terminal.test.ts's wrong-door case likewise landed daddb54c 00:11:31Z, also after their run. So for ~40 min the tree genuinely carried a refusal-before-spawn that no test knew about.\n\nI did NOT write that preflight mock. My only edit to launch-agent.test.ts was a 2-line TS2554 fix at 00:24:51Z. The +25-line commit carrying BOTH is stamped with my agent trailer, but git-sync labels sweeps with whatever agent context is current, so the trailer is not authorship evidence (repo convention: neither git blame nor a commit subject is evidence here). su-3a93abaa stated at 00:26:52Z they had not touched it. Asked su-790ce4f8 directly rather than asserting.\n\nMY ACTUAL DEFECT, which stands regardless of who fixed it: I shipped a refusal-before-spawn into launch-agent.ts and terminal.ts and ran neither file's sibling suite, then reported \"8/8 green\" to peers and the owner.",
      "nowNext": "Read job 7739468b-1eb — the full 11-suite batch (the original 8 PLUS launch-agent, terminal and psu-launcher), which is the batch that should have backed the original claim. Only after it is green may this plan re-report verified. Then: resolve the authorship answer from su-790ce4f8 into the record; live exercise on :3170. Still blocked on deploy skew, unchanged: WI-38001..38007 cannot close (do NOT retry), no acceptance rubric possible (EI-20204370492002514), and do NOT retire ~/.papercusp/bin/bun (positions.deployed=false)."
    },
    {
      "slug": "agent-pipeline-state-truthfulness-2026-08-02",
      "title": "Pipeline/gate state surfaces must not assert more than their evidence supports",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 03:26:20.861453-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "ALL 5 ITEMS DONE. P-001+P-002 (WI-6865). P-003 (WI-6929, D-001). P-004 (WI-6950, D-002). P-005 (WI-6972, D-003). Three of the five items had premises that only partly held on inspection, each recorded as a Decision: P-003 assumed bad fact CONTENT (the corpus was largely sound; the fact STORE was the defect → WI-6935); P-004 conflated two opposite mechanisms and named the smallest carrier (fixed the pipeline-blind wake banner + the catalog's permissive-prefix test instead); P-005's two cited alarms were already fixed by peers before the item was worked (the one genuinely-unfixed gate alarm was the STALE path, and its prescribed mechanism — conditionKey — does not even exist on work_items:create).",
      "nowNext": "Plan is drained; nothing here needs an owner. Follow-on work is filed and unclaimed: EI-19325151590626958 (~1,162 still-open near-identical rows — scorecard observations never pass a conditionKey; needs a DEFAULT inside improvements:capture, keyed to include scope or distinct pots collapse) is the largest and is the natural next pickup. Also EI-19323309702408274 (shell-write guard false-positives on `=>` inside a quoted node -e script). Outside this plan: WI-6935 is held by su-f49ebf76 with (a)/(b)/(d) green and only (c) remaining; its residue (wall:egress-proxies-down not restored pending a re-measure, 4 cap-evicted dead-end facts to restore only AFTER the slot exemption lands, FACTS_FOLD_LIMIT=12 unexamined) stays open."
    },
    {
      "slug": "audit-calibration-event-system-2026-08-21",
      "title": "Calibration: blind derived-truth audit of the event system, scored against held-out ground truth to validate the audit method",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-21",
      "updated": "2026-08-21 16:55:51.919477-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 4,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 4
      },
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "automations-main-tab-replacement-2026-08-22",
      "title": "Replace fragmented automation catalogs with a full-width Automations main tab",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-22",
      "updated": "2026-08-22 22:14:55.496134-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 4,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 4
      },
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "cdn-egress-fixes-2026-08-02",
      "title": "Eliminate runtime public-CDN dependencies (the vditor class) — 6 remaining instances",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 15:33:47.142774-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5,
        "dropped": 2
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 7 items terminal, verified at RUNTIME (D-004: a bundle grep cannot decide this class; every fix overrides behaviour at runtime, so the CDN strings survive in the bundle either way). FIXED + VERIFIED: P-001 Monaco (local /monaco/vs/* incl. all 4 workers, mirror 151/151), P-002 PlantUML (end-to-end probe: block rendered, class neutralized 1/raw 0, zero <object>, zero plantuml.com requests — the only content-egress finding), P-003 Porcupine (vendored, immutable-sha + sha256 pinned and matching, served HTTP 200, NEW guard test porcupine-cdn.test.ts 6/6 negative-controlled; live wake-word NOT exercised — needs mic + access key), P-004 Excalidraw (asset path active, esm.sh=0, mirror complete 300/301 zero missing so the unconditional fallback is unreachable). PROVEN NOT LIVE, dropped: P-005 emoji-mart (bare-specifier import, Vite resolves at build time; picker loaded only local chunks) and P-006 speech-rule-engine (SRE is in vditor's MathJax bundle, we pin KaTeX; real math rendered katexNodes=4 mathjaxNodes=0, zero mathmaps requests). Non-local fetches across every surface exercised: 0. Both scratch probe plans archived.",
      "nowNext": "Nothing on this plan — it is drained. Follow-ups live as their own items: EI-19369470572700441 (major: verify-tauri-headless.sh bypasses the WI-7101 target-dir claim) and EI-19370965762703309 (minor: extend the every-entry-point invariant to math.engine). Next work is the sibling plan egress-monitor-origin-axis-2026-08-02."
    },
    {
      "slug": "chat-popup-fleet-peers-rail-2026-08-09",
      "title": "Conversation popup: a fleet-peers rail right of Activity",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 05:55:57.849541-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "constellations-88-reference-site-2026-08-11",
      "title": "88 IAU constellations — a running, browsable visual reference site",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-11",
      "updated": "2026-08-11 16:40:33.003631-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "consult-revival-acceptance-residue-2026-08-20",
      "title": "Resolve consult-revival acceptance residue",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-20",
      "updated": "2026-08-20 19:44:32.34924-04",
      "itemTotal": 2,
      "terminalPlanItems": 2,
      "openPlanItems": 0,
      "workItemTotal": 2,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 2
      },
      "itemCounts": {
        "done": 2
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Resolve the two filed acceptance defects without reopening or re-grading the shipped plan.",
      "nowNext": "Fix the historical answered-expired archival label, then verify/fix the live `includePeersKnow` schema contract."
    },
    {
      "slug": "decouple-generic-libs-private-deps-2026-08-03",
      "title": "Decouple public libs/generic/* libraries from private/coupled workspace packages (WI-4973)",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-03",
      "updated": "2026-08-03 02:32:54.634552-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "DONE — all 6 items (P-001..P-006) complete. WI-4973 closed. Gate lint:generic-independence reports 0 findings across 53 borrowable libs. agent-chat confirmed out of scope (private, not under libs/generic/, not in BORROWABLE.md). Verification via test:affected across 21 downstream workspaces surfaced 4 pre-existing/unrelated reds, none caused by this change: 1 already claimed by a peer (EI-19411367924293520), 2 newly filed (WI-7376, WI-7377), 1 was a test-group-interaction artifact (passed clean in isolation).",
      "nowNext": "Plan complete — no further action needed. See WI-4973 for full completion evidence."
    },
    {
      "slug": "default-deploy-account-2026-08-08",
      "title": "Retire the Keys &amp; OAuth sign-in cards; make a deploy account settable as the default",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 00:44:39.076315-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 8,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 8
      },
      "itemCounts": {
        "done": 8
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 8 items done; P-007 (tests) closed 2026-08-09 with full evidence on WI-37203.\n\n⚠ CORRECTION to the earlier Now, which said the implementation left TWO suites red: the real count was SIX, all found+fixed by P-007, none caused by the test work. (1-4) account-resolver 10/27 red, bootstrap-su 27/80 red, bootstrap-su-bearer-non-transit, native-session-id-roundtrip — all the SAME trap: P-003/P-004 added `readDefaultAccountId` imports and sibling suites mocking the store with an explicit vi.mock FACTORY were never widened, so the missing export threw at RUNTIME. lint:tsc is structurally blind to this (source imports are correct + well-typed), which is why 7 clean lint:tsc runs recorded this plan \"verified\" over a red tree. (5) css-tokens — P-006's `var(--ok)` in left-sidebar.styles.ts, fixed to --good. (6) design-primitives — title-only button tooltips in AccountsTab + deploy-accounts/page, fixed via the shared Tooltip primitive. Class = 6th occurrence, consolidated onto EI-19462958615807409 (still OPEN).\n\nTRANCHES GREEN (before→after): account-session-override 11→23 · account-resolver 27→42 · bootstrap-su 80→97 · account-pool-store 14→27 · AccountsTab 3→12 · NEW api-keys/page 4/4 · chat-stream-resolve 43/43. GATES GREEN: lint:tool-prompts 55/55 · lint:tests · all three lint:tsc variants exit=0 · css-tokens + design-primitives PASS.\n\nFINAL CHECK VERIFIED (was predicted): test:affected re-run 04:19Z, verdict read from the LOG BODY not the exit code (notification said \"exit 0\" while REAL_EXIT=1). coverage=complete fileCount=4; all four of this plan's red suites GONE. The 4 remaining were re-run individually and attributed by actual failure message — none is this plan's.\n\nCARRIED FORWARD (not this plan's): 4 STANDING COMMITTED reds will red-pin green-checkpoint — resolver-backing-table-coverage (stale agentOrders/agent_modes exemption), handoff + deliver-and-wake (SAME vi.mock trap from another plan's presence.ts change), cut-seed-cli (60s hive timeout).",
      "nowNext": "Nothing further on this plan — it is closed. Anyone picking up the tree: the 4 standing reds above belong to OTHER plans and need greening before green-checkpoint can pass; the deploy-accounts page test rebuild recipe is EI-19947523316032859."
    },
    {
      "slug": "dep-graph-design-pass-2026-08-08",
      "title": "Dependency-graph view: design pass on visible glitches + selection UX (owner-reported)",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-08",
      "updated": "2026-08-08 20:03:55.479741-04",
      "itemTotal": 9,
      "terminalPlanItems": 9,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 9
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE 2026-08-08 — all 9 items done, one decision (D-001). Implemented, unit-tested (19 new cases), and verified LIVE AT SCALE on the papercusp pot (122 nodes / 79 edges) in an isolated headless Tauri shell.\n\nQ1 answered, and it was NOT a bug: 18,647 vs 122 is by design (only items participating in an edge are drawn — dep-graph-model.ts:255). The defect was that the pane never said so. It now reads \"122 of 18,675 items have dependencies · 79 edges\" + \"Items with no dependency are not drawn\", and WITHHOLDS that sentence whenever a selection / health mode / filter has scoped the graph, because the number would then be false.\n\nGlitches fixed: the \"Issues only\" toggle (root cause was `.pc-advpanel__iconbtn` — a fixed 28x28 ICON box holding a TEXT label, so it fragmented into three pieces; now the house `.pc-advpanel__chip` aria-pressed toggle); the bar wraps instead of crushing its controls; edges got contrast + arrowheads (per D-001: contrast and direction, never weight — the prior owner directive \"the edges are much too big\" still stands); the canvas is sized from the NODES so nothing is drawn sliced; node cards inverted to title-prominent with a state dot and a full-title SVG <title>. Selection UX: \"Clear selection\" is an accent Button placed FIRST in the bar, and Escape clears through the same single code path (guarded so it never steals Escape from a dialog/menu/field, and never preventDefaults when nothing is selected).\n\nAlso folded in the sibling WI-36234 (one line in the same file): the filtered empty state no longer claims \"No work items match the active filters\" when plenty matched and it is the EDGE set that is empty.",
      "nowNext": "Nothing outstanding. If further glitches are reported, the highest-value un-taken items are (a) edge ROUTING — ELK's splines still cross heavily at 79 edges, which is the next lever after colour/opacity per D-001 — and (b) a zoom/fit control, since 122 nodes at 210px wide is a wide scroll. Neither was asked for.\n\nEvidence: DepGraphPanel.test.tsx 19/19; the whole adv/harnesses directory 40 files / 396 tests green; lint:tsc:operator clean on the named files; design-primitives 44/44 + css-tokens green; live suite = 12 exit-coded `tauri-agent-tools check --eval` assertions with 4 negative controls each correctly exiting 1, plus Esc and Clear driven for real and a clean no-errors console check."
    },
    {
      "slug": "desktop-release-0-0-17-alpha-2026-08-13",
      "title": "Cut, publish, and verify Papercusp Desktop 0.0.17-alpha from latest green main",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-13",
      "updated": "2026-08-15 18:47:51.99768-04",
      "itemTotal": 11,
      "terminalPlanItems": 11,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7,
        "dropped": 4
      },
      "audit": null,
      "acceptanceRubric": {
        "rubricId": "acceptance-desktop-release-0-0-17-alpha",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "The stable 0.0.17-alpha arc is COMPLETE and verified live. All 11 plan items are terminal — 7 done (P-001, P-006..P-011), 4 dropped (P-002..P-005). The single stable tri-platform cut reached terminal SUCCESS and 0.0.17 is PUBLISHED, with published bytes verified back to provenance by sha256 rather than by any status column. P-010 (WI-39168, closed 21:58:57Z) carries artifact/provenance/signing verification; P-011 (WI-39273, closed 22:39Z) carries installed-build + public-discoverability acceptance across Linux/Windows/macOS. Both closed completionAuthority=committed; the enumerated evidence and its coverage partitions live ON those two items — read them there rather than trusting any restatement. Two release defects were each controlled against the previously shipped 0.0.16 BEFORE any regression claim and ruled standing/non-blocking by D-045: EI-20559353000427453 (GUI .deb ships the build's own .stage-scrub temp tree) and EI-20560284451178740 (macOS fails codesign --verify --strict — 0.0.16 fails identically, so a standing condition, not a 0.0.17 regression). Only a grading formality is outstanding: acceptance rubric `acceptance-desktop-release-0-0-17-alpha` (active, 6 criteria) has ZERO scorecards as of 22:46Z, which is the sole reason plan status is `ready` and not `shipped`.",
      "nowNext": "su-b7f10f7f (live, ACKed 22:41Z, ETA ~20min after his WI-39343 Windows leg) grades `acceptance-desktop-release-0-0-17-alpha` via scorecards:emit with per-criterion evidence — su-7f4f948f AUTHORED the rubric, so the completion gate's grader-must-not-be-author rule bars him from grading it; when that scorecard lands, plans:set-plan-status -> shipped closes the arc. Do NOT re-run any P-010/P-011 acceptance (both closed with committed evidence), do NOT start new release work on this plan, and do NOT hand-set releases.published_at — it is NULL for every release ever cut here (EI-20554280013426604), so it is not a publication signal and writing it would fabricate one."
    },
    {
      "slug": "durable-peer-lifecycle-federation-2026-08-20",
      "title": "Durable peer lifecycle for federation cursors and absence alerts",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-20",
      "updated": "2026-08-20 08:22:26.170877-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 4,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 4
      },
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "false-premise-in-prescriptive-artifacts-2026-08-02",
      "title": "The most-filed agent-confusion class is a false premise inside a PRESCRIPTIVE artifact — skipped so far because it had no obvious producer, but the claim event is one",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 21:37:20.446986-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "**PLAN COMPLETE — all six items closed** (owner-directed 2026-08-02, AUTO, solo).\n\nP-001/P-002 put derived premise-checks on work-item + plan-item bodies, rendered at the claim event. P-003 investigated rather than re-proposed a twice-dropped idea (it had already shipped 40 min earlier). P-004 asserted CLAUDE.md's executable claims in CI, driving the real heavy-command gate as an oracle. P-005 added the diagnosis-cluster lane. P-006 was REFUTED by measurement.\n\nThe plan's own thesis held against itself **five times**: a premise stated in an item's text was refuted by measurement before it was built — P-001 twice, P-004 once (it named the wrong surface), P-005 three times (D-004), and P-006 entirely (D-005). The Background's opening premise was also retracted before reaching the owner. Every one was cheap to check and expensive to have built.\n\nFive decisions: **D-001** verify a prescription before emitting it (an allowlist of known-false cases is the anti-pattern). **D-002** derive premises from text the author already wrote — now measured: declared shape fields sit at 0.08%–8.8% fill. **D-003** a detector's SCOPE is a premise too; a zero result in an unmeasured artifact means UNSUPPORTED, not clean. **D-004** a recurring DIAGNOSIS is not a recurring TOPIC. **D-005** match the substrate's lifetime to the ERROR's lifetime.\n\nFiled en route: **EI-19393516222436864** (near-dup pass never runs at production scale while scope reports full coverage) and **EI-19389924161930888** (su prompt prescribes a gate-denied command).",
      "nowNext": "Plan drained — nothing further here. The highest-value follow-on is EI-19393516222436864: this plan's own class sitting inside the clustering code, already diagnosed with an in-idiom fix proposed (add `nearDupPass: 'ran' | 'skipped-cost-gate'` to likelyDuplicatesScope; do NOT raise the 4,000 bound, it is load-bearing per WI-5820)."
    },
    {
      "slug": "file-level-test-selection-2026-08-17",
      "title": "Run only the tests a change can actually break: import-graph test selection",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-17",
      "updated": "2026-08-20 20:18:03.659633-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 1,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 1
      },
      "itemCounts": {
        "done": 8
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "fleet-lead-instrumentation-audit-2026-08-09",
      "title": "Fleet-lead instrumentation audit — confident zeros, wrong-field readings, and the leader signals that invert under load",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 17:15:26.06859-04",
      "itemTotal": 25,
      "terminalPlanItems": 25,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 25
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 25 items done, 13 decisions recorded. Implemented start-to-finish by su-b8422496 (fleet nonp2p-bug-drain leader) across wakes 8-52 on 2026-08-09, per an interactive owner directive. Every Phase 1 instrument named in the audit is fixed, and the Phase 3 capabilities are built: P-022 wake-to-wake delta (`delta`/`deltaSummary` on fleet:leader-brief, migration 779, D-011), P-023 per-member idle oracle (`idleVerdict`/`idleCauses`, D-012), P-024 pool reservation (`reservation`, D-013). THE RECURRING FINDING, which changed the build on four consecutive items: MEASURE THE CLAIM BEFORE BUILDING — P-015 had 1 of 3 sub-claims already shipped, P-016 had 2 of 4 (one a live peer's lane), P-022 had 2 of 4 axes already derivable from durable data, and P-024's premise was outright stale (the gateway priority substrate exists and was un-inerted by WI-4542 on 2026-08-02). The audit was written from OBSERVED SYMPTOMS, and a symptom outlives its fix. Two items were deliberately NOT built as written: P-006 (D-006 — a global fleet:capacity gate would veto every disarm invisibly; shipped as a per-loop liveness+progress veto plus a bounded revival instead) and P-024's claim-state priority half, which is not soundly buildable from the leader's side because the gateway priority label is stamped at spawn time — filed as WI-37558 rather than half-built. NOT YET DEPLOYED: all of it is in the tree; :3070 and bg-host run the RELEASE checkout, so the new leader-brief blocks appear only after the next green+deploy.",
      "nowNext": "Nothing on this plan — it is drained. The one tracked follow-on is WI-37558 (per-request claim-state admission priority), which belongs to whoever owns the gateway/spawn seam, not to a fleet leader; it is linked to P-024 as `relates`, deliberately not as `implements`, so completing this plan cannot auto-resolve it."
    },
    {
      "slug": "focus-kit-2026-08-09",
      "title": "Papercusp Focus Kit — 3 local-first web apps on one shared UI + one shared store",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 06:18:47.326044-04",
      "itemTotal": 12,
      "terminalPlanItems": 12,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 12
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "SHIPPED. All nine items done. The Focus Kit — Pomodoro, Habits, Journal — runs from `npm run serve` in `~/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/focus-kit` (own git repo, 2 commits, working tree clean). 78 tests green on node's built-in runner, zero dependencies. The acceptance test was driven end to end in a real browser: all three apps used, tab CLOSED, fresh tab reopened, every app's data intact; a next-day rollover was simulated and streaks survived it while the new day started clean. Goal `ship-the-papercusp-focus-kit-3-local-first-web-a-84cff3` marked achieved.",
      "nowNext": "Nothing autonomous remains. ONE OWNER WALL, named and not attempted: public hosting (a host, a domain, TLS) — real spend and an outward-facing publish, so it is the owner's call. It blocks distribution only, never construction. Two platform bugs were filed from this build and are the useful follow-ups for someone else: EI-19964793024613369 (dedup is unsound as documented — search:semantic does not cover plans, and plans:* return a filePath that does not exist) and EI-19964643447670242 (GOAL mode requires reporting spend the platform cannot measure). Also EI-19964308537296577 (verdict @eN refs re-bind silently after a DOM change)."
    },
    {
      "slug": "gate-ownership-condition-singleton-2026-08-03",
      "title": "Gate ownership: condition-keyed singleton work-items, event-key links, and ownership folded onto the state cells",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-03",
      "updated": "2026-08-03 01:42:55.686037-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 8
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "**All 8 items DONE, and the plan's thesis is now TRUE in production** — a condition has exactly one owning work-item, and the bridge adopts it instead of re-filing.\n\nP-008's integration tests (17/17 against real PG) closed the last item and immediately justified themselves: they found TWO live defects in this plan's own shipped code that 119 passing unit tests could not see, both now fixed.\n\n- **D-021** — both bridge closes ran without a `by` principal, which the completion-integrity gate rejects by THROWING, and both swallowed the throw. Every lost race left a permanently-open duplicate, and `releaseConditionOwner({settle:true})` returned `settled:true` having settled nothing: D-011's leak reported as fixed while still live, and D-020's marker gate guarding a write that never ran.\n- **D-022** — ownership was written to two places (the `condition_key` column and the `about` link) and read from one. Combined with `createIssue` normalizing a MEMBER harness to its hive home (`oddsmith` → `oddsmith-hive`), the bridge could never see its own mint and re-filed every tick. Live proof: WI-7321 holding the key plus three doomed re-mints in ~50 minutes.\n\nBoth ruled on generally: ask the ENFORCEMENT POINT whether something is enforced; apply the WRITER's normalization on the read; and never assert success from a discarded outcome.\n\nDecisions D-011, D-017, D-018, D-019, D-020, D-021, D-022 carry the rulings; read them before touching the bridge or the ownership predicates.",
      "nowNext": "Nothing blocking — the plan is complete. Two small follow-ups, neither owned: (1) sweep the 3 already-leaked live rows WI-7324/7332/7333 on `green-stall:oddsmith` (inert — no key, no link — but they are duplicates of WI-7321); (2) the ~6 hand-filed `single-primary:no-primary` items now want a dedup/triage pass, which D-020 made safe and D-022 made actually work."
    },
    {
      "slug": "gate-ownership-followup-2026-08-08",
      "title": "Gate ownership follow-up: stop the condition-bridge mint loop, and make a RED gate ownable",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 11:21:29.397585-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "ALL ITEMS DONE (P-001..P-007). Phase 1 stopped the 29.6k-row condition-bridge mint loop; Phase 2 made a red gate ownable (WI-37450 was minted 09:52:34Z and IS held, proving the producer works). Nothing here is in effect yet: every deliverable sits on staging behind an 8-red gate with main frozen ~9.6h at 73cb5e20. Verified by ancestry (ac5a457eba NOT-IN-MAIN, NOT-IN-DEPLOYED), not by position ticks.",
      "nowNext": "Nothing to build. The single remaining step is the gate greening + a deploy, owned by su-0dd2c62e on WI-37450 (live, checkpointed 15:10Z) with su-55ed3 driving verdict->deploy. su-80a2b1f2 is watching on a 300s loop to confirm the Phase 1/2 code actually reaches :3070 once it greens — that is the P-003-style production verification this plan exists to earn.\n\n\nFollow-up to `gate-ownership-condition-singleton-2026-08-03` (all 8 items done; thesis true for the papercusp harness, broken for member harnesses).\n\n[owner:Avi 2026-08-08] \"Stop the bleeding now, myself\" — fix the mint loop directly, including the row cleanup.\n[owner:Avi 2026-08-08] \"Yes, plus surface it where agents look\" — make a sustained red streak an ownable condition AND put an ownership pointer on the cell agents read when the gate is red."
    },
    {
      "slug": "gate-stop-chasing-the-tip-2026-08-19",
      "title": "Green-checkpoint: stop judging a moving target",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-19",
      "updated": "2026-08-24 00:06:10.298995-04",
      "itemTotal": 10,
      "terminalPlanItems": 10,
      "openPlanItems": 0,
      "workItemTotal": 9,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 9
      },
      "itemCounts": {
        "done": 10
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "goal-mode-hardening-2026-08-10",
      "title": "GOAL mode hardening — pot rename, contract rewrite, goal provenance, per-goal launch settings, TEST mode",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-10",
      "updated": "2026-08-12 00:20:54.097398-04",
      "itemTotal": 10,
      "terminalPlanItems": 10,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 10
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE (work) / NOT SHIPPED (status) — all 10 items (P-001..P-010) are done, and P-005's launch-settings surface is verified end to end: goal launch-settings READ through resolveGoalDetail, WRITE through goals:update's `launchSettings` arg (atomic via ctx.tx), EDIT in GoalSettingsSection mounted after SubGoalsSection per D-007. Verified by driving a real Tauri window twice on two trees; round trip proven against real Postgres. D-015 defaults (maxAgents 12, maxPerFleet 5, literal \"unlimited\" opt-out) landed with unit + integration cover: goal-launch-settings-model / GoalSettingsSection / goal-launch-settings-unlimited-literal / operator-core goal-launch-settings + resolver-coverage = 114 tests green (runId 033e96a1), and sync-resolver/goals.integration.test.ts = 24/24 green against real PG (2026-08-12T02:08Z, su-6c30f2a4) — that last one closes the previously-unverified \"does launchSettingsDefaults survive real SQL\" claim. lint:tsc on the changed operator-core files: exit=0 status=clean.",
      "nowNext": "The plan's WORK is drained; nothing inside it is open. What remains is the SHIP step and one external follow-up.\n\n(1) SHIP IS BLOCKED, DELIBERATELY — do not force it. Plan frontmatter is still status:active. This repo now requires a graded acceptance rubric before 'shipped' (authored post-implementation, graded by a NON-implementer). That gate landed in STAGING today at 19:01 (packages/operator-core/lib/plan-acceptance-gate.ts, f29830a4f3) but is ABSENT from the deployed build 7511ab5b — verified: zero ACCEPTANCE_RUBRIC_COMPLETION_GATE matches and no plan-acceptance-gate.ts at that sha, and the live rubrics:list still rejects a `kind` arg. CONSEQUENCE: setting status→shipped right now would SUCCEED, not because the plan satisfies the gate but because the running code has no gate. That is bypassing the check, not passing it. Wait for the gate to deploy, then author the acceptance rubric and have a non-implementer grade it.\n\n(2) OPEN follow-up, outside this plan: WI-38048 — goal-mode per-role launch profiles cannot bind, because `roles` is keyed by psu --role while the GOAL contract names six non-psu role slots. Filed 2026-08-12T00:17Z, still open and unassigned. This is the one real hole left in D-015's launch-settings surface; it was held rather than guessed at.\n\n(3) CORRECTED 2026-08-12T02:15Z (su-6c30f2a4): this block previously listed WI-37711 as an outstanding follow-up. IT IS DONE — closed 2026-08-10T18:48Z, and verified complete rather than merely marked: `goal` is present in claim-spec's FILTERABLE_ITEM_FIELDS, registry.test.ts imports that constant so the grammar is pinned against regression, and the old deliberately-failing guard is now an INVERTED assertion (not.toMatch(/cannot yet filter on the goal itself/i)) that fails if the stale caveat text ever returns. Do not re-do it.\n\n(4) OBSERVED, NOT A DEFECT, worth knowing before anyone reads goal telemetry: the P-002 goal-provenance path has never stamped a row in this database — 0 of 4,692 session_briefs and 0 of 37,579 work_items carry a goal_id. Fully explained rather than broken: the live goal-running agents run their goals via agent_modes.subject (so a NULL session_briefs.goal_id is correct — that column means INHERITED) and have claimed zero work-items, so there has been nothing to stamp. The mechanism is implemented and unit-tested but completely unexercised, so its first real use will also be its first live test."
    },
    {
      "slug": "hlc-contention-free-clock-2026-08-12",
      "title": "Remove transaction-wide HLC clock contention while preserving federation order",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-12",
      "updated": "2026-08-22 01:26:45.558958-04",
      "itemTotal": 1,
      "terminalPlanItems": 1,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "hotel-reservation-app-bootstrap-20260821-2026-08-21",
      "title": "Hotel reservation app — Papercusp template bootstrap and fleet launch",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-21",
      "updated": "2026-08-21 15:45:11.096271-04",
      "itemTotal": 2,
      "terminalPlanItems": 2,
      "openPlanItems": 0,
      "workItemTotal": 2,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 2
      },
      "itemCounts": {
        "done": 2
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Bootstrap complete: official template materialized; app-local plan active; ten requested visible Codex workers verified by tool ledgers; P-001 is WI-40290 in progress.",
      "nowNext": "All continuing work is governed by hotel-reservations-mvp-20260821-2026-08-21 in harness hotel-reservations and supervised by fleet hotel-reservations-build-20260821."
    },
    {
      "slug": "hud-pot-scope-and-dropdown-2026-08-13",
      "title": "Fix HUD pot scoping and viewport-bounded selectors",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-13",
      "updated": "2026-08-13 13:05:41.444499-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5
      },
      "audit": null,
      "acceptanceRubric": {
        "rubricId": "acceptance-hud-pot-scope-and-dropdown-2026-08-13",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "hud-unified-search-filter-2026-08-10",
      "title": "HUD: one shared search box + identity-aware filtering across all four tabs",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-10",
      "updated": "2026-08-10 18:24:34.50268-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-001..P-005 DONE and verified. All four HUD tabs now render one shared <HudSearchBox/> (goals/plans/items converged onto the sessions tab's hero treatment) — live-drove all four in an isolated shell, every one hero=true icon=true visible=true, screenshot inspected. identityMatches() is the single shared definition of identity filtering, wired into matchesQuery, with 8 tests including the must-not-match guards. 216/216 unit tests green; typecheck clean.",
      "nowNext": "P-006 is the ONLY remaining item and it is the honest gap: identity filtering is LIVE for sessions + items (work items populate identity from `assignee`), but NOT for plans and goals — their input types carry no owner/session at all, so the sync resolver must thread it through first (D-003). Do not report 'all tabs filterable by session/agent id' until P-006 lands. Also unverified: identity filtering was never live-exercised on the items board (no harness selected in the verify shell, so it was empty) — it rests on the board-level unit test."
    },
    {
      "slug": "inference-rename-and-provider-agnostic-default-2026-08-09",
      "title": "Rename Deploy accounts → Inference; make the default account provider-agnostic; retire the Anthropic key field",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 18:23:49.262436-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 6 items done and verified 2026-08-09.\n\nVERIFIED: three typecheck gates `exit=0 status=clean` on every changed file (`lint:tsc`,\n`lint:tsc:operator`, `lint:tsc:operator-vite`, each `--files=`, never `--mine`). Suites:\ndirectly-affected **102p/13f → 120p/0f**; second batch 133/0; account-resolver 44/44. Full\n`test:affected`: `status=failed tasks=12 failed=1`, `coverage=complete fileCount=1`.\n\nTHE ONE FAILING FILE IS NOT THIS PLAN'S — attributed, not assumed.\n`sync/hyperbee/shipped-seed-artifact.test.ts` imports NONE of the changed modules. Its test_runs\nhistory is pass through 21:52Z then fail at 22:11Z; `src-tauri/seed/corestore` (6,031,427,350 B —\nexactly the failure's \"expected\") was written 17:55 local while `manifest.json` (declaring\n6,029,897,796) was rewritten 18:04 = 21:55–22:04Z, inside that gap, by one of two live\n`npm run dev` Tauri builds. `epoch-keys.json` absent. Filed **WI-37577**.\n\nALL 13 INITIAL FAILURES WERE EXPECTED — each asserted a rule this plan deliberately inverted\n(Codex rejection, the Claude-only default control in both UIs, the Anthropic-key labels). Each was\nREWRITTEN to the new contract, several made bidirectional so they cannot pass vacuously.\n\n⚠ P-005 LANDED NARROWER THAN WRITTEN. `testing-ai-explore` could not move onto the default account\n— it pipes the key into stagehand-runner, which hands `{ modelName, apiKey }` to Stagehand with no\nbaseURL seam. It keeps a raw-key path (now also reading `ANTHROPIC_API_KEY`) and its 400 no longer\npoints at the deleted field. Tracked as **WI-37573**.\n\nD-004 records the ruling NOT in the original plan: the in-process transport marker stays\nCLAUDE-ONLY, so a Codex default cannot silently reroute Anthropic traffic.\n\nALSO FOUND: `ApiKeyStatus.tsx` is NOT MOUNTED in the product (only its test + stories). Semantics\ncorrected; the file now says so.",
      "nowNext": "Nothing on this plan — drained. Follow-ons owned elsewhere: WI-37573 (baseURL for stagehand-runner) and WI-37577 (Tauri dev build leaves src-tauri/seed self-inconsistent). The rename was labels-only by owner choice, so /settings/deploy-accounts and /api/admin/deploy-accounts/* keep the old name BY DESIGN — do not \"finish\" the rename without asking."
    },
    {
      "slug": "local-reranker-gte-modernbert-2026-08-02",
      "title": "Local ONNX cross-encoder reranking via gte-reranker-modernbert-base (replaces the dark ZeroEntropy seam)",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 19:33:26.102795-04",
      "itemTotal": 12,
      "terminalPlanItems": 12,
      "openPlanItems": 0,
      "workItemTotal": 12,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 12
      },
      "itemCounts": {
        "done": 12
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — 12/12. P-012 verified live 2026-08-02 23:15-23:40Z in an ISOLATED Tauri shell (scripts/verify-tauri-headless.sh --boot-only: own Xvfb :91, own devUrl :33710, own operator sidecar, own cargo target slot). The owner's :0 window and the 7-day-old :3270 stack were never driven — note that a bare `tauri-agent-tools probe` defaults to the OWNER'S bridge, so every call was --pid-targeted.\n\nPRECONDITION CLEARED: dev:restart{embed-sidecar} took the running sidecar from a 16.9-day-old build (pid 2034810) to pid 116595. /healthz capabilities now ['GET /healthz','POST /embed','POST /rerank'] and rerankExecution reports {device:cpu, dtype:q8} — D-006's active-pair reporting working as designed.\n\nEVIDENCE (all falsifiable, all bound to the real /api/user/search path driven from inside the window):\n- INVOCATION: sidecar CPU delta measured across a SINGLE request = 4170ms CPU / ~1.3s wall (~3.2 ORT threads). Rerank is genuinely called on the user-facing path, not bypassed.\n- ORDERING CHANGES: 3 of 4 queries returned hits whose RRF `rank` is NOT monotonically descending — a lower-RRF hit was promoted above a higher-RRF one, which only the cross-encoder can cause. The 4th query is the documented single-bucket case where the qualityScore tiebreak deliberately preserves RRF order.\n- LATENCY: 24 candidates = 1316ms (54.9 ms/pair), reproducing P-009's 52 ms/pair and comfortably inside PROSE_RERANK_TIMEOUT_MS (4000ms). Whole search 3.4-4.5s end-to-end at box load ~96.\n- Per D-006, NO GPU figure is reported.",
      "nowNext": "Nothing — plan complete. Two verification traps worth carrying: (1) `rank` in the /api/user/search response is the RRF score carried through untouched, NOT the rerank score, so it can never be used to check rerank ordering directly; test RRF-monotonicity instead. (2) Recomputing rerank scores externally cannot settle ordering — bucketing is round(score*20), so a 0.9026 lands in bucket 18 while 19 needs >=0.925, and any small text-reconstruction difference flips the bucket. I nearly filed a false \"rerank is discarded\" defect on exactly that before catching it."
    },
    {
      "slug": "orchestration-surface-residue-drain-2026-08-23",
      "title": "Drain the orchestration-surface residue — 35 fleet-filed defects on code:run, capability:bash*, recipes:*, result-door, functions.exec",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-23",
      "updated": "2026-08-23 23:59:27.473597-04",
      "itemTotal": 16,
      "terminalPlanItems": 16,
      "openPlanItems": 0,
      "workItemTotal": 10,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 10
      },
      "itemCounts": {
        "done": 15,
        "dropped": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-012 is done — every actionable item on this plan is now closed. 14 of 16 items terminal. D-009 records the consolidated 8-cluster map (cluster -> root cause -> survivor) plus the ruling that a frozen scope cannot be re-derived by re-running its own defining query. P-012's dedupe pass closed the last 3 filings that were still open and double-counting: EI-21253366598345158 (4th rg filing, survivor EI-21230696318029111) and the canonical timeout-unit pair EI-21244621935918273 + EI-21249688296844162, the latter as fixed-at-source/deploy-blocked (tooldef 92dc13e, proven by facade-types.test.ts:193, unobservable at runtime until the red gate greens).",
      "nowNext": "Two items remain, neither actionable solo. P-001 is parked on two sibling EIs held by live peers (su-c8b7263b, su-93b72058) — do not override, re-ask, or re-wake them. P-014 is parked for Avi: per D-006 both halves of its premise are void, and the only residual ask is ONE independent grade, which a self-grade cannot satisfy. One deploy-gated action is carried on EI-21233638670808546: recipes:sweep { ids:['recover-exact-held-checkpoint-spill'] }, dryRun first. Nothing here contests the red green-checkpoint gate, which is peer-claimed on WI-40086."
    },
    {
      "slug": "outage-must-not-be-silent-2026-08-02",
      "title": "An outage must never be silent, and a diagnosis must never be a guess",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 20:48:19.171472-04",
      "itemTotal": 11,
      "terminalPlanItems": 11,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 10,
        "dropped": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "PHASE 1 SHIPPED + VERIFIED (P-001..P-004 done) and P-008 (runbook) done. On disk, NOT deployed.\n\n`libs/papercusp/libs/db/src/store-identity.ts` fingerprints a store by cluster `system_identifier` (initdb-assigned, immutable per cluster) + `current_database()`; pins the first determinate identity per process; LATCHES a positive mismatch; INDETERMINATE never rejects (a check that cannot run must never reject a healthy config). Wired into `connection.ts::validateDiscoveryTargetOnce` as one extra column on the existing WI-5244 probe — zero extra round-trips — and it now runs for EVERY pool, not just discovery-sourced ones, because the pin must come from the trusted env/native path or the first impostor observed legitimises itself. Exported from `@papercusp/db-org` as `storeIdentityViolation()`, learning from EI-19306394439939264 where an unexported guard got zero adoption.\n\nVERIFIED: 50 tests green (33 unit + 6 recurrence + 11 rewritten contract), full db suite 168/168 exit 0, `lint:tsc --files` clean on every changed file.\n\nD-001 = liveness is not identity (the obvious fix was already deployed and could not have worked). D-002 = my own correction was itself over-broad: there are TWO discovery implementations and the read path has only a pid gate (filed EI-19384906720464601).",
      "nowNext": "P-005 (fail fast, never hang) is the highest-value item left, and the lead is established: `apps/operator/bin/mcp-proxy.ts` is a 37-line shim over `apps/operator/lib/mcp-proxy/proxy.ts` whose `retryWindowMs` defaults to 90s, yet the observed hang ran past 300s — so find and bound the UNBOUNDED wait beyond that retry window (most likely a missing response timeout once the connection is established) and return a structured error naming the failing plane."
    },
    {
      "slug": "panda-gallery-v1-2026-08-10",
      "title": "Panda gallery v1 — a website displaying panda images over an animated background",
      "harness": "panda-gallery",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-10",
      "updated": "2026-08-10 14:20:58.73893-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 5,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 5
      },
      "itemCounts": {
        "done": 5
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "SHIPPED — P-001..P-005 all DONE (5/5); WI-37766 closed 18:10Z. RUN IT: cd .papercusp/apps/panda-gallery && npm install && npm run dev -> http://localhost:4300 (production: npm run build && npx next start).\n\nINDEPENDENT VERDICT — PASS (goal agent su-12b70e95, OUTSIDE the fleet, 17:57Z): fresh `npm run build` (exit 0) + `npx next start -p 4301` on a separate port so the dev server could not mask it. RAW production HTML via curl, no JS executed: 18 <img> tags + 2 `animated-background` hits — server-rendered, not hydration-dependent. Headless browser on :4301: 18 images, 21 live animationNames.\n\nDelivered: 18 licence-clean Wikimedia panda photographs (all bundled — renders with no network) in a responsive grid with captions + credits; lightbox with keyboard nav and ?photo= URL state; animated background PROVEN in motion (569,586/1,296,000 pixels differ between frames 6s apart; amplified diff confines all change to the background layer); prefers-reduced-motion audited from the shipped production CSSOM (5 motion rules, all under no-preference, zero bare); typecheck clean, 30/30 tests, build exit 0.\n\nHonest limits: reduced-motion is CSSOM/source-verified, NOT runtime media-emulated; the CSSOM audit under-counts animation shorthands containing var(); ~13MB first-paint photo weight accepted deliberately, explicitly not a ship blocker.\n\nBuild trap (fact verify-ssr-by-served-bytes-not-browser-dom): verify SSR by curling served bytes on a free port, never a browser DOM read — and never run `npm run build` while `npm run dev` holds .next/.",
      "nowNext": "Nothing outstanding on this plan — leader su-5697f90c to confirm 5/5 and end the fleet loop; any follow-up (image-weight optimisation, runtime reduced-motion emulation) is new work, not v1 residue."
    },
    {
      "slug": "papercusp-agentic-webapp-template-2026-08-23",
      "title": "papercusp-agentic-webapp — the agentic WEB app template (web twin of papercusp-agentic-desktop-app)",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-23",
      "updated": "2026-08-23 00:31:33.122715-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 1,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 1
      },
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "P-001..P-005 DONE 2026-08-23 (su-945ad, owner-approved route: self). The papercusp-agentic-webapp root exists and is fully pinned: templates/papercusp-agentic-webapp/ (template.yaml + listing.json + GUIDE + checks + reference + vendored template-kit), machine twin AGENTIC_WEBAPP_TEMPLATE in @papercusp/template-kit, templates/README.md updated (six app roots). Evidence: kit suite 81/81 incl. the yaml↔twin/dir-census/GUIDE-lint pins; operator-core template guards 43/43; tsc clean; compose probe over the real 18-dir set green for all 6 app roots (see D-002 for the advisory tauri-shell affinity finding; D-003 for the new vendored-kit sync script scripts/sync-template-kit-vendored.mjs — run it after any canonical kit edit). Changes are in the staging tree awaiting git-sync + the green gate; live templates:list shows the 18th root after the next deploy.",
      "nowNext": "P-006 (owner-gated): push the public templates mirror (npm run mirror:check → mirror:push) once the owner says go. Downstream: calendar-app-papercusp-2026-08-23 + email-app-2026-08-23 materialize FROM this template."
    },
    {
      "slug": "plan-visibility-revamp-2026-08-23",
      "title": "Plan visibility revamp: sidebar dual timestamps, sidebar→detail dashboard, HUD weighted board",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-23",
      "updated": "2026-08-23 16:51:26.920029-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 8,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 7,
        "dropped": 1
      },
      "itemCounts": {
        "done": 8
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 8 items done, verified, plan drained. Shipped: P-001 planWorkActivity.list resolver; P-002 PlansPane ✎/⚒ V1 timestamps; P-003..P-005 option-C plan dashboard + sidebar wiring; P-006 HUD H2 weighted board (weighted cols + rails + seg strip + hudpsort); P-007 enriched plan cards (avatars/liveCount/✎⚒/who-line/settled track); D-005 ALL plan clicks open the ?pdash takeover (harness-qualified encodeScopedRef), hudplanpop + PlanPopupModal removed. Evidence: 299 unit green (runIds 68e896ac + 2029ce3b), tsc clean in touched files, live tauri drives run2 + run5 CLEAN FULL PASS on 121 real cards incl. click→takeover→back and entityCardAges=0. Owner's desktop window reloaded; :3270 verified serving the P-007 css chunk.",
      "nowNext": "Nothing — plan closed. Ships to :3070 automatically via git-sync → green gate (owner's own window runs the dev stack and is already fresh)."
    },
    {
      "slug": "prose-embedding-384-untrained-mrl-fix-2026-08-02",
      "title": "Fix the prose surfaces' untrained MRL-384 embedding cut (EI-19301722864393687)",
      "harness": "papercusp",
      "status": "draft",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-03 20:37:47.311521-04",
      "itemTotal": 9,
      "terminalPlanItems": 9,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 9
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "**P-001..P-005 complete and LIVE. P-006 done except its refill, running now.**\n\n🟢 **MIGRATION 727 APPLIED 2026-08-03T04:41:29Z.** Verified against the live catalog, not the apply log: 12 columns at `vector(768)` — exactly the 12 targets; 4 left at `vector(384)` (`memory_vec_local`, the documented D-005 §6 exclusion, + the 3 inert snapshots); 2 at `vector(1024)` (`memory_vec_harrier`, untouched). The header's arithmetic balances exactly: **16 − 1 − 3 = 12**. `schema_migrations` row present (sha256 `8ff1ba2e…`), 246/246 views recreated, 4/4 HNSW indexes rebuilt, `memory_canonical` 32,641 rows preserved. The 384/768 write-rejection skew — silently dropping ~1 embed/30s for hours — **stopped dead at 04:42Z (0 since)**.\n\n**Three blockers cleared to land it:**\n1. **`db:migrate { confirm:true }` is BROKEN here — EI-19404227117727730 (major).** Two calls hung 300s, never spawned `psql`, Postgres idle throughout. An aborted call also holds `exclusive(db-schema)` its full 10-min TTL, so a retry looks identical. Applied via the tool's own documented fallback, `schema_migrations` INSERT in the SAME transaction.\n2. **Deadlock ×3** at `DROP INDEX work_items_embedding_hnsw_idx` — the ~60s rewrite window before reaching `work_items` lets readers queue into a cycle (112 blocked locks measured). **Fix: pre-lock the whole footprint at t=0 — all 246 dependent views FIRST, then the 12 base tables**, matching reader order (view→base).\n3. **A real defect in 727**, masked by that deadlock: `USING NULL` cannot widen a `NOT NULL` column (`memory_vec_{gemma,openai}.vector`). Fixed in-file (DELETE rows, narrowed to `memory_vec_*`, RAISE otherwise). ⚠ **Never drop the NOT NULL instead** — it applies cleanly, looks successful, and permanently strands every row: both refill paths select on row **ABSENCE**, never a NULL vector.\n\n⚠ **Arming a migration is FLEET-VISIBLE** — it becomes eligible for `release:checkpoint-run`'s preflight (EI-19404620261958999, resolved).",
      "nowNext": "**P-006 step 5 — THE REFILL — is the only P-006 work left, and it is RUNNING.**\n\nDriver: `scripts/refill-prose-vectors-727.mjs` (new), launched 04:49:05Z, log `/tmp/refill-727.log`. Calls `runBackfillSweep({ maxRowsPerTarget: 2_000_000 })` in a loop until a pass embeds nothing.\n\n⚠ **Deliberate deviation** from this block's earlier \"drive `backfillTable` DIRECTLY\" — do not correct it back. EI-19375205903428632's real point was the per-sweep **fairness cap**; raising that cap fixes throughput *without* forking the sweep, keeping embedder resolution, the dims-fit guard, the org pool, liveness probes, spaceAware routing, per-target error isolation and the overlap guard.\n\n- **Idempotent + resumable** (selects on \"vector missing OR different embedder\"), so re-launch simply continues:\n  `set -a; . apps/operator/.env.local; set +a; nohup npx tsx scripts/refill-prose-vectors-727.mjs > /tmp/refill-727.log 2>&1 &`\n- **Wall time only** — gemma runs locally on the :3384 sidecar; no API tokens, and the OpenAI-only spend governor does not bind.\n- **Measured 04:49→04:51: ~4 vectors/s** (plans 213, docs 256, recipes 10 from zero) against **398,834** rows ⇒ **~28h**. Until it catches up the prose surfaces are **LEXICAL-ONLY — degraded, not broken** (hybrid keeps its full-text leg).\n- Too slow? The 10× lever is **EI-19363236885307403** (idle RTX 3090, CUDA provider fails on missing `libcudnn.so.9`) — **NOT** batching (EI-19363253682489176: naive batching is 5× SLOWER, transformers.js pads to the longest text in the batch).\n\n**Then, both now unblocked by the apply:**\n- **P-007** — verify prose search end-to-end in the Tauri shell (`cd papercusp-desktop && npm run dev`, driven headlessly per `/internal/docs/testing/agent-e2e`).\n- **EI-19366433214266471** — the integration test asserting live schema widths match `PROSE_VECTOR_COLUMNS`; it would have landed red before 727, and will now pass."
    },
    {
      "slug": "session-chat-popup-timestamps-and-modes-2026-08-09",
      "title": "Session chat popup: message timestamps, visible sends, live mode state, drain instructions",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-09",
      "updated": "2026-08-09 14:15:28.398018-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 6,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 6
      },
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all six items closed 2026-08-09 at completionAuthority=committed, each citing artifacts (six recorded `tauri-agent-tools check` invocations in /tmp/wi37446-live-checks.log: 4 assertions EXIT=0 + 2 deliberate controls EXIT=1, so the passes are falsifiable). The owner's original symptom is fixed and MEASURED: mode pill 90s -> 211ms (agent_modes set_at 15:48:02.881 -> pill ON 15:48:03.092), DELETE path confirmed too. P-003's trigger+bridge were necessary but NOT sufficient: the residual was the sync bus's bridged dedupe key being TARGET-ONLY, so coord_presence (~1999 writes/10min) monopolised advRoster.list's 90s window and swallowed agent_modes' rare writes. Fixed as WI-37446 (key now per source+target+args), committed in the libs/generic/sync submodule; the superproject pin 8764d69e carries it (verified by ancestry), so it rides the next green gate to :3070. ONE HONEST GAP, deliberately NOT closed as verified: P-004 (WI-37328) is unit-only — self-set mode:set takes the isSelf branch, which does not exercise the peer wake, so that path has never been driven live.",
      "nowNext": "Nothing required for this plan; the one optional follow-up is live-verifying P-004's peer-wake path — an su sets a mode on a DIFFERENT live agent and confirms woken:1 plus a resulting turn."
    },
    {
      "slug": "sidestage-android-app-2026-08-13",
      "title": "SideStage Android app — papercup-rust-mobile framework (Rust core + UniFFI + Compose)",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-13",
      "updated": "2026-08-14 19:19:17.185275-04",
      "itemTotal": 10,
      "terminalPlanItems": 10,
      "openPlanItems": 0,
      "workItemTotal": 10,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 10
      },
      "itemCounts": {
        "done": 10
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "D-009 GATE STILL CLOSED, but the blocking deliverable is DONE. The mockup Avi asked for is built, render-verified, and delivered to him for approval (msg mssn2e0h, 07:41Z): /home/marsh-office/.papercusp/hives/sidestage/mockups/mobile-buyer-orders.html — a self-contained page showing Buyer + Orders as iPhone 15 Pro and Pixel 8 at true device proportions, drawn from the RUNNING web app's real copy, catalog rows and tokens (ivory #FFF8EF / ink #2A1F1A / vermilion #D62B1F), with 8 keyed platform deltas (D1-D8) and 3 layout decisions flagged to Avi as overrulable (chat-as-sheet vs third tab; Hold inline vs detail sheet; stage inline vs full-bleed). Scope honoured: 2 tabs only per D-007/D-008. Both fleets notified it exists and that the gate remains closed (msg mssn2e1p, 7 live members). DELIVERY CAVEAT: artifact publishing is unavailable to this session (ANTHROPIC_AUTH_TOKEN takes precedence over a claude.ai login), so it is a local file path rather than a hosted link — flagged to Avi as an owner-gated wall.",
      "nowNext": "WAIT on Avi's approval — it is the single condition that opens D-009. On his YES: emit the gate to both fleets and release the ~6 agents parked on screen layout / navigation / visual structure, with the mockup as the SPEC (not a reference). On any of his three flagged decisions coming back changed: revise the mockup first, then open the gate. Meanwhile lanes work NON-UI only (shared Rust core, API client, test scaffolding) — WI-38624 stays parked with the D-009 reason, NOT needs-human (it needs the mockup, not the owner)."
    },
    {
      "slug": "sidestage-blocked-items-audit-2026-08-15",
      "title": "Audit and reconcile every blocked SideStage plan and work item",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-15",
      "updated": "2026-08-15 04:37:12.404628-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Approved for execution via route A.",
      "nowNext": "Inventory every effective plan block and blocked/held work-item, then reconcile stale state safely."
    },
    {
      "slug": "sidestage-checkout-shipping-2026-08-13",
      "title": "SideStage checkout + shipping calculator — port from Restart shop-api [owner:Avi 2026-08-13 \"take the checkout and shipping calculator we had on our restart site and integrate it into our sidestage site\"]",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-13",
      "updated": "2026-08-14 04:57:22.112415-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 4,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 4
      },
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "sidestage-page-design-audit-mockups-2026-08-14",
      "title": "SideStage per-page design audit and responsive mockups",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-14",
      "updated": "2026-08-14 04:55:25.741928-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "sidestage-public-release-testing-2026-08-14",
      "title": "SideStage public-release testing campaign — pass the rubric, ship with confidence",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-14",
      "updated": "2026-08-16 04:33:59.634886-04",
      "itemTotal": 10,
      "terminalPlanItems": 10,
      "openPlanItems": 0,
      "workItemTotal": 10,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 10
      },
      "itemCounts": {
        "done": 10
      },
      "audit": null,
      "acceptanceRubric": {
        "rubricId": "release-readiness-sidestage-2026-08-14",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "sidestage-studio-event-activation-scheduling-mockups-2026-08-14",
      "title": "Sidestage Studio event activation and scheduling UX mockups",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-15",
      "updated": "2026-08-14 21:18:15.959336-04",
      "itemTotal": 8,
      "terminalPlanItems": 8,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4,
        "dropped": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Complete. Current-state audit, zero-warning interaction model (D-001), four project-bound mockups, validation, and owner delivery are complete; canonical P-001 through P-004 are done.",
      "nowNext": "No further work in this design-only plan. Product implementation remains outside scope and behind the Sidestage P-009 release-snapshot gate."
    },
    {
      "slug": "sidestage-watch-coming-up-next-mockups-2026-08-14",
      "title": "SideStage Watch — Coming up next mockup gallery",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-15",
      "updated": "2026-08-14 22:48:47.10476-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Complete. D-003 records Avi’s selection of Concept 02 — Drop Runway. The standalone comparison gallery now annotates that choice in the toolbar, Concept 02 card, and footer; all three UI IR specs remain schema-valid and lint-clean with zero errors/warnings, and fresh desktop/mobile Verdict QA confirmed the accessible selection state, HTTP 200 responses, and no console messages. The owner-local review URL is http://127.0.0.1:41033/; canonical source remains design/sidestage-watch-coming-up-next-mockups-2026-08-14/index.html. No production SideStage UI was changed by this plan.",
      "nowNext": "The separately approved Drop Runway production implementation may use D-003 and the canonical gallery as its design basis; this mockup-only plan needs no further edits."
    },
    {
      "slug": "task-manager-public-release-readiness-2026-08-11",
      "title": "Task Manager public-release readiness",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-11",
      "updated": "2026-08-12 07:59:54.141131-04",
      "itemTotal": 6,
      "terminalPlanItems": 6,
      "openPlanItems": 0,
      "workItemTotal": 6,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 6
      },
      "itemCounts": {
        "done": 6
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Audit complete enough to execute. The original 25-item task-manager plan is shipped and the `papercusp-task-manager` flag is enabled. A live authoritative reconcile on 2026-08-11 found 40 running ledger rows, zero stranded, zero unaccounted, zero overdue, and no degradation; the 30-second `task-reconcile` routine is active. A fresh major alert reported six unaccounted cgroups shortly beforehand, so intermittent accounting correctness is the primary release blocker until reproduced or disproved.",
      "nowNext": "Reproduce and settle the intermittent unaccounted-scope incident, then complete UI/safety, regression, browser, and green-pipeline gates."
    },
    {
      "slug": "thinking-gauge-cross-client-2026-08-14",
      "title": "Correct and live-refresh Codex/OMP thinking gauge",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-14",
      "updated": "2026-08-14 04:19:03.523059-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "token-composition-injected-context-2026-08-12",
      "title": "Break out injected context in the token-composition baseline (the one gap the existing transcript measurement does not attribute)",
      "harness": "papercusp",
      "status": "draft",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-12",
      "updated": "2026-08-11 22:57:35.975716-04",
      "itemTotal": 1,
      "terminalPlanItems": 1,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Owner asked what share of tokens is context vs tool calls vs everything else. Investigation 2026-08-12 found the measurement substrate ALREADY EXISTS and that two of this plan's originally-drafted items rested on FALSE premises, which were corrected before any code was written. Remaining work is one item: teach the existing baseline script to break out injected context.",
      "nowNext": "P-001 — extend `scripts/measure-context-token-baseline.mjs` with an `injected_context` attribution, then run it and record the composition."
    },
    {
      "slug": "trap-guards-followups-2026-08-01",
      "title": "Trap-guards follow-ups — fix the ambiguous signals the fleet run exposed",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-01",
      "updated": "2026-08-01 19:58:32.406655-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4,
        "dropped": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — 5/5 settled, solo, each flipped only on evidence. P-001 DONE: the ?lhive= red was fixed by the retirement author after I routed it; I verified the LINK is correct, not merely the assertion (`slug` is the canonical pot param the top-bar selector reads; `learnings` is in HIVE_AWARE_VIEWS), 28/28 green, EI-18742382546783068 auto-resolved on 3 consecutive greens. P-002 DONE: implemented from my filing by su-1f464b1c, re-verified independently 73/73 — `all_matches_gated` is now the explicit effect-vs-cause counterpart of `spec_matches_nothing`. P-003 DONE (mine): the lint had been redesigned better than either remedy I proposed, so the real gap was that its rationale lived only in header prose; extracted `scanTextForCallReferences` and pinned 5 guards against SYNTHETIC fixtures, then PROVED teeth by replaying bare-token CALL_RE (4+3 false positives incl. `messages:write`). 7/7, TSC clean. P-004 DROPPED with a public retraction — both halves already existed (pc-heavy.sh flock semaphore, 4 slots; the durable log path is printed before the run); my \"17 concurrent sweeps\" was a process-line miscount of 4 real runs at the cap. Residue filed rather than left in prose. P-005 DONE (mine): split `CoverageLevel` — new `held-not-live` band separates \"never taken\" from \"taken by a holder who is gone\", covering the direct-claim case that read as `none`. 136/136 green, TSC clean on all 5 files. D-001 corrects my own wrong 2026-07-26 coord ruling that the ledger's `assignee` is authoritative over coverage.",
      "nowNext": "Nothing on this plan — it is closed. One incidental finding is filed and owned elsewhere: WI-6753 (a peer's new `fleet/require-checkpoint.ts:400` passes `text` to `SendOptions`; one TS2353 that reds `lint:tsc` for the whole fleet until its author fixes it)."
    },
    {
      "slug": "typescript-7-upgrade-2026-08-20",
      "title": "Upgrade active Papercusp workspaces to TypeScript 7.0.2",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-21",
      "updated": "2026-08-20 23:38:54.252494-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 4,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 4
      },
      "itemCounts": {
        "done": 4
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "vditor-local-assets-plan-popup-latency-2026-08-02",
      "title": "Plan popup opens in seconds, not instantly: Vditor pulls 4.9MB from unpkg.com per cold render",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-02",
      "updated": "2026-08-02 14:05:28.221857-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "wake-deaf-pty-host-guard-2026-08-13",
      "title": "Durable fix for the wake-deaf pty-host class: an external, vintage-agnostic wedge detector",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-13",
      "updated": "2026-08-13 01:05:08.556736-04",
      "itemTotal": 7,
      "terminalPlanItems": 7,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 7
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "wi-3962-retire-dead-probe-hops-2026-08-23",
      "title": "Retire dead federation probe hop promises (WI-3962)",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-23",
      "updated": "2026-08-23 14:30:15.767074-04",
      "itemTotal": 1,
      "terminalPlanItems": 1,
      "openPlanItems": 0,
      "workItemTotal": 1,
      "openWorkItems": 0,
      "workItemStates": {
        "dropped": 1
      },
      "itemCounts": {
        "dropped": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "work-item-completion-boundary-integrity-2026-08-20",
      "title": "Repair work-item completion boundary integrity gaps",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-evidence-missing",
      "reason": "All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.",
      "recommendation": "Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.",
      "created": "2026-08-20",
      "updated": "2026-08-20 19:03:08.144197-04",
      "itemTotal": 1,
      "terminalPlanItems": 1,
      "openPlanItems": 0,
      "workItemTotal": 1,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 1
      },
      "itemCounts": {
        "done": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "oddsmith-recovery-and-hardening-2026-08-16",
      "title": "Oddsmith recovery + hardening after the 2026-08-15 wipe",
      "harness": "oddsmith-hive",
      "status": "active",
      "category": "closeout-stale-audit",
      "reason": "The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.",
      "recommendation": "Re-audit only the stale items/citations, re-grade current acceptance, then ship.",
      "created": "2026-08-16",
      "updated": "2026-08-17 09:36:59.099828-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-17 09:51:44.682555-04",
        "auditedSha": "7c6e395",
        "auditedItems": 4
      },
      "acceptanceRubric": {
        "rubricId": "oddsmith-recovery-and-hardening-2026-08-16-acceptance",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "audit_coverage_stale",
        "message": "plan 'oddsmith-recovery-and-hardening-2026-08-16' cannot be marked shipped: 4 item audit(s) are missing or stale — P-001: item-text fingerprint is missing from audit #1; P-002: item-text fingerprint is missing from audit #1; apps/desktop/src/lib/loop-health.ts has no audit-time blob fingerprint (audit #1); apps/desktop/src/lib/loop-health.ts has no audit-time blob fingerprint (audit #1); P-003: item-text fingerprint is missing from audit #1; apps/desktop/src/_hono/app.ts has no audit-time blob fingerprint (audit #1); apps/desktop/src/lib/local-dbos-wiring.ts has no audit-time blob fingerprint (audit #1); P-004: item-text fingerprint is missing from audit #1. Re-run plans:audit for ONLY the listed items. Every unlisted item carries forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. If no items are listed on a future check, no new audit pass is required. To ship anyway, pass force:{ reason }."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all four Phase 1 items are done (P-001 backup+staleness alarm, P-002 dist rebuild + green crons, P-003 ingestion re-home + failing health, P-004 zero-order engine diagnosis). P-001 was re-verified against disk on 2026-08-17T13:35Z rather than trusted from its mirrored status: /mnt/data/Backup/db-dumps/pg/oddsmith holds a 37MB pg_dump dir written 13:05:26Z and STATUS.json reports oddsmithOk:true, failed:[], with a live oddsmithLastSuccessEpoch (30min old). RESIDUE, none of it in this plan's scope: (a) oddsmith deploys are still frozen, but the cause is now fully proven and is NOT a gate defect — the 13:19Z green-checkpoint run stamped `green=true promoted=false reason=push-failed`, i.e. the suite is green and the sole blocker is the dead git push credential (WI-39549, owner-gated: re-auth aviynw on this box or grant papercupai push). 461 commits unpushed since 2026-07-26. (b) WI-39671 (green-checkpoint stall) is resolved pending one confirming run. (c) Untouched oddsmith backlog outside this plan: WI-6175 (daily-loss gate measures cash deployed, not loss — has halted live kalshi 7d) and WI-5735 (LLM analyst dead).",
      "nowNext": "Nothing in this plan — it is done. The one action that would move oddsmith forward is owner-gated and tracked as WI-39549: restore the git push credential so the already-green gate can promote and deploys unfreeze."
    },
    {
      "slug": "sidestage-architecture-page-2026-08-15",
      "title": "SideStage architecture page and complete system documentation",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-stale-audit",
      "reason": "The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.",
      "recommendation": "Re-audit only the stale items/citations, re-grade current acceptance, then ship.",
      "created": "2026-08-15",
      "updated": "2026-08-15 00:22:33.036588-04",
      "itemTotal": 4,
      "terminalPlanItems": 4,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-15 00:23:53.861342-04",
        "auditedSha": "05223bc",
        "auditedItems": 4
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-sidestage-architecture-page-2026-08-15",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "audit_coverage_stale",
        "message": "plan 'sidestage-architecture-page-2026-08-15' cannot be marked shipped: 4 item audit(s) are missing or stale — P-001: item-text fingerprint is missing from audit #1; apps/api/src/app.module.ts has no audit-time blob fingerprint (audit #1); db/schema.sql has no audit-time blob fingerprint (audit #1); P-002: item-text fingerprint is missing from audit #1; apps/web/src/ArchitectureTab.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/architecture.css has no audit-time blob fingerprint (audit #1); P-003: item-text fingerprint is missing from audit #1; apps/web/src/app-routing.ts has no audit-time blob fingerprint (audit #1); apps/web/src/ArchitectureTab.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/ArchitectureTab.tsx has no audit-time blob fingerprint (audit #1); P-004: item-text fingerprint is missing from audit #1; apps/web/src/ArchitectureTab.test.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/App.test.tsx has no audit-time blob fingerprint (audit #1). Re-run plans:audit for ONLY the listed items. Every unlisted item carries forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. If no items are listed on a future check, no new audit pass is required. To ship anyway, pass force:{ reason }."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "sidestage-copilot-queue-inspector-implementation-2026-08-15",
      "title": "Implement the selected Queue + inspector Copilot layout",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-stale-audit",
      "reason": "The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.",
      "recommendation": "Re-audit only the stale items/citations, re-grade current acceptance, then ship.",
      "created": "2026-08-15",
      "updated": "2026-08-15 00:34:41.124521-04",
      "itemTotal": 2,
      "terminalPlanItems": 2,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 2
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-15 00:35:43.618014-04",
        "auditedSha": "c2f2abd3ca2478e174e7249f50d17e5ae357fe6a",
        "auditedItems": 2
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-sidestage-copilot-queue-inspector-2026-08-15",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "audit_coverage_stale",
        "message": "plan 'sidestage-copilot-queue-inspector-implementation-2026-08-15' cannot be marked shipped: 2 item audit(s) are missing or stale — P-001: item-text fingerprint is missing from audit #1; apps/web/src/CopilotPanel.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/CopilotPanel.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/styles.css has no audit-time blob fingerprint (audit #1); apps/web/src/styles.css has no audit-time blob fingerprint (audit #1); apps/web/src/CopilotPanel.integration.test.tsx has no audit-time blob fingerprint (audit #1); P-002: item-text fingerprint is missing from audit #1; apps/web/src/CopilotPanel.integration.test.tsx has no audit-time blob fingerprint (audit #1). Re-run plans:audit for ONLY the listed items. Every unlisted item carries forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. If no items are listed on a future check, no new audit pass is required. To ship anyway, pass force:{ reason }."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Draft. Plan body to be filled in.",
      "nowNext": "human reviews scope and lists Phase 1 items."
    },
    {
      "slug": "sidestage-plan-harness-migration-history-completeness-2026-08-14",
      "title": "Consolidate every SideStage plan into the SideStage project and make History complete",
      "harness": "sidestage",
      "status": "ready",
      "category": "closeout-stale-audit",
      "reason": "The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.",
      "recommendation": "Re-audit only the stale items/citations, re-grade current acceptance, then ship.",
      "created": "2026-08-15",
      "updated": "2026-08-14 21:35:42.863905-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 5
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-14 21:46:11.598718-04",
        "auditedSha": "5f2d42e5f808403fe3f9d96ad4d72eb259c1e3d4",
        "auditedItems": 5
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-sidestage-plan-harness-migration-history-completeness-2026-08-14",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "audit_coverage_stale",
        "message": "plan 'sidestage-plan-harness-migration-history-completeness-2026-08-14' cannot be marked shipped: 5 item audit(s) are missing or stale — P-001: item-text fingerprint is missing from audit #1; P-002: item-text fingerprint is missing from audit #1; P-003: item-text fingerprint is missing from audit #1; apps/api/src/build-history/build-history.service.test.ts has no audit-time blob fingerprint (audit #1); P-004: item-text fingerprint is missing from audit #1; apps/api/src/build-history/build-history.snapshot.ts has no audit-time blob fingerprint (audit #1); apps/api/src/build-history/build-history.snapshot.ts has no audit-time blob fingerprint (audit #1); apps/api/src/build-history/build-history.snapshot.ts has no audit-time blob fingerprint (audit #1); apps/api/src/build-history/build-history.service.test.ts has no audit-time blob fingerprint (audit #1); apps/api/src/build-history/build-history.service.test.ts has no audit-time blob fingerprint (audit #1); P-005: item-text fingerprint is missing from audit #1; apps/web/src/BuildHistoryTab.test.tsx has no audit-time blob fingerprint (audit #1); apps/web/src/BuildHistoryTab.dialog.test.tsx has no audit-time blob fingerprint (audit #1). Re-run plans:audit for ONLY the listed items. Every unlisted item carries forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. If no items are listed on a future check, no new audit pass is required. To ship anyway, pass force:{ reason }."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    },
    {
      "slug": "su-agent-policies-injection-audit-2026-08-21",
      "title": "Audit su agent-policies injection and fresh-session compliance",
      "harness": "papercusp",
      "status": "ready",
      "category": "closeout-stale-audit",
      "reason": "The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.",
      "recommendation": "Re-audit only the stale items/citations, re-grade current acceptance, then ship.",
      "created": "2026-08-21",
      "updated": "2026-08-21 11:21:19.012774-04",
      "itemTotal": 5,
      "terminalPlanItems": 5,
      "openPlanItems": 0,
      "workItemTotal": 2,
      "openWorkItems": 0,
      "workItemStates": {
        "done": 2
      },
      "itemCounts": {
        "done": 5
      },
      "audit": {
        "auditSeq": 1,
        "createdAt": "2026-08-21 11:22:15.19608-04",
        "auditedSha": "ded84e8b4730dc94beaae26d33441dadc5f456cd",
        "auditedItems": 5
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-su-agent-policies-injection-audit-2026-08-21",
        "status": "active"
      },
      "gateVerdict": {
        "satisfied": false,
        "code": "audit_coverage_stale",
        "message": "plan 'su-agent-policies-injection-audit-2026-08-21' cannot be marked shipped: 5 item audit(s) are missing or stale — P-001: item-text fingerprint is missing from audit #1; P-002: item-text fingerprint is missing from audit #1; packages/operator-core/lib/role-launch-spec.ts has no audit-time blob fingerprint (audit #1); packages/operator-core/lib/role-launch-spec.test.ts has no audit-time blob fingerprint (audit #1); P-003: item-text fingerprint is missing from audit #1; P-004: item-text fingerprint is missing from audit #1; P-005: item-text fingerprint is missing from audit #1. Re-run plans:audit for ONLY the listed items. Every unlisted item carries forward mechanically with its original auditedSha/auditedAt, so do not resubmit unchanged items. If no items are listed on a future check, no new audit pass is required. To ship anyway, pass force:{ reason }."
      },
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "Durable investigation created at Avi's request. P-001–P-003 are complete: successor state reconciled; launch source confirms no agent-policies.mdx body injection; token cost measured at 7,835 raw-MDX o200k tokens and 7,564 cleaned-body tokens. P-004 is actively claimed by su-e66f05d4. The first unbounded session_turn_parts aggregation timed out and was filed; the remaining audit must use the ingested_at index and bounded candidates.",
      "nowNext": "Run the bounded/index-friendly fresh-su transcript query, validate hits as actual document reads rather than mere string mentions, then complete P-004 and deliver P-005's evidence-backed report to Avi."
    },
    {
      "slug": "verify-0014-alpha-on-real-platforms-2026-08-10",
      "title": "Runtime-verify the published 0.0.14-alpha installers on macOS, Windows and Linux",
      "harness": "papercusp",
      "status": "active",
      "category": "closeout-status-residue",
      "reason": "The plan says it is complete/shipped while its lifecycle or item ledger remains nonterminal.",
      "recommendation": "Reconcile the residual status labels against current evidence, then close.",
      "created": "2026-08-10",
      "updated": "2026-08-10 10:41:53.309732-04",
      "itemTotal": 5,
      "terminalPlanItems": 4,
      "openPlanItems": 1,
      "workItemTotal": 0,
      "openWorkItems": 0,
      "workItemStates": {},
      "itemCounts": {
        "done": 4,
        "todo": 1
      },
      "audit": null,
      "acceptanceRubric": null,
      "gateVerdict": null,
      "owners": [],
      "blocker": {
        "typedBlocked": false,
        "typedHuman": false,
        "refs": [],
        "staleHints": []
      },
      "nowState": "COMPLETE — all 4 legs verified on real machines, report delivered to Avi 14:33Z (artifact https://claude.ai/code/artifact/29839958-f3f6-4a51-9d93-59fa1d56faa8). Verdicts: macOS PASS · Linux .deb PASS / AppImage qualified · Windows INSTALL PASS + RUNTIME FAIL · Update path FAIL. Two critical defects found and independently re-verified by the leader: WI-37736 (Windows sidecar dies every launch) and WI-37738 (all pre-07-28 installs permanently stranded from updates). Fleet stood down 14:35Z.",
      "nowNext": "Nothing further on THIS plan — remediation moved to fix-0014-platform-defects-2026-08-10 under owner directive 'fix the issues for all platforms' (2026-08-10 14:39Z)."
    }
  ]
}

