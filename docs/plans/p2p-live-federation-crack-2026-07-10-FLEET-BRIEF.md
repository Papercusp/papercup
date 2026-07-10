# Fleet brief — p2p-blocker-crack-sonnet5

**You are a member of `p2p-blocker-crack-sonnet5`.** Leader: su-07320b7c (this session).
**Mission (owner-authorized, Avi 2026-07-10):** crack the ONE root cause keeping shared-hive p2p live-federation RED, then drain the drill + witness + GO/NO-GO blocked behind it.

## First acts (every member)
1. `coord:orient { intent, planSlug: "p2p-live-federation-crack-2026-07-10", planItems: [<the ONE lane you take>] }` — claim exactly ONE lane.
2. Pick the highest-`importance`, **unblocked** lane not already claimed by a peer (check `fleet:assignments { plan:"p2p-live-federation-crack-2026-07-10" }` first). Do NOT double-claim.
3. Work it to DONE with real verification (tests in the project framework, not ad-hoc scripts). `work_items:checkpoint` your in-flight state every turn. `work_items:complete` with evidence when done.

## The situation (ground truth as of 19:40Z, re-verify — it is a live system)
- Gate is RED for ONE cause: **EI-8895** (`connected_never_replicated`, WI-183 class) — a log admitted AFTER a swarm connection is up never gets its replicator attached. Watermark frozen: coord_event_log remote count=147 / max_ts 2026-07-10 10:32 EDT / cursor `ef7a8160` pos=0 for 2h+.
- Conclusively diagnosed by coord-lane lead **su-bce8d8e6** (WI-3549 checkpoint 19:40Z). NOT disk/ENOSPC (Mac `df -h` clean).
- A candidate fix + test **`wi183-attach-on-late-admit.integration.test.ts`** already exist.
- Already fixed & verified (do NOT re-investigate): WI-3646 (hive_slug federation regression, live-rig green), WI-3869 (coord_event_log scan → "looks paused").
- Second live blocker: iMac `hives` table is empty → restore membership via typed surfaces (lane P-002).

## HARD RULES (these are why prior attempts failed — do not repeat them)
1. **Repro-first, NO blind live-federation edits.** A prior blind auto-fix on EI-8895 already failed. Verify the candidate test IN-PROCESS (deterministic) before ANY live-rig run or federation-code change. Coordinate with coord-lane su-bce8d8e6 for incident history before editing federation code.
2. **Live-rig access is SERIALIZED behind the single P-003 owner.** Only ONE member touches the tower↔iMac rig at a time. P-002 (iMac-side) and P-003 (cross-machine verify) are the only rig lanes and they are ordered. If your lane is not P-002/P-003, do NOT touch the live rig.
3. **NEVER run a tree-wide destructive git op** (`git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`) — it wipes peers' uncommitted work. Discard only your OWN single file, by hand, if needed. Do not `git add/commit/push` — the background routine commits the shared tree.
4. **Edit ONLY the canonical staging tree** (`~/papercupai-workspace/papercusp`, branch `staging`). The PreToolUse guard blocks edits in sibling worktrees.
5. **Stuck / blocked?** A blocker is work, not a stop sign — resolve it durably. If it is genuinely owner-gated or cross-lane, coord:send the leader (su-07320b7c) + keep a checkpoint; do not silently drop it or spin an empty poll.

## Key references
- Plan (your work queue): `p2p-live-federation-crack-2026-07-10` (7 lanes P-001..P-007).
- Umbrella plans (reference): `p2p-git-live-activation-2026-07-09`, `p2p-rest-lanes-2026-07-09`.
- Leader handoff: `docs/plans/p2p-rest-LEADER-HANDOFF-2026-07-10.md`.
- Ledger: `shared-hive-release-testing/RELEASE-READINESS.md`, `federation-public-release-known-limitations.mdx` §2.
- Diagnosis toolkit: `agent-insights/shared-hive-federation-diagnosis-toolkit`.
