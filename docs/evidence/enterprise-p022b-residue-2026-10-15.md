# P-022b fixture and operational proof residue

15 October 2026 · WI-6554700010013720 · papercusp-enterprise-readiness-roadmap-2026-10-09

P-004, P-005, and P-006 each evaluated **pass**, with no blocking criteria, on the staging evaluator measured as `ce9cbd9a0e` at approximately 01:32 UTC. Their current certification cards have been filed. P-005's independent grading-integrity audit passed at 01:48 UTC. P-004 and P-006 remained pending at the 01:51 UTC current-build readback; this report does not claim complete audited acceptance or shipment.

## What changed

The predecessor refresh, WI-6554700010013624, identified proof recipes that omitted fixture dimensions, exact clause targets, oracle metadata, or the required operational evidence kind. This follow-up reused the maintained suites, canonical test-run ledger, mutation runner, and existing spec-evidence/certification surfaces. No product implementation or historical run provenance was rewritten.

Fresh clean runs used committed candidate `3d2e1fd122eb4823c6b044472d5d898b012c14a8`. The retained suite logs report seven passing focused suites: 64, 36, and 42 passing assertions across the three runner groups. Five original mutations were caught, with pre-probe source bytes restored and verified.

P-004 now measures its inline integration fixture and all ten SQL migrations actually loaded by that test: 902, 903, 904, 906, 907, 978, 1005, 1188, 1473, and 1496. Those dimensions were supplied on the first binding of fresh baseline `21249121` and mutant `21249137`. Existing immutable run recipes were preserved.

P-005 and P-006 received fresh fixture-calibrated proof, exact clause targeting, independent oracle metadata, and operational bindings. Operational evidence exercises production entry paths in the process plane, including real PostgreSQL where the maintained suite uses it. It is not a hosted-deployment or external-enterprise drill.

## Exact evidence

| Clause | Current replacement evidence | Passing certification card |
| --- | --- | --- |
| P-004 | Test `45828`, operational `45829`, mutation `45830`; baseline `21249121`, copy baseline `21249126`, caught mutant `21249137` | `EI-26007196257314461` |
| P-005 | Mutation `45806` from caught mutant `21249122`; operational `45786`; maintained fresh test bindings | `EI-26007212094985223` |
| P-006 | Operational `45787`; caught mutation bindings `45799`, `45798`, `45797` from runs `21249106`, `21249111`, `21249112`; maintained fresh test bindings | `EI-26006327405705776` |

Readback verified replacement bindings before withdrawing older proof. P-005 `45362` was withdrawn after `45806` read current. P-004 `45783`, `45788`, and `45361` were withdrawn after `45828`, `45829`, and `45830` read current. Earlier retirements are preserved in the work-item checkpoint and ledger.

At 01:36 UTC, all three subject cards' `payload.observation.gradingAudit.state` values were `pending`, with exact dispatch reservations recorded at 01:34:37 UTC. The targeted `scorecards:repair` request subsequently completed: it recovered terminal inference-gateway failures and registered three independent judge launches through the compatible dispatcher. The returned judge identities are P-004 `su-85bc8d16-8dec-4f51-8172-590428693354`, P-005 `su-2a4239bb-9505-46f1-bb9c-5739f43812cd`, and P-006 `su-73dc6974-e44d-4fcb-9f0a-7dbff3f63aed`. Launch registration does not establish first-turn pickup or a completed audit. A card's ordinary `done` state is not proof that its independent audit passed.

The 01:51 UTC `scorecards:get` reads through staging `:3170` report `gradingAuditCurrentness.state: current` and `auditTarget.evidenceBindingCurrentness.state: current` for each card. P-005's audit is `passed`, with audit card `EI-26008140664243853` and `auditedAt: 2026-10-15T01:48:15.873Z`. P-004 and P-006 are still `pending`. The main reader omits these newer currentness fields, so this acceptance read uses the current build.

P-004's timeline through 01:51 UTC contains its opening guard message at 01:36 UTC and no subsequent recorded agent tool calls; targeted presence reports it parked and wakeable. A direct required wake was queued at 01:52 UTC, with pickup unconfirmed at that receipt. Suspected producer stall `EI-26008433277408959` records this evidence; the fleet leader was asked to assign the follow-up. P-006 recorded spec-evidence reads through 01:44 UTC and received a direct request for its exact progress or blocker. These observations do not establish an inference or resource cause.

## Verification and limits

Verified: maintained focused suites and original mutation catches; fresh full-fixture bindings; current replacement readbacks before retirement; exact P-004/P-005/P-006 evaluator passes; successful current certification filing; current rubric and binding identities; P-005's independent audit pass.

Still required for final closure: independent grading-integrity verdicts for P-004 and P-006, a final read of the three cards' current audit authority, and accountable ownership of the producer-stall follow-up. WI-6554700010013720 remains open until that evidence is available.

Outside this finite lane: integrated P-022 journeys, other prerequisite lanes, release promotion, deployment, and external enterprise outcomes. P-022 remains unshipped. The prior P-022b refresh remains complete.

Reproduction references: `/tmp/wi3720-fixture-suite-20261015.log`, `/tmp/wi3720-control-suite-20261015.log`, and `/tmp/wi3720-mutation-45361-20261015.log` through the other four exact mutation logs. The durable run IDs and binding IDs above remain the primary evidence after temporary logs expire.
