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
});
