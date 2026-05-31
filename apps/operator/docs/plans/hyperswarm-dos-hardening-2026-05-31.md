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

## Cross-references
- `papercusp-trust-model-2026-05-31` §12 — anti-flood funnel + the recorded gap (canonical design rationale).
- `apps/operator/lib/sync/hyperbee/swarm.ts` — `getSharedSwarm()` (Phase 1/2 constructor opts + firewall) + `joinHarnessSwarm` connection handler (Phase 2 PeerInfo, Phase 3 conn rate-limit).
- The substrate read-loop / `applyHyperbeeOpToPg` — Phase 4 per-writer op/byte rate-limit.
- `apps/operator/lib/auth-rate-limit.ts` + `@papercusp/rate-limit` — the limiter to reuse.
- `boot-history.ts` + `/admin/dogfood-substrate` — Phase 5 observability surface.
