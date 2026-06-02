---
title: Phase 2 — per-op Ed25519 signing + verify-on-receipt (swarm substrate)
slug: substrate-perop-signing-phase2-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Phase 2 — per-op Ed25519 signing + verify-on-receipt (swarm substrate)

## Now

**State:** DRAFT FOR REVIEW — design only, no code. This is Phase 2 of
[[security/shared-harnesses]] / `papercusp-trust-model-2026-05-31`. It exists because
shipping an L–XL cryptographic change to the substrate's apply/projection path
unsupervised would be reckless; the three policy forks below must be decided in review
before any implementation.

**Next:** review the three open decisions (D-001..D-003 record the *recommended*
resolutions — accept/amend), then convert "Proposed implementation" into tracked items.

## Background — the gap

Replicated Autobase/Hyperbee ops are **not signed, authenticated, or authorized on
receipt** — the only admission check today is a schema-version filter plus the
channel-2 *peer-admission* gate. Because the swarm topic is derivable from the public
GitHub repo id, **any peer who reaches the DHT can write forged feature/PR/contributor/
claim rows into every other peer's local DB/UI.** Phase 1 (advisory + re-derive
decision-bearing facts from GitHub) neutralises what *matters*; Phase 2 is
defence-in-depth / UX-integrity for the *advisory* layer: stop peers from poisoning each
other's local state with plausible-but-forged rows.

Phase 2 is **NOT** the authority of record — GitHub remains that (merge state, write
access, "shipped"). It raises the cost of advisory-row forgery from "any DHT peer" to "an
admitted, channel-2-bound writer" and makes tampering detectable.

## Current state (verified against source 2026-06-02)

**Already built — the primitives:**
- Device Ed25519 keypair in the OS keychain; `signWithDeviceKey(keychainId, bytes)`
  (`apps/operator/lib/identity/sign-with-device-key.ts`) + `loadOrGenerateDeviceKeypair`
  (`attest.ts`). Channel-2 binds device-pubkey ↔ GitHub login (gist attestation).
- Peer admission re-verifies channel-2 periodically (`read-admission.ts`, `boot.ts`,
  `load-revoked-pubkeys.ts`) — so "which pubkey maps to which identity / is revoked" is
  already maintained.

**Not built — the per-op layer:**
- `OpEnvelope` (`apps/operator/lib/sync/hyperbee/op-envelope-types.ts`) carries **no
  signature / seq / writer-pubkey** fields.
- The apply/projection path (`projection.ts`, `projections/register-all.ts` +
  per-table `projections/{feature-queue,contributors,feature-claims,issues,prs,...}.ts`)
  does **no** per-op signature check.
- Write sites (`peer-log.ts` append + the per-table writers) append ops **unsigned**.
- No per-writer freshness/replay tracking.

## The three policy forks (decide in review)

1. **Replay-state durability — in-memory vs PG.** To reject replays we track each writer's
   highest-seen `seq` per harness. In-memory: simplest, but resets on reboot (a replay in
   the window after boot, before the high-water mark is re-learned from the log, could slip).
   PG: durable across reboots, +1 write per applied op. *(Radicle's 2026 replay-CVE is the
   cautionary tale — sign seq+freshness, not just content.)*
2. **Invalid-op handling — drop vs quarantine.** Drop = fail-closed, clean, but a signing
   bug silently vanishes data (hard to debug). Quarantine (keep, flag `valid:false`, audit)
   = debuggable, but invalid rows linger and every consumer must respect the flag.
3. **Coverage — sign-all vs opt-in + grandfather.** Sign-all is strict but a **flag day**:
   existing **unsigned** ops already in every peer's log must be grandfathered (accepted as
   legacy) or they'd all drop. Opt-in/gradual leaves a forgery gap during rollout. The
   grandfather cutoff (by op-key epoch? by a schema-version bump?) is the crux.

## Proposed design (pending the forks above)

- **Envelope:** add `sig?: string` (base64 Ed25519), `seq?: number`, `writer_pubkey?:
  string` to `OpEnvelope`. Sign the **canonical (JCS) op content + seq + harness topic** —
  not content alone.
- **Write path:** a `signOp(op, keychainId, nextSeq)` wrapper at the `peer-log.ts` append
  seam (single choke point preferred over editing every per-table writer).
- **Read path:** `verifySignedOp(op, knownWriterPubkeys, maxSeqSeen)` invoked in
  `projection.ts`/`register-all.ts` before an op mutates local state. Drops (or quarantines)
  ops that are unsigned (post-grandfather), badly signed, from a non-admitted/revoked
  pubkey, or stale (`seq <= maxSeen`).
- **Writer-pubkey resolution** reuses the channel-2 admission set already loaded at boot
  (`load-revoked-pubkeys.ts` + the admission map) — Phase 2 adds *op* verification, it does
  not add a new identity gate.
- **Fail-open on infra error** (consistent with rev-v1/v2 D-006/D-004): a transient
  verify-state load failure must not evict the whole log; it's visible + self-heals.

## Test matrix (must cover before ship)

Property/integration tests, not just examples — `fast-check` for the canonicalisation:
- valid signed op → applied; tampered content → dropped; unsigned post-grandfather →
  dropped; **grandfathered legacy unsigned** → accepted; replayed `seq` → dropped;
  op from a revoked/never-admitted pubkey → dropped; key-rotation (old pubkey retired, new
  admitted) → old dropped, new applied; reboot → replay-state correctly re-derived (if
  in-memory) or reloaded (if PG); two-peer bidi swarm still converges
  (extend `__tests__/two-peer-swarm-bidi.test.ts`).

## Proposed phasing

- **2a** — envelope fields + `signOp`/`verifySignedOp` modules + unit/property tests (no
  wiring; behind a flag). Pure, reviewable in isolation.
- **2b** — wire `signOp` at the write choke point; ship **sign-all-new** with legacy
  grandfathering; verify-but-don't-drop (quarantine + audit) to shake out false negatives.
- **2c** — flip to drop-invalid once 2b's audit stream is clean; remove the flag.

## Risks / why this is gated

- **Canonicalisation drift** = mass false-drops across the fleet (every peer must
  byte-identically canonicalise). The #1 reason this is review-gated, not autonomously built.
- **Grandfather miss** = existing logs wiped on rollout.
- **Equivocation still possible** (Kleppmann): a validly-admitted-then-malicious writer can
  sign false/equivocating rows — Phase 2 does NOT solve this (accepted; advisory + GitHub
  re-derivation covers it; a BFT-CRDT ACL is explicitly out of scope).

## Relation to other work

- Parent: `papercusp-trust-model-2026-05-31` (this is its Phase 2).
- Sibling (built): `papercusp-substrate-revocation-v1/v2` (self + owner revocation, channel-2
  re-verify) — Phase 2 reuses their admission/revocation set.
- Independent of the Cupboard work (`cupboard-provisional-listing-trust-2026-06-02`,
  `cupboard-abuse-surface-review-2026-06-02`) — Cupboard's listing copy is GitHub-bearer
  authenticated, a different surface from the swarm advisory rows this plan signs.

## Decisions

(Recorded below — D-001..D-003 are RECOMMENDED resolutions of the three forks, pending review.)

### D-001 — Recommended: PG-backed replay state (per-writer max seq), not in-memory
Date: 2026-06-02
RECOMMENDED, pending review. Persist `(harness, writer_pubkey) → max_seq_seen` in Postgres rather than an in-memory map. Rationale: the in-memory variant resets on every operator/desktop reboot, opening a post-boot replay window until the high-water mark is re-derived from the full log; on a desktop that restarts often, that window is frequent. PG costs one small upsert per applied op (the operator already writes PG on the projection path), and it's the durable store-of-record per the storage policy. Re-derivation-from-log can be the fallback/seed, not the source of truth. Revisit only if the per-op PG write shows up as a projection-throughput regression in the Day-0 benchmark.

### D-002 — Recommended: quarantine-then-drop (2b quarantines + audits, 2c drops)
Date: 2026-06-02
RECOMMENDED, pending review. Don't go straight to fail-closed drop. In phase 2b, verify-but-keep: mark a failing op `valid:false`, exclude it from the projected view, and emit an audit event — but don't discard it. Run the fleet on real data until the `attestation`/`verify_failed` audit stream is clean (proving no canonicalisation drift or grandfather miss is silently nuking valid ops). Only in 2c flip to hard drop and stop persisting invalid ops. Rationale: the catastrophic failure mode here is a canonicalisation mismatch mass-dropping legitimate rows across every peer; quarantine makes that visible and reversible before it destroys data, at the cost of carrying flagged rows for one rollout phase.

### D-003 — Recommended: sign all new ops; grandfather pre-cutoff unsigned ops via a schema-version epoch
Date: 2026-06-02
RECOMMENDED, pending review. Every op written after the cutoff MUST be signed; ops written before are grandfathered (accepted unsigned) so existing logs aren't wiped on rollout. Anchor the cutoff on the substrate schema-version bump (`schema-version.ts`) rather than a wall-clock time: bump the version when 2b ships; the verifier treats "unsigned AND schema-version < cutoff" as legacy-accept, "unsigned AND >= cutoff" as invalid. This is deterministic across peers (no clock dependence) and self-documenting. Do NOT attempt to retroactively sign old ops (impossible — the original device key may be gone). Accept that grandfathered ops remain forgeable-in-principle; they age out as the queue churns, and nothing decision-bearing rests on them (GitHub re-derivation).
