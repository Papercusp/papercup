# Packaged two-instance federation merge — the write-free unlock + the same-box DHT ceiling
URL: /internal/docs/agent-insights/packaged-two-instance-federation-merge

How to prove a real federation MERGE between two SEPARATELY-PACKAGED desktop instances on one box: write-free join lets a synthetic repo id publish a binding (A3), but same-box public-DHT discovery fails (NAT hairpinning) and silent swarm-join failures hid it. The PAPERCUSP_DHT_BOOTSTRAP override + [swarm] logs + the merge smoke.

import { Aside } from '@astrojs/starlight/components';

The in-process [`p079-live-federation.live.test.ts`](/internal/docs/testing/p079-bidirectional-federation)
proves the write-free admission *logic* with two real identities over a testnet
DHT. The remaining acceptance is the **packaged** version: two separately-built
`.deb` desktop processes on one box federating a real write. Here's what's true,
what blocks it, and the harness.

## What write-free join unlocked (verified in the packaged app)

The old `papercusp-desktop/bin/two-instance-federation-smoke.sh` header says the
MERGE is *"admission-gated on real GitHub bindings; a synthetic repo id can't
publish a binding → no merge."* **That ceiling is gone.** After the write-free
join (`non-collaborator-join-fork-pr-2026-06-02`, "A3"), admission proves the
`device_pubkey ↔ github_user_id` binding from the announced **attestation gist**

* signed announce — not a contributor file written to the shared repo. So the
  `github_repository_id` is just a **swarm-topic seed**; each peer self-publishes
  its own gist.

Verified live: two packaged instances (distinct identities `papercupai` +
`aviynw` via per-instance `GH_TOKEN`), each `POST /api/harness/:slug/share/finalize`
with the SAME **synthetic** repo id, both return `bindingPublished: true` and
`swarm: { state: "booted" }`. The federating write itself works too: a direct
`INSERT … origin='local'` into `harness_shared.harness_features_consolidated`
fires the migration-102 capture trigger → `substrate_outbox`.

## Why a same-box merge still doesn't "just work"

Two failure modes, both **packaged-runtime / infra — not the federation logic**:

1. **Same-box discovery over the public DHT fails (NAT hairpinning).** Two
   Hyperswarm instances on one machine must holepunch to their own public IP,
   which most routers/clouds drop. This is *exactly* why the in-process p079 test
   uses `hyperdht/testnet` instead of the public DHT.
2. **Silent swarm-join failures were invisible.** `bootHarnessSubstrate`'s
   swarm-join `try/catch` recorded `swarm_join_failed` only to **in-memory**
   boot-history (no stdout, and `GET /api/admin/dogfood-substrate-boot-history`
   is trust-gated) — so an identity/keychain/announce failure left the harness
   silently local-only with zero observable signal.

A harness that "booted" (`state:"booted"`, `bindingPublished:true`) is **not**
necessarily swarm-joined. The reboot boots PG state; the actual Hyperswarm join
can still fail-closed silently. Always check the `[swarm]` log lines (below).

## The fix: `PAPERCUSP_DHT_BOOTSTRAP` + `[swarm]` logs

Both added to `apps/operator/lib/sync/hyperbee/`:

* **`PAPERCUSP_DHT_BOOTSTRAP`** (`swarm.ts`, `swarmConstructorOpts` /
  `parseDhtBootstrap`) — a comma-separated `host:port` list. When set, every peer
  sharing the value joins the **same isolated DHT** (a local `hyperdht/testnet`),
  so two same-box instances discover each other over loopback. Unset → the public
  DHT (default, unchanged). Unit-tested in `swarm.test.ts`.
* **`[swarm]` stdout diagnostics** (`boot.ts`) — always-on: `[swarm] joined topic
  …`, `[swarm] peer_connected …`, and crucially `[swarm] join FAILED … staying
  local-only: <error>` (the previously-silent catch — a real production
  regression signal, not just test scaffolding).

## Running the packaged merge proof

`papercusp-desktop/bin/two-instance-merge-smoke.sh` spins a local testnet DHT,
launches two `.deb` instances pointed at it with distinct identities, registers a
harness + shares write-free on both, waits for `[swarm] peer_connected`, then
INSERTs a feature on A and asserts it lands in B's PG with `origin='remote'` (and
the reverse). **It requires a `.deb` rebuilt (`bin/release-local.sh`, serialized
via the `desktop-sidecar` exclusive lock) from a tree that includes the
`swarm.ts` + `boot.ts` changes above** — an older `.deb` ignores
`PAPERCUSP_DHT_BOOTSTRAP` and uses the public DHT.

Launch teardown must be **scoped** — `pkill -f "$WORK"` (the run's mktemp dir),
NEVER `pkill -f papercusp-desktop` (that kills peers' dev desktops + e2e Xvfb).
Use a dedicated `Xvfb` display, not the shared `:99`/`:100`.
