# Brief V — Re-key (Move 2) adversarial test GATE

Co-owned: K (su-313d1) + the wave lead (su-9140a). The acceptance battery that proves
the C-001 read-cutoff — i.e. that member-remove / go-private make a removed peer
**unable to read post-boundary content** — to a public-release bar. This is the
**definition of DONE** for `shared-hive-rekey-2026-06-19`: the plan flips GREEN only
when every MUST case below is green (unit + integration + the LIVE on-binary witness),
with the existing federation + D-001 convergence suites still green.

Status legend: ✅ landed · ◻ pending the op-path wiring (P-004/op-path) · 🔴 live (needs the binary).

---

## Tier 0 — building blocks (✅ done, teeth-verified, ahead of the gate)
These already exist (35 tests; see findings-REKEY §Status). V relies on them; re-listed
as the gate's foundation, not re-tested here.
- ✅ crypto: epoch-key fresh-random + wrap/unwrap (sealed box) + AEAD; op under epoch N+1
  undecryptable with the epoch-N key (`hive-epoch-crypto-impl.test.ts`, ed300).
- ✅ boundary core: advance epoch → wrap to REMAINING members; removed excluded; e2e
  unwrap+decrypt for a remaining member, fail for removed (`hive-epoch-boundary.test.ts`).
- ✅ provider: re-unwrap + cache; **fail-closed** when no row (`hive-epoch-key-provider.test.ts`).
- ✅ producer: encrypt under current epoch; epoch N unreadable with N-1 key (`hive-epoch-producer.test.ts`).
- ✅ projection/store: per-member rows, demux, drain hook (`hive-epoch-keys.test.ts`).
- ✅ ordering buffer: defer content until its epoch-key row applies; removed defers forever (J, `pending-epoch-content.ts`).

## Tier 1 — the flip (◻ pending wiring): `revoked-swarm.integration.test.ts`
The existing test **codifies the gap** ("the revoking side's writes still federate to the
revoked peer" as intended C-001 behavior). The re-key INVERTS it. Flag-gated on
`papercusp-hive-rekey` so it stays green-as-codified with the flag OFF and asserts the
cutoff with the flag ON (no RED-in-CI before the impl).
- **V-1 (MUST)** flag ON: owner removes member B → owner writes content at the new epoch →
  B replicates the op bytes but **cannot decrypt** (no epoch-(N) wrapped row) → the op is
  DEFERRED, never applied; a REMAINING member C decrypts + applies + converges.
- **V-2 (MUST)** flag OFF: the legacy codified behavior is unchanged (back-compat).

## Tier 2 — threat-model battery (◻): extend `federation-threat-model.test.ts`
The C-001 case there asserts "removed member keeps READING"; under re-key it must assert
the cutoff + resist the adversarial angles a PUBLIC/untrusted deployment faces:
- **V-3 (MUST)** removed member holding its OLD epoch-(N-1) key cannot read epoch-N content
  (the key it has is the wrong epoch; AEAD fails closed).
- **V-4 (MUST)** removed member that kept the topic + reconnects gets only ciphertext for
  every post-boundary op, indefinitely (the cut is permanent, not a transient).
- **V-5 (MUST)** a removed member **replaying** another member's wrapped-key row cannot
  open it (sealed to that member's device key; unwrap with the removed device fails).
- **V-6 (SHOULD)** go-private→go-public re-key: a non-member who grabbed the pubkey while
  public, then was excluded at the private flip, cannot read post-flip content.
- **V-7 (SHOULD)** re-ADD a removed member: the next epoch advance wraps to them again →
  they read from the re-add epoch forward, but NOT the epochs they were excluded from
  (no back-read of the gap).
- **V-8 (MUST, no-regression)** a NORMAL remaining member reads + writes + converges across
  several epoch advances (the cut doesn't break the happy path).

## Tier 3 — ordering / liveness edges (◻, pair with J's buffer)
- **V-9 (MUST)** content op arrives BEFORE its epoch-key row (the reorder race) → deferred,
  then applied on key arrival (drain) — never applied-as-garbage, never lost.
- **V-10 (SHOULD)** bounded buffer: a flood of undecryptable ops (a removed peer's deferred
  content, or junk) cannot OOM — oldest-evicted, bounded (J's DEFAULT_MAX_PENDING).
- **V-11 (MUST)** epoch monotonicity under concurrent boundaries (two removes near-simultaneous)
  → no epoch reuse, no lost wrap-to-remaining (ties to advanceHiveEpoch concurrency note).

## Tier 4 — LIVE cut-off witness (🔴 P-008, the release gate)
On a real-binary 2-instance pair (the inverse of the current C-001 live witness in findings-K):
- **V-12 (MUST, RELEASE GATE)** owner removes member B → owner writes a NEW feature →
  assert **B's PG never materializes the plaintext** (the op is ciphertext/deferred,
  `origin=remote` but undecryptable) while a REMAINING member C reads it (`origin=remote`,
  decrypted) + converges. The exact inverse of findings-K's "removed member still reads."
- **V-13 (SHOULD)** go-private live: owner flips public→private → writes content → a peer
  that was on the topic pre-flip cannot read post-flip content. (Inverts Brief E's live E-001.)
- Method: the from-repo real-join pair on the integrated fix-`.deb` (real device
  attestations → real wrap targets), `papercusp-hive-rekey` ON; verify via each peer's
  embedded-PG. Coordinate the live pair with the lead (one pair at a time; never :0).

## Gate
GREEN ⟺ V-1..V-5, V-8, V-9, V-11, V-12 (the MUSTs) green + the federation + D-001 suites
unregressed. SHOULDs (V-6/7/10/13) are strongly desired for the public bar; if any is
deferred, log it explicitly in the rollup (no silent gap). Until V-12 (the live witness)
is green on the real binary, shared-hive is NOT public-release-ready on the C-001 axis.

## Dependencies
All of Tier 1–4 are gated on the op-path WIRING (P-004 boundary wiring + J's
encrypt/decrypt apply-gate + the projection registration), which is itself gated on the
A-003 (a′) live witness (the hive-home→joiner seam epoch keys ride). Tier 0 is done.
The wiring + V battery land together once A-003 (a′) is witnessed green.
