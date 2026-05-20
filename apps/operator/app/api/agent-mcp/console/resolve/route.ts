/**
 * POST /api/agent-mcp/console/resolve
 *   body: { slug?: string | null }
 *   returns: ConsoleEnvelope (see lib/console-launcher.ts)
 *
 * Loopback-only admin endpoint that the `+` console-launcher button
 * (via Tauri) calls to get the cwd / env / .mcp.json body needed to
 * open a native terminal.
 *
 * Trust model: same as /api/agent-mcp/el-admin-creds — if the request
 * comes from 127.0.0.1 we trust it. The returned `.mcp.json` body
 * contains the superuser bearer token only when the token file exists;
 * if it doesn't, the response flags `needsSuperuserBootstrap: true` and
 * the Tauri caller is expected to install it before writing the file.
 */
import { NextRequest } from 'next/server';

import { activeWorkspaceId } from '@/lib/workspace-registry';
import { buildConsoleEnvelope } from '@/lib/console-launcher';
import { PrincipalCheckError, requirePrincipal } from '@/lib/auth/require-principal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  // Console-launcher: any authenticated principal can resolve the
  // envelope. The returned .mcp.json body intentionally contains the
  // superuser bearer only when the token file already exists on
  // disk; that's the actual trust gate, not the request principal.
  try {
    await requirePrincipal(req.headers);
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return Response.json({ error: err.reason }, { status: err.status });
    }
    throw err;
  }
  const body = (await req.json().catch(() => ({}))) as { slug?: string | null };
  const workspaceId = activeWorkspaceId();
  try {
    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: body.slug ?? null,
      operatorBaseUrl: new URL(req.url).origin,
    });
    return Response.json(envelope);
  } catch (e: any) {
    return Response.json({ error: e?.message ?? 'console-resolve failed' }, { status: 400 });
  }
}
