/**
 * `system:idle-session-reaper` — the P-011 (D-007) idle-session reaper.
 *
 * Marks DEAD-process open `adv_sessions` rows ended (owner dropped out of the
 * liveness set past the grace window), reclaiming the live roster + unblocking
 * `session-dir-gc` (which protects every `ended_at IS NULL` row). Design +
 * safety model live in `idle-session-reaper.ts`.
 *
 * DOUBLE-GATED + safe: flag-gated DEFAULT-OFF (FLAGS.IDLE_SESSION_REAPER → a
 * no-op until armed) AND the routine is seeded INACTIVE. This slice only ever
 * touches sessions whose process is already dead — it never terminates a live
 * session (that's the follow-on slice; see the plan).
 *
 * trigger_config (optional): `dry_run` — plan + log, mark nothing.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { readCoordLivenessConfig } from '../../coord-liveness-config';
import {
  runIdleSessionReap,
  findIdleLiveSessions,
  terminateIdleLiveSessions,
  reapZombieResumeProcs,
  reclaimDanglingInboxWakeAwaits,
} from '../../idle-session-reaper';
import { sweepEndedPresence, PRESENCE_ENDED_REAP_MS } from '../../agent-tools/coordination/presence';
import { gatherOnDesktopSessions } from '../../desktop-window-liveness';
import { gatherViewerAttachedOwners } from '../../pty-viewer-heartbeat';

registerSystemAction('idle-session-reaper', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const dryRun = cfg.dry_run === true;

  // Presence-row reaper (dead-row-retention fix) — evict genuinely-ENDED
  // coord_presence rows (stale beyond a short TTL + NO live inbox-wake await),
  // sparing parked (wakeable) + on-desktop/viewer sessions. This ALSO runs on the
  // always-on coord:presence read path; firing it here keeps the roster bounded even
  // when nothing is reading it. Deleting a dead, not-wakeable row is non-destructive
  // (a live owner re-creates its row on the next heartbeat), so — unlike the
  // process-killing slices below — it needs no flag + no dry-run gate. Best-effort.
  try {
    const [onDesktop, viewers] = await Promise.all([
      gatherOnDesktopSessions().then((s) => s.owners).catch(() => new Set<string>()),
      gatherViewerAttachedOwners().catch(() => new Set<string>()),
    ]);
    const protectedOwners = new Set<string>([...onDesktop, ...viewers]);
    const reaped = await sweepEndedPresence({ ttlMs: PRESENCE_ENDED_REAP_MS, protectedOwners });
    if (reaped > 0) {
      console.log(`[idle-session-reaper] presence-row reap: evicted ${reaped} ended coord_presence row(s)`);
    }
  } catch (e) {
    console.warn('[idle-session-reaper] presence-row reap failed (non-fatal):', (e as Error)?.message ?? e);
  }

  // Slice 3 (EI-1873) FIRST — the dominant fleet leak: ZOMBIE `claude --resume`
  // procs whose adv_session is ENDED but the process never exited (32 of them
  // wedged the box on 2026-06-20). Deterministic (ended session + live proc) and
  // starvation-independent — unlike the presence-based slices below, it does not
  // depend on the supervisor heartbeat the overload starves. DOUBLE-GATED.
  const zomb = await reapZombieResumeProcs({ dryRun });
  if (zomb.enabled) {
    console.log(
      `[idle-session-reaper] zombie-proc reap: scanned ${zomb.scannedProcs} resume-proc(s) → ` +
        `${zomb.dryRun ? 'WOULD kill' : 'killed'} ${zomb.zombies} zombie(s)` +
        (zomb.killedPids.length
          ? ` [pids: ${zomb.killedPids.slice(0, 20).join(',')}${zomb.killedPids.length > 20 ? ',…' : ''}]`
          : ''),
    );
  }

  // Read-only D-007 saturation metric — the LIVE-but-idle cohort (the sessions
  // that actually hold the event loop). Slice 2 terminates these (double-gated);
  // surfacing the count + the target list keeps the cohort visible even when the
  // terminate flag is off.
  const idleLive = await findIdleLiveSessions();
  console.log(
    `[idle-session-reaper] live-but-idle sessions: ${idleLive.length}` +
      (idleLive.length
        ? ` (oldest idle ~${Math.round(Math.max(...idleLive.map((s) => s.idleMs)) / 3_600_000)}h) — ` +
          `slice-2 termination target [ids: ${idleLive.slice(0, 20).map((s) => s.advSessionId).join(',')}${idleLive.length > 20 ? ',…' : ''}]`
        : ''),
  );

  // Live-but-idle TERMINATION (slice 2 / WI-152) — DOUBLE-GATED DEFAULT-OFF
  // (a no-op unless BOTH IDLE_SESSION_REAPER and IDLE_SESSION_REAPER_TERMINATE
  // are on). Ctrl-C → SIGKILL → mark ended; busy owners already excluded.
  const term = await terminateIdleLiveSessions({ dryRun });
  if (term.enabled) {
    console.log(
      `[idle-session-reaper] live-idle terminate: targeted ${term.targeted} → ` +
        `${term.dryRun ? 'WOULD terminate' : 'terminated'} ${term.terminated}, failed ${term.failed}` +
        (term.terminatedIds.length
          ? ` [ids: ${term.terminatedIds.slice(0, 20).join(',')}${term.terminatedIds.length > 20 ? ',…' : ''}]`
          : ''),
    );
  } else {
    console.log(
      '[idle-session-reaper] terminate flags off (need papercusp-idle-session-reaper + papercusp-idle-session-reaper-terminate) — live-idle termination skipped',
    );
  }

  // Dead-process ghost reap (slice 1) — flag-gated DEFAULT-OFF.
  // live-configurability-audit P-014: apply the session-reaper grace override (undefined ⇒ default).
  const livenessCfg = await readCoordLivenessConfig();
  const r = await runIdleSessionReap({ dryRun, graceMs: livenessCfg.sessionReaperGraceMs });
  if (!r.enabled) {
    console.log('[idle-session-reaper] reap flag off (papercusp-idle-session-reaper) — ghost reap skipped');
    return;
  }
  console.log(
    `[idle-session-reaper] scanned ${r.scanned} open session(s) → ` +
      `${r.dryRun ? 'WOULD end' : 'ended'} ${r.reaped} dead-process ghost(s), ` +
      `kept ${r.keptLive} live (${r.keptOnDesktop} on-desktop/hard-exempt)` +
      (r.reapedIds.length
        ? ` [ids: ${r.reapedIds.slice(0, 20).join(',')}${r.reapedIds.length > 20 ? ',…' : ''}]`
        : ''),
  );

  // Slice 4 — RECLAIM-LANE (fleet-dispatch-wake-clarity P-004): GC the dangling
  // inbox-wake awaits of DEAD sessions so a coordinator's coord:presence /
  // fetchWakeability stops showing them as `wakeable`/`parked` dispatch targets
  // (the "misleading zombie pile") and the ghost-reap above stops being
  // protection-polluted by them. Non-destructive (cancels a DB await row, touches
  // no process) → rides the single IDLE_SESSION_REAPER master flag.
  const aw = await reclaimDanglingInboxWakeAwaits({ dryRun });
  if (aw.enabled) {
    console.log(
      `[idle-session-reaper] await-reclaim: scanned ${aw.scanned} inbox-wake await owner(s) → ` +
        `${aw.deadOwners} dead → ${aw.dryRun ? 'WOULD cancel' : 'cancelled'} ${aw.cancelled} await(s)` +
        (aw.sampleOwners.length
          ? ` [owners: ${aw.sampleOwners.slice(0, 10).join(',')}${aw.deadOwners > 10 ? ',…' : ''}]`
          : ''),
    );
  }
});
