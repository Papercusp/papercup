# Shared-Pot — the ideal long-term fix architecture

**Author:** su-963ee (Brief E + A-002/A-003 root-cause diagnosis). **Status:** proposal for
the owner + substrate engineer. **Not implemented** — this is the design, not a patch.

The 7-lane release program found four federation defects that look separate but are two
architectural problems. This doc states the *ideal long-term* solution for each (not the
tactical point-fixes), how they relate, and what's a product decision vs. mechanical work.

| Finding | Symptom | Cluster |
|---|---|---|
| **A-002** (EI-1590) | hosting a 2nd pot stalls the 1st's federation (join-time) | 1 — multi-pot correctness |
| **A-003** (EI-1591) | `hive_members`/`hive_settings` + the revocation record never reach a joiner | 1 — multi-pot correctness |
| **C-001** | removing a member doesn't cut off their READS | 2 — true membership cutoff |
| **E-001** | `public→private` doesn't cut off READS (directory-only) | 2 — true membership cutoff |

Why point-fixes are not the answer: routing revocation through a different table (A-003
fix-b) or per-pot announce channels (A-002 fix) each patch one hole and leave the
underlying seam half-migrated; and **no point-fix delivers read-cutoff** — that needs
re-keying. The ideal solution is two coordinated moves.

---

## Move 1 — finish "the pot is the top-level federation unit" (root-fixes A-002 + A-003)

**This is already the declared design**, just incomplete. `derive-swarm-topic.ts:20-28`:
*"the `pot:` binding REPLACES the shared-harness slug as the top-level unit (D-001/D-003)
… harness sync becomes a component, not the top unit (P-004)."* Both live S1s are exactly
where that migration didn't finish:

- **A-002** — the admission/announce channel is keyed per-**muxer** (`swarm.ts:111-119,146-150`,
  single `ANNOUNCE_PROTOCOL`, "last-writer-wins" per socket). With 2 local pots sharing the
  singleton swarm, both pots' connection handlers fire on one peer socket; the first to
  `createChannel` wins the lone announce channel and the other pot's admission is dropped →
  the joining pot's log is never admitted → zero apply. (Matches the live trigger: stall
  only when the owner *already hosts* hive2 *at join time*; add-hive2-after works because the
  muxer already holds hive1's channel.)
- **A-003** — `hive_members`/`hive_settings` projections demux by the **pot-home** slug
  (`pot-members.ts:94` `if (row.hive_home_slug !== opts.harnessSlug) return`), but a joiner
  boots the **member** harness, so its projection-apply is bound to the member slug
  (`register-all.ts:122-146` builds projections with the booted slug; `boot.ts:519-523`). The
  pot-home-scoped ops are dropped. And `boot.ts:583-587` then loads the joiner's admission
  revoked-set from that (empty) `hive_members` → the joiner never learns of a revocation.

**The fix (one coherent change, no product decision):** make **pot** the consistent key
end-to-end.
1. A node boots one substrate **per pot** (keyed by pot pubkey / home-slug); member
   harnesses are components *inside* the pot's substrate, not the top unit.
2. The admission/announce channel is discriminated **per-pot** on the shared muxer — a
   per-pot Protomux channel `id` (e.g. the pot topic hex); key `announcePairedMuxers` /
   `announceOptsByMuxer` by `(muxer × hiveTopic)`.
3. A joiner runs the **pot-home-scoped** projection-apply for `hive_members`/`hive_settings`
   (it already has the pot-home harness registered from the join's view materialization) —
   so member-list, settings, and the revocation record all reach joiners.

**Two constraints on the per-pot announce channel (found while implementing — EI-1590):**
- **Privacy:** the per-pot Protomux channel `id` must be `sha256(topic)`, NOT the raw topic.
  The `id` is sent in the clear over the muxer (a channel-open reaches a connected peer before
  it has a matching channel), so a raw-topic id would leak hive2's *content* topic to a
  hive1-only peer → they could join hive2's swarm and read it (C-001). A one-way hash pairs for
  topic-sharers while leaking nothing invertible.
- **Back-compat / rollout:** today both ends open the announce channel with NO `id` (pairing on
  the default); adding an `id` means an old-build peer and a new-build peer won't pair → admission
  fails between mixed-version peers during rollout (a live remote peer would hit this). Needs a
  versioned negotiation (try id'd, fall back to default), an atomic fleet rollout, or to be folded
  into the boot-per-pot re-architecture where admission is pot-scoped by construction.

**Test gates:** (a) a 2-owner-pot + joiner integration test — joining hive1 while the owner
hosts hive2 federates hive1 fully (closes A-002); (b) a joiner applies a pot-home-scoped
`hive_members`/`hive_settings` op (closes A-003); (c) the existing single-pot federation
suite stays green; (d) `pot-members.integration.test.ts:87` (the per-scope drop guard) stays
green — the guard is correct, the wiring is what changes; (e) a mixed-version pairing check (the
back-compat constraint above).

**Effort/risk:** mechanical substrate correctness; load-bearing (touches the boot + swarm
admission path), so it wants the substrate engineer + the gates above, but **no product
decision**. Highest-leverage next step — unblocks multi-pot deployments.

---

## Move 2 — epoch re-keying + content encryption (the only thing that fixes C-001 + E-001)

C-001/E-001 are **not** patchable by routing or directory changes. The architecture uses an
**immutable pot identity** → content topic = `sha256("…:pot:<pubkey>")`, never rotated, and
cores are **unencrypted** (`corestore.ts`/`boot.ts` — no `encryptionKey`). With that, neither
member-remove nor `public→private` can cut off a prior pubkey-holder's reads — proven live
(E-001) and by C-001. Topic withdrawal stops *new discovery*; write-revocation stops *writes*;
neither stops *reads*.

**The ideal solution is the standard for secure group membership — a per-epoch group key
(MLS / TreeKEM-style):**
- The pot has a current **epoch group key**; content cores are encrypted under it.
- A **member-remove or `public→private` advances the epoch** and re-keys, delivering the new
  key to the *remaining* members only (via the still-trusted members' channel).
- A removed/excluded peer keeps whatever it already cached but **cannot read any new content** —
  exactly what "remove member" / "go private" must mean.
- A stable discovery topic can remain; the cutoff comes from **key rotation, not topic secrecy**
  (so it's robust even if a removed peer re-derives the topic).

This subsumes A-003's *enforcement* concern (a removed member can't decrypt regardless of
whether the revocation row federated) and is the principled basis the immutable-identity note
(`pot-identity-phase0.integration.test.ts:97`) will have to revisit.

**This is a product decision + a real cryptographic effort**, not a patch. Lane C already
landed the honest-UI stopgap (C-001 option (d) — the UI no longer implies reads are cut off),
so there is no false promise while this is decided. The owner must choose: ship with the
documented limitation, or commit to epoch re-keying.

---

## Relationships & sequencing

- **The pot identity/epoch is the natural anchor for both moves** — the same per-pot unit
  that Move 1 establishes is where Move 2's epoch key lives. So **Move 1 is the foundation
  Move 2 builds on.**
- **Move 1 can start now** (mechanical, no product decision) — recommended next engineering
  work; it closes the two multi-pot S1s and unblocks multi-pot deployments.
- **Move 2 waits on the owner's go** on the revocation/privacy model (the C-001/E-001 bundle).
- **D-001** (HLC-of-record vs `fed_ts` LWW divergence) is the **only hard S0** among the blockers
  (data divergence / non-convergence) and is **orthogonal** to both moves — but **not** purely
  "land-regardless mechanical": HLC is assigned only at the drain/append seam (`boot.ts:1465`), so a
  local write's PG row carries no `hlc`; BOTH viable fixes must move HLC assignment to **write-time**.
  Two empirically-validated fixes (Brief D / `findings-D.md`): (a) carry an `hlc` column into the PG LWW
  guard, or (b) derive `fed_ts` from `packHlc` — the skew fuzz sweep converges under an `lwwPick`-ordered
  guard, diverges under `fed_ts`. Belongs at **S0 priority** in RELEASE-READINESS; lands regardless of
  Moves 1–2. Spec: `findings-D.md` + plan `shared-pot-hardening-2026-06-13` D-013.

## Cross-references
- Findings: `findings-A.md` (A-002/A-003 live), `findings-C.md` + `threat-model-C.md` (C-001),
  `findings-D.md` (D-001 convergence), `findings-E.md` (E-001), `RELEASE-READINESS.md` (the lead's
  blocker synthesis).
- Trackers: EI-1590 (A-002 pin), EI-1591 (A-003 pin).
- Code: `swarm.ts` (announce channel), `register-all.ts` + `boot.ts` (projection-apply wiring),
  `pot-members.ts`/`pot-settings.ts` (demux guard), `derive-swarm-topic.ts` (the declared
  pot-as-top-unit design).
