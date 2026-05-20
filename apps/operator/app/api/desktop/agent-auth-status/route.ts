/**
 * GET /api/desktop/agent-auth-status
 *
 * Per-provider sign-in detection for the Setup Wizard's logins step.
 * Returns whether each agent has a credentials file on disk. The
 * aggregate `logins` step status in /api/desktop/setup-status is the
 * OR of these; this endpoint breaks it out per-provider so each
 * provider card can show its own ✓.
 *
 * Loopback-only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { claudeSignedIn, ompSignedIn } from '@/lib/agent-auth-detect';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return NextResponse.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  let claude = false;
  let omp = false;
  try { claude = claudeSignedIn(); } catch { /* fs error → false */ }
  try { omp = ompSignedIn(); } catch { /* fs error → false */ }
  return NextResponse.json({ claude, omp });
}
