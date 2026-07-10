# worker-log EI-8895 (implement role) — resolved needs-human

**Bug:** WI-183 `connected_never_replicated` is detect-only — a log admitted AFTER
connect never gets its replicator attached (no recovery).

## Investigation

Read the full attach/admit/detect path:
- `packages/operator-core/lib/sync/hyperbee/swarm.ts` — `joinHarnessSwarm`: per
  connection calls `store.replicate(socket)` (whole-corestore replication) +
  opens the announce channel. Also retro-attaches to EXISTING sockets on late
  topic-join (`for (const socket of swarm.connections)`).
- `packages/operator-core/lib/sync/hyperbee/read-admission.ts` — pure D-004
  admission decider (sig + attestation binding + revocation). Security gate.
- `packages/operator-core/lib/sync/hyperbee/boot.ts` — `drainAdmissionQueue()`
  opens the newly-admitted remote log via `openRemoteLog` (`store.get({key})`)
  and `admitted.set(...)`. `mergeOnePass()` then iterates `admitted.values()`
  and calls `update()` on every remote each ~1s pass.
- `packages/operator-core/lib/sync/hyperbee/peer-log.ts` — `openRemoteLog` =
  `store.get({key})` session; `update()` = `core.update({wait:true})`.
- `packages/operator-core/lib/sync/hyperbee/replication-liveness.ts` — the
  WI-1840 detector layer; `connected_never_replicated` axis + edge-triggered
  stall/recovery EIs. Detect + escalate only, no heal ACTION.

## Findings

1. The EI's proposed in-process fix ("on admit, iterate connected peers and
   re-attach replication for the new log") is ALREADY effectively present: a
   drained admission adds the log to `admitted`, and the very next `mergeOnePass`
   calls `update()` on it, which is corestore's `ondownloading -> attachAll`
   trigger — it attaches the core to ALL active `store.replicate(socket)` streams
   (existing connections). So admission IS an attach trigger, via the merge loop.

2. The codebase's own probe `wi183-attach-on-late-admit.integration.test.ts`
   documents the remaining question as UNRESOLVED: if in-process attach works
   (GREEN), the P-059 reverse-leg failure is a transport dead-data-path
   phenomenon and a re-attach-on-admit fix is a no-op; if RED, there is a genuine
   attach-seam gap. This is an open architecture question, not a settled bug.

3. The requested recurrence-guard ("auto-heal: force re-attach or cycle the
   connection") is a large, risky new capability in a security-adjacent P2P
   federation substrate:
   - Cycling a shared-swarm socket affects EVERY log/harness/topic on that muxer
     (collateral disruption of healthy replication).
   - A force close+reopen of a remote core session has correctness + session-leak
     implications (WI-1856 class).
   - Spans replication-liveness.ts + swarm.ts + boot.ts and needs real-rig
     verification that it actually heals the transport-level dead path.

## Decision: needs-human

Hits three STOP conditions for the auto-implement gate: security-adjacent
federation/admission substrate, large multi-subsystem change, and an unresolved
design question (in-process gap vs transport phenomenon) where the proposed
in-process attach trigger already exists. A wrong auto-fix here — e.g.
connection-cycling that disrupts healthy replication on the shared swarm — is
exactly what this gate exists to prevent.

## Proposed direction for a human with architecture authority
- First determine the RED/GREEN state of `wi183-attach-on-late-admit` on a real
  2-machine rig (it is a testnet-DHT integration test). If in-process attach is
  GREEN, the fix is a no-op and the real work is confirming/closing the
  transport-level dead-data-path cause (out of this EI's framing).
- If a heal action is still wanted, scope it deliberately: prefer a per-log
  force-refresh (bounded close+reopen of the single stalled remote core session,
  reusing the WI-1856 close() seam) over cycling the shared socket, and gate it
  behind the existing edge-triggered `connected_never_replicated` alarm with a
  heal-storm guard. This is a design decision, not an auto-fix.

No code changes made. No tests changed.
