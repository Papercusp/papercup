/**
 * GET /api/runtime-config
 *
 * Tiny JSON endpoint that surfaces process.env values to the browser at
 * REQUEST TIME (vs build time). Necessary because:
 *
 *   - Next.js inlines NEXT_PUBLIC_* env vars at `next build` time.
 *   - The desktop bundle picks zero-cache's port at runtime (port-pick
 *     to avoid collisions across workspaces). At build time we don't
 *     know the port yet.
 *   - Therefore NEXT_PUBLIC_ZERO_SERVER can't carry the port — it would
 *     be empty in the client bundle.
 *
 * Solution: client fetches this endpoint on mount, gets the live URL,
 * and only THEN constructs the SyncProvider. One extra fetch per page
 * load; negligible compared to streamed Zero's savings.
 *
 * Web (Hetzner) deploy can either keep using NEXT_PUBLIC_ZERO_SERVER as
 * the build-time URL (it knows zero-cache's URL at build time —
 * https://zero-papercup.papercupai.com), or use the same runtime-config
 * path. Both work.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    zeroServer:
      process.env.HARNESS_ZERO_INTERNAL_SERVER
        ?? process.env.NEXT_PUBLIC_ZERO_SERVER
        ?? null,
  });
}
