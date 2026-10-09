# Cloud end-to-end campaign — 2026-10-08

Plan: `cloud-cross-feature-e2e-shipment-2026-10-08`. Driving work item: `WI-10007600`.
Execution: this session personally, AUTO registered, work loop armed at 120 seconds.
This is a working census and evidence record. It is **not a shipped verdict**.

## Acceptance population

The population follows the current cloud workspace guide, supported-provider UI,
hosted authentication/billing routes, workspace-host lifecycle, and tutorial/session
surfaces. GCP and AWS are supported. Azure is visibly planned and must remain
unavailable; its absence is not a passing provider lifecycle test.

| Scenario | Required observations | Maintained evidence surface | Campaign result |
| --- | --- | --- | --- |
| Account admission | Sign-in, organization membership, workspace access and denied access | `auth/hosted/workspace-admission.integration.test.ts`, hosted auth routes | Database-backed suite passed; real hosted acceptance open |
| Tenant and workspace switching | No cross-tenant hosts, credentials, sessions or progress | Workspace RLS suites, hosted admission and tutorial progress | Pending |
| Hosted workspace entry | Prepared workspace selection requires no customer credentials or duplicate provisioning | `e2e/cloud-tutorial.spec.ts` | Current browser fixture passed; native/real hosted acceptance open |
| GCP connection | Required project/service-account fields, least-privilege validation, provider refusal | Connection routes, hosted delegation, GCP provider contracts | Unit baseline passed; live validation pending |
| AWS connection | Account, region, setup template, ExternalId and role/resource validation | AWS setup/connection/provider tests, Cloud page tests | Unit baseline passed; browser/live validation pending |
| Unsupported Azure | Visible planned state; admission and provisioning fail closed | Cloud page and provider-action tests | Pending focused UI verification |
| Configuration and cost | Catalog options, explicit valid disk, current price/configuration review | Cloud page tests and first-agent journey | Pending |
| Provisioning | Persist desired state, replay safely, reach healthy observed host | Provision route, provisioning runner integration | Route baseline passed; database/live proof pending |
| Remote browser/desktop connection | Bind the intended host, connect, reconnect and isolate transport | Hosted desktop/session protocols and viewer suites | Pending |
| Agent launch and task | Intended account/model, correlated request, streaming result and useful completion | Cloud first-agent journey and hosted session routes | Current browser fixture passed, including restored GCP/AWS task result; real sessions open |
| Stop and start | Desired/observed state converges and the same host reconnects | Lifecycle runner, action routes and provider canaries | Unit baseline passed; browser/live proof pending |
| Snapshot | Provider snapshot is durable before advertised recovery | Lifecycle/action/receipt suites | Unit baseline passed; live proof pending |
| Restore | New restored workspace retains data and becomes usable | Restore integration, recovery and Cloud dialog tests | Database/live proof pending |
| Failed provisioning and repair | Failure evidence remains visible; retry repairs without duplicate resources | Lifecycle chaos and provisioning integration | Chaos baseline passed; integration/live proof pending |
| Concurrent/replayed operations | Per-host independence, idempotence, stale-controller fencing | Lifecycle/provisioning/store suites | Unit baseline passed; database proof pending |
| Credential expiry and revocation | Denial, refresh, least privilege and output redaction | Credential lifecycle and hosted provider authentication | Unit baseline passed; live proof pending |
| Tutorial and Help | Keyboard/accessibility, pause/reload/resume, denied progress and provider outage | Cloud tutorial Chromium journey and lesson integrations | Current 15-case Chromium suite passed; native proof open |
| Billing and entitlements | Organization scope, unavailable billing recovery and sandbox-safe payment behavior | Hosted billing store/usage/budget integrations | Database billing-store suite passed; live billing closure open; no customer purchases authorized |
| Destroy and partial-failure cleanup | Correct recovery disposition and no leaked campaign resources | Destroy runner, resource obligations, teardown receipts | Unit baseline passed; provider closure pending |
| Exact deployed cloud and desktop artifact | Authenticated serving identity matches the final journey and deployment receipt | Release/acceptance journals and final runtime verification | Pending; no shipment receipt |

## Evidence collected

- Baseline group `cloud-e2e-20261008-baseline`: **13 files, 213 tests passed,
  zero skipped**, canonical Vitest router exit 0. Shared test-run rows
  `20938427` through `20938439` resolve to commit
  `f812c6ece265ead566822ff9cde3f9897e58c9a0`. The initial shell command omitted
  `PAPERCUSP_TEST_RUN_HARNESS`, so those rows have a null harness; retain exact
  IDs/group and do not bind them as harness-scoped plan evidence.
- Covered baseline files: lifecycle runner and chaos, hosted lifecycle policy,
  hosted provider delegation, credential lifecycle, connection/provision/action
  routes, GCP/AWS soak orchestration, live-evidence validation, customer acceptance
  receipt and teardown receipt. Provider calls in these tests are simulated;
  passing their assertions does not prove an actual cloud lifecycle.
- Plan activation audit 1 passed against revision 3. Its exact specification
  quality card `EI-25448754251777562` passed the independent audit
  `EI-25448978715325314`. Five implementation items were promoted. Census
  `P-001`/`WI-10007608` is done. Persistent coverage `P-002`/`WI-10007609`
  has passing tests but remains open: its attempted completion was refused
  until the exact behavioral clause has current spec-test-adequacy attestation.
- Integration attempt `f9c80491-6103-43ef-b2e8-cc4179cae0e9` timed out in the
  foreground; its authoritative recovery run
  `d1aa81df-9e13-4b17-9433-35ca9e1845de` **passed, exit 0**. Five database-backed
  files exercised provisioning/replay, restore, hosted BYOC vendor outage,
  account/workspace admission and billing storage. Shared rows `20938458` through
  `20938462` are recorded as `admin-ui`, not `local`. Their commit is
  `f812c6ece265ead566822ff9cde3f9897e58c9a0`. The router reported skipped-test
  count as unknown; do not infer zero skips from its exit code.
- Isolated UI run `20261008T213740Z-2145167`, group
  `cloud-e2e-20261008-browser`, stopped in prepare because the frozen source
  overlapped peer-held locks on `computer/provision-desktop.ts` and
  `scripts/npm-install-safe.mjs`. Boot and assertions were blocked; **no UI test
  passed or failed**. Evidence directory:
  `~/.local/state/verification-harness/verify-tauri-headless/20261008T213740Z-2145167`
  under the campaign host's home directory.
- A second native-backed prepare, `20261008T215353Z-3174664`, failed on a
  different set of unrelated active source locks. No boot or assertion ran.
  The maintained default Playwright profile then ran the browser fixture on a
  dedicated Vite server, with API writes intercepted and unmodelled routes
  refused. This establishes browser behavior; it does not replace native proof.
- The Cloud UI unit baseline found four failing expanded-host behaviors, all
  because its complete `nuqs` mock omitted `parseAsArrayOf`. `WI-10007605` fixed
  the originating mock and the same brittle parser-mock pattern in the two
  related desktop fixtures by retaining actual parser exports. Current-tree
  canonical Vitest verification passed **66 tests in three files**, zero
  failures/skips, group `cloud-e2e-20261008-ui-repair2`.
- Four persistent Chromium cases were added to the existing
  `apps/operator/e2e/cloud-tutorial.spec.ts`: GCP and AWS lifecycle recovery and
  teardown, plus provider-refusal retry for each. The full 15-case run passed
  13 cases: the 11 existing tutorial/accessibility/audio/agent journeys and
  two new refusal/retry cases. Two authored negative scenarios initially used
  a display name that derived a different host ID; the production restore guard
  correctly permitted it. After using a name that derives the original ID, both
  lifecycle cases passed (**2 passed, exit 0**, group
  `cloud-e2e-20261008-lifecycle-recheck`, row `20939085`, reported commit
  `bb0f15e16648907717ad34dae04858b06787b051`). The tests assert stop/start on the
  same host, repair, durable snapshot selection, distinct-host restore, reload,
  wrong-name refusal, exact discard confirmation and zero fixture hosts.
  These provider responses are synthetic, explicitly not real cloud receipts.
- Read-only provider preflight verified GCP project
  `active-alcove-504205-q3` and its existing image family. The interactive AWS
  SSO profile is expired, but the existing automation and publisher profiles
  authenticate in `413781344298`, and the clean-room role authenticates in
  `497149484242`. No credential values were printed or copied into the tree.
  Registered GCP/AWS canary connections are available; actual canaries remain
  to be run against the chosen exact release artifact.

## Execution and evidence rules

### Resume evidence, 2026-10-08

The current full Cloud tutorial suite passed **15 tests, zero failed or skipped**,
exit 0, group `cloud-e2e-20261008-complete-restored-task`, durable row `20939983`.
The reporter recorded commit `9dc07b0faeb884006c225619e2e816a93f6d9ac9`
and a dirty worktree. The two restored-workspace cases now review configuration
and cost, assert the selected `host-restored-cloud-e2e` URL identity, connect,
launch one agent, submit an action-plan request, observe its correlated response,
and destroy both fixture hosts. Provider traffic remains synthetic.

The warm-enabled diagnostic run first reached the real UI and failed at the
launcher prerequisite: its snapshot still displayed **Review configuration and
cost**. The originating error was an omitted review click in the authored test.
Failure artifacts remain in `/tmp/cloud-e2e-20261008-restored-agent-warm`.
The earlier navigation failure had warm-up disabled; it is a separate diagnostic
class, not evidence of a product launcher defect.

Current browser proof is bound as `31951`; reached production-store/Postgres
restore integration proof is `31952`. The stale earlier browser binding `31908`
was withdrawn. Targeted copy-out mutation proof uses
`scripts/mutation-probe.sh --relocation overlay`; neither the shared source nor
the owner's desktop is used as a mutation target. Its original and relocated
unmutated baselines both passed two cases. Removing the duplicate restored-host
guards caused both cases to fail at the disabled-button assertion; the probe
reported `caught` and mutant ledger row `20940824`. Formal adequacy must still
establish the task-completion falsifier before this is treated as a passing L4
attestation. The evaluator initially accepted this row against `JOURNEY-P-002`,
but the failed assertion occurs before task submission and proves the duplicate
identity boundary. Binding `31971` was withdrawn for that scope mismatch.
The next control must break task dispatch or result correlation itself;
`P-002` remains open. The two passing baselines and the boundary catch remain
useful evidence for adversarial admission checks.
Retained log: `/tmp/cloud-e2e-20261008-restore-guard-probe.log`.

The maintained nightly `operator-e2e-isolated` routine runs the default
Playwright suite with shared test-run records and an hourly red-result filer.
The changed-file `test:affected` plan selects operator Vitest and lint guards;
it does not itself execute this browser spec. These are separate recurrence
lanes. Native acceptance is queued through the supported committed-source
verifier mode, with explicit byte-matched acceptance inputs, an isolated ready
database and `verify-cloud-workspaces-aws.mjs` native pointer assertions.
The completed run failed in prepare: **dirty tested-input mismatch:
package-lock.json**. Run `20261008T234106Z-4100298` never reached boot or native
assertions. Log: `/tmp/cloud-e2e-20261008-native-committed.log`. This is a source
integrity admission refusal; it establishes no native product verdict.

Acceptance rubric revision 2 includes the three actual UI repair regression
files. Activation audit 3 re-read all 21 source-conversation turns with no span
gap. Independent reviewer `su-16da39cf` recorded full critique in
`WI-10007600` comment `1166270`: structured-check quality fails, and
falsifiability/non-overlap need strengthening. Before certification, pin the
scenario/evidence denominator, bind actual measured detector cases, and reuse
receipt/journal/completion validators for real-artifact, teardown and defect
disposition checks. No passing rubric attestation is claimed.

AWS publication receipts are retained at
`/mnt/backup/p012-bake-fire105/aws-a-p012r69-20261007t125744z/publish.A-r62b.json`
and
`/mnt/backup/p012-bake-fire105/aws-b-p012r70-20261007t125744z/publish.B-contained.json`.
They prove accepted publication from account `413781344298`, with embedded
clean-account canary proof in `497149484242`. On October 8, `su-ee96d6e7` held
the separate P-012 real-account lifecycle, soak, teardown and shipment lane.
The October 9 authoritative read of `WI-10005036` is blocked and unassigned,
with an unresolved canonical v4 scope answer and missing execution/acceptance
proof. The historical holder statement is not current ownership evidence.
Do not rerun these accepted publishers or touch retained resources.

GCP preflight observed the latest image-family entry as `0.0.18-r19`.
The retained GCP input names historical source
`f11fb1a55446441c29ae09fa8d506b641c5e71db`, bundle
`b41358fb4354d2b083998782f93fd2fb5a925cbd40ce53487941b2145092893b`.
It cannot establish current-source acceptance. A current GCP-compatible isolated
artifact route is still needed; the shared AWS release pin has not been changed.
No current-campaign provider resources have been created.

Reuse canonical suites and the isolated UI/native verifier. The maintained
operator API current-build route is staging `:3170`, which shares the database
and workspace; all writes need private campaign identities and data. Browser
fixtures replace authenticated cloud network boundaries and establish product
control behavior only. Real GCP/AWS canaries need uniquely tagged disposable
resources, actual provider receipts and final provider-side absence checks.

Record source and serving identities, exact commands, test-run IDs, provider
receipts, screenshots/traces and cleanup for every scenario. Mark skipped,
unavailable and failed prerequisites explicitly. Do not delete unrelated hosts,
change customer billing, paste credentials or drive the owner's desktop.

The live release lane is held by `su-6c740129-47fc-4079-a142-5d2ea506e5c5` on
`WI-10006055`. That session replied that current HEAD is blocked before origin
egress and no fresh shipment receipt exists. Continue independent cloud work;
do not duplicate live gate triage, reruns, deployment or monitoring.

## Still open

Execute real hosted/GCP/AWS canaries through the maintained production executors,
complete native acceptance once its safe snapshot prerequisites hold, verify
provider-side cleanup and exact served artifacts, complete the campaign audit and
grade, and publish the final shipment report. Existing image input found during
preparation targets an older release; it must not be reused as current-artifact
acceptance. No universal pass or shipped status is justified yet.

## Receipt reconciliation — 2026-10-09

This session resumed personally under the existing AUTO authorization. Threaded
replies reached the parity lead for `WI-10007848`; the saved browser and database
receipts are reusable historical evidence, while native and real provider
acceptance remain unmet. The current work loop was inactive and has been
re-armed at 120 seconds with warm carry on `WI-10007600`.

`P-002` remains open for task dispatch/correlation falsifiability and audited
adequacy. A fresh copy-out overlay probe removes only the lesson's
`sendToSessionOwner(ownerId, request.prompt)` call. It selects the maintained
GCP restored-workspace lifecycle case, with dedicated Vite port 39311 and an
original baseline, relocated baseline and mutant phase. The original baseline
passed one case. The relocated baseline and mutant are still running; no caught
verdict or adequacy claim is made at this checkpoint. Log:
`/tmp/cloud-e2e-20261009-task-dispatch-probe.log`.

`P-003` is blocked by `P-002`. A current GCP-compatible artifact and complete
hosted/provider task, reconnect and teardown receipts remain required. The
retained AWS A/B publication receipts are not substitutes for those receipts.
Direct readback confirms accepted A `0.0.21-p012r69` /
`ami-08b30abb33126e2e5`, manifest
`sha256:54b09574c51539808b9c945426c808406e80d9290266166488c0a5d33d870305`,
and B `0.0.21-p012r70` / `ami-05a8be4f5e5e553f3`, manifest
`sha256:73420c6303698a4b33a0670b942b295d451142d68a6a7f0a2d34ff6304a23402`.
Their clean-account proof records report healthy services, terminated canaries
and empty residual-resource lists as observed on October 8. No fresh provider
absence query or full lifecycle/task/soak acceptance was performed in this
continuation.

No current-campaign cloud resources were created in this continuation, and no
shipment was claimed. The next native attempt requires a pre-run audit of the
source-lock and byte-matched input admission failures already observed; it must
preserve the isolated database and exact source/binary provenance contract.
