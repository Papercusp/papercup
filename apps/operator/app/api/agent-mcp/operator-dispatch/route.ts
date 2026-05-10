/**
 * POST /api/agent-mcp/operator-dispatch
 *
 * Server-side proxy that dispatches a card on behalf of the operator
 * principal. The operator's bearer token lives in
 * <workspace>/system/operator/config.json and never ships to the browser
 * — this route holds it server-side and forwards the request to
 * /api/admin/execute-action with the bearer attached.
 *
 * Why a separate route (vs. relaxing /api/admin/execute-action to
 * accept session cookies):
 *   - execute-action's contract is "bearer-derived caller", used by
 *     harness agents through MCP. Mixing session-auth into the same
 *     endpoint would conflate identity sources and complicate audit.
 *   - The operator-as-UI-dispatcher case is its own flow; isolating it
 *     keeps each endpoint with one auth model and one caller identity.
 *
 * Request body (flat shape — matches what OperatorPanel + the
 * background scanner already send):
 *   {
 *     op: 'send_message' | ...,
 *     to?: string[],
 *     kind?: string,
 *     subject?: string,
 *     body?: string,
 *     reason?: string,
 *     ...op-specific fields
 *   }
 *
 * Response: passthrough from /api/admin/execute-action.
 */

import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { papercuspPath } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readSystemPrincipal } from '@/lib/system-principal';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SystemPrincipalConfig {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

function seedToUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function loadOperatorBearer(): Promise<SystemPrincipalConfig | null> {
  const p = await readSystemPrincipal('operator');
  return p ? { bearer: p.bearer, name: p.name, workspaceId: p.workspaceId, capabilities: p.capabilities } : null;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: 'unauthenticated', detail: 'no session' },
      { status: 401 },
    );
  }

  const principal = await loadOperatorBearer();
  if (!principal) {
    return NextResponse.json(
      { ok: false, error: 'operator_not_provisioned', detail: 'POST /api/agent-mcp/provision first' },
      { status: 503 },
    );
  }
  const workspaceId = activeWorkspaceId();
  if (principal.workspaceId !== workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'workspace_mismatch', detail: `file=${principal.workspaceId} active=${workspaceId}` },
      { status: 503 },
    );
  }

  let flat: Record<string, unknown>;
  try {
    flat = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'validation_error', detail: 'invalid JSON body' },
      { status: 400 },
    );
  }
  if (!flat || typeof flat !== 'object' || typeof flat.op !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'validation_error', detail: 'op required' },
      { status: 400 },
    );
  }

  // Wrap the flat client shape into execute-action's { actionId, action }.
  // execute-action requires actionId to be UUID-formatted. Clients pass a
  // semantic seed (e.g. `${card.id}:dispatch`) for idempotency; we hash it
  // into UUID shape here. No seed = fresh UUID (no idempotency).
  const seed =
    typeof flat.actionId === 'string' && flat.actionId.length > 0
      ? flat.actionId
      : null;
  const actionId = seed ? seedToUuid(seed) : randomUUID();
  const { actionId: _unused, ...actionFields } = flat;
  const wrapped = { actionId, action: actionFields };

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? `http://localhost:${process.env.PORT ?? '3055'}`;
  const upstream = await fetch(`${operatorBase}/api/admin/execute-action`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${principal.bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(wrapped),
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
