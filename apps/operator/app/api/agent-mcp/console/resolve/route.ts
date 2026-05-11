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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  if (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  ) {
    return true;
  }
  const xfwd = req.headers.get('x-forwarded-for') ?? '';
  if (xfwd && !xfwd.startsWith('127.') && xfwd !== '::1') return false;
  return host.endsWith(':3055') || host.endsWith(':3070');
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isLoopback(req)) {
    return Response.json({ error: 'loopback only' }, { status: 403 });
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
