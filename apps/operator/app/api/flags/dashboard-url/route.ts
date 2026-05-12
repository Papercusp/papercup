/**
 * GET /api/flags/dashboard-url
 *
 * Returns the URL to open in the operator's PostHog dashboard for the
 * feature-flag list. Used by the read-only /settings/flags page to render
 * a deep-link button. Returns 404 when PostHog is unconfigured.
 */
import { NextResponse } from 'next/server';

import { getPosthogConfig } from '../../../../lib/posthog-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  const config = getPosthogConfig();
  if (!config) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 404 });
  }
  const url = `${config.host.replace(/\/$/, '')}/project/@current/feature_flags`;
  return NextResponse.json({ ok: true, url });
}
