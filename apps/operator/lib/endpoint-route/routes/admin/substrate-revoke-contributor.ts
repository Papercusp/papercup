/**
 * POST /api/admin/substrate/revoke-contributor
 *
 * Plan: substrate-revocation-v2 Component B / D-005.
 *
 * OWNER action: revoke a bad-actor contributor by deleting their
 * `user/<github_user_id>` branch on GitHub (their Channel-2 binding
 * artifact). Once deleted, Component A's re-verify loop drops them
 * from live federation on its next cycle.
 *
 * DESTRUCTIVE: this deletes a GitHub branch. Only a repo admin may
 * invoke this endpoint (enforced via the `repos.get` admin-check in
 * the core — and the `auth: { trust: ['verified', 'trusted'] }` gate
 * at the operator level).
 *
 * Auth: `{ trust: ['verified', 'trusted'] }` — same gate as the sibling
 * admin substrate endpoints. Admin-only.
 *
 * Core logic is `handleRevokeContributor(input, deps)` (deps injected)
 * so it's unit-testable without a live GitHub / substrate.
 *
 * Status-code mapping:
 *   ok:true              → 200
 *   not_admin            → 403 (caller's gh token is not a repo admin)
 *   no_context           → 404 (harness not shared / gh not authed)
 *   bad input            → 400 (missing/invalid fields, non-int githubUserId)
 *   github_error         → 502 (upstream GitHub API failure)
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  revokeContributorViaGithub,
  type RevokeContributorSeams,
} from '@/lib/sync/hyperbee/revoke-contributor';

// ─── injectable core ──────────────────────────────────────────────────────────

export interface RevokeContributorEndpointInput {
  workspaceId: string;
  harnessSlug: string;
  githubUserId: number;
}

export interface RevokeContributorEndpointDeps {
  revoke: (
    input: RevokeContributorEndpointInput,
    seams?: RevokeContributorSeams,
  ) => ReturnType<typeof revokeContributorViaGithub>;
}

const realDeps: RevokeContributorEndpointDeps = {
  revoke: (input) => revokeContributorViaGithub(input),
};

function parseBody(body: unknown): RevokeContributorEndpointInput | { error: string } {
  if (body === null || typeof body !== 'object') {
    return { error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const workspaceId = typeof b.workspaceId === 'string' ? b.workspaceId.trim() : '';
  const harnessSlug = typeof b.harnessSlug === 'string' ? b.harnessSlug.trim() : '';

  if (!workspaceId) return { error: 'workspaceId is required and must be a non-empty string' };
  if (!harnessSlug) return { error: 'harnessSlug is required and must be a non-empty string' };

  // githubUserId must be a positive integer.
  const rawId = b.githubUserId;
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return {
      error:
        'githubUserId is required and must be a positive integer (the numeric GitHub user id, not the login)',
    };
  }

  return { workspaceId, harnessSlug, githubUserId: rawId };
}

export async function handleRevokeContributor(
  input: RevokeContributorEndpointInput,
  deps: RevokeContributorEndpointDeps = realDeps,
): Promise<Response> {
  const result = await deps.revoke(input);

  if (result.ok) {
    return Response.json(result);
  }

  switch (result.code) {
    case 'not_admin':
      return Response.json(
        {
          error:
            'The authenticated GitHub token does not have admin permissions on the shared repo — only repo admins may revoke another contributor',
          code: result.code,
        },
        { status: 403 },
      );
    case 'no_context':
      return Response.json(
        {
          error:
            'No shared repo context found — the harness may not be shared, or gh is not authenticated (`gh auth login`)',
          code: result.code,
        },
        { status: 404 },
      );
    case 'github_error':
      return Response.json(
        {
          error: 'GitHub API returned an unexpected error',
          code: result.code,
          detail: result.detail,
        },
        { status: 502 },
      );
    default: {
      // TypeScript exhaustiveness guard.
      const _never: never = result;
      return Response.json({ error: 'unexpected error', detail: String(_never) }, { status: 500 });
    }
  }
}

// ─── endpoint ─────────────────────────────────────────────────────────────────

const post = defineTool({
  method: 'POST',
  path: '/admin/substrate/revoke-contributor',
  // Admin-only: same trust gate as the self-revoke and dogfood-substrate-health
  // endpoints (per D-005 decision).
  auth: { trust: ['verified', 'trusted'] },
  async handler(req) {
    const body = await req.json().catch(() => null);
    const parsed = parseBody(body);
    if ('error' in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    return handleRevokeContributor(parsed);
  },
});

export default [post];
