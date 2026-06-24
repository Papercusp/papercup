/**
 * POST /api/desktop/bootstrap-hive/start
 *
 * Trigger the `papercusp` dogfood clone-on-first-boot RIGHT NOW (don't wait for
 * the next operator boot). The setup wizard fires this once the GitHub step
 * completes — the boot-time trigger no-ops when `gh` isn't signed in yet, so on
 * a fresh install the clone would otherwise not start until a later restart.
 *
 * Single-flight + idempotent (startBootstrapPapercuspHive): a boot trigger + a
 * wizard trigger share ONE run; a re-POST while it's cloning is a no-op. Returns
 * the well-known `progressId` IMMEDIATELY (fire-and-forget) so the wizard can
 * subscribe to `hiveFromRepo.progress` and render the banner / gate; it does NOT
 * block on the multi-GB clone.
 *
 * `auth: 'loopback'` — localhost-only by the sidecar bind. Flag-gated on
 * DOGFOOD_PAPERCUSP_HIVE (same as the boot path).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  startBootstrapPapercuspHive,
  BOOTSTRAP_PROGRESS_ID,
} from '../../../harness/bootstrap-papercusp-hive';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'POST',
    path: '/desktop/bootstrap-hive/start',
    auth: 'loopback',
    async handler() {
      try {
        if (!(await getFlag(FLAGS.DOGFOOD_PAPERCUSP_HIVE, 'system'))) {
          return new Response(
            JSON.stringify({ ok: true, started: false, reason: 'flag_off', progressId: BOOTSTRAP_PROGRESS_ID }),
            { status: 200, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
          );
        }
        // Fire-and-forget: kick the single-flight, return the progressId now.
        // The promise rejects only on an unforeseen error — swallow so a wedged
        // clone never crashes the host; the banner surfaces a clone error step.
        const { progressId, done } = startBootstrapPapercuspHive();
        void done.catch(() => {});
        return new Response(
          JSON.stringify({ ok: true, started: true, progressId }),
          { status: 200, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }),
          { status: 500, headers: { 'content-type': 'application/json', ...CORS_HEADERS } },
        );
      }
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/bootstrap-hive/start',
    auth: 'public',
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
