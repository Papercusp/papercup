/**
 * GET /api/desktop/telemetry-config
 *
 * Browser-side init endpoint for posthog-js. Returns:
 *   { enabled: boolean, host?: string, project_key?: string }
 *
 * The browser instrumentation in app/_components/PostHogProvider.tsx
 * fetches this on mount; if !enabled, posthog-js is never initialized.
 *
 * Gate: user opted in (telemetry_enabled === true)
 *       OR PAPERCUSP_INTERNAL_BUILD === 'true'.
 *
 * Host + projectKey resolve from env → discovery file → bundled
 * POSTHOG_PUBLIC_DEFAULTS so an opt-in alone is sufficient on shipped
 * binaries; no manual posthog.json drop required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readOperatorState } from '@/lib/operator-state-pg';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { ensureInstallId } from '@/lib/setup-wizard-install-id';
import { getPosthogConfigWithSource } from '@/lib/posthog-config';
import { POSTHOG_PUBLIC_DEFAULTS } from '@/lib/posthog-public-defaults';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function resolveHostKey(): { host: string; projectKey: string } {
  const envHost = process.env.PAPERCUSP_POSTHOG_HOST;
  const envKey = process.env.PAPERCUSP_POSTHOG_KEY;
  if (envHost && envKey) return { host: envHost, projectKey: envKey };
  const phResolved = getPosthogConfigWithSource();
  if (phResolved.config) {
    return { host: phResolved.config.host, projectKey: phResolved.config.projectKey };
  }
  return { host: POSTHOG_PUBLIC_DEFAULTS.host, projectKey: POSTHOG_PUBLIC_DEFAULTS.projectKey };
}

export async function GET(req: NextRequest) {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const installId = await ensureInstallId();
  const state = await readOperatorState<{ telemetry_enabled?: boolean }>('setup_wizard_state');

  const userOptedIn = Boolean(state?.telemetry_enabled);
  const internalBuild = process.env.PAPERCUSP_INTERNAL_BUILD === 'true';
  // Never ship dev clicks/sessions to production PostHog. The flags
  // endpoint at flags.papercuspai.com also redirects unauthenticated
  // requests, which triggers CORS preflight failures in the browser
  // console even for non-fatal config loads.
  if (process.env.NODE_ENV !== 'production') {
    return NextResponse.json({ enabled: false, reason: 'dev-mode' });
  }
  const enabled = userOptedIn || internalBuild;
  if (!enabled) {
    return NextResponse.json({ enabled: false, reason: 'user-opt-out' });
  }
  const { host, projectKey } = resolveHostKey();
  return NextResponse.json({
    enabled: true,
    host,
    project_key: projectKey,
    distinct_id: installId,
    workspace_id: activeWorkspaceId(),
  });
}
