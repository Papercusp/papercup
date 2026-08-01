/**
 * `system:gc-verify-instances` — the registration seam for {@link gcVerifyInstances}.
 *
 * Thin by design, matching `gc-dead-loops-action.ts`: every safety condition and the
 * reason for it lives in `gc-verify-instances.ts`; this file only puts it on a cadence.
 *
 * Config (routine `trigger_config`, all optional):
 *   - `ttl_hours`   — override VERIFY_INSTANCE_TTL_HOURS_DEFAULT (6).
 *   - `max_per_run` — override VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT (50).
 *   - `tmp_dir`     — override the scan root (default /tmp).
 *   - `dry_run`     — report matches without killing or deleting.
 *
 * HOST-LOCAL, not workspace-scoped: it reaps files and processes on the machine the
 * tick runs on. `ctx.workspaceId` is deliberately unused — there is nothing
 * multi-tenant about /tmp.
 *
 * The log line names the freed bytes and a sample of dirs rather than a bare count:
 * an unattended sweep that deletes 300GB should say what it deleted.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { gcVerifyInstances } from './gc-verify-instances';

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

registerSystemAction('gc-verify-instances', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const ttlHours = Number(cfg.ttl_hours);
  const maxPerRun = Number(cfg.max_per_run);
  const result = await gcVerifyInstances({
    dryRun: cfg.dry_run === true,
    ...(typeof cfg.tmp_dir === 'string' && cfg.tmp_dir ? { tmpDir: cfg.tmp_dir } : {}),
    ...(Number.isFinite(ttlHours) && ttlHours > 0 ? { ttlHours } : {}),
    ...(Number.isFinite(maxPerRun) && maxPerRun > 0 ? { maxPerRun } : {}),
  });
  if (result.reaped > 0) {
    const sample = result.instances
      .filter((i) => !i.skipped)
      .slice(0, 5)
      .map((i) => `${i.dir.split('/').pop()} (${Math.round(i.ageHours)}h)`)
      .join(', ');
    console.log(
      `[gc-verify-instances] ${result.dryRun ? 'would reap' : 'reaped'} ${result.reaped} abandoned ` +
        `verify instance(s) older than ${result.ttlHours}h, freeing ${gib(result.bytesFreed)} — ${sample}`,
    );
  }
  // A refusal is worth a line of its own: it is the guard doing its job, and silence
  // would make a permanently-skipped dir invisible.
  const refused = result.instances.filter((i) => i.skipped?.includes('refusing'));
  if (refused.length > 0) {
    console.warn(
      `[gc-verify-instances] REFUSED ${refused.length} dir(s): ` +
        refused.map((i) => `${i.dir.split('/').pop()} — ${i.skipped}`).join('; '),
    );
  }
});
