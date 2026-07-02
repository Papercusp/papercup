# SELF-BRIEF — git-plan FLEET LEADER (post-compaction pickup)

> **STALE SNAPSHOT of a live multi-agent system.** Before acting on any fleet /
> claim / liveness statement below, re-run `coord:orient` (via the mcp-call
> fallback — MCP is dropped) and reconcile. You LEAD a live 4-member fleet.

## Identity / session (structured)
- **su-id:** `su-3700bc41-26db-4549-afb7-3dcf8fd072dc` (su-3700b) — on the **aviynw2** system account.
- **workspace:** `papercusp-workspace` · **harness:** `papercusp`
- **canonical tree (edit ONLY here):** `/home/marsh-office/papercupai-workspace/papercusp`
- **MCP `papercusp-su` is DROPPED.** Drive it via:
  `node scripts/mcp-call.mjs <tool> '<json>' --client su-3700bc41-26db-4549-afb7-3dcf8fd072dc`
  (colon tool names; `plans:set-status {harness:'papercusp',slug,itemId,status}`).
- **AUTO mode: ON.** **I LEAD fleet `git-plan`** — monitor loop ARMED (`loop:arm`, 600s;
  `loop:end` only when the plan is done or the owner stops it).

## OWNER DIRECTIVES (latest wins — this is the current standing order)
The owner changed the route THREE times; the FINAL standing order (2026-07-02) is:
**Launch a fleet of 4 `claude-fable-5` agents @ effort xhigh, pinned to the aviynw4 account,
take leadership, AUTO mode, and MANAGE THE FLEET until the plan is complete.** (This
superseded "do it entirely yourself.") Also: **watch the aviynw2 account (the system login);
before it runs out of usage, re-pin this session to another account** so work continues.

## THE FLEET (git-plan) — 4× claude-fable-5:xhigh, account=aviynw4, leader=su-3700b
Launched via `fleet:launch-on-plan` (one call per lane, count=1, per-lane launchContext).
To relaunch a dead member: same call with its lane file.
- **Lane A** — Policy/crefs, GC, scope: G-6 (P-030), G-5c (P-035), G-9 (P-042), G-1b (P-041).
  `docs/plans/FLEET-lane-A-2026-07-01.md`
- **Lane B** — Integrator completion + lock handoff: G-5b (P-034), G-5d (P-038), G-0 (P-033),
  G-0b (P-037). Touches `authority/lock-authority.ts` (SHARED). `FLEET-lane-B-2026-07-01.md`
- **Lane C** — Worktree bridge + bootstrap: G-7 (P-031), G-7b (P-036), G-7c (P-040), G-8
  (P-032). `FLEET-lane-C-2026-07-01.md`
- **Lane D** — Distributed test gate: DG-1..DG-6 (P-044..P-049). `FLEET-lane-D-2026-07-01.md`
- Shared brief: `docs/plans/FLEET-git-briefs-2026-07-01.md` (§0 rules + leader-landed list).

## LEADER-HELD (mine, not the fleet's)
- **G-3 announcements (P-027)** — `{device, sigrefsOid}` as P-009 federated events → fetch trigger.
- **G-2 LIVE channel adapter** — open a `papercusp/hive-git` Protomux sub-stream per fetch on the
  real hive-swarm connections, bridged to `fetchOverDuplex`/`serveUploadPack` (transport core done).
- Review EVERY merged member diff (fable5 = capable but review closely).

## WHAT I ALREADY LANDED (leader, all green — build ON, don't redo)
`packages/operator-core/lib/sync/hive-git/`:
- **G-1** `storage.ts` (+`storage.integration.test.ts`, 7) — per-device-namespace bare-repo store.
- **G-2** `fetch-transport.ts` + `git-ext-bridge.mjs` (+integration test, 4) — native v2 fetch over
  a Duplex (ext:: bridge; sockets MUST be `allowHalfOpen:true`).
- **G-4/G-4b** `sigrefs.ts` (+integration test, 6) — device-signed snapshots + rollback + reconcile.
- **G-5 core** `integrator.ts` (+integration test, 5) — merge-queue staging (ff/merge-tree/skip).
- **G-10** `secrets-guard.ts` (+unit test, 7) — publish-time secret scan.
Plan items marked done: P-025(G-1), P-026(G-2), P-028(G-4), P-039(G-4b), P-029(G-5), P-043(G-10).

## COORDINATION AUDIT (su-99a02's work) — DONE, verdict: SOUND
Audited H1/H2/H3 (P-050/51/52), M6 (P-055), M5b (P-054), M8 (P-057), L9 (P-058), P-021. All
fixes correct AND wired (attested-id gate; del device-pin at frame+sink; M6 steer-gate via
`hiveScoped`; reaper proven NON-federating). 81/81 audit-surface unit tests green. No bugs
needing fixes. Residuals honestly deferred (H1 opaque owner_id; P-021 live-cutover not wired).

## THE RELEASE GATE (my red gate to green — IN PROGRESS)
Gate was RED ~19-20 consecutive reds (deploys frozen ~13h) on a SERIES of already-fixed
transient tests (ctx_tier, then design-primitives — both pass in HEAD now). Root cause of "no
green": each checkpoint judged a slightly-stale candidate. **Fired a fresh `release:checkpoint-run`
on the fixed HEAD (unit `papercup-green-checkpoint-manual-au9t47`, ~40min).** ON PICKUP: check
`release:deploy op:status`; if green → `release:deploy op:trigger` to ship; if a NEW red →
find it in `~/.papercusp/checkpoint-logs/` (newest) or the 01:51-style logs, fix, re-run.
Levers: `git-sync:run` → `release:checkpoint-run` → `release:deploy op:trigger`.

## NEXT CONCRETE ACTIONS (each monitor wake)
1. `coord:orient` / `coord:glance` / `fleet:assignments` — reconcile; reclaim orphaned/stalled
   lane claims; relaunch any dead member (same lane launchContext); answer cross-lane questions.
2. Review any member diffs landed since last wake (tests green? tsc clean? matches the lane spec?).
3. Check the gate (`release:deploy op:status`); trigger the deploy when green.
4. Check aviynw2 usage (`accounts:list`/`gateway:status`); re-pin this session before exhaustion.
5. Build/advance the leader-held G-3 + G-2 adapter when not firefighting.
6. `loop:end` only when the whole plan is done (all G-*/DG-* + LIVE-1 gate) or the owner stops it.
