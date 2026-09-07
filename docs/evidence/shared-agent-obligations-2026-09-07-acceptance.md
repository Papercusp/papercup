# Shared agent obligations — current acceptance evidence

Plan: `shared-agent-obligations-and-briefs-2026-09-05`, revision 53.
Work item: `WI-2147072` / P-008. This is an in-progress evidence record; shipment is not yet verified.

## Contract

Acceptance rubric revision 5 preserves the seven existing outcomes and adds the required test layers. Independent approval is WI-10000444, thread-post:200074. A fresh complete amendment preview matched that approval before the CAS write from rubric 4 / plan 52. The resulting bar-set hash is `ca3298f63363387825eb41a28d0e69705d0b4c995a9bf26997073191cdce328f`.

The current rubric is revision **6**, criteria hash `ac834b178cce464cdfc38ca56ab120c8f24e36be583f04193791623a9da2986e`. It adds the concrete structured-check files requested in independent critique WI-10000492#200159 and clarifies the external GUI-journey evidence. BAR meanings, hashes, required layers and evidence planes are unchanged. Independent follow-up WI-10000511#200173 passes all six meta criteria. The attestation EI-22595027678539732 failed its independent grading-integrity audit EI-22599330104926621 on evidence form: its sampled strings lacked repeatable probes. The reviewer confirmed the sampled substantive claims. Replacement attestation **EI-22608924825300338**, emitted 13:19Z, supplies explicit tool calls, full critique references and repository-resident logs. Its independent audit **EI-22609326366147036** passed at 13:25:33Z; it supersedes the failed card without changing the rubric.

R-1 through R-5 require tree evidence. R-6 additionally requires containing deployment evidence. R-7 additionally requires a real cockpit journey; staging or an isolated current build is admissible. Component tests cannot satisfy that journey. Decisions D-011 and D-015 retain unexercised live-agent behavior and canary residue.

## Current automated execution

The repository test router ran 15 files, comprising acceptance unit/component checks and the owner-report / goals PostgreSQL integration checks, at `ddb59a866e`, starting 2026-09-07T08:54:14.620Z and completing by 09:00:10Z. All 419 tests passed: 277 core unit tests, 113 component tests, and 29 real-PostgreSQL integration tests. No tests were skipped; the named paths were clean before and after. Full execution log: `/tmp/wi2147072-acceptance-tests-0854.log`.

The additional event-await store and unanswered-directed PostgreSQL tests passed 100/100, with zero skips, at the same clean revision. Execution ran from 09:06:25Z to 09:10:19Z; log: `/tmp/wi2147072-recovery-tests-0906.log`. The implementation files recorded by the proof bindings have no diff from `ddb59a866e` at the subsequent verification read.

The newly bound launch-agent / launch-on-plan checks passed 290 tests and the OMP injection checks passed 60 tests, with zero skips, at `e9f641f0a5`. Log: `/tmp/wi2147072-check-binding-tests-0927.log`.

At the subsequent source check, every bound implementation file remained byte-identical to its tested revision. `leader-brief-shape.test.ts` had one TypeScript-only cast correction (`as unknown as`); its current focused router run `88060f43-eacc-4d67-879a-008c4bc3fd37` passed 26 tests, with zero failures, skips or collection errors. Seven affected bindings were refreshed as IDs **1390–1396**, with the current test-file SHA-256 snapshots and that supplemental execution recorded on each binding. The remaining historical execution observations retain their original timestamps. A new explicit-current adequacy evaluation passed all **19** clauses, with zero fail/unknown results. Current comparison payload: `/tmp/wi2147072-adequacy-current-1001.json`; bounded verdict record: `/tmp/wi2147072-adequacy-current-summary.json`.

The separate provider, evaluator, leader brief, and brief-shape run passed 307 tests at `98d9146953` with no skips. Its 234 leader-brief tests supplement the checks above. The provider, evaluator, and leader-brief implementation files have no diff between that revision and `ddb59a866e`.

The later launch-source refresh passed **292 tests across two files**, with zero failures or skips, at `5f95dea7aa`, from 13:11:14Z through 13:11:32Z. Raw SHA-256 snapshots of both implementation files and both test files matched before and after execution. This covers subsequent plan-bound response and stack-binding changes; the earlier 350-test launch/OMP observation remains historical. Three launch proof bindings were appended with fresh source/test snapshots. The explicit-current evaluation again passed all 19 clauses, with zero fail/unknown results. Its replay payload is [current-proof.json](shared-agent-obligations-2026-09-07-current-proof.json); compare its recorded fingerprints with the files before using it after any further change.

The original logs are now durable, byte-for-byte copies in this repository. Read their `TEST_FILE_RESULT` lines with `rg -n -F TEST_FILE_RESULT <path>` and their `Tests` summaries to reproduce the historical count and provenance claims:

| Log | Execution | SHA-256 |
| --- | --- | --- |
| [acceptance-tests.log](shared-agent-obligations-2026-09-07-acceptance-tests.log) | 419 tests / 15 files, `ddb59a866e` | `935819b09347eca1b649a43c6f854b4379749f8fe19e2caabdcbfad7a1a06652` |
| [recovery-tests.log](shared-agent-obligations-2026-09-07-recovery-tests.log) | 100 tests / 2 files, `ddb59a866e` | `dc2e1f49293f470379d5f87e6d7448eae785b5dc99ce08e253f5bd47936d3b8f` |
| [launch-injection-tests.log](shared-agent-obligations-2026-09-07-launch-injection-tests.log) | 290 launch + 60 OMP tests / 3 files, `e9f641f0a5` | `5e5109d0bf24251bc33751ec371ca021b8cfe384cf249964341b3181ba0002f5` |
| [launch-current-tests.log](shared-agent-obligations-2026-09-07-launch-current-tests.log) | 292 launch tests / 2 files, `5f95dea7aa` | `43912532bf8c54e6ada69b26583784be02fbbae1b25387fd7f5f1122eadaa759` |

The later model-authority change in the shared launch code exposed three stale test assumptions. Repair **EI-22610286535025427** updates the missing-model case to require refusal and supplies explicit models to the existing kickoff/capacity fixtures. The [new run log](shared-agent-obligations-2026-09-07-model-authority-tests.txt) records **292 passed, zero failed/skipped**, at base `52db2dd1e9` plus the [exact local test patch](shared-agent-obligations-2026-09-07-model-authority-tests.patch), from 13:41:52Z through 13:42:24Z. Its `uncommittedPaths=1/2` stamp is preserved: this is local-build evidence. Bindings **1438–1440** carry the updated raw source/test snapshots; all 19 explicit-current adequacy clauses passed again. The replay payload above now uses these fingerprints.

For the exact criterion models, methods, failure observations and detector paths, call `rubrics:get {"rubricRef":"shared-agent-obligations-and-briefs-2026-09-05-acceptance","revision":6}` against staging `http://127.0.0.1:3170`; assert `results[0].rubric.revision === 6` and the criteria hash above. Read the independent counterexample partition with `work_items:get {"id":"WI-10000492","harness":"papercusp","detail":true,"threadLimit":3}` (post 200159) and the detector repair confirmation with the same call for `WI-10000511` (post 200173). Both posts are authored by su-9b55680f, independently of the attestation author.

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

Independent review WI-10000514 is complete: acceptance grading EI-22599793240835202 rates R-1 through R-5 and R-7 pass, and R-6 partial. The reviewer independently reran the ten core files (277 passed, zero failed/skipped), audited the GUI records and reproduced the negative deployment result. Their exact scope and repair are recorded in WI-10000514#200262. The four PostgreSQL legs were verified from the recorded router evidence, not independently rerun by that reviewer.

Follow-up **WI-10000528** is also complete. Audit **EI-22609326366147036** passed the repaired attestation on all six criteria at 13:25:33Z; the reviewer executed its probes, verified the log hashes and read the named assertions. Refreshed independent acceptance **EI-22609569466831718**, rubric revision 6, again rates six criteria pass and R-6 partial. The earlier R-6 pass on EI-22529780338394678 is rubric revision 3 and itself discloses `deployed:false`; D-016 makes that old pin ineligible for current acceptance. It cannot establish shipment. Still required: final containing deployment, eligible final grading and acceptance, final audit and ship transition.

The runtime check at **2026-09-07T10:23:22.946735Z** found the deployment requirement unmet. The serving operator's `/api/health` reported `e66be3c4ff`. Its build identity is resolved at module load in `apps/operator/bin/serve.ts` and cached by `getBuildInfo()`. Git object reads at that reported revision could not resolve the four obligation engine, reader, provider and reminder source files. The GUI section and model matching current bytes therefore did not establish deployment of the underlying feature. This timestamped negative shipment observation is recorded as WI-2147072 comment200245.

The later final-evidence read at **2026-09-07T13:22:11.520027Z** still reported `e66be3c4ff`. The commit resolved, each of the same four paths was absent at that commit, and the staging positive control resolved all four. R-6 remains unmet. This verifies the serving feature identity; it does not report or operate the live release gate. Independent follow-up **WI-10000528** completed the repaired attestation audit and acceptance-grade refresh.

Accountable author decision **EI-22611006002466663**, recorded at 13:50Z, is **reject shipment pending containing deployment**. The server verified succession from the ended rubric author, based on the held WI-2147072; no identity rebind was used. P-008 and the plan remain open. After a deployment notification, verify the serving build contains the feature, refresh final evidence and independent grading as needed, and record a new acceptance decision before shipping the plan.

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
