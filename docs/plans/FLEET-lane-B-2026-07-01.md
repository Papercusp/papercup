# Lane B — Integrator completion & lock handoff (git-plan fleet)

You are **Lane B** of the `git-plan` fleet (model `claude-fable-5` @ xhigh). Leader:
**su-3700b**. Plan: `cross-machine-coord-parity-and-trust-2026-07-01` (harness `papercusp`).

**FIRST:** read `docs/plans/FLEET-git-briefs-2026-07-01.md` — the LEADER-LANDED FOUNDATION
(your work builds directly on `integrator.ts` — read it + its test) and **§0 shared ground
rules**. Then `plans:get` each item for full text. Build in `sync/hive-git/`.

1. **G-5d integrator epoch fencing (P-038)** — the authority lease carries a monotonic
   `epoch`; the integrator stamps each staging advance with `(epoch, seq)` and SIGNS it
   (device-signing idiom, `ed25519.ts`). A receiver accepts a staging-advance only if its
   `(epoch, seq)` is strictly greater than the last accepted AND it's a fast-forward. This
   fences a stale ex-authority's late advance. Add `signStagingAdvance` / `verifyStagingAdvance`
   / `acceptStagingAdvance(incoming, priorEpochSeq)` (pure). Acceptance: a lower/equal
   `(epoch,seq)` is rejected; a valid higher one accepted; a bad signature rejected.

2. **G-5b two-speed gate (P-034)** — `staging` is the FAST, ungated integration (already
   computed by `integrateMemberHeads`). Add the SLOW `release` promotion: a distinct
   release ref advanced ONLY when the green gate passed for that staging sha (ties to G-6's
   crefs threshold + Lane D's aggregator). Build `promoteRelease(repo, integratorDev,
   stagingSha, greenProof)` that advances the release ref iff the proof satisfies the crefs
   rule. Acceptance: release advances only with a satisfying proof; ff-only.

3. **G-0 sha-token lock handoff (P-033)** — when the authority lease changes hands, the new
   authority must continue staging from the OLD authority's last published sha, never rewind.
   Implement a `(stagingSha, epoch)` handoff token the outgoing authority publishes and the
   incoming one adopts before its first advance. **This COLLIDES with
   `authority/lock-authority.ts` (the coordination agent's P-021 landed there — a rendezvous
   selector exists but is NOT wired live). coord:send su-3700b BEFORE editing lock-authority.ts.**
   Acceptance: after a simulated handoff, the new authority's first staging is a descendant of
   the old authority's last staging (no rewind).

4. **G-0b park-token protocol (P-037)** — when the integrator PARKS a head H (can't integrate
   yet), it notifies the lock authority and the handoff token carries H, so a resumed/new
   authority resumes from H rather than a rewind. Acceptance: a parked head survives a handoff.

Report `coord:send { to:['su-3700b'], plan_slug:'cross-machine-coord-parity-and-trust-2026-07-01' }`
on each item green, on a blocker, or before editing `lock-authority.ts`. The leader reviews every diff.
