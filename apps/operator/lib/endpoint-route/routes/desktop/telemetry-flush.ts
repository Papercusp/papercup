/**
 * POST /api/desktop/telemetry-flush — flush buffered telemetry now.
 *
 * Ported from app/api/desktop/telemetry-flush/route.ts. `auth: {}`.
 */
import { flushTelemetry } from '@/lib/telemetry-flush';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'POST',
  path: '/desktop/telemetry-flush',
  auth: {},
  async handler() {
    try {
      const result = await flushTelemetry();
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  },
});
