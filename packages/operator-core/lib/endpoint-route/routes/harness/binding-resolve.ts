/**
 * POST /api/harness/binding/resolve — resolve a GitHub remote to its canonical
 * repo identity + any existing shared-harness binding (Phase 1b P-068 route).
 *
 * The missing link the ShareWizard's step-2 binding lookup calls. Until now the
 * binding SERVICE (binding-service.ts: resolveRepoIdentity, createUnclaimedBinding)
 * was in tree but UNEXPOSED over HTTP, so the wizard's
 * fetch('/api/harness/binding/resolve') 404'd → github_repository_id was never
 * resolved → share/finalize would then 400 on a non-positive id. This wraps the
 * service so the wizard's binding step works end-to-end.
 *
 * Returns the wizard's BindingResolveResult:
 *   { github_repository_id, github_owner, github_repo, existing_binding }
 * The repo id is resolved from GitHub EVEN with no binding row (it derives the
 * swarm topic in shared.json). Needs an authenticated gh-token (getOctokit);
 * without one the service throws GITHUB_API_DOWN → 502.
 *
 * Core logic is `resolveBinding(remote, deps)` (deps injected) so it's unit-
 * testable without GitHub/PG; the handler wires the real `resolveRepoIdentity`
 * and maps BindingServiceError codes onto HTTP.
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  resolveRepoIdentity,
  parseGithubRepoUrl,
  type RepoIdentity,
} from '../../../harness/binding-service';
import {
  BindingServiceErrorThrowable,
  type BindingServiceError,
  type BindingClaimStatus,
} from '../../../harness/binding-types';

/** Wizard-facing result shape (mirrors ShareWizard's BindingResolveResult). */
export interface BindingResolveResult {
  github_repository_id: number;
  github_owner: string;
  github_repo: string;
  /** GitHub repo visibility — the wizard uses this to reject shared-public on a
   *  private repo at the privacy step (Cupboard refuses private repos). */
  private: boolean;
  existing_binding: null | {
    harness_topic: string;
    harness_slug: string;
    claim_status: BindingClaimStatus;
    publisher_github_login: string;
  };
}

export interface ResolveBindingDeps {
  /** Resolve a GitHub URL → canonical id/owner/repo + any existing binding row. */
  resolveIdentity: (githubUrl: string) => Promise<RepoIdentity>;
}

/** Raised on bad input; the handler maps it to a 4xx. */
export class ResolveBindingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ResolveBindingError';
  }
}

/**
 * Resolve `github_remote` to the wizard's BindingResolveResult. Rejects an
 * absent/unparseable remote with a 400 BEFORE hitting GitHub. GitHub/service
 * failures surface as the service's BindingServiceErrorThrowable (mapped to
 * HTTP by the handler).
 */
export async function resolveBinding(
  remote: string,
  deps: ResolveBindingDeps,
): Promise<BindingResolveResult> {
  if (!remote || typeof remote !== 'string') {
    throw new ResolveBindingError('github_remote required', 400);
  }
  if (!parseGithubRepoUrl(remote)) {
    throw new ResolveBindingError(`unparseable GitHub remote: ${remote}`, 400);
  }
  const id = await deps.resolveIdentity(remote);
  const b = id.existing_binding;
  return {
    github_repository_id: id.github_repository_id,
    github_owner: id.github_owner,
    github_repo: id.github_repo,
    private: id.private,
    existing_binding: b
      ? {
          harness_topic: b.harness_topic,
          harness_slug: b.harness_slug,
          claim_status: b.claim_status,
          publisher_github_login: b.provisional_owner_github_login,
        }
      : null,
  };
}

/** Map a BindingServiceError to an HTTP status + optional Retry-After (seconds). */
export function httpForBindingError(
  err: BindingServiceError,
): { status: number; retryAfterSec?: number } {
  switch (err.code) {
    case 'GITHUB_REPO_NOT_FOUND':
      return { status: 404 };
    case 'GITHUB_REPO_PRIVATE_NO_ACCESS':
      return { status: 403 };
    case 'GITHUB_API_RATE_LIMIT':
      return { status: 429, retryAfterSec: Math.ceil(err.retry_after_ms / 1000) };
    case 'GITHUB_API_DOWN':
      return { status: 502 };
    default:
      // BINDING_* variants shouldn't occur on a pure resolve.
      return { status: 500 };
  }
}

const realDeps: ResolveBindingDeps = {
  resolveIdentity: resolveRepoIdentity,
};

const bindingResolve = defineTool({
  method: 'POST',
  path: '/harness/binding/resolve',
  auth: 'loopback',
  async handler(req) {
    const body = (await req.json().catch(() => null)) as { github_remote?: unknown } | null;
    const remote = typeof body?.github_remote === 'string' ? body.github_remote : '';
    try {
      const result = await resolveBinding(remote, realDeps);
      return Response.json(result);
    } catch (e) {
      if (e instanceof ResolveBindingError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      if (e instanceof BindingServiceErrorThrowable) {
        const { status, retryAfterSec } = httpForBindingError(e.error);
        return Response.json(
          { error: e.error.code },
          {
            status,
            ...(retryAfterSec !== undefined
              ? { headers: { 'Retry-After': String(retryAfterSec) } }
              : {}),
          },
        );
      }
      throw e;
    }
  },
});

export default bindingResolve;
