# The hive approval-membership gate lives at the owner admission seam
URL: /internal/docs/agent-insights/hive-approval-membership-gate-wiring

membership:'approval' is enforced by ownerAdmitOrPend in boot.ts drainAdmissionQueue — not by the joiner; the per-op enforcer and the join orchestrator deliberately do NOT decide approval.

## TL;DR

A shared hive's `membership:'approval'` policy is enforced **on the OWNER side**, at the
substrate admission seam (`boot.ts` `drainAdmissionQueue`), via
**`ownerAdmitOrPend`** (`hive-membership-admission.ts`). When the owner admits a
binding-verified peer's announce it does NOT unconditionally trust-admit; it consults
the owner-signed policy:

* **already a member** → refresh the row (idempotent epoch re-grant on reconnect).
* **not a member, open/allowlisted** → `upsertHiveMember` (trust-admit).
* **not a member, approval mode** → `recordPendingJoin` (a federated pending request,
  written by the owner so it reaches the joiner + the `hive:membership_pending` queue);
  the peer is **not** trust-admitted until `hive:membership_decide` approves.
* **not a member, banned / not-allowlisted** → neither.

## The trap (WI-639, fixed 2026-06-23)

Approval mode was **built but unwired** — for a while it was a complete no-op (a
verified joiner was auto-admitted exactly as if `membership:'open'`). Three things
conspired:

1. **`evaluateJoinAdmission`** (the function that records the pending request) had
   **zero live callers**. The 6-step join orchestrator (`joinSharedHarness` →
   `handleJoinLink` → `joinHiveAsView`) never calls it — joining is about cloning +
   attestation + booting the substrate, not membership policy.
2. **`drainAdmissionQueue`** in `boot.ts` UNCONDITIONALLY `upsertHiveMember`'d every
   binding-verified, non-revoked peer (the comment even said "including OPEN-mode
   auto-admit"). No `getHivePolicy` / membership-mode check.
3. **`policy-admission.ts`** (`decidePolicyOp`) enforces only ban → allowlist →
   takedown → content **per op**. It deliberately does NOT decide approval — its header
   says *"approval admission stays the JOIN gate's job"*. But that gate was #1 (unwired).

So nothing created a pending row, and the owner admitted before any approval.

## Why the fix lives at the owner seam (not the joiner)

The owner is online + authoritative, and it already receives + verifies the joiner's
announce. Having the **owner** write the pending row (origin=`local` on the owner)
matches the existing decision-federation model (the owner writes the `hive_members` row
on approve and the `denied` status on deny). The pending row then federates back to the
joiner so the joiner sees "pending" — robust even if the joiner is offline. This avoids
a chicken-and-egg where a joiner-written pending row needs the owner to admit its core
first.

## Invariants — what `ownerAdmitOrPend` does NOT touch

It gates ONLY the membership-UPSERT decision. **Core admission, the `revoked` set, the
C-001 read-cut/epoch decrypt gate, and per-op policy enforcement are unchanged** (each
at its own seam). A pending/refused peer's *content* is still gated by the P-002
membership guard, so nothing federates as a member before approval. With no policy or
`open` mode the outcome is `admit` → **byte-equivalent** to the prior behavior, so
existing hives are unaffected (no flag needed — it's naturally scoped to
approval/allowlist-policy hives, which are owner opt-in).

## Federated table note

`hive_pending_joins` **is** a federated table (it has a Hyperbee projection +
op-key + a `substrate_outbox` capture) — so a recorded pending request, and the owner's
approve/deny decision, both federate. (An older WI-559 note listing the federated set
omitted it; that list was incomplete.)

## Tests

`hive-membership-admission.test.ts` (unit) + `hive-membership-admission.integration.test.ts`
(real PG, incl. the `substrate_outbox` put that proves federation) cover all
`ownerAdmitOrPend` branches end to end.
