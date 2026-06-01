---
title: Papercusp substrate — Model B rewrite (per-peer signed logs)
slug: papercusp-substrate-model-b-rewrite-2026-05-31
status: draft
created: 2026-05-31
owner: avi@storewolf.com
supersedes_design: papercusp-trust-model-2026-05-31 (Addendum C — the A-vs-B decision; this is the "separate rewrite plan, not yet written" C.4(a) calls for)
---

# Papercusp substrate — Model B rewrite (per-peer signed logs)

## Now

**State:** **DESIGN SPEC — awaiting review, then an implementation plan (writing-plans).** No code yet. This is the rewrite plan that `papercusp-trust-model-2026-05-31` Addendum C.4(a) said was "not yet written."

**Decision recap (this session, owner-confirmed with full awareness):**
- **Model B over A** (re-confirmed 2026-05-31 after re-examining the tradeoff — see Background). The substrate moves from multi-writer Autobase → per-peer single-writer signed logs + a local read-merge.
- **No feature flag.** We're in alpha; the substrate is simply **always on** for shared harnesses. The `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` gate is **removed** wherever it's read (`host-bootstrap.ts`, `share-finalize.ts` reboot dep, the retired `instrumentation-node.ts:341` block).

**Next:** writing-plans turns this spec into staged implementation items; then build + the two-peer verification (§8).

## Background

### Why B (the decision)
`papercusp-trust-model-2026-05-31` Addendum C compared the two substrate write-models. **Decision: B.** The keystone reasons (C.5):
- **Security is structural, not bolted-on.** A per-peer Hypercore is single-writer and natively signed by the device key, so a peer can only write facts *about itself* and there is **no shared structure to forge into**. Model A would need three things it lacks — `addWriter` admission, per-op authorization, signature-verify-on-receipt — and still hits the append-only **no-true-removal** problem. B collapses all of that to **one read-time decision: "do I aggregate this peer's log?"** Revocation becomes trivial *and actually possible* (stop reading the log).
- **No deterministic-`apply()` burden, better failure isolation** (a corrupt log → skip that author, vs. a bad op corrupting the merged view for everyone), **looser coupling** (each consumer reads with its own versioned reader), and it's the **dominant** Hyperswarm pattern.
- The one thing A buys that B doesn't — a **free global total order** (mainly claim arbitration) — is re-homeable to GitHub / LWW, and the advisory-state pivot (C.2) makes a Byzantine-consistent canonical merge over-engineering for what are coordination *hints*.

### The unbuilt-merge finding (2026-05-31, code-verified)
Cross-peer merge is **unbuilt in BOTH models today** — every peer boots its Autobase `bootstrap: null` (its own root), `addWriter` is handled but never emitted, the autobase key is never surfaced, and the join link carries only topic + repo_id. So this is **not** "keep working A vs. rewrite B" — A works single-peer but its multi-peer merge is as unbuilt as B's. The real question was *which remaining build*; B's is lighter + safer. (Recorded: `HANDOFF-dogfood-substrate-2026-05-30.md` Session 3 + [[project_dogfood_substrate_merge_unbuilt]].)

### What's already proven
`sheets` is live-shared single-machine (synthetic repo id `999000001`): enable → share → boot → join swarm → health `healthy`. The transport + projection layers work; the data layer is what we're replacing.

## Decisions

### D-001 — Model B (per-peer signed logs), confirmed
Owner re-confirmed B after re-examining A-vs-B with full awareness that (a) the prior "decided B" was recorded but not deliberately made, and (b) multi-peer merge is unbuilt in both. See Background.

### D-002 — Claims = LWW advisory + clobber-toast
A claim ("I'm working on F-042") is an ephemeral per-peer hint, not durable truth — and at claim time there is usually no GitHub artifact yet, so GitHub-anchoring is awkward exactly when needed. Read-merge resolves claims last-writer-wins; contention surfaces via the **already-built** clobber-toast (Phase-5b P-035). The *done* side stays GitHub-anchored via `completion_ref`. **Consequence: Model B needs ZERO ordering machinery anywhere** — the single biggest simplification. Removes the Phase-6 Autobase merge-order claim (`feature-claim.ts` append→await-own-merge→check-first).

### D-003 — Read-merge = LWW-register per key, relational projection
Per-peer logs carry LWW-register ops `{table, key, field?, value, ts, author_pubkey}`. Read-merge resolves each `(table, key[, field])` by highest `(ts, author-tiebreak)` and materializes via the **existing** `projections/* writeToPg` row-writers. NOT a document-CRDT (Automerge/Yjs) — our data is relational + author-partitioned, so a CRDT is an impedance mismatch + a heavy dep we'd fight; LWW-register reuses the projection layer and keeps one uniform conflict rule across the whole substrate. Granularity: **per-field** LWW where rows have independent editors, per-row elsewhere.

### D-004 — Read-admission = signed announcement-on-connect, verified against the two-channel binding
On a swarm connection, peers exchange a signed announcement `{ device_pubkey, github_user_id, github_login, log_core_key, sig }`. A peer aggregates a log **iff** (1) `sig` verifies against `device_pubkey`, (2) `device_pubkey` ↔ `github_login` is a valid **two-channel binding** (Phase 1b, already built), and (3) that `github_login` is a **collaborator on this repo** (binding service / gh API). Otherwise the log is ignored (no data enters PG). **Revocation = drop the pubkey from the admitted set** (the `revoked_pubkeys` drop-list, now trivially effective). This realizes C.4(d) ("the firewall hook becomes B's read-admission seam"). Chosen over a per-harness "membership log" for simplicity — no extra log to maintain.

### D-005 — Migration = replace-in-place, substrate always-on (no flag)
Keep the transport + projection layers; replace only the data layer. The `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` flag is **removed** (alpha — nothing to protect; per repo CLAUDE.md "no deprecation aliases, break things freely"). The substrate boots unconditionally for **shared** harnesses (those with `.harness/shared.json`); unshared harnesses are untouched as before. No A-and-B-side-by-side, no model-select flag.

### D-006 — DoS Phase-4 → per-author replication/ingest cap
The connection-layer DoS hardening (`hyperswarm-dos-hardening` Phases 1-3+5) is model-independent and **stays**. The shaped-out Phase-4 per-op Autobase limit becomes a **per-author replication/ingest cap** at read time (C.4c) — a noisy author bloats only its own log; consumers cap/drop it.

### D-007 — The user-protection auditor is OUT OF SCOPE here
Read-admission (D-004) answers "whose logs do I trust as *authorship*." The user-protection **auditor** (`papercusp-user-protection-gate-2026-05-31`, trust-model Addendum D) is a *separate, downstream* gate answering "does this content — even from a verified collaborator — try to make my local agent do something malicious." This spec **notes the seam** (read-admission feeds the auditor) but does not build the auditor.

## Architecture

### The three layers — B swaps only the middle
| Layer | Status | Detail |
|---|---|---|
| **Transport** | KEEP | Hyperswarm join + `corestore.replicate` + DoS connection hardening (`swarm.ts`, `swarm-guard.ts`). Model-independent. |
| **Data** | REPLACE | multi-writer Autobase + deterministic `apply()` → per-peer single-writer signed logs + local read-merge. |
| **Projection → PG** | KEEP | `projections/* writeToPg` + relational schema + clobber-toast + health/status diagnostics. Read-merge feeds these unchanged. |

### Per-peer log (new — `peer-log.ts`)
Each device appends only to **its own** Hypercore (single-writer, natively signed by the device key from the OS keychain — Phase 1b). Op = an LWW-register cell (D-003). A peer's own log is its complete contribution; there is no shared structure.

### Discovery + read-admission (new — `read-admission.ts`)
Announcement-on-connect (D-004). Maintains the per-harness **admitted set** {pubkey → log_core_key} of verified collaborators, plus the `revoked_pubkeys` drop-list. Replication of a peer's log is started only on admission; dropped on revocation.

### Read-merge (new — `read-merge.ts`, replaces the Autobase path in `read-loop.ts`)
Replicate all admitted logs; for each `(table, key[, field])` apply highest `(ts, author-tiebreak)`; materialize via existing `projections/* writeToPg`. Driven by per-log `'append'`/`'truncate'` events + a polled fallback (mirrors today's read-loop). Idempotent.

### Claims (LWW advisory — D-002)
Append claim hints to own log; read-merge LWW picks a holder; clobber-toast on override.

### Migration map
- **New:** `peer-log.ts`, `read-merge.ts`, `read-admission.ts`, announcement wire-format + verify.
- **Rewrite:** `boot.ts` (drop Autobase wiring → start own-log + read-merge + admission), `read-loop.ts` (merged-view replay → admitted-log aggregate), `feature-claim.ts` (Autobase merge-order → LWW hint).
- **Retire:** `autobase-setup.ts`, the `bootstrap`/`addWriter` apply path, the `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` flag reads.
- **Keep unchanged:** `corestore.ts`, `swarm.ts` + `swarm-guard.ts`, `projections/*`, `derive-swarm-topic.ts` (topic still = `sha256("…:gh:<repo_id>")`), the relational schema, clobber-toast, `health.ts`/`in-process-status.ts`/boot-history.

### Auditor seam (not built here — D-007)
Read-admission emits the verified-authorship boundary; the auditor consumes aggregated content before it drives local agent execution. Tracked in `papercusp-user-protection-gate-2026-05-31`.

## Testing — two-peer on one box (closes the gap we found)

Two corestores/instances on this machine, each with its own data-dir + device key + log, joining the same topic (repo id `999000001`):
1. **Replication:** peer A writes a `sheets` feature → it **lands in peer B's Postgres** via the read-merge (the round-trip that's been impossible until B).
2. **Read-admission:** a peer whose `github_login` is **not** a repo collaborator is **refused** — its log never enters PG.
3. **Revocation:** dropping a pubkey from the admitted set stops further ingest from it.
4. **LWW claim:** both peers claim F-042 → converges to one holder, the other gets the clobber-toast.

(Unit-test the merge + admission as pure functions; the two-peer harness is the integration proof.)

## Scope / non-goals

- **Out:** the user-protection auditor gate (own plan, D-007); op-level encryption-at-rest; >2-peer beyond "it generalizes" (verify with 2); any UI changes (Phase-8 surfaces read the same projected PG).
- **In:** the data-layer rewrite, read-admission/discovery, LWW claims, the DoS per-author ingest cap, removing the flag, and the two-peer verification.

## Open questions

- **OQ-1 — collaborator-verification source for D-004(3):** binding service vs. a live `gh` repo-collaborators call vs. the Cupboard binding. Lean: the binding service (Phase-1b P-068), cached, with a gh fallback. Resolve in the plan.
- **OQ-2 — announcement transport:** a dedicated tiny "hello" core per peer that others read first, vs. an out-of-band handshake message on the swarm connection. Lean: a well-known-named `announce` record the peer signs + others read on connect. Resolve in the plan.
- **OQ-3 — backfill:** existing `sheets` (and any A-shared harness) has Autobase state; B starts fresh per-peer logs. Since data is advisory + re-derivable, lean: **no migration of A's view** — start clean (PG already has the local rows; peers re-announce + re-replicate). Confirm.

## Cross-references

- `papercusp-trust-model-2026-05-31.md` — Addendum C (the A-vs-B decision this implements), Addendum D (the auditor reframe).
- `papercusp-user-protection-gate-2026-05-31.md` — the downstream auditor gate (D-007 seam).
- `hyperswarm-dos-hardening-2026-05-31.md` — the connection-layer hardening that stays; Phase-4 reshape (D-006).
- `papercusp-dogfood-phase5a/5b/6-*.md` — the Model-A substrate being replaced (projection + UI survive; Autobase merge + Autobase claim swapped).
- `HANDOFF-dogfood-substrate-2026-05-30.md` — Session 3: the unbuilt-merge finding + the live `sheets` share state.
