/**
 * POST /api/agent-tokens/power-user
 *   body: { workspace?: string }
 *   returns: {
 *     access_token, access_expires_at,
 *     refresh_token, refresh_expires_at,
 *     workspace_id, user_id, auth_session_id
 *   }
 *
 * Issues an OAuth-style two-token pair for the `workspace-power-user`
 * auth tier. See docs/plans/omp-power-user-bundle-2026-05-20.md §4.1.
 *
 * Trust model: loopback-only, same as /api/agent-mcp/console/resolve.
 * The ConsoleLauncherButton calls this internally (Tauri → operator,
 * always 127.0.0.1) when the user picks `mode: 'omp'`. The resolved
 * user identity comes from the operator session cookie when present,
 * else the desktop's default user (single-user desktop, v1).
 *
 * Opening a session writes one row to harness_shared.power_user_sessions
 * — that row is the revocation surface.
 */
import { NextRequest } from 'next/server';

import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';
import { getSessionUserOrDefault } from '@/lib/auth';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { createPowerUserSession } from '@/lib/power-user-sessions';
import { mintAccessToken, mintRefreshToken } from '@/lib/power-user-token';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return Response.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const body = (await req.json().catch(() => ({}))) as { workspace?: string };
  try {
    const user = await getSessionUserOrDefault();
    const workspaceId = (body.workspace ?? '').trim() || activeWorkspaceId();

    const { authSessionId } = await createPowerUserSession({
      workspaceId,
      userId: user.id,
    });
    const access = await mintAccessToken({
      workspaceId,
      userId: user.id,
      authSessionId,
    });
    const refresh = await mintRefreshToken({ authSessionId });

    return Response.json({
      access_token: access.token,
      access_expires_at: new Date(access.exp * 1000).toISOString(),
      refresh_token: refresh.token,
      refresh_expires_at: new Date(refresh.exp * 1000).toISOString(),
      workspace_id: workspaceId,
      user_id: user.id,
      auth_session_id: authSessionId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'power-user token issue failed';
    return Response.json({ error: msg }, { status: 400 });
  }
}
