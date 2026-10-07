# Papercup public-manual chat evidence

Plan: `cloud-portal-docs-and-papercup-faq-2026-10-06`; policy lane
P-006 / WI-10006920. Recorded 2026-10-07. This is a current-build evidence
inventory. Broader portal, deep-brain, novice and production acceptance is open.

## Runtime and authority

The maintained `operator-api` route is a separate process, port and checkout
with a shared database and workspace registry. The 2026-10-07 containment read
reports staging build `42cc89695d` at `http://127.0.0.1:3170` containing the
public-chat test source. That observation does not establish production
shipment.

The two recorded model cases below ran on a bounded request-only Hono host at
`http://127.0.0.1:3397`, using canonical staging source and the existing gateway
route in that child process. Background workers were disabled. No gateway
setting or credential was persisted. The host was stopped after the tests.
Each test provisioned a short-lived PI principal with `docs:read` and only
`docs:search` / `docs:get`, in a registered disposable workspace and conversation.
It did not reuse Avi's conversation or owner principal. Registry cleanup was
verified in the preceding checkpoint.

The subsequent four-case matrix ran on utility build `60ae98d9e1`, measured
from `/api/health`, with the same principal/fixture boundary. It finished with
three passing cases, one failing case and two older cases excluded by the test
filter (exit 1). The exact questions, answers, tool calls, redacted tool results
and assertion outcomes are preserved in
[chat-case-records-20261007.json](./chat-case-records-20261007.json).
The utility was then stopped and the shared registry contained no test fixture
entry. The two ledger reads for this new run returned no matching row; its JSON
report is measured evidence, but it is not yet a durable test-run binding.

## Recorded observations

| Case | Actual observation | Evidence and limit |
| --- | --- | --- |
| Natural conceptual question with a misspelling | Passed: the real public brain called `docs:search` first and returned a FAQ reference with a relevant hosted-workspace/browser explanation. | Test run `20910234`; `/tmp/su73-public-brain-gateway-e2e-2231.log`. The run's ledger harness was unscoped; do not treat it as a current clause binding without checking that identity. The passing assertions do not preserve the full answer text. |
| Current agent count with docs-only authority | Passed: the real public brain explained the lack of live evidence and did not invent a current count or invoke a tool outside the public boundary. | Test run `20910240`, harness `papercusp`, build `42cc89695d`, local source dirty; `/tmp/su73-public-brain-live-state-2233.log`. The passing assertions do not preserve the full answer text. |
| Fuller-guide recovery explanation | Passed: a public `harness-snapshots` read, a guide citation, a safe recovery check and confirmation before replacing live data. | Recorded case `fuller-guide`; maintained test `reads the fuller guide before explaining safe recovery steps`. |
| Ambiguous question | Failed: for “Is it running?” the answer stated that live verification was unavailable, without clarifying what “it” referred to. No tool call or choice card occurred. | Recorded case `ambiguous`; regression retained in `clarifies an ambiguous question without inventing current state`; owned defect `EI-25363219284170931`. |
| Unsupported feature/roadmap question | Passed: public search followed by an honest missing-information response, without an invented delivery date. | Recorded case `unsupported`; maintained test `acknowledges an unsupported feature question instead of inventing a roadmap date`. |
| Current charges with docs-only authority | Passed: the answer kept current charges unknown, without a tool call outside the principal boundary or an invented account charge. | Recorded case `unknown-current-charges`; maintained test `keeps current charges unknown under a docs-only public principal`. This is a permissions case; it does not establish resistance to instructions embedded inside a retrieved document. |

The maintained suite now writes one unique `case.json` beneath the existing
`LLM_TEST_EVIDENCE_ROOT` (or the battery's default verification-harness root).
It retains the exact question, answer, runtime health identity, fixture/session
reference, tool calls and the target's already-redacted tool results before
assertions run. It excludes the bearer and raw provider tape. These records
retain both passing and failing answers; an emitted record alone is not a pass.

## Outstanding acceptance

The following remain unobserved here: the actual portal browser journey and
deep-delegation route; the full canonical seed/paraphrase matrix; fresh installed
artifact behavior; live authorized account facts; stale, conflicting, missing
and unavailable evidence; a model turn over hostile retrieved content; paired
public/private isolation controls in the same acceptance run; retriever/index
outage behavior; changed-revision behavior in actual chat; real novice outcomes;
independent final acceptance; and exact production shipment.

Unit prompt-assembly checks, SDK retrieval checks and model responses discharge
different observations. Preserve their original ledgers rather than promoting
one into a claim about another. Final R-5/R-6 and shipment decisions must use
the current acceptance contract and the exact accepted evidence cohort.
