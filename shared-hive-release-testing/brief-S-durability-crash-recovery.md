# Brief S — Substrate durability & crash/restart recovery

**Priority: S0/S1 lane.** Live + integration. Directly topical: this box restarted
mid-effort + lost the live fleet this very session.

## Objective
Prove federation **survives crashes** — an instance, its embedded Postgres, or the
whole box dying mid-federation/mid-drain — and **recovers correctly** on restart with
no data loss, no duplication, and no stuck state.

## Why it matters
The session's own trigger was a host restart that killed the fleet. Real deployments
crash: OOM (bg-host self-recycled at 3.2GB THIS session), power loss, OS restart,
process kills. The substrate has CDC outbox → drain → projection pipelines, HLC
clocks (mig-314), and corestore append logs — all with in-flight state. What happens
if the box dies between capture and drain? Between drain and projection-apply? Mid
re-key (later)? Recovery from persistent disk is asserted nowhere live.

## Scope / scenarios
1. **Instance crash mid-drain:** kill instance A (SIGKILL) while its outbox is
   draining to B → restart A → assert no lost/dup ops, the outbox resumes draining,
   B converges. (drained_at semantics under crash — exactly the EI-681 column.)
2. **Embedded-PG crash:** kill the embedded Postgres mid-write → restart → assert WAL
   recovery + the substrate re-attaches + federation resumes.
3. **Box restart (the real one):** restart BOTH instances (or the box) mid-federation
   → on reboot, do they re-boot the substrate, re-join the topic, re-drain, and
   converge? (This is the session's actual failure — make it a test.) Note: post-A-003
   the OWNER must re-boot the hive-home harness onto the topic on restart too.
4. **Partial write / torn op:** simulate a half-written outbox row / interrupted
   projection apply → assert idempotent recovery (no double-apply, no skip).
5. **Recovery after long downtime:** A down for a long window while B writes → A back
   → backfills the gap fully (cursor catches up, no loss).
6. **HLC monotonicity across restart:** mig-314 hlc_clock survives restart (no clock
   regression → no D-001-class divergence post-restart).

## Method
- Live packaged pair: SIGKILL by recorded PID (never name-pattern), restart, re-assert
  via embedded-PG. Integration rigs for torn-write / idempotency. Cargo for any Rust
  shell recovery.

## Deliverables
- `findings-S.md`: crash/recovery matrix (instance, PG, box, partial-write, long-gap),
  any loss/dup/stuck-state bug, the HLC-survives-restart confirmation.

## Done / verdict
GREEN only when federation recovers cleanly from instance/PG/box crash mid-drain with
no loss/dup, the outbox resumes, the topic re-joins, and HLC stays monotonic.
