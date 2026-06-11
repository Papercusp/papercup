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
      return Response.json({ ok: true, key, enabled, backend: 'posthog' });
    }
    if (result.reason === 'flag-backend-not-configured') {
      const override = await setFlagOverride(key, enabled);
      if (override.ok) {
        publishFlagChange(key);
        return Response.json({ ok: true, key, enabled, backend: 'pg-override' });
      }
      return Response.json(
        { ok: false, error: override.reason, key },
        { status: 502 },
      );
    }
    return Response.json({ ok: false, error: result.reason, key }, { status: 502 });
  },
});
