# Shared agent obligations — current acceptance evidence

Plan: `shared-agent-obligations-and-briefs-2026-09-05`, revision 53.
Work item: `WI-2147072` / P-008. This is an in-progress evidence record; shipment is not yet verified.

## Contract

Acceptance rubric revision 5 preserves the seven existing outcomes and adds the required test layers. Independent approval is WI-10000444, thread-post:200074. A fresh complete amendment preview matched that approval before the CAS write from rubric 4 / plan 52. The resulting bar-set hash is `ca3298f63363387825eb41a28d0e69705d0b4c995a9bf26997073191cdce328f`.

The current rubric is revision **6**. It adds the concrete structured-check files requested in independent critique WI-10000492 / comment200159 and clarifies the external GUI-journey evidence. BAR meanings, hashes, required layers and evidence planes are unchanged. Independent follow-up WI-10000511 / comment200173 passes all six meta criteria. The new meta attestation is EI-22595027678539732; its grading-integrity audit remains required.

R-1 through R-5 require tree evidence. R-6 additionally requires containing deployment evidence. R-7 additionally requires a real cockpit journey; staging or an isolated current build is admissible. Component tests cannot satisfy that journey. Decisions D-011 and D-015 retain unexercised live-agent behavior and canary residue.

## Current automated execution

The repository test router ran 15 files, comprising acceptance unit/component checks and the owner-report / goals PostgreSQL integration checks, at `ddb59a866e`, starting 2026-09-07T08:54:14.620Z and completing by 09:00:10Z. All 419 tests passed: 277 core unit tests, 113 component tests, and 29 real-PostgreSQL integration tests. No tests were skipped; the named paths were clean before and after. Full execution log: `/tmp/wi2147072-acceptance-tests-0854.log`.

The additional event-await store and unanswered-directed PostgreSQL tests passed 100/100, with zero skips, at the same clean revision. Execution ran from 09:06:25Z to 09:10:19Z; log: `/tmp/wi2147072-recovery-tests-0906.log`. The implementation files recorded by the proof bindings have no diff from `ddb59a866e` at the subsequent verification read.

The newly bound launch-agent / launch-on-plan checks passed 290 tests and the OMP injection checks passed 60 tests, with zero skips, at `e9f641f0a5`. Log: `/tmp/wi2147072-check-binding-tests-0927.log`.

At the subsequent source check, every bound implementation file remained byte-identical to its tested revision. `leader-brief-shape.test.ts` had one TypeScript-only cast correction (`as unknown as`); its current focused router run `88060f43-eacc-4d67-879a-008c4bc3fd37` passed 26 tests, with zero failures, skips or collection errors. Seven affected bindings were refreshed as IDs **1390–1396**, with the current test-file SHA-256 snapshots and that supplemental execution recorded on each binding. The remaining historical execution observations retain their original timestamps. A new explicit-current adequacy evaluation passed all **19** clauses, with zero fail/unknown results. Current comparison payload: `/tmp/wi2147072-adequacy-current-1001.json`; bounded verdict record: `/tmp/wi2147072-adequacy-current-summary.json`.

The separate provider, evaluator, leader brief, and brief-shape run passed 307 tests at `98d9146953` with no skips. Its 234 leader-brief tests supplement the checks above. The provider, evaluator, and leader-brief implementation files have no diff between that revision and `ddb59a866e`.

The PostgreSQL goals checks execute the actual goal detail resolver, including the holder's exact turn-start obligation projection and canonical portfolio. The owner-report integration checks verify the newest complete exact-goal evidence across reporting channels and reject incomplete, wrong-subject, wrong-owner, wrong-workspace, and non-human rows.

## Frozen policy pilot

The three six-row matrices remain unchanged: SHA-256 of `packages/operator-core/lib/agent-obligation-providers.test.ts` is `f25fb93c541bedbedc423ae3f7efce8b67a33e630f2e483583d2c180de31a3b9`. The current framework run asserts each provider's actual status and action against its authored fixture oracle. An AST census of those passing matrices gives:

| Family | Due | Blocked | Satisfied | No demand | Unknown | In progress | Opportunities |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Placement | 1 | 1 | 1 | 1 | 1 | 1 | 6 |
| Owner report | 2 | 0 | 1 | 2 | 1 | 0 | 6 |
| Independent verification | 2 | 1 | 1 | 1 | 1 | 0 | 6 |

Eight known actionable cases and three unknown cases have explicit next actions; the latter request inspection and are never reclassified as due or satisfied. The seven satisfied/no-demand controls have no action. Those fixture controls produce zero false interventions. These are 18 deterministic opportunities, not 18 completed live work cycles.

The shared evaluator has a three-entry / 400 estimated-token ceiling, with tighter sink limits. Tests exercise the token ceiling, explicit overflow, observed-effect clearing, unknown handling, and operation/admission agreement. The evaluator imports only Node crypto and makes no inference request. Zero inference applies to this policy execution, not to the engineering or grading sessions.

The historical Work-on-everything run in D-011 is a separate population: its 4.4/10 GOAL and 5.0/10 stewardship grades, 15 reports, and 93.5-minute longest report gap are context. They are not denominators for a claimed live behavioral improvement. Current live completed cycles, missed obligations, outcome timeliness, and changed LLM behavior remain unmeasured. P-007 recorded a historical warm source read of 754 ms; this is not a fresh evaluator-latency measurement.

A separate current microbenchmark executed the pure evaluator plus leader-brief projection over the captured ten-row server reading (eight primary rows), with 100 warmups and 1,000 measured iterations. Mean was 0.0403 ms, p95 0.0670 ms, maximum 0.7374 ms. It delivered three entries / 964 characters / 241 estimated tokens. This measures local computation, not IO, cold startup, or live completed cycles. Output and reproducible input: `/tmp/wi2147072-evaluator-benchmark-0919.json` and the captured GUI payload below. Timer diagnostic strings in the live degraded reading exceeded the configured optional-source timeout; their measurement origin and scheduler delay remain unconfirmed under EI-22593756574584299. No strict live wall-time claim is made from the benchmark.

## Verifier repairs and open runtime evidence

Runtime package exports now survive the source copy; dependency hardlinks stay on the donor filesystem; bulk SPA/profile/database allocations stay on TMPDIR; aggregate demand is checked and reserved through the existing shared disk ledger. The focused recurrence suite passed 25 tests, including real rsync plus CJS package loading, a blanket-exclusion negative control, same-device selection, aggregate capacity refusal, and reservation rollback. These fixes are closed as EI-22590231221058313, EI-22588292228855829, and EI-22589054433344154.

The fourth real rig successfully copied source/SPA and initialized PostgreSQL, then failed because Cargo selected a nonexistent sibling target under a non-writable parent. That distinct repair is owned under EI-22591751627922907. No GUI pass is claimed from that run.

The fifth rig successfully ran the real desktop at PID 3924823, display :91, port 33710, serving `ddb59a866e`. It used the available shared Cargo slot zero; it does not validate the peer's alternate-slot repair. The journey opened the installed goal through its card, waited for real goal data, compared the exact server-provided component payload with the DOM, closed the cockpit and verified `hudgoal` disappeared, reopened through the card, and captured the rendered section. All seven parity checks passed: status, generation, observation time, action, omitted count, recovery text, and absence of false all-clear. The goal remained killed throughout; the verifier was stopped afterward.

The exact parity sample was degraded at generation `9fdb18df0f498e361ca3`, observed 09:13:46.539Z, with a turn-start receipt of one delivered entry, seven omitted, 255 characters and 64 estimated tokens. The screenshot is a separate later refresh at generation `6f9c85c1cfaf49675789`, observed 09:15:11.225Z. Complete payload, DOM observations and journey checks are in [the GUI record](shared-agent-obligations-2026-09-07-gui-journey.json); [the screenshot](shared-agent-obligations-2026-09-07-goal-mode-state.png) was visually inspected. This exercises the live degraded/unknown path. Known/no-demand cases remain covered by component and PostgreSQL integration tests; no live opportunity was induced.

Still required: independent grading-integrity audit of the revision-6 meta attestation and independent implementation grading (WI-10000514); the accountable acceptance verdict; feature-containing deployment proof; final audit and ship transition.

The final runtime check at **2026-09-07T10:23:22.946735Z** found the deployment requirement unmet. The serving operator's `/api/health` reported `e66be3c4ff`. Its build identity is resolved at module load in `apps/operator/bin/serve.ts` and cached by `getBuildInfo()`. Git object reads at that reported revision could not resolve the four obligation engine, reader, provider and reminder source files. The GUI section and model matching current bytes therefore did not establish deployment of the underlying feature. This is a timestamped negative shipment observation, recorded as WI-2147072 comment200245; it is not a statement about a later runtime or the live release gate.

## Proof binding index

The table below records the historical spec-revision-2 bindings. Revision 6 projected every clause to **spec revision 3**. Forty current bindings, IDs **1344–1383**, retain the unchanged test and GUI observations and add the launch / OMP witnesses; their complete payload is `/tmp/wi2147072-proof-bindings-r6.json`. All 19 current clauses passed `plans:evaluate-spec-test-adequacy` with explicit current fingerprints (zero fail/unknown). This adequacy result does not supply the missing R-6 deployment proof or independent implementation acceptance. The old binding payload remains `/tmp/wi2147072-proof-bindings-0906.json`.

| BAR / item | Layer | Binding ID |
| --- | --- | ---: |
| <a id="R-1-P-002-unit-ddb59a866e"></a>R-1 / P-002 | unit | 1309 |
| <a id="R-1-P-002-integration-ddb59a866e"></a>R-1 / P-002 | integration | 1310 |
| <a id="R-1-P-003-unit-ddb59a866e"></a>R-1 / P-003 | unit | 1311 |
| <a id="R-1-P-003-integration-ddb59a866e"></a>R-1 / P-003 | integration | 1312 |
| <a id="R-1-P-004-unit-ddb59a866e"></a>R-1 / P-004 | unit | 1313 |
| <a id="R-1-P-004-integration-ddb59a866e"></a>R-1 / P-004 | integration | 1314 |
| <a id="R-1-P-007-unit-ddb59a866e"></a>R-1 / P-007 | unit | 1315 |
| <a id="R-1-P-007-integration-ddb59a866e"></a>R-1 / P-007 | integration | 1316 |
| <a id="R-1-P-009-unit-ddb59a866e"></a>R-1 / P-009 | unit | 1317 |
| <a id="R-1-P-009-integration-ddb59a866e"></a>R-1 / P-009 | integration | 1318 |
| <a id="R-2-P-003-unit-ddb59a866e"></a>R-2 / P-003 | unit | 1319 |
| <a id="R-2-P-006-unit-ddb59a866e"></a>R-2 / P-006 | unit | 1320 |
| <a id="R-2-P-007-unit-ddb59a866e"></a>R-2 / P-007 | unit | 1321 |
| <a id="R-3-P-003-unit-ddb59a866e"></a>R-3 / P-003 | unit | 1322 |
| <a id="R-3-P-003-integration-ddb59a866e"></a>R-3 / P-003 | integration | 1323 |
| <a id="R-3-P-006-unit-ddb59a866e"></a>R-3 / P-006 | unit | 1324 |
| <a id="R-3-P-006-integration-ddb59a866e"></a>R-3 / P-006 | integration | 1325 |
| <a id="R-3-P-007-unit-ddb59a866e"></a>R-3 / P-007 | unit | 1326 |
| <a id="R-3-P-007-integration-ddb59a866e"></a>R-3 / P-007 | integration | 1327 |
| <a id="R-4-P-005-unit-ddb59a866e"></a>R-4 / P-005 | unit | 1328 |
| <a id="R-4-P-007-unit-ddb59a866e"></a>R-4 / P-007 | unit | 1329 |
| <a id="R-5-P-004-unit-ddb59a866e"></a>R-5 / P-004 | unit | 1330 |
| <a id="R-5-P-007-unit-ddb59a866e"></a>R-5 / P-007 | unit | 1331 |
| <a id="R-6-P-008-unit-ddb59a866e"></a>R-6 / P-008 | unit | 1332 |
| <a id="R-7-P-007-unit-ddb59a866e"></a>R-7 / P-007 | unit | 1333 |
| <a id="R-7-P-007-integration-ddb59a866e"></a>R-7 / P-007 | integration | 1334 |
| <a id="R-7-P-008-unit-ddb59a866e"></a>R-7 / P-008 | unit | 1335 |
| <a id="R-7-P-008-integration-ddb59a866e"></a>R-7 / P-008 | integration | 1336 |
| <a id="R-7-P-009-unit-ddb59a866e"></a>R-7 / P-009 | unit | 1337 |
| <a id="R-7-P-009-integration-ddb59a866e"></a>R-7 / P-009 | integration | 1338 |
| <a id="R-4-P-005-integration-ddb59a866e"></a>R-4 / P-005 | integration | 1339 |
| <a id="R-4-P-007-integration-ddb59a866e"></a>R-4 / P-007 | integration | 1340 |
| R-7 / P-007 | live E2E, GUI record | 1341 |
| R-7 / P-008 | live E2E, GUI record | 1342 |
| R-7 / P-009 | live E2E, GUI record | 1343 |

The following anchors identify the additional current-revision check witnesses in the forty-row payload:

- <a id="R-2-P-003-additional-checks-e9f641f0a5"></a>R-2 / P-003: launch-agent and launch-on-plan no-write controls.
- <a id="R-2-P-006-additional-checks-e9f641f0a5"></a>R-2 / P-006: the same concrete launch-boundary checks.
- <a id="R-2-P-007-additional-checks-e9f641f0a5"></a>R-2 / P-007: the same integrated launch-boundary checks.
- <a id="R-5-P-004-additional-checks-e9f641f0a5"></a>R-5 / P-004: OMP port budget and hung-dispatch controls.
- <a id="R-5-P-007-additional-checks-e9f641f0a5"></a>R-5 / P-007: the same injection-port controls.
