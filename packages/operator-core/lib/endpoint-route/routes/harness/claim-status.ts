/**
 * GET /api/harness/:slug/claim-status — Phase 8 P-069 (a/b/e) read path.
 *
 * The claim-status data source for the live `/adv` shell. Reads the
 * LOCAL `harness_shared.shared_repo_binding_cache` row for the harness
 * slug, joins `harness_shared.contributors` to resolve claimant logins
 * by numeric id, resolves the local viewer (`resolveLocalGithubIdentity`),
 * and runs the PURE `resolveClaimStatus` view-model.
 *
 * Until now the binding cache held real `claim_status` + claimant lists
 * but NOTHING exposed it by slug over HTTP — the Insights ProjectCard
 * badge always rendered the hardcoded `'unclaimed'` fallback. This route
 * is the missing read so the mounted HarnessClaimHeader / badge show the
 * real claim state, and `useViewer()` decides the viewer-specific copy
 * ("you're the provisional owner").
 *
 * Public read (loopback desktop). Defensive: missing table / no binding
 * → 200 with the no-binding shape (status 'unclaimed', empty claimants),
 * never a 500.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-069.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';
import {
  resolveClaimStatus,
  type ClaimStatusRow,
  type ResolvedClaimStatus,
} from '../../../harness/claim-status-resolver';
import type { BindingClaimStatus } from '../../../harness/binding-types';

type SrbcRow = {
  github_repository_id: number | string;
  claim_status: BindingClaimStatus;
  provisional_owner_github_user_id: number | string;
  provisional_owner_github_login: string;
  claimed_by_github_user_ids: Array<number | string> | string | null;
  superseded_by_harness_topic: string | null;
};

/** Postgres BIGINT[] arrives as number[], string[], or a `{1,2}` literal. */
function parseIdArray(raw: SrbcRow['claimed_by_github_user_ids']): number[] {
  if (raw == null) return [];
  let arr: unknown[];
  if (Array.isArray(raw)) arr = raw;
  else {
    const s = String(raw).trim();
    if (!s || s === '{}' || s === '[]') return [];
    if (s.startsWith('{') && s.endsWith('}')) arr = s.slice(1, -1).split(',');
    else {
      try {
        const v = JSON.parse(s);
        arr = Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    }
  }
  return arr
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Wire shape returned to the client (mirrors ResolvedClaimStatus, snake-ish). */
export interface ClaimStatusResponse {
  status: ResolvedClaimStatus['status'];
  binding_id: string | null;
  claimant_login: string | null;
  claimants: Array<{ github_user_id: number; login: string | null }>;
  provisional_owner_login: string | null;
  viewer_is_provisional_owner: boolean;
  viewer_is_claimant: boolean;
  viewer_can_claim: boolean;
  superseded_by_href: string | null;
  summary: string;
}

const NO_BINDING: ClaimStatusResponse = {
  status: 'unclaimed',
  binding_id: null,
  claimant_login: null,
  claimants: [],
  provisional_owner_login: null,
  viewer_is_provisional_owner: false,
  viewer_is_claimant: false,
  viewer_can_claim: false,
  superseded_by_href: null,
  summary: 'This harness has no shared binding yet.',
};

function toResponse(resolved: ResolvedClaimStatus): ClaimStatusResponse {
  return {
    status: resolved.status,
    binding_id: resolved.bindingId,
    claimant_login: resolved.claimantLogin,
    claimants: resolved.claimants.map((c) => ({
      github_user_id: c.githubUserId,
      login: c.login,
    })),
    provisional_owner_login: resolved.provisionalOwnerLogin,
    viewer_is_provisional_owner: resolved.isProvisionalOwner,
    viewer_is_claimant: resolved.isClaimant,
    viewer_can_claim: resolved.viewerCanClaim,
    superseded_by_href: resolved.supersededByHref,
    summary: resolved.claimantSummary,
  };
}

async function viewerId(): Promise<number | null> {
  try {
    const id = await resolveLocalGithubIdentity();
    return id.kind === 'ok' ? id.githubUserId : null;
  } catch {
    return null;
  }
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/claim-status',
  auth: 'public',
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const viewer = await viewerId();
    try {
      const { sql } = getOrgPg();
      const rows = (await sql`
        SELECT github_repository_id, claim_status,
               provisional_owner_github_user_id, provisional_owner_github_login,
               claimed_by_github_user_ids, superseded_by_harness_topic
          FROM harness_shared.shared_repo_binding_cache
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${slug}
         LIMIT 1
      `) as unknown as SrbcRow[];
      const row = rows[0];
      if (!row) return Response.json(toResponse(resolveClaimStatus(null, viewer)));

      const claimantIds = parseIdArray(row.claimed_by_github_user_ids);

      // Resolve claimant logins from the contributors table (any harness —
      // github_user_id is globally unique). Best-effort: missing rows just
      // render as a null login.
      const loginMap: Record<number, string> = {};
      if (claimantIds.length > 0) {
        try {
          const cRows = (await sql`
            SELECT DISTINCT github_user_id, github_username
              FROM harness_shared.contributors
             WHERE workspace_id = ${workspaceId}
               AND github_user_id = ANY(${claimantIds})
          `) as unknown as Array<{ github_user_id: number | string; github_username: string }>;
          for (const r of cRows) {
            const id = Number(r.github_user_id);
            if (Number.isFinite(id) && r.github_username) loginMap[id] = r.github_username;
          }
        } catch {
          // contributors table missing / unreachable — degrade to id-only.
        }
      }

      const claimStatusRow: ClaimStatusRow = {
        github_repository_id: Number(row.github_repository_id),
        claim_status: row.claim_status,
        provisional_owner_github_user_id: Number(row.provisional_owner_github_user_id),
        provisional_owner_github_login: row.provisional_owner_github_login ?? '',
        claimed_by_github_user_ids: claimantIds,
        claimant_logins: loginMap,
        superseded_by_harness_topic: row.superseded_by_harness_topic,
      };
      return Response.json(toResponse(resolveClaimStatus(claimStatusRow, viewer)));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Missing schema / PG unreachable → treat as "no binding yet", not a 500.
      if (/does not exist|relation .* does not exist/i.test(msg)) {
        return Response.json(NO_BINDING);
      }
      throw e;
    }
  },
});

export default [get];
