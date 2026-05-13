/**
 * GET /api/flags/bootstrap
 *
 * Returns the resolved feature-flag payload for the calling user. Clients
 * (Tauri, browser, mobile) call this once at startup and again whenever the
 * /api/flags/stream SSE event tells them a flag changed.
 *
 * If PostHog is unconfigured or unreachable, the payload is FLAG_DEFAULTS
 * (all features off — V1 ship state). Fail-safe-closed.
 */
import { NextResponse } from 'next/server';

import { getAllFlags } from '@papercusp/flags/server';

import { resolveDistinctId } from '../../../../lib/flag-distinct-id';

// Force this route to run on every request so we always reflect the live
// PostHog state. The library caches flag definitions for several seconds
// internally, so this is not actually a per-call PostHog round-trip.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const distinctId = resolveDistinctId(req);
  const payload = await getAllFlags(distinctId);
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
