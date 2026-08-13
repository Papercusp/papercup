/**
 * `system:sweep-wedged-pty-hosts` — the registration seam for
 * {@link sweepWedgedPtyHosts} (EI-20287339148365013).
 *
 * Thin by design, matching `stalled-loops-action.ts`: the sweep logic lives in
 * `pty-host-wedge-guard.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `dry_run` — report matches without broadcasting or paging.
 *   - `min_consecutive_defers`, `min_streak_span_ms`, `recovery_idle_ms` — threshold
 *     overrides, for tightening the guard from the routine row without a deploy.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { sweepWedgedPtyHosts } from './pty-host-wedge-guard';

registerSystemAction('sweep-wedged-pty-hosts', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const result = await sweepWedgedPtyHosts({
    dryRun: cfg.dry_run === true,
    ...(typeof cfg.min_consecutive_defers === 'number'
      ? { minConsecutiveDefers: cfg.min_consecutive_defers }
      : {}),
    ...(typeof cfg.min_streak_span_ms === 'number' ? { minStreakSpanMs: cfg.min_streak_span_ms } : {}),
    ...(typeof cfg.recovery_idle_ms === 'number' ? { recoveryIdleMs: cfg.recovery_idle_ms } : {}),
  });

  if (result.wedged.length > 0) {
    // WARN, and naming the SAFETY split rather than just the count: the two populations
    // need opposite handling. An `idle` host can be replaced; a `busy` one is still
    // emitting output and must not be touched — it is working, it just cannot be reached.
    const idle = result.wedged.filter((w) => w.recoverySafety === 'idle');
    const busy = result.wedged.filter((w) => w.recoverySafety !== 'idle');
    console.warn(
      `[sweep-wedged-pty-hosts] WAKE-DEAF ${result.wedged.length}/${result.checked} live pty-host(s) — ` +
        `every wake deferred against a staged line that never moves. ${idle.length} idle (safe to ` +
        `replace), ${busy.length} still emitting (do NOT trample): ` +
        result.wedged.map((w) => `${w.ownerId}×${w.verdict.consecutiveDefers}`).join(', '),
    );
  }

  // An unreadable ledger is an ABSENCE OF EVIDENCE, not a clean bill of health, and it is
  // logged separately for that reason: a rising count here means the guard is going blind
  // (pruned/rotated ledgers, permissions, a renamed dir) while its wedged count — the
  // number anyone actually reads — would keep reporting a reassuring zero.
  if (result.unreadable.length > 0) {
    console.log(
      `[sweep-wedged-pty-hosts] ${result.unreadable.length}/${result.checked} host(s) had no readable ` +
        `lifecycle ledger — NOT a health verdict, these hosts were simply not observable this pass`,
    );
  }
});
