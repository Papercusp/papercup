# DESIGN — Per-fleet selective federation scope (P-006)

**Plan:** `p2p-work-distribution-2026-07-02` · **Item:** P-006 (X10/H16/X3b) · **Author:** su-c88ac (lane C) · **Date:** 2026-07-02
**Status:** PROPOSAL — awaiting leader ratification (decisions FS-D1..FS-D6 below). No build until ratified.
**Consumers:** P-101 offers · P-108 results channel option (b) · P-206 capacity ads · future scout-gym work-shaped rows · P-303 push-nudges.

---

## 1. Problem

The substrate today has exactly two federation granularities:

- **hive-wide** — every hive-scoped row replicates to every member (per-peer hypercore
  logs, all admitted on the one hive swarm topic; git device-namespaces fetched by all).
- **machine-local** — the row never leaves the box (`coord:send { scope: 'local' }`).

P2P work distribution needs a third: **fleet-scoped** — offers, results-ref visibility,
capacity ads must reach **opted-in fleet members only**. The audit findings this design
answers:

- **H16 (flood):** receiver-side filtering still ships every fleet's rows to every hive
  member — a busy fleet floods the whole hive's replication + storage.
- **M14 (leak):** non-opted-in hosts still **store** other fleets' rows (presence labels,
  offer contents). Filtering at read time doesn't fix storage.
- **X3b:** P-108's results channel option (b) needs "per-fleet ref visibility" on the
  hive-git plane — a replication class that does not exist today.
- **X10:** H16's "offers ride per-fleet scopes" *assumed* this primitive; it must be
  designed once, as a named substrate primitive, not three ad-hoc versions.

Non-goals: cross-hive federation (the scope lives INSIDE one hive's swarm); poison
screening; economics (P-2xx). Receiver-side row filtering is **rejected by the item text
itself** and not re-litigated here.

## 2. Substrate today (verified against live code)

**Bee/table-op plane** (`packages/operator-core/lib/sync/hyperbee/`):

- One **per-peer single-writer hypercore log** (`peer-log.ts`); ops are
  `{ type, table, hbKey, value, ts, schema_version, author_pubkey, hlc?, epoch? }`.
- All members join **one swarm topic** derived from the hive pubkey
  (`derive-swarm-topic.ts`, `hive:<pubkey>` binding).
- On connect, peers exchange a **signed announce** binding device identity → log core key
  (`announce.ts`: `{ device_pubkey, github_user_id, attestation_gist_id, log_core_key,
  harness_slug?, ts, nonce?, sig }`). Optional fields are **additive + covered by the sig**
  (the `harness_slug` A-003 precedent) — the receive-side (boot.ts `onAnnounce`) admits a
  log iff identity verifies AND the frame is in scope for a local projection.
- **Hive-epoch crypto** (`hive-epoch-crypto.ts`): per-epoch symmetric content key, fresh
  per epoch, wrapped to each remaining member's device key; a removed peer keeps
  ciphertext bytes but cannot decrypt post-boundary content. Ops carry `epoch` on the wire.
- **Receiver-side per-op gates exist** on the merge path (`comms-tier-gate.ts`: device →
  attested numeric `github_user_id` → tier, TTL-cached; `rate-limit-admission.ts`).

**Git plane** (`packages/operator-core/lib/sync/hive-git/`):

- Per-hive **bare repo**, per-device **ref namespaces** (`refs/namespaces/<hex>/…`)
  authenticated by **sigrefs**; fetch = real git protocol v2 over a **per-fetch Protomux
  sub-stream** on the same hive swarm connection (`fetch-transport.ts`); serving is
  guarded to repos **inside the hive-git root** (`assertServeableRepo`); the
  `(hive, repo) → path` map already exists (`storage.hiveGitRepoPath`).
- Ref changes propagate by a signed **ref-announce** on the federated events rail
  (`events:emit { scope: 'hive' }`) with per-device fetch budgets.

Key physics used below: **a hypercore is capability-addressed** — a peer that never
learns a core's key cannot request it, and corestore replication only carries cores both
sides have added. Disclosure of the core key IS the replication grant.

## 3. The primitive: `FederationScope`

A **FederationScope** is a named replication unit *inside* a hive, smaller than the hive:

```
scope_id  := 'fleet:' <owner_github_user_id> '/' <fleet_slug>     (X9: numeric id; H5: owner-prefixed)
           | 'hive'          (today's behavior — the default, unchanged)
           | 'local'         (never federates — already exists on coord:send)
```

- **Roster:** the set of (numeric github_user_id → attested device_pubkeys) currently
  opted in to the scope. Derived from the P-101 fleet directory + the host's opt-in rows;
  **epoch-versioned** (X6): every roster mutation advances `scope_epoch` monotonically.
  Grants/opt-ins are keyed by numeric user id; devices resolve ONLY through attestations
  (the `comms-tier-gate.ts` device→user resolution, reused).
- **Guarantee (the contract consumers program against):**
  1. *Storage scoping* — a non-member host never stores scope rows (not even ciphertext),
     absent a deliberate key leak by a member.
  2. *Read scoping* — even a host that somehow obtains scope bytes cannot read content
     sealed after its removal boundary (crypto cut, X6-aligned).
  3. *Loud refusal* — a non-member's request for a scoped unit is refused with a P-004
     receipt + counter, never silently dropped.
  4. *No new transport* — scopes ride the existing hive swarm connections and the
     existing announce/fetch rails.

## 4. Options considered

| # | Option | Verdict |
|---|--------|---------|
| O1 | **Receiver-side filtering** (rows replicate hive-wide, receivers drop) | ❌ Rejected by the item: re-opens H16 flood; M14 storage leak remains. |
| O2 | **Crypto-only scoping** (rows on the existing hive-wide logs, sealed per-fleet) | ❌ as primary: non-members still STORE + relay ciphertext (H16 flood + the storage half of M14); metadata (table, row count, sizes, authorship, timing) leaks. ✅ as a LAYER of O4. |
| O3 | **Per-scope swarm topic** (each fleet its own DHT topic + connection mesh) | ❌ Heavyweight: per-fleet DHT announces, duplicate connection meshes between the same peers, a second boot/backfill path — buys nothing over O4 inside one hive, where members already share authenticated connections. Right shape for CROSS-hive fleets someday (P-3xx), not for v1. |
| O4 | **Scoped log cores + disclosure-gated announce + serve-side roster gate + per-scope epoch crypto** | ✅ **CHOSEN** — mechanism below. |

## 5. Mechanism — bee/table-op plane

### 5.1 Scoped log cores (the replication unit)

Each peer's corestore gains one additional writable log **per scope it participates in**:

```
store.get({ name: `peer-log:scope:${scope_id}`, valueEncoding: 'json' })
```

Same `PeerLogOp` envelope, same HLC stamping, same projection machinery. Fleet-scoped
tables (`p2p_work_offers`, `p2p_capacity_ads`, results-ref pointers, scout-gym rows)
write their ops to the scope log instead of the main log; everything else is untouched.
The main hive log and today's behavior are the `scope_id = 'hive'` degenerate case —
**zero change to existing tables**.

### 5.2 Disclosure-gated announce (capability layer)

Extend `AnnounceBody` with an **additive, sig-covered, optional** field (the exact
`harness_slug` A-003 precedent):

```ts
/** Scoped-log declarations, disclosed per-connection to scope members only. */
scoped_logs?: Array<{ scope_id: string; log_core_key: string; scope_epoch: number }>;
```

The sender builds the announce **per connection**: after verifying the remote's announce
(device → attested numeric user id — already done on every connect), it includes only the
`scoped_logs` entries whose roster contains that peer. A non-member never learns the
core key → never requests → never stores. **This is sender-side scoping, not receiver
filtering** — the H16/M14 fix lives at the source.

Receive side (boot.ts `onAnnounce`): a scoped entry is admitted iff (a) identity verifies
(unchanged), (b) **self is in the scope roster** (else refuse + P-004 counter — a peer
disclosing a scope we didn't opt into is a protocol error, loud not silent), (c) a
projection is registered for the scope's tables.

### 5.3 Serve-side roster gate (belt-and-braces)

Capability-by-disclosure fails open if a core key leaks (any member can leak it; hypercore
serves whoever proves key knowledge). So the replication wiring additionally refuses to
serve a scoped core on a connection whose verified identity is not in the scope's
**current** roster — checked at stream-open time against a **cache-bypassing** roster read
(C6: enforcement reads bypass cache tiers). Refusal emits a P-004 receipt naming the scope
+ missing membership.

### 5.4 Per-scope epoch crypto (read cut on revocation)

Reuse the `HiveEpochCrypto` seam **generalized from (hive, epoch) to (scope, epoch)** —
the interface already takes `(hiveId, epoch)`; scope keying is `(hiveId + scope_id,
scope_epoch)` with zero interface change. Scope-content ops seal under the scope-epoch
key; the wrapped-key distribution rides the same `hive_epoch_keys`-shaped row family,
wrapped to **scope members'** device keys only.

**Membership boundary = scope-epoch advance** (leave/revoke/downgrade): fresh key, wrapped
to remaining members; the removed member replicates nothing new (5.2 stops disclosing,
5.3 stops serving) and cannot read anything sealed post-boundary even from bytes obtained
via a leaked key. Epochs are the revocation gate — wall-clock never is (X6).

### 5.5 Roster churn, backfill, flood

- **Join:** opt-in lands → roster + scope_epoch advance → peers' next announces disclose
  the scope logs → the joiner backfills scope cores from length 0 (scope logs are young
  and small; offers/ads have TTLs — H16 — so history is bounded; a `backfill-local-state`
  style floor can skip expired ranges later if needed).
- **Leave/revoke:** roster shrinks + epoch advances + rekey (5.4). Old bytes already
  stored on the departed host are un-erasable (same truth as hive rekey; documented, not
  pretended away). In-flight foreign work winds down per P-106/M16 — not this primitive's
  job.
- **Flood control:** per-scope instances of the existing `rate-limit-admission` +
  publisher-side caps (P-101/P-107). The primitive bounds the BLAST RADIUS to the scope
  roster; the caps bound volume within it.

### 5.6 Projection + PG

Scoped ops project through the existing fanout-projection path; scope tables register
projections like any table. The hive-home workspace resolution MUST use the shared
resolver + the C3 regression test (write/capture/drain agree — WI-1564 class). Scoped
rows carry `scope_id` as a column so local reads/UI can distinguish provenance, but the
column is **informational**: enforcement happened at replication time, never by
row-filtering readers (that would be O1).

## 6. Mechanism — git plane (what P-108(b) consumes)

**Per-scope bare repo**, NOT ref-filtering inside the hive repo:

```
<hive-git-root>/<hive>/scopes/<scope_id>/repo.git
```

- Reuses `storage.hiveGitRepoPath`-style mapping + `assertServeableRepo` (the guard
  already refuses anything outside the hive-git root) + `fetch-transport.ts` **unchanged**
  (it is already parameterized by repo path; a scoped fetch is just a fetch of a different
  repo over the same Protomux channel family).
- **Serve gate:** before `serveUploadPack` on a scope repo, the server resolves the
  requesting connection's verified device → numeric user id → scope roster (5.3's check,
  same code path). Non-member → refuse + P-004 receipt. This is exactly the "per-fleet
  ref visibility" X3(b) asks for, delivered at repo granularity where git's own transport
  can't leak sibling refs (upload-pack inside one repo advertises that repo's refs only —
  no `hideRefs` fragility, no namespace-wide advertisement to filter).
- **Sigrefs:** the executor's sigrefs for scope-repo refs live in the scope repo itself
  (per-device namespaces inside the scope repo, same G-4 machinery) — sigref semantics
  gain the C8 executor-not-author distinction ONLY here, not in the hive-wide plane.
- **Ref-announce:** scoped ref-announces ride the same signed envelope but on a scoped
  event key (`hive-git:ref-announce:scope:<scope_id>`), delivered to scope members
  (P-303's nudge machinery is the same rail). Budgets per device apply unchanged.
- **GC:** scope repos are independently GC-able and DELETABLE when a fleet archives
  (H10) — canonical history is never entangled with foreign work products. (X4 composes:
  foreign clones push INTO the scope repo; the size/blob-cap admission at push is P-108's
  item, the repo unit is this design's.)

## 7. Consumer mapping

| Consumer | What it does with the primitive |
|---|---|
| P-101 offers | `p2p_work_offers` rows ride `fleet:<owner>/<slug>` scope logs; publisher caps + TTLs per H16. |
| P-108 results (b) | results refs live in the scope repo (§6); completion receipt references ref + execution epoch (H9). |
| P-206 capacity ads | `p2p_capacity_ads` rows on the scope log; advisory, TTL'd. |
| Scout-gym rows | future work-shaped rows declare a scope at table-registration time. |
| P-303 nudges | scoped event keys on the events rail (§6 ref-announce shape). |

## 8. Acceptance criteria (feed LIVE-2 legs)

1. Two-member fleet inside a 3-member hive: the third (non-opted-in) host's corestore
   **never contains** the scope core (assert by discovery-key absence), and its PG never
   holds a scope row. (M14/H16 leg.)
2. Non-member requests the scope core / scope repo by key (simulated leak): serve
   **refused + receipt + counter**, origin-observable. (P-004 leg.)
3. Revoked member: scope-epoch advances; post-boundary ops undecryptable by the removed
   device; its next fetch attempt refused. Epoch-gated, no wall-clock in the path. (X6 leg.)
4. Scoped git fetch by a member succeeds over the existing swarm connection; the hive-wide
   repo's replication is byte-identical to a no-fleet run (no cross-contamination).
5. C3 regression: scope-table write/capture/drain agree on the hive-home workspace.

## 9. Cost + build shape (for pricing, not building yet)

Real work, in rough dependency order: announce extension + per-connection disclosure
(5.2) → scoped core open/admission + projection registration (5.1, 5.6) → serve-side
roster gate shared by both planes (5.3/§6) → scope-epoch generalization of the rekey seam
(5.4) → scope repos + scoped ref-announce (§6). Roster derivation depends on P-101's
directory schema (co-design the roster read with lane A's P-001 grants shapes — same
numeric-id + epoch discipline). Estimated as the substrate half of Phase 1; the O4 pieces
reuse landed machinery at every layer (announce sig plumbing, corestore, rekey seam,
fetch transport, tier-gate resolution, rate-limit-admission).

## 10. Decisions proposed for ratification

- **FS-D1** — The primitive is **O4**: per-scope log cores + disclosure-gated announce +
  serve-side roster gate + per-scope epoch crypto. O1/O2/O3 rejected (§4).
- **FS-D2** — `scope_id = fleet:<numeric-gh-user-id>/<slug>`; rosters keyed numeric,
  epoch-versioned; devices resolve only via attestations (X9/X6).
- **FS-D3** — Git plane = **per-scope bare repos** under the hive-git root with a serve
  gate; NOT hideRefs/namespace filtering in the hive repo (§6). This is the P-108(b)
  mechanism.
- **FS-D4** — Membership boundary ⇒ scope-epoch advance + rekey, reusing the
  `HiveEpochCrypto` seam keyed `(hive+scope, scope_epoch)` (5.4).
- **FS-D5** — Rollout: tier 1 (same-owner machines, P-005) may ship with 5.2+5.3 and
  **defer 5.4 per-scope crypto** (same-owner ⇒ no adversarial member); 5.4 becomes a
  **hard gate for tier 2** alongside X1's loopback boundary. Structural inertness — no
  dark flag needed.
- **FS-D6** — Enforcement reads (roster at serve/disclose time) bypass cache tiers (C6);
  refusals are receipted per P-004 taxonomy (M15: unauthenticated → counters,
  authenticated → receipts).
