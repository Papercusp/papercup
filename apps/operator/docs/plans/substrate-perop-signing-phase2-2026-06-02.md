---
title: Phase 2 — per-op Ed25519 signing + verify-on-receipt (swarm substrate)
slug: substrate-perop-signing-phase2-2026-06-02
status: shipped
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Phase 2 — per-op Ed25519 signing + verify-on-receipt (swarm substrate)

## Now

**State:** SHIPPED — narrowed Phase 2 (D-004) implemented + tested, including the now-built optional telemetry. P-001: lwwPick LWW tiebreak keys off the unforgeable `sourceLogKeyHex`. P-002: remote attribution stamps the immutable `sourceLogKeyHex` (local keeps the own device pubkey). P-003: end-to-end admission-boundary test (a rejected peer's replicated ops never reach PG) + boot-history observability. P-004 (added on user request, see D-005): `substrate_admission_rejected` PostHog telemetry — a `recordTelemetryReport` server-side helper feeding the existing ring-buffer→flushTelemetry→PostHog pipeline (opt-in gated), emitted from boot.ts via a best-effort seam; the /desktop/telemetry-report route was refactored to share the helper. All telemetry + hyperbee unit tests green (56 files / 520 tests); tsc clean on changed files, no consumer regressions.

**Next:** None — plan complete (P-001..P-004 all done). Future: re-open per-op signing only if ops ever move outside the Hypercore framing (HTTP/gist op-sync / untrusted import — the Radicle-2026 shape).

## Background — the gap (re-grounded)

Phase 1 (`papercusp-trust-model-2026-05-31`) neutralised what *matters* by re-deriving
decision-bearing facts from GitHub. This plan originally proposed Phase 2 as defence-in-depth for the
*advisory* swarm rows: stop an arbitrary DHT peer from poisoning other peers' local state with
plausible-but-forged feature/PR/contributor/claim rows, by signing and verifying every op.

**The 2026-06-02 source review found that threat is already closed at the log layer**, so the per-op
layer the plan was built around is mostly redundant. The evidence is in "Current state".

## Current state (verified against source 2026-06-02)

The substrate is **NOT** the Autobase multi-writer model the original draft assumed — Stage 4/5
retired Autobase (`op-envelope-types.ts` header). It is **per-peer single-writer Hypercore logs +
a read-merge over admitted logs** (`peer-log.ts`, `read-merge.ts`, `boot.ts`). That reframes the
threat model entirely.

**The trust chain is already complete, end-to-end:**

1. **GitHub identity → device pubkey** — channel-2 gist attestation (`verify-binding-adapter.ts` →
   `verifyAttestation`) binds a device Ed25519 pubkey to a GitHub login / userId.
2. **Device pubkey → log core key** — the swarm **announce** frame (`announce.ts`) carries
   `device_pubkey` + `log_core_key` + `ts`/`nonce`, and `sig` is an Ed25519 signature **by the
   device key over all of it**; `log_core_key` is explicitly "covered by the signature, so it cannot
   be substituted in transit." Admission (`read-admission.ts`) admits a log **only** on `sig` valid
   + binding valid + not revoked (else `bad_sig` / `binding_invalid` / `revoked` / `pending`). The
   announce's `ts`-window + `nonce` give the announce itself replay protection.
3. **Log core key → every op** — a Hypercore is self-certifying: blocks are Merkle-verified against
   the (signed) core key, at fixed monotonic indices. You cannot inject, modify, reorder, or
   duplicate a block without the core's secret key.

**Consequences for the three original forks:**

- **Replay (old D-001)** — Hypercore's append-only Merkle index already prevents in-log
  replay/dup/reorder, and the read loop advances by `(core_key, index)`. **No op ever leaves the
  Hypercore framing**: the only op *sources* are local own-log appends (`write-*`, `outbox-drain`
  CDC → own log, `boot.ts`) and remote **admitted** logs via `read-merge` (which stamps
  `sourceLogKeyHex` = the source core key). The gist is channel-2 *identity attestation only* —
  there is no op-over-gist/file path. So a per-op `seq` + per-writer high-water map would
  re-implement the Hypercore index for no gain.
- **Authenticity** — already established per-log by (1)+(2)+(3). A per-op *device* signature
  re-proves, per op, what is already proven per log — not worth the canonicalisation-drift risk.
- **The one real gap is attribution, not signing.** The op's `author_pubkey` is a **self-declared
  field inside the op value**, distinct from the cryptographic `sourceLogKeyHex` (`peer-log.ts`
  explicitly: "do not conflate them"). The security-relevant local/remote `origin` split already
  (correctly) keys off `sourceLogKeyHex` (`projection.ts`, D-006 — "cannot be forged by a remote
  peer"). BUT two places still trust the self-declared field:
  - `lwwPick` (`projection.ts`) breaks an **exact-`ts`, same-type** conflict on the
    lexicographically-greater `writerPubkey` — a (minor) decision-bearing use a peer can bias by
    self-declaring an all-`f` pubkey.
  - the projected `author_pubkey` column (issues / feature-queue / feature-working-set /
    harness-features) is written from the self-declared field — misattributable.

## What Phase 2 actually is (narrowed scope)

Per-op Ed25519 signing + verify-on-receipt + replay-state is **NOT needed** for the threat model as
it stands. Drop it. The residual, much smaller work:

1. **Bind authorization + attribution to the admitted log identity** (`sourceLogKeyHex` → its
   admitted device / GitHub identity), never the self-declared `author_pubkey` / `writerPubkey`:
   - `lwwPick` tiebreak → use `sourceLogKeyHex` (unforgeable, peer-stable — keeps the
     order-independent-fold property the original D-003 wanted, without the spoof).
   - projected `author_pubkey` column → derive from the source log's admitted identity.
2. **Assert the admission invariant with tests** — only sig-valid + binding-valid + not-revoked logs
   become `AdmittedLog`s and project; a forged / non-admitted / revoked log's ops never reach PG.
   The mechanism exists (`read-admission.ts`, `boot.ts` `pubkeyToLogKey` + `revoked`); Phase 2's
   value is making it the explicit, audited, regression-tested invariant. Admission-rejection events
   can ride the existing PostHog `TELEMETRY_KINDS` taxonomy (`telemetry-kinds.ts`) for cheap
   fleet-health observability — a one-kind edit, no bespoke audit table.

**Explicitly out of scope (unchanged):** equivocation by an admitted-then-malicious writer
(Kleppmann) — a validly-admitted peer can still write false rows into its own log; advisory + GitHub
re-derivation covers it; a BFT-CRDT ACL is not in scope.

**When to re-open per-op signing:** only if a future path moves ops *outside* the Hypercore framing
— an HTTP/gist op-sync, or importing ops from an untrusted serialized blob — where the
`(core_key, index)` provenance is stripped. That is the Radicle-2026 shape (signed refs with no
nonce/parent → replayable; fixed by signing the parent link). If that path is ever built, sign
`content + seq + topic` and track a per-writer high-water mark *for that path only*.

## Test matrix (narrowed)

- **admission:** sig-invalid announce → not admitted; revoked pubkey → not admitted; binding-invalid
  → not admitted; admitted log's ops → project; non-admitted / forged log's ops → never project.
- **attribution:** a forged self-declared `author_pubkey` on an admitted log → both the `lwwPick`
  winner and the stored attribution follow `sourceLogKeyHex`, not the self-declared field.
- **convergence:** two-peer bidi swarm still converges with the `sourceLogKeyHex` tiebreak (extend
  `__tests__/two-peer-swarm-bidi.test.ts`).

## Risks (re-grounded)

The original plan's #1 risk — **canonicalisation drift mass-dropping legitimate rows across the
fleet** — **disappears**, because there is no per-op canonicalise-and-verify step. The remaining
risks are ordinary:
- the `lwwPick` / attribution change must stay deterministic across peers (covered by the
  convergence test);
- the admission gate must remain the *sole* path to `AdmittedLog[]` (covered by the admission tests).

## Relation to other work

- Parent: `papercusp-trust-model-2026-05-31` (Phase 1 — advisory + GitHub re-derivation).
- Siblings (built): `papercusp-substrate-revocation-v1/v2` — this plan reuses their
  admission/revocation set, the very mechanism that makes per-op signing redundant.
- Architecture references verified 2026-06-02: `peer-log.ts`, `read-merge.ts`, `announce.ts`,
  `read-admission.ts`, `verify-binding-adapter.ts`, `projection.ts`, `boot.ts`.
- Independent of the Cupboard work (GitHub-bearer-authenticated listing copy — a different surface).


## Phase 2 (narrowed) — attribution-binding + admission tests

- **P-001** `done` lwwPick: replace the self-declared `writerPubkey` tiebreak (projection.ts) with the unforgeable, peer-stable `sourceLogKeyHex`. Preserve order-independent-fold determinism. Property test: fold-order independence + exact-ts same-type tie resolves to the same winner on every peer, and a forged self-declared pubkey cannot flip the winner. importance: high (lwwPick tiebreak → sourceLogKeyHex; forge-resistance + fold-order property tests green commit 8ef145a92)
- **P-002** `done` Projected attribution: stamp `author_pubkey`/provenance from the unforgeable `sourceLogKeyHex` (or its admission-bound device identity), never the self-declared op field. Test: an op carrying a forged self-declared author on an admitted log leaves the stored attribution following `sourceLogKeyHex`. importance: high (remote attribution → immutable sourceLogKeyHex chosen over stale-able resolved pubkey; provenance-g1 reconciled commit befdeb17d)
- **P-003** `done` Admission invariant tests: assert only sig-valid + binding-valid + not-revoked logs become AdmittedLogs and project; a forged / non-admitted / revoked log's ops never reach PG. Optionally surface admission-rejection counts via the existing PostHog TELEMETRY_KINDS taxonomy. (admit-one/reject-one end-to-end boundary test rejected peer's replicated ops never reach PG + boot-history observability assertion. PostHog telemetry skipped: redundant with boot-history announce_rejected events + no server-side capture path commit 4950f2acd)
- **P-004** `done` PostHog admission-rejection telemetry: `substrate_admission_rejected` kind + shared server-side `recordTelemetryReport` helper (ring buffer → flushTelemetry → PostHog, opt-in gated); boot.ts emits at the rejection site via a best-effort injectable seam; /desktop/telemetry-report route refactored to share the helper. Payload: harness_slug, reason, truncated peer label. (substrate_admission_rejected kind + recordTelemetryReport helper + boot seam + route refactor; 520 tests green, tsc clean commit on apps/operator/lib/{telemetry-kinds,record-telemetry,sync/hyperbee/boot}...)




## Decisions

(D-001..D-003 are the original recommended resolutions of the three forks; **all superseded by
D-004** after the 2026-06-02 source re-grounding. Their bodies are kept verbatim as the reasoning
trail.)

### D-001 — [SUPERSEDED by D-004] Recommended: PG-backed replay state (per-writer max seq), not in-memory
Date: 2026-06-02
**SUPERSEDED by D-004** — Hypercore's append-only Merkle index already prevents in-log replay and no
op leaves the Hypercore framing, so there is no per-op `seq` to track a high-water mark for.
*(Original:)* RECOMMENDED, pending review. Persist `(harness, writer_pubkey) → max_seq_seen` in
Postgres rather than an in-memory map. Rationale: the in-memory variant resets on every
operator/desktop reboot, opening a post-boot replay window until the high-water mark is re-derived
from the full log; on a desktop that restarts often, that window is frequent. PG costs one small
upsert per applied op (the operator already writes PG on the projection path), and it's the durable
store-of-record per the storage policy. Re-derivation-from-log can be the fallback/seed, not the
source of truth. Revisit only if the per-op PG write shows up as a projection-throughput regression
in the Day-0 benchmark.

### D-002 — [SUPERSEDED by D-004] Recommended: quarantine-then-drop (2b quarantines + audits, 2c drops)
Date: 2026-06-02
**SUPERSEDED by D-004** — there is no per-op verify step producing invalid ops to quarantine;
admission rejection happens at the merge boundary (a non-admitted log is simply never merged), so the
quarantine→drop rollout doesn't apply. (The observability instinct survives as admission-rejection
telemetry on the existing PostHog taxonomy — see "narrowed scope".) *(Original:)* RECOMMENDED,
pending review. Don't go straight to fail-closed drop. In phase 2b, verify-but-keep: mark a failing
op `valid:false`, exclude it from the projected view, and emit an audit event — but don't discard it.
Run the fleet on real data until the `attestation`/`verify_failed` audit stream is clean (proving no
canonicalisation drift or grandfather miss is silently nuking valid ops). Only in 2c flip to hard
drop and stop persisting invalid ops. Rationale: the catastrophic failure mode here is a
canonicalisation mismatch mass-dropping legitimate rows across every peer; quarantine makes that
visible and reversible before it destroys data, at the cost of carrying flagged rows for one rollout
phase.

### D-003 — [SUPERSEDED by D-004] Recommended: sign all new ops; grandfather pre-cutoff unsigned ops via a schema-version epoch
Date: 2026-06-02
**SUPERSEDED by D-004** — with no per-op signing there is no signed/unsigned distinction to
grandfather. (Aviynw's alpha instinct — "just drop the old logs" rather than build grandfather
machinery — is correct and now moot for signing; it remains fine as general reset hygiene if a log
reset is ever wanted for another reason.) *(Original:)* RECOMMENDED, pending review. Every op written
after the cutoff MUST be signed; ops written before are grandfathered (accepted unsigned) so existing
logs aren't wiped on rollout. Anchor the cutoff on the substrate schema-version bump
(`schema-version.ts`) rather than a wall-clock time: bump the version when 2b ships; the verifier
treats "unsigned AND schema-version < cutoff" as legacy-accept, "unsigned AND >= cutoff" as invalid.
This is deterministic across peers (no clock dependence) and self-documenting. Do NOT attempt to
retroactively sign old ops (impossible — the original device key may be gone). Accept that
grandfathered ops remain forgeable-in-principle; they age out as the queue churns, and nothing
decision-bearing rests on them (GitHub re-derivation).

### D-004 — Re-grounding: per-op signing is redundant given per-peer-Hypercore + channel-2-admitted-merge; narrow to attribution-binding + admission tests
Date: 2026-06-02
ACCEPTED-PENDING-REVIEW. A source review (2026-06-02, verified against `peer-log.ts`, `announce.ts`,
`read-admission.ts`, `verify-binding-adapter.ts`, `read-merge.ts`, `projection.ts`, `boot.ts`)
established that the trust chain is already complete at the log layer: **GitHub → device** (channel-2
gist attestation), **device → log_core_key** (device-signed announce; `log_core_key` is covered by
the sig; `ts`-window + `nonce` guard announce replay), **log_core_key → every op** (Hypercore
self-certifying Merkle blocks at monotonic indices). Admission merges only sig-valid + binding-valid
+ not-revoked logs, and **no op leaves the Hypercore framing** (the gist is attestation only; the
only op sources are local own-log appends and `read-merge` over admitted remote logs). Therefore
per-op Ed25519 signing + verify-on-receipt + replay-state (D-001) is **redundant**, and the
quarantine / grandfather rollout machinery (D-002 / D-003) is **moot**. The original plan's stated
#1 risk — canonicalisation drift mass-dropping legitimate rows — disappears with the per-op verify
step. **Narrow Phase 2 to two residual fixes:** (1) bind the `lwwPick` tiebreak + the projected
`author_pubkey` column to the unforgeable `sourceLogKeyHex` instead of the self-declared
`author_pubkey` / `writerPubkey` (the only two places that still trust the self-declared field; the
security-relevant `origin` split already uses `sourceLogKeyHex` per D-006); (2) assert the admission
invariant with tests, optionally surfacing admission-rejection counts via the existing PostHog
`TELEMETRY_KINDS` taxonomy. **Re-open per-op signing only** if a future path moves ops outside the
Hypercore framing (HTTP/gist op-sync, untrusted serialized import) — the Radicle-2026 shape (signed
refs without a nonce/parent → replayable). Equivocation by an admitted-then-malicious writer remains
out of scope (GitHub re-derivation covers decision-bearing facts).

### D-005 — PostHog admission-rejection telemetry added (P-004) — corrects D-004's "skipped as redundant"
Date: 2026-06-02
Date: 2026-06-02
D-004 deferred the optional PostHog telemetry as "redundant with boot-history + no server-side capture path." The user requested it built; on closer look that rationale was half-wrong and is corrected here: (1) there IS a server-side path — `telemetry-flush.ts` (posthog-node) drains the `telemetry_reports` operator-state ring buffer and forwards to PostHog with opt-in gating; the POST `/desktop/telemetry-report` route was just the *client* ingress to the same buffer. (2) It is NOT purely redundant with boot-history: boot-history is LOCAL, per-harness, per-process observability, whereas PostHog adds OFF-DEVICE, cross-FLEET aggregation (rejection counts/trends across installs) — which boot-history cannot provide. The two are complementary (local forensics + fleet signal). Implementation: a `substrate_admission_rejected` telemetry kind; a shared `recordTelemetryReport` server-side helper (the route now reuses it — one ring-buffer impl); boot.ts emits at the `announce_rejected` site via a best-effort injectable seam (`recordTelemetryOverride`, never awaited / never throws — telemetry must not gate or slow admission). Payload carries `harness_slug`, `reason`, and a truncated peer label only (no full device pubkey, since this leaves the box). Gating + local archival are inherited from `flushTelemetry` (forward only on opt-in / maintainer-internal build; archive locally always).
Related: P-004
