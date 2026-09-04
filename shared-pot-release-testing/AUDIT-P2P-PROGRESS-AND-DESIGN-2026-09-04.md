# P2P release progress and design audit — 2026-09-04

Owner request: assess whether the agents are making real progress toward public release, audit the P2P features, and recommend substantial redesigns where warranted.

Audit owner: `su-11738410-028e-4785-a219-178bf967b8bd`. Durable record: **WI-2144414**. Evidence gathered September 4, approximately 19:33–19:50 UTC. This report makes recommendations; it does not authorize or implement a new product scope. The existing release work remains in progress.

## Verdict

**Real engineering progress has been made. The P2P product is not ready for an unconditional public release. The execution process has also wasted effort and overstated some intermediate results.**

The strongest recent accomplishments are a clean packaged candidate, completed physical coordination journeys, repairs to re-admission/backfill storms and memory growth, a passing post-revocation content test, and committed fixes for incorrect Git announcement identity and headless delegated-agent startup. These have code or executed evidence behind them.

The remaining bottleneck is converting those repairs into a reproducible packaged candidate and successful user journeys on separate machines. The latest VM sample inspected in this audit, **2026-09-04T19:23:32.908Z**, still reports `IXfGu216 local v1977 < announced v8597`. That is an observed failure of the deployed witness, not an administrative blocker. There was no final successor `BUILD-STAMP` in the inspected carrier inbox.

**I recommend retaining Hypercore/Hyperswarm, per-peer logs, Postgres materialization, Git object storage, and the cryptographic building blocks. I would redesign the identity/scope/readiness contracts and the delegated-execution boundary before a broad public launch.** The evidence does not justify replacing the entire transport stack. It does justify removing several layers of ambiguous fallback behavior while compatibility costs are still low.

## What “all P2P features” currently includes

These are separate capabilities with different evidence and trust requirements. A blanket “P2P is shipped” hides those differences.

| Capability | What the inspected evidence establishes | Remaining qualification |
|---|---|---|
| Hive discovery and joining | Directory plan is shipped; it records packaged, public-DHT, cross-machine discovery evidence. Signed device announcements and GitHub attestation are implemented. | Current code still accepts some legacy missing-scope announcements. A new-user install/join path must be tested on the release artifact. |
| Shared content and plan/work-item data | Peer logs, HLC ordering, scoped projections, provenance, snapshots and durable cursors exist. Historical bidirectional/restart/catch-up tests are banked. | Read/apply/ownership boundaries are complex. Some retry exhaustion paths stop retrying an unapplied operation. |
| Agent coordination | September 2 physical tower↔Mac witness covers actual sends, replies, visibility, trust negatives, reconnect, catch-up and restart: 17 passing probes. | Its plan is `awaiting-acceptance`, not shipped. The signed coordination slice also retains an observability residual. |
| Membership, privacy and revocation | Admission, receiver-stamped provenance and epoch encryption are implemented. September 2 revoked-member content-cut test passed. | This proves the tested path and candidate. Pre-ban content remains readable; it is not retroactive erasure or post-compromise security. |
| Shared memory | Receive-side `shareable:true` enforcement, source partitioning, temporal fields and retraction behavior exist. This audit's focused suite passed. | Egress is a separately governed privacy opt-in. Do not advertise memory federation as universally active. |
| Peer-to-peer Git and GitHub bridging | Signed snapshots, peer fetch, namespace isolation, publishing guards and bridge code exist. Identity fixes are committed. | **Live Git convergence is red.** Leg A, then the GitHub bridge live test, still need acceptance on the eligible artifact. |
| Delegated agent seats | Signed seat offers and spawn requests, host opt-in, audience checks, atomic seat accounting, boot verification and receipts exist. | Headless fix passes focused tests but the required new-candidate physical honor/run proof is still open. V1 seats are unmetered and use the host's agent authority. |
| Generic foreign-work execution and compute budgets | Substantial preserved grant, budget, sandbox and simulation code exists. | The active offer record accepts `seat` and `spawn_request`; generic `work` offers were retired. Tier-2/3 constants in the foreign-work policy remain false. This is not a shipped, sandboxed public compute marketplace. |
| Voice/video | Video plan was marked shipped September 1 with bidirectional public-DHT video evidence through Tauri; video remains default-off. The older voice plan is superseded. | Voice history still names microphone/audio-processing and NAT-diversity field work. A terminal plan is not proof that every voice/video promise is enabled and product-ready. |
| Scale and distribution | A dedicated benchmark suite is shipped; the scale plan accepts a 64-peer convergence result. | The current scale authority explicitly does **not** validate 256 peers. Hardware budget estimates and co-located tests are not WAN capacity guarantees. Signing/distribution inputs remain separate. |

Sources: the current `plans:get` records for `p2p-hive-directory-2026-06-06`, `p2p-coordination-public-release-2026-08-26`, `p2p-public-release-remaining-lanes-2026-07-16`, `p2p-git-live-activation-2026-07-09`, `p2p-work-distribution-2026-07-02`, the voice/video plans, and `harden-shared-hive-to-256-peers-2026-06-29#D-041..D-043`; code citations follow below. Historical evidence above was inspected as a record, not rerun in this audit.

## Progress over September 1–4

Dates below are recorded milestone/verification dates. A closure can bank an earlier repair; it is not necessarily the date every line was written. Auto-commit author names and commit subjects were not used to attribute engineering work.

| Date | Concrete progress | Evidence and limits |
|---|---|---|
| September 1 | Outbox drain recovered; memory admission was bounded; custody runbook and lifecycle guards were completed. | `WI-2039864` records a healthy live drain and 17 focused tests. `WI-2039865` records the bounded-memory fix, 154 tests and a 48-minute stable observation. `WI-2039868` records the custody runbook and 114 focused checks. These are useful repairs/evidence, not end-to-end release completion. |
| September 1 | Signed gate-verdict publication acquired deterministic evidence timestamps and retry-stable IDs. | `WI-2039879`, with production code in `release-actions.ts`. Historical duplicate rows remain in its completion; idempotence was verified without writing a third set. These are signed shard facts, not a signed public-release GO. |
| September 1–2 | Clean Server build #6 was built, identity/provenance audited, transferred, booted and used for a physical witness. Subsequent acceptance used build #8. | `WI-2039869` records pin `5be66dc6`, clean embedded provenance and artifact hashes; `WI-2039866` records forward/reverse delivered messages. Build #6's custody result also disclosed an amber outbox heuristic. Do not silently turn the whole run green. |
| September 2 | Repeated peer announcements stopped triggering full admission and bulk work; the join-storm repair was exercised on the rig. | `WI-2141418`, source commit `5c5ed3c5491c` in `boot.ts`, equality short-circuit and recurrence coverage. Its completion names three joins and bounded steady-state behavior. |
| September 2 | Coordination passed the actual physical user journeys; revoked-member post-ban content did not arrive in the tested matrix. | `WI-2039871`/`WI-42225`: 17/17 coordination probes. `WI-2039877`: `revocation_kcut` passed, but the overall matrix had an unrelated attestation setup failure. This is a scoped passing security result, not a wholly green matrix. |
| September 2 | W1 post-restart classification was settled with repeated discriminating observations. | `WI-2039875` and remaining-lanes D-161 bank three runs with a passing frame-B control; the record explicitly discloses mixed artifacts. This is stronger than the previous single lucky-run argument. |
| September 2–4 | Headless delegated-start fix, cross-process Git identity repair, stale-owner refusal, and retained identity history were committed. | Headless diff `884c40bb`; D-013 source `1079f5a8` and test `c0dab593`. The accepted frozen candidate `7cd37eca` contains the exact D-013 blobs. Unit success has not yet become the required new-artifact live success. |
| September 4 | The model-staging build failure was traced to matching an entire `.tmp.<pid>` parent path as a download fragment. The basename fix and regression are committed. | Desktop commit `23d8a477` and superproject test commit `79c74f74`; this audit reran the model-source suite: 12 passed. The carrier's item checkpoint still says “patch next,” illustrating reporting lag. The finished artifact remains unproven. |
| September 4 | A false “no new wrong-identity announcements” result was retracted and the acceptance guidance corrected. | Endgame D-014/D-015. The old SQL excluded `repo=NULL`; the receiver routes those legacy rows to the home repository. Corrected SQL found announcements through v8595, and the later VM log reports v8597. This improved the evidence, but it did not fix deployed convergence. |

The current endgame record has **15 of 24 items marked done and 9 unfinished**. This is a count of plan records, not “62.5% of the product is ready.” The items differ radically in size and include evidence reviews and administrative actions. The ship evaluator still returns `plan_items_unfinished`.

### Where effort was wasted or represented badly

1. **My own verification error caused false reassurance.** The old query required `fed_event.repo='papercusp'`, while current bad announcements were legacy untagged home-repo events. Its positive control only proved that a known row existed; it did not validate the query's population. The VM logs already provided contradictory advancing versions. I should have reconciled that immediately. Repeated “no recurrence” updates were not progress.
2. **Presence was sometimes substituted for work progress.** A recent tool call and a matching intent do not prove that a build advanced. Several of my earlier wakes repeated the pending handoff and rewrote checkpoints. Those are continuity operations with limited value, and there was too much of that around an unresolved measurement contradiction.
3. **Closures do not consistently satisfy their text.** P-402 asked for signing prerequisites supplied or explicitly waived; `WI-2039883` closed after reading that they remained pending. The packaging checks may be valid, but the item is broader than its completion. P-305 was closed for the audit half while P-511's verdict half remains open; current notes explain this, but the headline status is easy to misread.
4. **The same work is mirrored across plans, work-items, decisions, carry notes and the signed Markdown ledger.** The raw Promoted block still has unchecked entries for completed work. P-401 looks actionable in part of the derived plan view even though the live witness dependencies in prose are not met. This costs repeated reconciliation and makes accidental premature closure more likely.
5. **Status notes can lag useful code.** The model helper fix was present at 19:04 and its regression at 19:12, while the item checkpoint still describes implementation as the next action. Reading only either the ledger or the filesystem gives an incomplete picture.
6. **The scale program documents the same pattern historically.** Its D-043 retracts a re-derived ruling, points out an already-fired experiment, and corrects a dependency on an ended agent. Those are recorded process defects, not evidence that every agent's work is waste.

There is no defensible fleet-wide “percentage of time wasted” in the evidence collected here. I did not audit complete billing or invocation histories, and will not infer such a percentage from message volume or commit counts.

## Design findings and recommendations

### F1 — Release consistency is being inferred from a stall-health flag

**Priority: pre-release blocker for the acceptance contract. Directly reproduced.**

[`convergence-probe.ts`](../packages/operator-core/lib/sync/pot-git/convergence-probe.ts), particularly `judgeConvergence` and the return around line 290, sets `converged` to whether any peer has been persistently stalled. A peer can be behind and still produce true. Zero judgeable peers also produces true. The wrapper persists this as the field its comment directs a release reviewer to read: [`git-sync-action.ts`](../packages/operator-core/lib/harness/git-sync/git-sync-action.ts), around lines 4021–4039.

Direct execution of the actual function returned:

```text
no_peer_evidence                 converged=true judged=0 behind=0
behind_but_first_observation     converged=true judged=1 behind=1
```

The implementation's human summary distinguishes these cases, but the boolean does not. A newest-500 scan can age a silent device out of the comparison. That removes an alarm; it does not prove the device's data arrived. This audit therefore rejects age-out alone as release evidence.

**Change:** preserve a health result such as `advancing/stalled`, and introduce an exact consistency result such as `unknown/catching-up/current`. Acceptance should require a named expected peer set, fresh observations, an explicit store generation, and matching snapshot/ref identities at a recorded watermark. Include fixtures proving that no peers, filtered-out peers, transient lag, replayed announcements and absent expected peers cannot pass the release predicate.

### F2 — Repository identity and store generation need to be signed protocol fields

**Priority: pre-release protocol hardening. Signature/routing behavior directly reproduced; an end-to-end exploit was not established.**

[`ref-announce.ts`](../packages/operator-core/lib/sync/pot-git/ref-announce.ts) signs device, snapshot OID, version and timestamp. Repository routing is added outside that signature by [`ref-announce-repo-scope.ts`](../packages/operator-core/lib/harness/git-sync/ref-announce-repo-scope.ts). The same broad issue deserves review in [`sigrefs.ts`](../packages/operator-core/lib/sync/pot-git/sigrefs.ts) and [`staging-advance.ts`](../packages/operator-core/lib/sync/pot-git/staging-advance.ts): their signed statements do not explicitly bind the stable repository identity.

A local probe generated a real Ed25519 signature, changed only the envelope's repo from A to B, and observed both `signatureValidAfterRetag=true` and `routesToB=true`. Other transport/admission/object checks may prevent a concrete attack; the probe establishes the missing cryptographic binding, not arbitrary code injection.

The convergence code also infers a new lineage from a lower announced counter and prefers receiver-local event arrival order. It explicitly accepts that replaying an older signed announcement can lower the comparison bar. That is a symptom of missing protocol state.

**Change:** version the protocol before release. Sign stable hive/repository IDs, device identity, store-generation ID, per-generation sequence and snapshot OID. Reject missing scope on the new protocol; handle older peers through explicit negotiated compatibility rather than invisible null fallbacks. Local slugs should be presentation/lookup aliases, not authority identifiers. Reuse the project's existing canonical-signing and repository-identity machinery.

### F3 — Signing and serving must share one explicit runtime identity

**Priority: complete the existing repair and simplify the contract. Live failure plus committed repair evidence.**

The P-203 incident crossed the sidecar/background-host boundary: a process could sign as a valid GitHub-login device that was not the serving swarm identity. D-013 preserves history to prevent a fresh omission from being interpreted as proof that no serving identity ever existed. See [`hive-git-actor.ts`](../packages/operator-core/lib/harness/git-sync/hive-git-actor.ts) and [`substrate-booted-handles-pg.ts`](../packages/operator-core/lib/sync/hyperbee/substrate-booted-handles-pg.ts).

That repair is useful. A chain of “current handle → PG snapshot → historical hint → login fallback” remains difficult to reason about across restarts.

**Change:** make the serving process issue a typed identity/serving capability for the hive and repository generation. A publisher must possess current matching authority before it can announce. Represent absent, unknown, stopped and never-created separately. Expired discovery should cause a retryable unavailable state, not selection of another valid-but-unservable identity. The successor artifact must prove this across owner restart, snapshot omission and separate-process publishing.

### F4 — Retry exhaustion must not quietly convert an unapplied write into a completed cursor

**Priority: data durability hardening. Source-confirmed behavior; existing test passes this policy.**

[`read-merge.ts`](../packages/operator-core/lib/sync/hyperbee/read-merge.ts), `applyRecordingWinner` around lines 1080–1138, treats foreign-key ordering failures specially, but after repeated other exceptions/timeouts records the operation as the winner and drops it from ordinary retry. Its own diagnostic acknowledges that a timeout may come from a temporarily slow valid write. The original Hypercore bytes can remain recoverable; that is different from the projection automatically recovering.

**Change:** use a typed apply result: applied, rejected permanently, waiting for a dependency, or retryable infrastructure failure. Retain a durable, inspectable retry/dead-letter record for anything not applied; make replay idempotent and prove recovery after a database outage. A processed log position must not be presented as equivalent to a complete materialized view. Extend the existing cursor/quarantine surfaces rather than adding another independent recovery service.

### F5 — Delegating an agent seat is a substantial host privilege grant

**Priority: public product/security boundary. Current path inspected; no sandbox escape claimed.**

The host opt-in and signed-request checks are good. The active seat path intentionally uses the host's Papercusp agent envelope, not the P-105 foreign-code sandbox: [`accept-delegated-seats.ts`](../packages/operator-core/lib/p2p/accept-delegated-seats.ts). [`delegated-spawn-honor.ts`](../packages/operator-core/lib/p2p/delegated-spawn-honor.ts) composes a remote brief and launches the standard member command. The inspected default carries the plan, fleet, model, account and seat; it does not itself select a restricted delegated-worker role. [`console-launcher.ts`](../packages/operator-core/lib/console-launcher.ts) documents the superuser console path. Additional host policy can constrain it; that constraint needs end-to-end evidence, not a comment.

Meanwhile, generic foreign-work policy, its kill switch, its sandbox modules, and delegated-seat opt-in are distinct surfaces. [`offer-store-schema.ts`](../packages/operator-core/lib/p2p/offer-store-schema.ts) only accepts seat/spawn-request records; [`rollout-tiers.ts`](../packages/operator-core/lib/p2p/rollout-tiers.ts) retains disabled higher tiers for the older foreign-work model. These must not be used interchangeably to claim isolation.

**Change:** explicitly label trusted host-agent delegation. Bind each grant to allowed workspaces/repos, tools, credential routes, maximum concurrency, lifetime and revocation behavior. For untrusted public work, require an OS-enforced container/VM boundary with scoped credentials and restricted network/filesystem access. Prompt framing and client hooks are not hostile-code containment. If v1 stays trust-layer-only, say so plainly and verify that the visible stop control actually stops this active seat path.

Unmetered seats are an accepted scope decision (D-011/D-164), not an implemented billing capability. A count of simultaneous agents also does not bound total spend over time. At minimum, provide duration/spend visibility and host-owned ceilings before marketing unattended capacity donation broadly.

### F6 — Deterministic leader selection is not exclusive leadership during a partition

**Priority: required before claiming partition-safe autonomous failover. Direct pure-function reproduction; live double execution not established.**

[`fleet-leader-election.ts`](../packages/operator-core/lib/p2p/fleet-leader-election.ts) chooses from each peer's locally visible presence and keeps a roster epoch. Two isolated views of the same roster can each choose self at the same epoch. The same-epoch announcement check accepts both:

```text
view A: leader=device-a epoch=7 isSelf=true
view B: leader=device-b epoch=7 isSelf=true
acceptLeadershipAnnouncement(7, 7) = true
```

This pure selector is not proof that the live Git authority or resource sink accepts conflicting effects. The inspected service describes dormant/partial wiring; a static search found the service as the immediate caller, not a demonstrated active tick. Do not turn that into a claim of a live split-brain incident.

**Change:** separate membership epoch from leadership term. Irreversible shared effects need a monotonically fenced authority that the effect's recipient validates, or an explicitly single authority / quorum-backed acquisition. Advisory placement can remain eventually consistent. During a partition, choose which writes must stop; do not imply that identical code on divergent views supplies consensus. This is the fencing requirement described in [Kleppmann's distributed-locking analysis](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html).

### F7 — The release witness is too tightly coupled to a large, mutable app build

**Priority: high productivity and reproducibility improvement. Current build failure and source fix inspected.**

A P2P acceptance run is waiting on an ONNX model-copy helper in a desktop sidecar closure. The helper documents runtime model assets absent from `npm ci` and formerly supplied by host cache or ad-hoc scripts. This failure has a small, now-committed fix; the architectural issue is that unrelated model packaging repeatedly enters the P2P critical path.

**Change:** produce a minimal, versioned headless P2P runtime and separately hashed model/optional capability packs. A full offline installer may still bundle those packs, but their identity and tests should be independently reproducible. Build the witness once from explicit source, dependency, migration, seed and model hashes; use the same produced artifacts through acceptance. This is a packaging boundary change, not a proposal to drop full-app installation tests.

### F8 — Readiness needs one computed evidence model

**Priority: high; it addresses both wasted work and false greens.**

`RELEASE-READINESS.md` is a valuable history, but it combines old signatures, corrections and current rows. Several scope/status contradictions require reconstructing weeks of decisions. The default test counts, plan-state counts, artifact hashes, live witness receipts and global release verdict are different facts.

**Change:** extend the existing signed verdict/evidence system with a current release manifest. For every required capability record artifact identity, scenario, actual execution, expected peers, result, evidence digest, freshness, approved exclusions and owner. Generate the human readiness table and the remaining dependency graph from that manifest. Keep historical judgments append-only, while exposing exactly one current interpretation. “Skipped,” “not measured,” “still advancing,” “source tested” and “passed on this artifact” must remain distinct.

The counterexample fixtures from F1 and the bad SQL population from D-014 should be permanent negative controls for that acceptance path. A product test suite being green does not prove that a release reviewer asked the right question.

## What I would keep

- **Per-peer logs and local materialization.** They fit offline collaboration and provenance well. Hypercore supplies signed-log integrity and sparse replication; application authorization still belongs above it. [Hypercore documentation](https://github.com/holepunchto/hypercore).
- **Hyperswarm discovery and encrypted peer connections.** The current incidents do not show that the networking primitive needs replacement. Keep the separation between connection identity and permission to apply data or execute a task. [Hyperswarm documentation](https://github.com/holepunchto/hyperswarm).
- **Git objects, per-device namespaces and signed snapshots.** These are appropriate building blocks for exchanging code. Tighten context binding and authority around them. Radicle is a useful comparison for repository identity, signed references and verification; switching the entire implementation to Radicle would need a dedicated compatibility/cost study. [Radicle protocol guide](https://radicle.dev/guides/protocol).
- **Receiver-stamped provenance, host-local consent, per-source memory partitions, key-before-content deferral and explicit receipts.** These are sound directions with real tests. Preserve them while simplifying their interfaces.
- **HLC/LWW for advisory replicated records.** Use it where concurrent edits are acceptable, while keeping grants, exclusive execution, revocation and publication authority out of “last writer wins” assumptions.

The broad recommendation is a substantial consolidation of existing pieces. A wholesale rewrite would discard working behavior and reset the evidence backlog without yet explaining which fundamental primitive was wrong.

## The concrete route to release

### Existing plan obligations

1. **Finish the eligible successor build and publish its final identity.** The source carrier `7cd37eca` is accepted and contains the exact D-013 source/test blobs; it is not itself a completed artifact receipt. The model-source bug is fixed in current source, but artifact audit/cut still needs the carrier's final result.
2. **Run P-203's exact live Git proof on that artifact.** Verify serving identity, repo/generation, signed snapshot content and the mirror result. Do not close from no error, a completed fetch, event age-out, or the stall-health boolean alone.
3. **Run P-202's headless delegated-seat proof.** Demonstrate boot, a real first turn, scoped work, receipts and release/revocation from the originating machine. Bank the already-passed D-160 legs; keep the intentionally excluded pull/meter legs explicit.
4. **Run P-204's live GitHub bridge test.** Members commit; the intended bridge performs the authorized GitHub interaction. Verify its required authority/failover behavior rather than assuming success from component tests.
5. **Obtain the independent P-401/P-511 GO decision and complete acceptance.** Reconcile the old signed NO-GO with executed evidence. Coordination, bridge and fleet-reliability plans already at awaiting-acceptance should finish their independent grading without unnecessary additional implementation.
6. **Complete distribution and portfolio closure.** Signing inputs are documented pending, with Avi's standing instruction not to keep asking for them. All independent engineering can continue; a signed/notarized public installer cannot be claimed before those inputs or an explicit distribution decision exist.
7. **Honor the post-GO work.** The 72-hour canary, chaos exercise and default Git-mode decision remain requirements of the full endgame. D-158 schedules soak/chaos after GO; they must not be silently pulled forward as pre-GO walls or silently omitted at final closeout. A full completion date therefore cannot be promised immediately after the next build.

### Proposed changes to that route

Before broad public exposure, address F1's exact acceptance predicate, F2/F3's signed context and serving identity, and F5's explicit delegated-agent trust boundary. F4 needs a focused outage/recovery proof and replay design. Gate any exclusive automatic failover on F6's sink-level fencing proof. F7/F8 are the highest-value changes for preventing another month of release churn.

Define separate readiness rows for data collaboration, peer Git, trusted delegated seats, and optional media/memory. Keep retired generic work-marketplace behavior out of v1 claims. Do not silently lower any existing acceptance bar to make that packaging look green.

## Verification performed for this audit

These are **current working-tree focused checks**, not full-suite, public-WAN or packaged-release acceptance. The source snapshot inspected included superproject `47fba77388b933b79c2f18a0b5f6176c9bc3f65d`; this shared tree continued advancing during the audit. Individual test-run records below identify the actual executions.

| Test file | Result | Durable run ID |
|---|---:|---|
| `sync/pot-git/convergence-probe.test.ts` | 26 pass | `1529eb1a-b222-46f9-9ea1-e0decf22ecee` |
| `sync/pot-git/ref-announce.test.ts` | 11 pass | `add21715-a04c-4af7-bf31-3e6b804206e7` |
| `sync/hyperbee/hive-epoch-op-gate.test.ts` | 26 pass | `838313b1-e293-4889-872c-0890655618e7` |
| `p2p/delegated-spawn-honor-headless-greeting.test.ts` | 3 pass | `9d2aaaa3-c851-44d8-b2a6-abb3e87669f3` |
| `sync/hyperbee/read-merge-apply-timeout.test.ts` | 3 pass | `3d2af500-01fc-46a0-94c7-d9cec7b743ac` |
| `p2p/delegated-spawn-honor.test.ts` | 66 pass | `a4c92b6c-27cd-4d27-a49a-d9b1b4928402` |
| `sync/hyperbee/projections/p2p-memories.test.ts` | 16 pass | `c94180fd-3052-4039-9a7d-e57572d1f01b` |
| `sidecar-transformers-model-source.test.ts` | 12 pass | `7ea21825-9adc-47e8-be81-d2ce68b17a34` |
| `sync/hyperbee/read-admission.test.ts` | 18 pass | `f164d52f-f891-4903-aa40-c1e3ec7a1dc0` |

Total: **181 passing, zero failing, zero skipped assertions across nine files**, all relative to `packages/operator-core/lib/`. The counter writer `testing-run-store.ts::distillVitestRun` was inspected: it counts actual reported assertions, not requested file names. One initially mistyped admission-test path was refused with zero tests; it is excluded from these results and was corrected before the real file ran.

Additional read-only probes executed actual production pure functions for F1, F2 and F6; their bounded outputs are reproduced in the findings. They demonstrate contract behavior, not end-to-end exploitability. The report does not claim a full hostile-peer audit, every operating-system installer tested, field NAT coverage, a new 256-peer benchmark, or a new release candidate passed. No product code, running rig, live gate or peer-owned build was changed for this audit.

## Evidence index

- Progress/completion records: `WI-2039864`, `WI-2039865`, `WI-2039866`, `WI-2039868`, `WI-2039869`, `WI-2039871`, `WI-2039875`, `WI-2039877`, `WI-2039879`, `WI-2039880`, `WI-2039881`, `WI-2039883`, `WI-2141418`.
- Current release blockers: `WI-2142873`, `WI-2142501`, `EI-22356733765630454`; carrier `su-f54d7965-118b-4647-aa7d-6fa08663a8b7`.
- Release authority: `p2p-public-release-endgame-2026-09-01`, especially D-008, D-011–D-015; remaining-lanes D-158, D-160–D-164. Decision IDs are plan-local.
- Signed/historical ledger: [RELEASE-READINESS.md](RELEASE-READINESS.md), particularly the September 2 coordination slice, rows 34–35 and the owner-input section. The older headline remains NO-GO; later per-slice progress does not equal a newly signed global GO.
- Current protocol and behavior sources: linked in F1–F8; also [peer-log.ts](../packages/operator-core/lib/sync/hyperbee/peer-log.ts), [projection.ts](../packages/operator-core/lib/sync/hyperbee/projection.ts), [memory projection](../packages/operator-core/lib/sync/hyperbee/projections/p2p-memories.ts), and [seat-accounting.ts](../packages/operator-core/lib/fleet/seat-accounting.ts).
- Design/reference drift example: [hyperbee README](../packages/operator-core/lib/sync/hyperbee/README.md) still describes early Autobase/stub state, while the live implementation is Model B. Existing docs and comments are navigation aids, not substitutes for the executing call path.
