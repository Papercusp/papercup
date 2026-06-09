/**
 * `system:session-dir-gc` — the periodic janitor for the per-session isolation
 * dirs (`session-claude/`, `session-mcp/`, `su-codex-homes/`, the legacy
 * `role-codex-homes/`) that the launch paths materialize and never clean up. The
 * EI-155 follow-on the unify-launch-mechanics work surfaced; design + safety
 * model live in `session-dir-gc.ts`.
 *
 * Runs as ONE durable step (the system-actions contract) — safe to re-run from
 * the top: the sweep is idempotent (a removed dir simply isn't rediscovered, and
 * removal is `force`), and the protected-set is re-gathered each tick.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `retention_days` — collect a not-live, not-resumable dir once unmaterialized
 *     this long (default 7).
 *   - `dry_run` — plan + log but remove nothing (handy to preview a first run).
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { runSessionDirGc, DEFAULT_RETENTION_MS } from '../../session-dir-gc';

registerSystemAction('session-dir-gc', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const retentionDays = Number(cfg.retention_days);
  const retentionMs =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays * 24 * 60 * 60 * 1000
      : DEFAULT_RETENTION_MS;
  const dryRun = cfg.dry_run === true;

  const result = await runSessionDirGc({ retentionMs, dryRun });
  console.log(
    `[session-dir-gc] scanned ${result.scanned} dir(s) → ` +
      `${result.dryRun ? 'WOULD remove' : 'removed'} ${result.removed.length}, ` +
      `kept ${result.keptProtected} live/resumable + ${result.keptFresh} within retention` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : '') +
      ` (retention ${Math.round(retentionMs / 86_400_000)}d)`,
  );
  if (result.errors.length) {
    for (const e of result.errors) console.warn(`[session-dir-gc]   ! ${e.path}: ${e.error}`);
  }
});
