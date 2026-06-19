# Findings S — Substrate durability & crash/restart recovery

**Lane:** Brief S (Wave 3, S0/S1). **Author:** su-c318e. **Date:** 2026-06-19.
**Status:** 🟢 GREEN — the deterministic recovery CORE (#1/#4/#5/#6, teeth-verified,
`crash-recovery-drain.integration.test.ts`) PLUS the **live recovery cycle** (#2/#3)
on the real packaged pair are both proven. (Continuation of my Brief N work —
recovery is the crash flip-side of N-peer backfill/cursor-refold.)
**Method:** deterministic integration (`*.integration.test.ts`, real testcontainer
PG + the REAL mig-102 capture trigger + `substrate_outbox` + `drainOutboxOnce` +
real corestore persistence across a close→reopen "restart") for the drain/recovery
core; live legs (#2 embedded-PG WAL, #3 real box/instance restart) on the live
harness (display :195+) later. Every new test teeth-verified.

## §live — live instance + embedded-PG crash recovery on the real binary (#2 + #3) 🟢

Stood up a real 2-peer packaged pair (the integrated fix-`.deb`: A-001+G-001+G-002+
A-003, Xvfb :195, A=papercupai owner / B=aviynw joiner, real testnet DHT,
`hello-world` hive). Baseline federation confirmed (content matrix bidirectional;
the only FAILs are the by-design presence wire + the A-003 hive_members/hive_settings
send-side gap — out of Brief S scope). Then the crash cycle, verified via each
peer's embedded PG `origin` column:

1. **Pre-crash:** wrote `F-CRASH-1` on A → crossed to B `origin='remote'` (~1 s).
2. **Crash:** wrote `F-CRASH-2`, then **SIGKILL'd the whole inst-a session** (the
   desktop process tree INCLUDING its embedded Postgres, pid by recorded session —
   never name-patterned). A's PG went unreachable (instance down). This is the
   session's own failure mode (a hard process/box kill that takes the embedded PG
   with it — so it exercises BOTH #3 instance-restart AND #2 embedded-PG-crash).
3. **Restart:** re-launched inst-a from its PERSISTED on-disk state
   (`fed_local_launch` on the same HOME). The embedded PG came back on a fresh
   dynamic port and **WAL-recovered** its data dir.
4. **NO LOSS:** the restarted A's PG held `F-CRASH-1` + `F-CRASH-2` and all 5
   `hello-world` features (WAL recovery, no corruption).
5. **Topic re-join:** `inst-a.log` shows `[hyperbee-substrate] boot complete booted=2`
   and `[swarm] joined topic b68823d8… harness=hello-world-hive` **AND**
   `harness=hello-world` — i.e. the hive-HOME harness re-joined the topic on restart,
   not just the member (the explicit 9140a check).
6. **Federation RESUMED:** a FRESH post-restart write `F-CRASH-3` on A crossed to B
   `origin='remote'` in ~2 s — the outbox drained + the topic round-trips again. B
   ends with exactly {F-CRASH-1, F-CRASH-2, F-CRASH-3} all remote (no loss, no dup).

So a real instance + embedded-PG hard-crash mid-federation recovers cleanly:
persisted state survives (PG WAL recovery), the substrate re-boots + re-joins the
topic (hive-home + member), the drain resumes, and federation converges with no
loss/dup. HLC-monotone-across-restart is the deterministic #6. All of the brief's
GREEN criteria are met. (Honest scope note: the embedded PG was hard-killed AS PART
OF the full-instance crash and WAL-recovered — the narrower "kill ONLY the PG while
the instance survives and re-attaches" fault was not separately injected; the
release-relevant crash — a process/box kill that takes everything — is what #3
covers, and it is the session's actual failure mode.)

## Verdict: 🟢 **GREEN**. The deterministic core (4/6: drain-resume after crash,
at-least-once dedup, large-backlog catch-up, HLC-survives-restart — all
teeth-verified) proves the recovery LOGIC, and the **live cycle** (§live) proves it
on the real packaged binary: a hard instance + embedded-PG SIGKILL mid-federation
recovers with NO LOSS (PG WAL recovery), the substrate re-boots + re-joins the topic
(hive-home + member), the outbox/drain resumes, and federation converges (a fresh
post-restart write crosses) — with HLC monotone across restart (#6). Every one of
the brief's GREEN criteria is met. **No S0/S1 found in this dimension.** One honest
follow-up (not a blocker): a PG-only-kill-with-instance-survival fault was not
separately injected (the PG was hard-killed as part of the full-instance crash) —
the release-relevant crash (a process/box kill) is what §live covers.

---

## What is ALREADY covered (do NOT duplicate — build deeper)

| Existing test | Covers | What it does NOT cover (Brief S's gap) |
|---|---|---|
| `cold-boot-resume.test.ts` (Brief F) | CLEAN restart of a peer's OWN log: close handle + drop corestore cache → reopen from DISK → fresh-cursor re-fold re-applies the IDENTICAL winner set (no loss, del wins); revocation re-seeded; idle-skip survives restart. | The **drain path** under crash. It writes straight to the own log; it never exercises `substrate_outbox` → `drainOutboxOnce` → `drained_at`. No crash MID-drain, no torn write, no at-least-once resume. |
| `wire-outbox-drain-online.integration.test.ts` (EI-521) | The ONLINE drain loop auto-drains a captured write + stamps `drained_at`; harness-scoping negative control. | Crash/restart. The loop runs to completion; nothing kills it mid-pass and asserts resume. |
| `feature-content-federation.integration.test.ts` | The full happy path: capture trigger → outbox → `drainOutboxOnce` → wire → B projects origin='remote'. | Crash recovery — the drain always completes; no interruption. (This is the **base pattern** Brief S reuses.) |
| Brief N (`n-peer-scale-churn`, `n-peer-content-fanout`) | Backfill-at-size, late-joiner cold backfill, churn with cursor-reset re-fold. | Backfill after a real RESTART (boot.ts fresh-cursor on reboot, not just an admitted-set change); drain-resume; HLC-across-restart. |

**The Brief S gap, precisely:** the AT-LEAST-ONCE drain contract
(`outbox-drain.ts`: `drained_at` is stamped ONLY after `handle.append` resolves; if
append throws, the error propagates and the row + all later rows stay undrained for
the next pass) is asserted by NO test under an actual crash. A crash between append
and the `drained_at` UPDATE leaves a row appended-but-undrained → on restart it is
re-appended (a DUPLICATE on the log) → correctness then rests on the projection's
idempotent LWW dedup. Neither half (resume-no-loss, re-append-deduped) is tested.

## Test matrix (planned)

| # | Scenario | Layer | Status |
|---|----------|-------|--------|
| 1 | **Instance crash mid-drain → restart → outbox resumes, no loss/dup** | deterministic integration (single-peer: real outbox+capture+drain) | 🟢 GREEN — `crash-recovery-drain.integration.test.ts` |
| 4 | **Torn write / at-least-once re-append → idempotent dedup** | deterministic integration | 🟢 GREEN — same file |
| 5 | **Long-downtime backfill catch-up** (a large accumulated outbox drains FULLY across multi-pass drain on restart) | deterministic integration | 🟢 GREEN — `crash-recovery-drain.integration.test.ts` |
| 6 | **HLC monotonicity across restart** (mig-314 `hlc_clock` survives a reboot → no clock regression → no D-001-class divergence post-restart) | deterministic integration (real PG hlc_clock) | 🟢 GREEN — `crash-recovery-drain.integration.test.ts` |
| 2 | **Embedded-PG crash → WAL recovery + substrate re-attach** | LIVE (:195) | 🟢 GREEN (via the #3 cycle — see §live) |
| 3 | **Real instance restart mid-federation → re-boot + re-join topic + re-drain + converge** (the session's actual failure; hive-home must also re-join) | LIVE (:195) | 🟢 GREEN — see §live |

## Results so far — #1 + #4 (GREEN, teeth-verified)

`packages/operator-core/lib/sync/hyperbee/__tests__/crash-recovery-drain.integration.test.ts`
(real testcontainer PG + the REAL mig-102 capture trigger + `substrate_outbox` +
`drainOutboxOnce` + the REAL features projection on the joiner side). The only
injected fault is the crash (a Proxy making `handle.append` throw after K rows).

- **#1 crash mid-drain → resume.** Seed N=8 features → 8 undrained outbox rows.
  Crash after K=3 appended (the 4th `append` throws) → asserted mid-state: exactly
  3 `drained_at` set, 5 undrained, own log length 3. Restart (clean `drainOutboxOnce`)
  → drains the remaining 5; ALL 8 `drained_at` set, own log holds exactly 8 ops
  (each feature_id once — no duplicate append since the throw preceded the partial
  append), and the joiner's REAL projection materializes all 8 features
  origin='remote'. **No loss, no dup, outbox resumes.** Teeth: neuter the restart
  drain → `expected +0 to be 5` RED.
- **#4 torn write (append OK, `drained_at` lost).** After a clean drain, re-arm two
  already-drained rows (`drained_at = NULL`) = "appended but the mark was lost to
  the crash". The re-drain re-appends them → the log carries DUPLICATE ops (N+2),
  exactly the at-least-once cost `outbox-drain.ts` documents — and the joiner's
  projection dedups to exactly one row per feature_id (PK + `fed_ts`/HLC guard).
  Teeth: neuter the re-arm → `re-append … expected +0 to be 2` RED.
- **#5 long-downtime large-backlog backfill.** A long downtime accumulates M=250
  undrained outbox rows (> `DEFAULT_DRAIN_BATCH`=200). On restart the drain catches
  the WHOLE backlog across multiple bounded passes (batch=50 → ≥5 passes, the
  deferral path), all 250 `drained_at` set, own log holds exactly 250 ops (no dup),
  and the joiner materializes the full gap — not a truncated head. Teeth: cap the
  drain at one pass → `expected 1 to be ≥ 5` RED.
- **#6 HLC monotonicity across restart.** Applies the REAL mig-314 `hlc_clock`
  section (the singleton clock + `hlc_now`/`hlc_recv`, verbatim from the migration).
  `hlc_now()` is monotone; a `hlc_recv()` of a FUTURE HLC (year ~2286, above
  wall-clock) advances + PERSISTS the clock in the durable `hlc_clock` table; a
  post-"restart" `hlc_now()` reads the persisted value and continues
  strictly-greater than the future — it does NOT regress to wall-clock (which a
  process-memory clock would, re-opening the D-001 divergence post-restart). Teeth:
  inject the regression (`UPDATE hlc_clock SET last_ms=0` = a restart that lost the
  clock) → `hlc_now` regresses below the future → `expected false to be true` RED.

## Status: 4 of 6 scenarios GREEN (the deterministic recovery CORE — #1/#4/#5/#6).
Remaining: the **live legs #2/#3** (embedded-PG WAL crash, real box/
instance restart — need the live harness on display :195+, coordinate via coord:*).

## First-test design (implemented above) — #1 crash mid-drain

Single-peer, no swarm/testnet needed (drain resume is an outbox→own-log property):
1. `setupPeerSchema(pgA)` — real mig-102 capture trigger + `substrate_outbox` +
   the `harness_features_consolidated` table (reuse the `feature-content-federation`
   schema setup pattern, applying the migration files verbatim).
2. `bootHarnessSubstrate({ workspaceRoot, ..., no swarmOverride })` → handle A (own log).
3. INSERT N features into `harness_features_consolidated` → the capture trigger
   enqueues N undrained `substrate_outbox` rows.
4. **Crash mid-drain:** call `drainOutboxOnce(crashingHandle, pgA)` where
   `crashingHandle = { ...handle, append: async (op) => { if (n++ >= K) throw new
   Error('CRASH'); return handle.append(op); } }`. The throw propagates out of
   `drainOutboxOnce` (the at-least-once halt) → K rows appended + `drained_at` set,
   the (K+1)th throws BEFORE its append (so NOT appended, NOT drained), rows
   K+1..N stay undrained. Assert mid-state: exactly K `drained_at` set, own log
   length == K.
5. **Restart:** `drainOutboxOnce(handle, pgA)` (clean handle) → appends N-K, marks
   them. Assert: ALL N `drained_at` set, own log length == N, each feature_id once.
6. **Convergence:** apply A's log into a fresh "B" PG via the real features
   projection (or a 2-peer merge) → B holds all N features, no loss, no dup
   (set-semantics by feature_id).
- **Teeth-verify:** neuter the at-least-once contract (e.g. make the restart drain
  skip undrained rows, or assert N before the restart) → RED on the missing tail;
  restore → GREEN.

#4 adds the DUP path: append a row, then `UPDATE substrate_outbox SET drained_at =
NULL` for that already-appended row (models append-succeeded-but-drained_at-failed)
→ re-drain re-appends it (log gets a 2nd op for the same key) → assert the
projection materializes exactly ONE row per key (idempotent dedup — the load-bearing
no-double-apply net, the same fed_ts guard Brief N modeled).

## Gaps / boundaries (so far)
- Live legs #2/#3 need the real packaged pair on display :195+ (coordinate the live
  harness via coord:* — never `:0`). Independent of A-003/re-key to START, but #3's
  full assertion (hive-home re-boots onto topic) intersects the A-003 send-side fix
  (d2230) — will note, not block on it.
- Not colliding with Brief U (federation observability — su-9140a) or the re-key
  lanes (ed300/313d1).
