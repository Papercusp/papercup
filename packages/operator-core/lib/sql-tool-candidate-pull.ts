/** Trusted host seam shared by the tool and Scout. No saved grants or derived results. */
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { readSqlToolCandidateWorklist, type SqlCandidateWorklist, type SqlCandidateWorklistOptions } from './sql-tool-candidate-worklist';
import { resolveConcreteHarnessSlug } from './agent-tools/_harness-scope';
import { productionMiningScope } from './agent-opportunities/privacy';

export type SqlCandidatePullContext = Pick<UnifiedToolContext,
  'principal' | 'workspaceId' | 'harnessSlug' | 'uiClientId' | 'gateBypass' | 'isSuperuser' | 'isPowerUser'>;
export interface SqlCandidateAuthorityRequest {
  workspaceId: string;
  harnessSlug: string;
  principal: NonNullable<UnifiedToolContext['principal']>;
  ownerId?: string | null;
}
/** The host supplies the key/epoch and fresh source ACL lookup outside tool arguments.
 * Workspace/harness visibility alone is not a per-source authorization grant. */
export type SqlCandidateAuthorityResolver = (request: SqlCandidateAuthorityRequest) => Promise<SqlCandidateWorklistOptions | null>;
let authorityResolver: SqlCandidateAuthorityResolver | null = null;

/** Host composition override. Null restores the canonical full-administrator reader;
 * principals without that source grant still receive UNKNOWN. */
export function bindSqlCandidateAuthorityResolver(resolver: SqlCandidateAuthorityResolver | null): void {
  authorityResolver = resolver;
}
export const unknownSqlCandidateWorklist = (): SqlCandidateWorklist => ({ status: 'UNKNOWN', candidates: [],
  snapshots: [], population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } });

/** Reuse the existing ledger source reader and key custody. A trusted wildcard
 * capability or the host's full SU capability bypass grants source access;
 * intel:read/workspace membership alone does not. Transport metadata is never
 * read from tool arguments. No principal, source approval or result is cached. */
async function productionAuthority(ctx: SqlCandidatePullContext,
  request: SqlCandidateAuthorityRequest): Promise<SqlCandidateWorklistOptions | null> {
  const { slug, kind, authMethod, trust } = request.principal;
  const fullGrant = () => {
    const principal = ctx.principal;
    return !!principal && principal.slug === slug && principal.kind === kind && principal.trust === trust
      && principal.authMethod === authMethod && principal.workspaceId === request.workspaceId
      && (principal.trust === 'trusted' || principal.trust === 'verified')
      && (!principal.allowedTools || principal.allowedTools.has('dev:pg_query'))
      && (principal.capabilities.has('*') || (ctx.isSuperuser === true && ctx.isPowerUser !== true
        && ctx.gateBypass?.capability === true && principal.trust === 'trusted'));
  };
  if (!fullGrant()) return null;
  const scope = productionMiningScope(request.workspaceId);
  const authorize: SqlCandidateWorklistOptions['authorize'] = async input => fullGrant()
    && input.workspaceId === request.workspaceId && input.harnessSlug === request.harnessSlug
    && input.sourceBoundary === scope.sourceBoundary;
  const { productionOpportunityReaders } = await import('./agent-opportunities/source-readers');
  const readers = productionOpportunityReaders({ workspaceId: request.workspaceId,
    harnessSlug: request.harnessSlug, sourceBoundary: scope.sourceBoundary, authorize });
  const { productionSqlRecommendationInput } = await import('./sql-tool-candidate-production');
  return { workspaceId: request.workspaceId, harnessSlug: request.harnessSlug, scope, authorize,
    authorizeSource: async id => !!await readers.authorizeLedgerSource(id),
    recommendationInput: productionSqlRecommendationInput };
}

export async function pullSqlToolCandidates(ctx: SqlCandidatePullContext,
  args: { harness?: string; limit?: number; ranOn?: string } = {}): Promise<SqlCandidateWorklist> {
  try {
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
    if (!harnessSlug || !workspaceId || workspaceId === '*' || !ctx.principal
      || (ctx.principal.workspaceId !== '*' && ctx.principal.workspaceId !== workspaceId)
      || (ctx.harnessSlug && ctx.harnessSlug !== '*' && ctx.harnessSlug !== harnessSlug)) return unknownSqlCandidateWorklist();
    // Resolve anew on EVERY pull, including repeated requests from the same session.
    const request = { workspaceId, harnessSlug, principal: ctx.principal, ownerId: ctx.uiClientId };
    const opts = authorityResolver ? await authorityResolver(request) : await productionAuthority(ctx, request);
    if (!opts || opts.workspaceId !== workspaceId || opts.harnessSlug !== harnessSlug
      || opts.scope.workspaceId !== workspaceId || typeof opts.authorize !== 'function'
      || typeof opts.authorizeSource !== 'function') return unknownSqlCandidateWorklist();
    return await readSqlToolCandidateWorklist({ ...opts, limit: args.limit, ranOn: args.ranOn });
  } catch { return unknownSqlCandidateWorklist(); }
}
