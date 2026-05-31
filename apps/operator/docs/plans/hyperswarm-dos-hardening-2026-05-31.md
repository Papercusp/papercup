---
title: Hyperswarm DoS / abuse hardening — connection caps, firewall ban-gate, flood rate-limits
slug: hyperswarm-dos-hardening-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
owner: aviynw3@gmail.com
---

# Hyperswarm DoS / abuse hardening — connection caps, firewall ban-gate, flood rate-limits

## Now

**State:** Ready for review. The substrate joins Hyperswarm with **zero**
DoS protection — `lib/sync/hyperbee/swarm.ts` does `new Swarm()` with no
options and its `connection` handler replicates to **every** peer
unconditionally (it doesn't even read the `info`/publicKey second arg). No
connection caps, no `firewall`, no `ban`, no rate-limits. This is the gap
recorded in `papercusp-trust-model-2026-05-31` §12 ("Anti-flood / DDoS — the
funnel (and a current gap)"). It is **independent of the per-op-authentication
trust model** and needed regardless: the trust model decides *who may write*;
this decides *how much any connected peer can consume*.

**Next:** greenlight Phase 1 (built-in connection caps — no policy decisions),
then proceed through the firewall ban-gate + rate-limits.

## Background

### The gap (verified 2026-05-31)
`swarm.ts`:
- `getSharedSwarm()` → `new Swarm()` — no `maxPeers` / `maxClientConnections` /
  `maxServerConnections` / `firewall`. An attacker who derives the (public,
  topic-hash-discoverable) topic can open unbounded connections.
- The `connection` handler is `(socket) => { … replicate … }` — the second
  arg (`PeerInfo`, carrying the remote Noise `publicKey`) is **ignored**, so
  there is no per-peer identity to rate-limit, ban, or even log. Every peer is
  replicated to immediately.
- The code comment concedes it: *"Diagnostic counters could be added here
  later."* They were not.

### Why this is independent of the security plan
Holepunch gives **mechanism, not policy**. Connection limits + a `firewall`
hook + per-peer `ban` are *built into* Hyperswarm; per-writer op-rate-limiting
is *ours* (Autobase delegates per-op handling to the apply handler). None of
this requires deciding the per-op-authentication / writer-admission question:

- The trust model (separate, under design) decides **who may write** —
  op-signature verification + `addWriter` admission tied to GitHub identity.
- This plan decides **how much any connected peer can consume** — total
  connection ceiling, per-peer connection rate, per-writer op/byte rate.

They share **two seams**: the `firewall(remotePublicKey)` hook and the
Hyperbee→PG **projection apply-handler**. This plan builds both as
**policy-injectable** (a predicate / a pre-filter) so the security layer later
composes its allow-list / signature-check into the *same* seams. Neither blocks
the other; this lands first.

### Reuse
- `@papercusp/rate-limit` (`libs/generic/rate-limit`) + the existing
  `apps/operator/lib/auth-rate-limit.ts` pattern — do not write a new limiter.
- Existing boot-history event surface (`boot-history.ts`,
  `/admin/dogfood-substrate`) for observability.

## Phase 1 — Built-in connection caps (pure resource ceiling, no policy)

- **P-001** `todo` Pass `maxPeers` / `maxClientConnections` / `maxServerConnections`
  to the Hyperswarm constructor in `getSharedSwarm()` (`swarm.ts`). Env-overridable
  (`PAPERCUSP_SWARM_MAX_PEERS`, …) with conservative defaults. No trust decision —
  a hard ceiling on concurrent connections so one attacker can't exhaust sockets/FDs.
  Acceptance: the swarm factory receives the caps; unit-test via the injected
  factory recording the opts (no network).
- **P-002** `todo` Surface `PeerInfo` in the `connection` handler — read the
  ignored second arg, extract `remotePublicKey`, thread it to `onPeerConnected(key)`
  and the rate-limit/ban path. Prerequisite for everything per-peer.
  Acceptance: the handler receives + logs the remote key; `joinHarnessSwarm` unit
  test asserts the key reaches `onPeerConnected`.

## Phase 2 — Firewall ban-gate (DoS bans, NOT GitHub admission)

- **P-003** `todo` Add a `firewall(remotePublicKey)` hook to the Hyperswarm
  constructor backed by a runtime ban-list (TTL map of banned keys); return `true`
  (deny) for a banned key — Hyperswarm drops it pre-handshake. Build the hook to take
  an **injected predicate** so the security layer can later compose a GitHub-collaborator
  allow-list into the same hook (this plan only supplies the DoS ban-list). blocked-by: P-002
  Acceptance: a banned key is rejected at connect; unit-test the firewall predicate.
- **P-004** `todo` Ban-on-abuse wiring: when a peer trips a limiter (Phase 3/4),
  add its key to the ban-list with a TTL cooldown (auto-unban) + call `PeerInfo.ban()`
  to drop the live connection. blocked-by: P-003
  Acceptance: a flooding peer is banned for the cooldown, then allowed back after TTL.

## Phase 3 — Per-peer connection rate-limiting (ours)

- **P-005** `todo` Per-remote-key connection-rate limiter via `@papercusp/rate-limit`:
  more than N connects per window from one key → add it to the ban-list (P-004) for a
  cooldown. Stops reconnect/churn storms that slip under the static cap. blocked-by: P-004
  Acceptance: a key opening > N connects/window is temp-banned; unit-test the limiter
  with an injected clock.

## Phase 4 — Per-writer op/byte flood rate-limiting at the projection (ours)

- **P-006** `todo` At the Hyperbee→PG apply/projection (`applyHyperbeeOpToPg` / the
  substrate read-loop), cap ops/sec + bytes/sec **per writer-key**; over-limit → drop the
  op + log + optionally feed the ban-list. Bounds the flood-into-log/PG even from an
  admitted peer (memo §12: "per-writer op-rate-limiting is ours"). Build the rate-limit as
  a **separable pre-filter** so the security layer's per-op signature check composes at the
  same point. blocked-by: P-002
  Acceptance: a writer exceeding the op/byte budget has excess ops dropped + counted; the
  honest writers' ops still apply; unit-test the per-writer limiter.

## Phase 5 — Observability

- **P-007** `todo` Emit `peer_rejected` / `peer_banned` / `rate_limited` boot-history
  events (alongside the existing `peer_connected`) and surface the counts on
  `/admin/dogfood-substrate`. blocked-by: P-003
  Acceptance: a banned / rate-limited peer appears in `boot_history` + the substrate
  dashboard shows the running counts.

## Decisions

### D-001 — DoS hardening is independent of, and lands before, the per-op-auth trust model
Date: 2026-05-31
The trust model decides **who may write** (op-signing + `addWriter` admission tied
to GitHub identity); this plan decides **how much any connected peer can consume**
(connection caps + per-peer/per-writer rate-limits). They share two seams — the
`firewall(remotePublicKey)` hook (Phase 2) and the projection apply-handler (Phase 4)
— so both are built **policy-injectable** (an injected predicate / a separable
pre-filter) and the security layer composes its allow-list / signature check into the
*same* seams later. Neither plan blocks the other; this one ships first because resource
exhaustion is exploitable today, with or without forged-op authentication.

### D-002 — Mechanism is built-in; policy is ours; reuse the existing limiter
Date: 2026-05-31
Connection caps, the `firewall` hook, and per-peer `ban` are built into Hyperswarm —
wire them, don't reinvent. Per-writer op/byte rate-limiting is ours because Autobase
delegates per-op handling to the apply handler (no built-in op-rate limit). Reuse
`@papercusp/rate-limit` + the `auth-rate-limit.ts` pattern rather than authoring a new
limiter, with injected clocks so the limits are deterministically unit-testable.


### D-003 — Prior-art check (Hyperswarm built-ins + libp2p) — three corrections to the items
Date: 2026-05-31
Web research (2026-05-31) against the Hyperswarm README + libp2p's DoS-mitigation guidance confirms the plan's shape is right but corrects three specifics:

**What Hyperswarm actually gives (built-in, "use what's there"):** `maxPeers` (total connection cap, default unlimited); `firewall(remotePublicKey) => bool` (reject pre-handshake, default allow-all; the handshake payload also carries the remote IP); the `connection` event's second arg `PeerInfo` with `.publicKey` (Noise key) + `.ban(bool)`. NOT built in: per-IP/per-peer connection rate-limiting, op-rate-limiting, or resource scopes — so Phases 3-4 ("ours") are correctly ours.

**Correction 1 (P-001):** `maxClientConnections`/`maxServerConnections` are NOT documented Hyperswarm constructor options (they exist on the DHT server / @hyperswarm/seeders, not the swarm). Use **`maxPeers`** as the documented hard cap; drop the client/server-split claim.

**Correction 2 (P-004):** `PeerInfo.ban(true)` prevents *future reconnection* but explicitly **does NOT close the existing connection** ("Banning will prevent any future reconnection attempts, but it will not close any existing connections"). To drop a live flooder immediately we must ALSO `socket.destroy()` — ban() alone is insufficient.

**Correction 3 (P-005):** rate-limit on the **remote IP** (exposed in the firewall's handshake payload), not just the Noise `publicKey`. Noise keys are free to generate, so a Sybil flooder rotates keys to evade per-key limits; libp2p rate-limits per-IP/subnet for exactly this reason (go-libp2p default: ~1 conn / 5s / IP, burst 16). Per-key is still useful for ban-targeting, but the rate axis should be IP/subnet.

**Layered-backstop note (matches libp2p philosophy):** per-IP and per-key limits are speed-bumps — NAT/CGNAT shares IPs and keys rotate. The real backstops are the hard `maxPeers` cap (bounds concurrency regardless of identity) and the per-writer op/byte limit at the projection (P-006, bounds *damage* regardless of identity). libp2p's analogues: ConnManager high/low-watermark trimming, the per-peer resource scope (memory/FD/inbound-conn), and ConnectionGater.InterceptAccept (= Hyperswarm's `firewall`).

Sources: github.com/holepunchto/hyperswarm README; npmjs.com/package/hyperswarm; docs.libp2p.io/concepts/security/dos-mitigation; libp2p.io go-libp2p v0.42 release notes (per-IP rate limiting); github.com/holepunchto/autobase README (apply `interrupt` is the only built-in escape hatch — no op-rate-limit).
Related: P-001, P-004, P-005


### D-004 — Library vs roll-our-own: reuse @papercusp/rate-limit; no 3rd-party dep; in-memory store for the swarm path
Date: 2026-05-31
Evaluated (web research 2026-05-31): (a) a Hyperswarm-specific rate-limit/DoS wrapper, (b) a 3rd-party rate-limit lib (rate-limiter-flexible).

**(a) No Hyperswarm wrapper exists.** There is no npm package that wraps Hyperswarm with rate-limiting / firewall / ban glue — confirmed by search. So the Hyperswarm-specific work (firewall predicate, TTL ban-list, `socket.destroy()` on live flooders, the per-writer op/byte limit at the Autobase→PG projection) is **bespoke no matter what** — no library removes it.

**(b) Don't add a 3rd-party rate-limit lib.** The rate-limit *algorithm* is the easy, well-understood part, and we already own it: `@papercusp/rate-limit` provides windowed soft+hard buckets with `lockedUntilMs` (block/cooldown built in) and a **pluggable `BucketStore`** — i.e. exactly the "N events/window → block for cooldown" pattern P-004/P-005 need, already extracted + tested + in production via `auth-rate-limit.ts`. `rate-limiter-flexible` (the leading 3rd-party) offers the same surface (per-key consume, `blockDuration`, swappable stores) — it would **overlap @papercusp/rate-limit entirely** while adding a dependency + a second rate-limit abstraction + supply-chain/maintenance surface, for ~zero reduction in the bespoke glue. Net negative. ("Roll our own" was never the choice — reuse the in-house primitive is.)

**Implementation refinement (the one real adjustment):** the swarm connection-rate path (P-005) and the per-writer op path (P-006) are **high-frequency + ephemeral** — they must NOT use the PG-backed `BucketStore` that `auth-rate-limit` uses (auth is low-frequency + durable). Implement a small **in-memory `BucketStore`** (a `Map` + TTL) behind the same `@papercusp/rate-limit` interface, so a connection flood causes zero PG writes. This is consistent with libp2p's design (its per-IP connection limiter is in-process, not durable).

Conclusion: reuse `@papercusp/rate-limit` + a new in-memory `BucketStore`; no new third-party dependency; the Hyperswarm glue stays ours because nothing provides it. Reinforces D-002.

Sources: npmjs.com/package/rate-limiter-flexible; npmjs.com/package/hyperswarm (no built-in/wrapper); the @papercusp/rate-limit source (libs/generic/rate-limit) + apps/operator/lib/auth-rate-limit.ts.
Related: P-005, P-006

## Cross-references
- `papercusp-trust-model-2026-05-31` §12 — anti-flood funnel + the recorded gap (canonical design rationale).
- `apps/operator/lib/sync/hyperbee/swarm.ts` — `getSharedSwarm()` (Phase 1/2 constructor opts + firewall) + `joinHarnessSwarm` connection handler (Phase 2 PeerInfo, Phase 3 conn rate-limit).
- The substrate read-loop / `applyHyperbeeOpToPg` — Phase 4 per-writer op/byte rate-limit.
- `apps/operator/lib/auth-rate-limit.ts` + `@papercusp/rate-limit` — the limiter to reuse.
- `boot-history.ts` + `/admin/dogfood-substrate` — Phase 5 observability surface.
