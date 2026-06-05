# lock authority — Track B of `distributed-coordination-shared-harness-2026-06-04`

The per-harness **lock authority**: the single point that serializes contended
control operations (file-claim locks, plan-item claim leases) across the machines
in a shared harness, so a mutual-exclusion grant never split-brains over the
eventually-consistent peer-log.

## Import surface

```ts
import {
  lockAuthorityFor,   // (harnessSlug) => { isSelf, peer?, liveCount }
  routeToAuthority,   // (harnessSlug, { local, remote? }) => { value, via, warning? }
  routeFileLockOp,    // file-claim scope-guarded routing (D-009)
  setPeerRpcTransport,// inject the wire transport when one exists
} from '@papercusp/operator-core/lib/authority';
```

## How the authority is chosen (D-005)

Not an election — a **deterministic function of live swarm membership**. The
authority for a harness is the peer with the **lowest live `device_pubkey`**
among the harness's `shared_presence` rows whose `last_seen_at` is within the
staleness window (`DEFAULT_AUTHORITY_STALE_MS = 90s`, the hysteresis knob). Every
peer computes this independently from the already-federated presence roster, so:

- No election round-trip, no leader-lease CAS race.
- **Failover is automatic**: when the current authority's heartbeat goes stale,
  the next-lowest live peer *is* the authority by definition. In-flight callers
  just re-resolve.
- Self is always a candidate (via `resolveUsageActor()`), even before this
  machine publishes its own presence row.

Edge case — **single box / no swarm**: zero live peers and no self identity →
`{ isSelf: true, liveCount: 0 }`. You are alone; you are the authority. This is
the current dev-box reality (one shared `papercusp_su`, PG advisory lock already
serializes).

## Routing + fail-open (D-004)

`routeToAuthority(harnessSlug, op)`:

| Situation | Behavior | `via` |
|---|---|---|
| We are the authority | run `op.local()` | `local-authority` |
| Remote authority, transport + `op.remote` present | RPC to the authority | `remote-authority` |
| Remote authority, unreachable / no transport / no `op.remote` | **fail open**: run `op.local()` + return a `warning` | `fail-open` |

Fail-open is **correct, not a compromise**: a shared harness is a git repo kept
in sync by git-sync with a merge-resolver, so concurrent edits are already
reconciled — git protects the data. Distributed locks only reduce merge churn.
Never block on an unreachable peer.

For su-119ce's plan-item claim leasing, wrap each claim op:

```ts
const { value, via, warning } = await routeToAuthority(harnessSlug, {
  local: () => claimStore.lease(/* … */),
  // when a transport lands, also pass `remote` so the authority leases on your behalf:
  // remote: { kind: 'claim.lease', payload: {...}, decode: raw => raw as LeaseResult },
});
if (warning) /* surface it */;
```

Until a transport exists, `remote` can be omitted entirely: on a single box
`isSelf` is always true (direct local lease); cross-machine it fails open to a
local lease + warning. Zero changes to your store when the transport lands.

## The RPC wire-leg is a seam (`peer-rpc-transport.ts`)

There is **no peer-to-peer request/response transport in the tree yet** — the
Hyperswarm substrate replicates append-only data, it is not RPC. So the remote
leg goes through a pluggable `PeerRpcTransport`. The default
(`NULL_PEER_RPC_TRANSPORT`) reports every peer unreachable → fail-open. When a
real transport lands (HTTP to the authority's `:3070` over the mesh, or an RPC
channel over the existing Hyperswarm connection), register it once:

```ts
setPeerRpcTransport(myTransport); // remote routing activates, callers unchanged
```

A transport MUST throw `PeerUnreachableError` (not a generic error) when it can't
reach the peer, so routing fails open rather than surfacing a hard error.

## The failure detector is a generic lib (`@papercusp/failure-detector`)

The signal that decides **when** a peer is stale enough to lose its authority /
have its lease revoked is φ-accrual + SWIM indirect probing. Those are pure,
domain-free algorithms, so they live in `@papercusp/failure-detector`
(`libs/generic/failure-detector`), not here — extracted from
`authority/{phi-accrual,swim-probe}.ts` by
`generalize-libs-to-generic-2026-06-05` (row #2). When the cutover wires
eviction, import them and bind this module's `PeerRef` as the label:

```ts
import { PhiAccrualDetector, indirectProbe, decideEviction } from '@papercusp/failure-detector';

const result = await indirectProbe(target, relays, myRelayProbe, {
  label: (p: PeerRef) => p.machineLabel || p.devicePubkey.slice(0, 8),
});
const { evict } = decideEviction(detector.phi(now), result);
```

The relay-probe transport is the same seam as `peer-rpc-transport.ts` above:
until a real P2P RPC channel lands, no relay can confirm a peer alive, so
eviction degrades to the bare φ signal (fail-open, D-004).

## File-claim scope guard (D-009) — `routeFileLockOp`

ONLY file-claim / repo-root (`coordination_domain`) locks route to the authority
— they guard concurrent edits to the SHARED repo's files. NAMED-RESOURCE locks
(`dev-server`, `db-schema`, `shop`, …) guard MACHINE-LOCAL resources (each user
runs their own dev-server / embedded-pg) and **stay local** — they never call
`routeFileLockOp`.

`routeFileLockOp(domain, op)` maps the lock's `coordination_domain` (the repo
realpath) to a harness via an injectable resolver
(`configureFileLockDomainResolver`), then delegates to `routeToAuthority`. The
default resolver returns `null` (no federated harness) → run locally.

## Why a no-op today, load-bearing tomorrow

The shipping product is a desktop app backed by **embedded Postgres per machine**
(CLAUDE.md "Database topology"). Each machine then has its OWN `papercusp_su` lock
store, so a file-claim lock on a shared file genuinely needs a cross-machine
serialization point — the authority. On the current single shared-PG dev box
there is one `papercusp_su` and the PG advisory lock already serializes, so the
authority resolves to `isSelf` and routing is a direct local call. Correct in
both worlds.

## Cross-machine cutover (what lights this up)

1. **Inject a `PeerRpcTransport`** (HTTP-over-mesh or Hyperswarm RPC) at boot via
   `setPeerRpcTransport`. The authority side exposes an endpoint that runs the
   serialized lock/claim op against its local `papercusp_su` and returns the
   result. (Handover, D-005: on becoming authority, a peer rebuilds its lock set
   from holders' re-asserted TTL heartbeats within one heartbeat interval; the
   brief gap is fail-open. The optional append-only lock-event stream on the
   peer-log — for instant reconstruction — is the deferred enhancement.)
2. **Wire `locks:acquire`/`release`/`queue`** (the file-claim handlers in
   `packages/operator-core/lib/agent-tools/locks/`) to route through
   `routeFileLockOp` instead of calling the store directly. NOT done this session:
   on the single box it would add a `shared_presence` query to the per-edit lock
   hook for zero functional change — a regression risk on the fleet's most
   safety-critical path. Add a cheap "any remote peers for this harness?" cache so
   the common (no-peers) case stays near-zero-cost before flipping it on.
3. **Register the domain→harness mapping** via
   `configureFileLockDomainResolver` from the harness registry (each managed
   harness's checkout realpath → its slug).

## Tests

- `__tests__/lock-authority.test.ts` — 18 pure unit tests: argmin / isSelf /
  empty-set / dedup / staleness failover; routing local / remote / fail-open /
  rethrow; file-lock scope guard.
- `__tests__/lock-authority.integration.test.ts` — 5 tests against a real
  Postgres `shared_presence` table: the canonical query, argmin selection,
  remote-authority, staleness failover, empty-presence.
