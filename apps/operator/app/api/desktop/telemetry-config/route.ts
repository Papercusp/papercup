/**
 * GET /api/desktop/telemetry-config
 *
 * Browser-side init endpoint for posthog-js. Returns:
 *   { enabled: boolean, host?: string, project_key?: string }
 *
 * The browser instrumentation in app/_components/PostHogProvider.tsx
 * fetches this on mount; if !enabled, posthog-js is never initialized.
 *
 * Telemetry is OFF by default. The operator state is the source of
 * truth (set by the wizard's Step 12); env defaults fill in for the
 * host/key if the user opted in but didn't set workspace-specific
 * values.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readOperatorState } from '@/lib/operator-state-pg';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  return (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) {
    return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  }
  const state = await readOperatorState<{
    telemetry_enabled?: boolean;
    telemetry_host?: string;
    telemetry_project_key?: string;
  }>('setup_wizard_state');

  const enabled = Boolean(state?.telemetry_enabled);
  if (!enabled) {
    // Don't leak the project key when telemetry is off — return only
    // the flag.
    return NextResponse.json({ enabled: false });
  }
  return NextResponse.json({
    enabled: true,
    host: state?.telemetry_host || process.env.PAPERCUSP_POSTHOG_HOST || undefined,
    project_key:
      state?.telemetry_project_key || process.env.PAPERCUSP_POSTHOG_KEY || undefined,
  });
}
