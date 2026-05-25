---
title: Papercusp dogfood — Phase 5a (Hyperbee plumbing)
slug: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24
status: in-progress
parent: papercusp-dogfood-v5-2026-05-23
created: 2026-05-24
updated: 2026-05-25
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 5a (Hyperbee plumbing)

## Now

**State:** **P-029 + P-030/P-031 SUBSTRATE SHIPPED 2026-05-25.** The Hyperbee + Autobase substrate is in tree at `apps/operator/lib/sync/hyperbee/` (corestore factory, autobase wrapper, schema-version gate, boot gate, projection registry). 18/19 tests pass (1 native-binding test deliberately skipped — covered by holepunch-spike's smoke runs). Typecheck clean. P-029 ShareWizard.tsx is at `apps/operator/app/harness/`, 7/7 tests pass.

**Next action:** per-table read/write hooks (one PR per HYPERBEE-bucket table — contributors, harness_features, feature_queue, prs, issues, presence, usage, claims) wiring the substrate's `registerProjection` interface to real PG row contracts. Each is ~50 LOC + 2 tests. Then boot wiring in `instrumentation-node.ts` + Hyperswarm replication step. P-066 (bootstrap progress indicator) follows.

## Background

Phase 5a implements `## Phase 5a — Hyperbee plumbing [L]` from v5 (~line 1240). It owns the share-this-harness wizard (P-029), the per-harness Hyperbee + Autobase wiring (P-030), the bidirectional projection between Hyperbee and PG (P-031), the sleeping-laptop bootstrap progress indicator (P-066), and the new `contributor_usage_events` ledger (P-070 from addendum 3).

**Gate:**
- Phase 0 `GATE: PASS` (mandatory).
- Phase 1b's P-068 (canonical binding service) + P-075 (two-channel verifier) done — the wizard calls both.
- Phase 2 + Phase 3 done — Phase 5a's projection layer fires `pg_notify` (Phase 3 path) on Hyperbee→PG writes.
- Phase 4 verdict `GATE: PROCEED` (mandatory — single-engineer dogfood must have passed before shared dogfood substrate ships).

## Phase tasks

### P-029 — Share-this-harness wizard UI [M]

v5 §5: nine-step flow including provisional-owner explainer + canonical repo-binding lookup. Replaces the placeholder `EntryHarnessLinkForm` from Phase 1a P-012e once it's repurposed as the share-FROM-existing-private flow.

**Files:** `apps/operator/app/harness/ShareWizard.tsx` (new), `apps/operator/app/harness/ShareWizard.test.tsx`, plus per-step components under `apps/operator/app/harness/share-wizard/`.

**Sub-acceptances:**
- **P-029a** — All nine steps from §5 render in sequence; each can be back-stepped without losing prior input.
- **P-029b** — Step 2 (canonical binding lookup) calls P-068; existing binding → "you'd join, not create" alert; no binding → continue.
- **P-029c** — Step 5 privacy confirm-modal copy matches §5 step 7 verbatim for shared-private and shared-public variants.
- **P-029d** — Step 8 backfill runs P-031's PG→Hyperbee seeder (one-time, see §7.3).
- **P-029e** — Step 9 writes `.harness/shared.json` (committed) + generates the harness-link URL + offers copy-to-clipboard + opens a "you're the provisional owner" modal with the owner-settings list from §5.1.

**Decision rule:** PASS when all sub-acceptances pass.

### P-030 — Hyperbee schema + Autobase setup [L]

v5: per-harness corestore, per-writer Hypercore, Autobase wiring. Includes D-024 schema-versioning.

**Files:**
- `apps/operator/lib/sync/hyperbee/index.ts` (new) — main module.
- `apps/operator/lib/sync/hyperbee/corestore.ts` — per-harness corestore at `<workspace>/<harness>/hyperbee/`.
- `apps/operator/lib/sync/hyperbee/autobase.ts` — per-writer Hypercore + Autobase merge view.
- `apps/operator/lib/sync/hyperbee/schema-version.ts` — D-024 enforcement: every op carries `schema_version BIGINT`; consumes `known_schema_versions` LOCAL table; emits toast on unknown-newer.

**Sub-acceptances:**
- **P-030a** — Per-harness corestore boots, persists across operator restarts, isolates from other harnesses.
- **P-030b** — Three Autobase writers (simulated from one host for test) converge on a deterministic merged view within 200ms; matches Phase 0 P-003 stability.
- **P-030c** — `addWriter` op produces a new writer's Hypercore being included in the next merged view; existing peers ack the new writer on next sync.
- **P-030d** — Schema-version enforcement: an op with `schema_version > my_known_max` is ignored AND a toast fires per D-024.
- **P-030e** — `revoked_pubkeys` honored: writes from revoked pubkeys are dropped before being applied to PG (consumed from `contributors` per §0.2).

### P-031 — Write-side + read-side projection [L]

v5: PG → Hyperbee on writes; Hyperbee → PG on remote ops; gates on both ensure-paths complete at boot.

**Files:**
- `apps/operator/lib/sync/hyperbee/projection.ts` — bidirectional projection.
- `apps/operator/lib/sync/hyperbee/write-hooks.ts` — install PG triggers OR application-layer hooks that fire `appendOp(Hypercore)` on every write to a HYPERBEE-bucket table.
- `apps/operator/lib/sync/hyperbee/read-loop.ts` — subscribes to Hyperbee KV updates; serializes to PG row writes; emits `pg_notify` via Phase 3's path.

**Sub-acceptances:**
- **P-031a** — Boot gate: projection refuses to start until BOTH ensure-paths (SQL migrations + `ensure-schema.ts`) report complete. Detected via a flag in `globalThis` (the same flag pattern Phase 1a P-013 uses).
- **P-031b** — Write a feature row in PG → Hyperbee KV updates within 100ms on the local peer → other peers see the update via Hyperswarm replication within 500ms.
- **P-031c** — Receive a Hyperbee KV update for a feature row → PG row updates → `pg_notify` fires → SSE subscriber sees the invalidate → UI refetches.
- **P-031d** — Conflict (two writers update the same key simultaneously) → LWW per D-012; clobber-toast surfaced in Phase 5b P-035 UI (P-031 just emits the event; UI consumes).
- **P-031e** — Backfill (used by P-029d) — seed Hyperbee from current PG state in one transaction-bounded sweep; idempotent (re-runnable without dups).

### P-066 — Sleeping-laptop bootstrap progress indicator [S]

v5 §Phases: subscribe to Autobase merge events; surface as "Syncing harness (N/M ops merged)…" in harness sidebar header; auto-dismiss when caught up.

**Files:** `apps/operator/app/harness/BootstrapProgressIndicator.tsx` (new), wired to a Hyperbee event stream from P-030.

**Sub-acceptances:**
- **P-066a** — On harness open after >10min offline, indicator appears within 1s.
- **P-066b** — Progress updates at least every 500ms as ops merge.
- **P-066c** — Auto-dismisses within 2s of being caught up (latest local seq = latest remote seq).
- **P-066d** — On 8hr offline reconnect (mirrors Phase 0 P-003d), indicator stays visible the whole time (no flicker), dismisses on completion.

### P-070 — `contributor_usage_events` HYPERBEE ledger [M]

v5 addendum 3 D-027: append-only event ledger; emitters in feature CRUD, PR daemon, decision/plan writes, agent runs. Idempotent dedupe on `event_id`.

**Files:**
- `apps/operator/lib/sync/usage-events.ts` (new) — `emitUsageEvent({kind, github_user_id, ref_id, payload}): Promise<void>` and `rollupForContributor(github_user_id, harness_slug): Promise<RollupSummary>`.
- Emitters added to: feature CRUD (`apps/operator/lib/agent-tools/features/...`), PR daemon (P-042 from Phase 7 — coordinate via interface), decision writes, plan writes (`plans:*` tools), agent run completion path.
- Schema already exists from Phase 1a P-013 (added in addendum 3); no schema work.

**Sub-acceptances:**
- **P-070a** — Each emitter writes exactly one event per logical action (idempotent via `event_id` UUIDv7-style).
- **P-070b** — Rollup helper returns counts within 100ms for a contributor with up to 10k events (paginated/indexed read).
- **P-070c** — Events propagate via Hyperbee to peers (using P-031's projection path).
- **P-070d** — Dedupe: receiving the same `event_id` twice is a no-op, not an error.

## Decisions

(None yet.)

## Named fallback rollout

If Phase 0's GATE was PASS but Phase 5a surfaces production-blocking issues with Autobase or Hyperbee at real load, the same fallback as Phase 0 applies: HYPERBEE bucket collapses into GIT bucket. See `papercusp-dogfood-phase0-spike-2026-05-24.md` `## Named fallback rollout` for the 8-step rollout.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 5a` (~line 1240), `### §5 — Share-this-harness wizard`, `### §6 — Hybrid sync model`, `### §7.1 — HYPERBEE bucket`, `### §7.3 — Backfill from PG`, `### §13 — Reactivity architecture`.
- Prereq plans: `phase0`, `phase1b`, `phase2`, `phase4`.
- D-007 (hybrid sync), D-012 (LWW honesty), D-015 (Holepunch primitives), D-024 (schema versioning), D-027 (event ledger).

## Open questions

### Q-1 — Where does the per-harness corestore live on disk?

Suggested: `<workspace_root>/<harness_slug>/.papercusp/hyperbee/`. Bundled into backup via Kopia (see `papercup-backup-integration` memory). Confirm before P-030a.

### Q-2 — How are HYPERBEE writes idempotent against operator restart mid-write?

If the operator dies between "wrote to PG" and "appended to Hypercore," the Hypercore is missing the op but PG has the row. The recovery path is the next boot's projection sweep noticing the divergence. Spec the divergence-detector before P-031 lands.

### Q-3 — What's the budget for Hyperbee disk growth?

Append-only logs grow forever. v5 §Q-5 deferred peer-mirror disk footprint to Phase 12+; same question applies here for the harness's own corestore. Acceptable answer for v1: monitor + warn if >10GB; no auto-compaction.

## For the next agent (Phase 5b)

Phase 5b consumes:
- `feature_queue` HYPERBEE table from P-030/P-031 — already projected to PG via P-031c.
- `contributors` HYPERBEE row with `binding_status` from P-075 (Phase 1b) — Phase 5b adds the `user/<id>` branch creation on first join.
- `BootstrapProgressIndicator` from P-066 — Phase 5b makes it visible in the harness header.
- Clobber-detection events from P-031d — Phase 5b renders the toast (P-035).

Phase 5b is M-sized vs Phase 5a's L; mostly UI integration on top of plumbing that already works.
