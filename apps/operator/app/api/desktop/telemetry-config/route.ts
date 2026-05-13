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
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ensureInstallId } from '@/lib/setup-wizard-install-id';
import { getPosthogConfigWithSource } from '@/lib/posthog-config';

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
  const installId = await ensureInstallId();
  const state = await readOperatorState<{ telemetry_enabled?: boolean }>('setup_wizard_state');

  const userOptedIn = Boolean(state?.telemetry_enabled);
  // PostHog must also be admin-bootstrapped via the shared resolver +
  // testingFeatures: true. This is the same privacy moat as feature
  // flags (see docs.papercupai.com/posthog). A shipped binary on a
  // fresh install has no discovery file → testingFeatures is false →
  // browser SDK never loads regardless of user opt-in.
  const phResolved = getPosthogConfigWithSource();
  const enabled = userOptedIn && phResolved.testingFeatures && Boolean(phResolved.config);
  if (!enabled) {
    return NextResponse.json({
      enabled: false,
      reason: !userOptedIn
        ? 'user-opt-out'
        : !phResolved.testingFeatures
          ? 'posthog-testing-features-off'
          : 'posthog-unconfigured',
    });
  }
  return NextResponse.json({
    enabled: true,
    host: phResolved.config!.host,
    project_key: phResolved.config!.projectKey,
    distinct_id: installId,
    workspace_id: activeWorkspaceId(),
  });
}
