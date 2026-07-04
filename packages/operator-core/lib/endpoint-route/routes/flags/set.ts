/**
 * POST /api/flags/set { key, enabled }
 *
 * Flips a single feature flag and broadcasts the change. With PostHog
 * configured the flip lands there (and any stale PG override for the key
 * is cleared so it can't shadow PostHog); without PostHog the flip lands
 * in the PG-backed override store (audit P-070, EI-76) — runtime flag
 * toggling on dev boxes with no PostHog and no process restart.
 * Used by the /admin/features UI.
 *
 * Ported from app/api/flags/set/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag, setFlagOverride } from '@papercusp/flags/server';
import { publishFlagChange } from '../../../flag-bus';
import '../../../flag-bus';
import { recordFlagAudit } from '../../../flag-audit';
import { defineTool } from '@papercusp/agent-mcp';

const Body = z.object({ key: z.string(), enabled: z.boolean() });

export default defineTool({
  method: 'POST',
  path: '/flags/set',
  auth: 'loopback',
  input: Body,
  async handler(req, ctx) {
    const { key: rawKey, enabled } = ctx.input;
    const key = rawKey as FlagKey;
    if (!ALL_FLAG_KEYS.includes(key)) {
      return Response.json({ ok: false, error: 'unknown flag key' }, { status: 400 });
    }
    const result = await setFlag(key, enabled);
    if (result.ok) {
      // The flip lives in PostHog now — drop any PG override so it can't
      // shadow later PostHog changes (best-effort; the flip itself is done,
      // and setFlagOverride reports failure in-band rather than throwing).
      await setFlagOverride(key, null);
      publishFlagChange(key);
      await recordFlagAudit(key, enabled, ctx.principal?.slug ?? 'operator', { backend: 'posthog' });
      return Response.json({ ok: true, key, enabled, backend: 'posthog' });
    }
    // EI-7088: fall back to the PG override store for ANY setFlag failure, not
    // just 'flag-backend-not-configured'. PostHog CONFIGURED-but-unreachable
    // (a fetch error, `list:<status>`, `patch:<status>`, or the flag simply not
    // existing there yet) previously fell straight to the 502 below with no
    // fallback attempt at all — during a PostHog outage NO existing-in-PostHog
    // flag could be toggled, including a kill-switch an operator might urgently
    // need to flip. The PG override is the same safe local mechanism already
    // used for the no-PostHog-configured case; using it here too keeps runtime
    // toggling working regardless of WHY the PostHog write failed.
    const override = await setFlagOverride(key, enabled);
    if (override.ok) {
      publishFlagChange(key);
      await recordFlagAudit(key, enabled, ctx.principal?.slug ?? 'operator', {
        backend: 'pg-override',
        posthogFailureReason: result.reason,
      });
      return Response.json({ ok: true, key, enabled, backend: 'pg-override', posthogFailureReason: result.reason });
    }
    return Response.json(
      { ok: false, error: `posthog: ${result.reason}; pg-override fallback also failed: ${override.reason}`, key },
      { status: 502 },
    );
  },
});
