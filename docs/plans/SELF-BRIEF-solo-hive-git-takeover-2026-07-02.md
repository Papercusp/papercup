# SELF-BRIEF — solo shared-hive-git takeover (su-16e4c274)

> **STALE SNAPSHOT of a live system.** Before acting on any fleet/claim/liveness
> statement, re-run `coord:orient` and reconcile. MCP flaky → fallback:
> `node scripts/mcp-call.mjs <tool> '<json>' --client su-16e4c274-8451-41b6-9480-bf758a7bf628 --harness papercusp`
> from the canonical tree.

## Identity + mode
- **su-id:** su-16e4c274-8451-41b6-9480-bf758a7bf628 · no fleet · harness papercusp
- **AUTO MODE ON** (owner-granted, standing, whole session). Route = **solo** (owner
  explicitly chose: "finish implementing what's left across all the plans entirely
  yourself" — no fleet, no queen). Route is STICKY.
- Prior driver: su-3700bc41 (dead) led fleets p2p-dist + git-plan; all 4 p2p-dist
  lanes dead (`recorded`). Takeover note sent to su-3700bc41's inbox.
- Owner: aviynw2@gmail.com. Loop: `loop:arm { intervalSec:60 }` when idle-risk.

## The three plans (all harness papercusp)
1. **p2p-work-distribution-2026-07-02** — THE BULK. 29 items; done: P-001, P-004,
   P-006, P-110. wip (MINE): P-002, P-005, P-109; P-108 reclaim pending (stale claim
   su-c88ac610 expired 22:17 EDT — re-flip wip). todo: P-003 (gated on LIVE-1),
   P-101..P-107, P-201..P-207, P-301..P-306. **ITEMS ARE THE SPEC** (D-016) — read
   item text in full; decisions D-017/D-018 = ratified designs (binding build notes).
   Designs: docs/plans/DESIGN-P-006-federation-scope-2026-07-02.md,
   DESIGN-P-108-results-channel-2026-07-02.md,
   DESIGN-p2p-P109-foreign-worktree-git-plumbing-2026-07-02.md.
2. **cross-machine-coord-parity-and-trust-2026-07-01** — only **P-059** (wip, mine):
   LIVE-1 drill D2–D6 per plan ##Now. Runbook: docs/plans/LIVE-1-rig-runbook-2026-07-02.md.
   VM = QEMU iMac `ssh aviweiss@172.31.44.2` (NEVER Avis-iMac.local); VM coord via
   sidecar node + /tmp/mcp-call.mjs, port from VM ~/.papercusp/endpoint-ipc.json
   (changes per app restart), --client su-live1-imac-probe --workspace
   papercusp-workspace. VM PG: tunnel per embedded-pg.json, harness_app/harness_app_pwd.
   ⚠ su-a1a71fca is LIVE debugging the Mac app on the same VM — coordinate.
   Completing P-059 unblocks p2p P-003. Final leg: flip PRESENCE_GOSSIP writer flag +
   30-min soak → P-059 done → plan complete.
3. **per-hive-git-and-release-gate-2026-06-29** — all 19 items done; ##Now stale.
   To close: canary-verify per-hive gate on oddsmith-hive live, flip
   PER_HIVE_RELEASE_GATE default ON (libs/flags/src/types.ts:261 + remove
   types.ts:1268 dark entry + KNOWN_DARK_FLAGS shrink), update ##Now, plan complete.

## In-flight build state (verified green 2026-07-02 22:12 EDT)
- Baseline: 106 unit (scope-disclosure 17, announce 26, scope-repo 18,
  results-receipt 17, p2p settings 16, grant-store 12) + 25 integration
  (foreign-merge-admission 16, foreign-mirror-quarantine 7, scope-repo 2) ALL GREEN.
- **P-108 remaining:** boot/connection wiring — open admitted scoped cores, serve-side
  roster gate, re-announce on roster change (D-017 n1: LIVE connections re-announce);
  needs roster seam (P-101 directory / P-001 grants store). Landed: scope-repo.ts,
  results-receipt.ts, announce.ts scoped_logs field, hyperbee/scope-disclosure.ts.
- **P-109 remaining:** leg i guard policy (apps/operator/scripts/hooks/cc/
  pretooluse-locks-acquire.sh = source of truth; host DENY under foreign root,
  foreign session allow ONLY own registered root, fail-closed via
  p2p_foreign_workspaces registry); leg ii foreign-git-sync routine (separate
  routine `system:foreign-git-sync`, origin author+committer stamping, 4 trailers,
  fail-closed on attestation, DISJOINT-scope regression test); leg iii publish
  wiring (mirror → per-scope repo per FS-D3/RC-D1(b), canonical merges import via
  refs/foreign/<scope>/ tracking refs, sigref originClaim bump CONFINED to
  scope-repo sigrefs). Landed: mig 467 p2p_foreign_workspaces, lib/p2p/
  foreign-workspaces.ts, foreign-clone.ts, hive-git/foreign-mirror-quarantine.ts.
- **P-002 remaining:** Tauri live-verify, page render test, m24 live view (P-104-gated
  — may defer m24 with note). FLAGS.P2P default-ON landed.
- **P-005:** tier flag GITHUB_BRIDGE-pattern default-ON; record FS-D5 (5.4 per-scope
  crypto = HARD GATE for tier 2 + X1 loopback boundary) in item text.

## Discipline reminders
- tsc: `npx tsc --noEmit -p .` directly; ~333-error pre-existing baseline in
  operator-core — grep YOUR files only.
- No git add/commit/push (git-sync owns it). Canonical staging tree only.
- Migrations ≥469 (467/468 taken), via db:migrate runner; pull-schema after.
- Sibling live agents: su-f5d2888e (federation-release-hardening, touches
  projections/tests), su-173cbb09 (su-loop-capability-parity), su-a1a71fca (VM Mac app).
- Work-item ledger: plan-item claims held via plans:set-status wip (auto-claim).

## Next actions (in order)
1. Re-flip P-108 → wip (claim expired).
2. P-109 leg ii (foreign-git-sync routine + disjoint test) then leg i (guard policy)
   then leg iii (publish wiring + sigref originClaim).
3. P-108 boot/connection wiring (roster seam: use P-001 grants store until P-101 lands).
4. Task 2: per-hive canary verify + flag flip + plan close.
5. P-059 LIVE-1 drill (check su-a1a71fca first).
6. P-002 remainder, P-005, then P-101..P-107, Phase 2, Phase 3 (P-306 before P-305).
