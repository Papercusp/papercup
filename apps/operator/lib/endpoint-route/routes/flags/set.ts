/**
 * POST /api/flags/set { key, enabled }
 *
 * Flips a single feature flag in PostHog and broadcasts the change.
 * Used by the /admin/features UI.
 *
 * Ported from app/api/flags/set/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '@/lib/flag-bus';
import '@/lib/flag-bus';
import { defineTool } from '@papercusp/agent-mcp';

const Body = z.object({ key: z.string(), enabled: z.boolean() });

export default defineTool({
  method: 'POST',
  path: '/flags/set',
  auth: 'public',
  input: Body,
  async handler(_req, ctx) {
    const { key: rawKey, enabled } = ctx.input;
    const key = rawKey as FlagKey;
    if (!ALL_FLAG_KEYS.includes(key)) {
      return Response.json({ ok: false, error: 'unknown flag key' }, { status: 400 });
    }
    const result = await setFlag(key, enabled);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.reason, key }, { status: 502 });
    }
    publishFlagChange(key);
    return Response.json({ ok: true, key, enabled });
  },
});
