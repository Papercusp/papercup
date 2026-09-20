/**
 * `system:gate-watcher-tick` — the cadence wrapper for the client-agnostic
 * session-gate transcript watcher (owner-inbox-single-pane-2026-07-17 P-002;
 * design + idempotency model in `gate-watch.ts`).
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run:
 * every file delta is fenced by its own byte watermark (session_gate_watcher_files).
 *
 * Config (routine `trigger_config`, all optional):
 *   - `root`      — transcript root (default `~/.claude/projects`).
 *   - `max_files` — per-tick file cap (default 5000).
 */
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { tickGateWatch } from './gate-watch';
import { sweepSessionIndependentGates } from './gate-reaper';

registerSystemAction('gate-watcher-tick', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const maxFiles = Number(cfg.max_files);
  const result = await tickGateWatch({
    root: typeof cfg.root === 'string' && cfg.root.length > 0 ? cfg.root : undefined,
    maxFilesPerTick: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined,
  });
  console.log(
    `[gate-watch] scanned ${result.scannedFiles} transcript(s) → ${result.opened} opened, ` +
      `${result.alreadyOpen} already-open, ${result.closed} closed` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
  );
  for (const e of result.errors.slice(0, 5)) console.warn(`[gate-watch]   ! ${e.file}: ${e.error}`);

  // WI-10002067: the SESSION-INDEPENDENT half. The watcher above can only ever
  // close a gate whose asking session is alive to be observed, which is why 241
  // gates had accumulated with no code path able to discharge them. This runs
  // inside the existing handler deliberately — the brief forbids a new routine,
  // and the repo's scheduling rule bans adding a third mechanism.
  //
  // Isolated in its own try/catch because it is ADDITIVE: it requires migration
  // 1185's columns, so on a host where that has not been applied yet it must
  // degrade to a logged warning rather than take the transcript watcher — which
  // predates it and is independently useful — down with it.
  try {
    const swept = await sweepSessionIndependentGates({
      unknownGoneAfterMs: readPositiveMs(cfg.unknown_gone_after_ms),
      limit: readPositiveMs(cfg.sweep_limit),
    });
    console.log(
      `[gate-reaper] examined ${swept.examined} open gate(s) → ${swept.closedAskerGone} asker_gone, ` +
        `${swept.closedDefaultApplied} default_applied; skipped ` +
        `${swept.skipped['asker-live']} live / ${swept.skipped['asker-unknown-within-grace']} within-grace` +
        (swept.truncatedByLimit ? ' — TRUNCATED BY LIMIT, more remain' : ''),
    );
  } catch (err) {
    console.warn(`[gate-reaper]   ! sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/** `undefined` for anything not a usable positive number, so the callee's own
 *  default applies rather than a NaN silently disabling a bound. */
function readPositiveMs(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
