/**
 * GET /api/runtime-config — surfaces request-time env values to the
 * browser (the desktop picks zero-cache's port at runtime).
 * Ported from app/api/runtime-config/route.ts.
 */
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/runtime-config',
  auth: 'public',
  handler() {
    return Response.json({
      zeroServer:
        process.env.HARNESS_ZERO_INTERNAL_SERVER ??
        process.env.NEXT_PUBLIC_ZERO_SERVER ??
        null,
    });
  },
});
