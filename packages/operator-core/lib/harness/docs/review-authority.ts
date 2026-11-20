import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { appliedExecutionRevision, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { z } from 'zod';
import { getDbEncryptionKey } from '../../db-encryption';
import { resolveAgentIdentity } from '../../agent-tools/coordination/identity';
import {
  AdmissionAuthorityRefused, admissionAuthoritySchema, bindAdmissionAuthority, renewReviewWriteAuthority,
  type AdmissionAuthorityContext,
} from '../../work-item-admission-authority';
import { sha256 } from './authored-doc-projection';
import { docFilePath, readDocBody } from './doc-fs';
import { resolveHarnessDocPaths } from './harness-repo';
import type { HarnessDocRecord } from './doc-record';

const writer = z.enum(['harness_docs:verify', 'harness_docs:anchor', 'docs:author']);
const operation = z.object({
  observer: z.string().min(1), tool: writer, args: z.record(z.string(), z.unknown()),
  authority: admissionAuthoritySchema, policyRevision: z.string().min(1),
});
const bodySource = z.object({
  repo: z.string().min(1), file: z.string().min(1).nullable(), hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const observation = operation.extend({ bodySource });
export type DocReviewOperation = z.infer<typeof operation>;
export type DocReviewObservation = z.infer<typeof observation>;
type DocPaths = NonNullable<Awaited<ReturnType<typeof resolveHarnessDocPaths>>>;
export type ReviewEligibility = 'eligible' | 'changed' | 'unknown';

/** An ordinary writer sees the authenticated invocation. An automatic anchor,
 * legacy baseline or anonymous request has no renewable reviewer observation. */
export function docReviewOperation(
  ctx: UnifiedToolContext & AdmissionAuthorityContext, harness: string,
  tool: DocReviewOperation['tool'], args: Record<string, unknown>,
): DocReviewOperation | undefined {
  if (!ctx.admissionRecoveryAuthority || !ctx.kernelEnforcement?.applied || ctx.kernelEnforcement.decision !== 'allow') return undefined;
  // An attached principal can be narrower than the transport. Its separate
  // credential or exact tool allowlist cannot be reconstructed from the spawn.
  if (ctx.principal && (ctx.principal.allowedTools !== undefined || ctx.principal.workspaceId !== ctx.workspaceId ||
      ctx.principal.slug !== (ctx.admissionRecoveryAuthority.kind === 'superuser' ? 'system:operator' : `system:${ctx.admissionRecoveryAuthority.role}`) ||
      ctx.principal.kind !== (ctx.admissionRecoveryAuthority.kind === 'superuser' ? 'system' : 'harness') ||
      ctx.principal.authMethod !== (ctx.admissionRecoveryAuthority.kind === 'superuser' ? 'bearer-token' : 'spawn-url') ||
      ctx.principal.trust !== 'trusted')) return undefined;
  const revision = appliedExecutionRevision(ctx.kernelEnforcement, 'enforce');
  if (!revision) return undefined;
  try {
    const authority = bindAdmissionAuthority(ctx, harness);
    if (!authority?.context || authority.context.harnessSlug !== harness) return undefined;
    const identity = resolveAgentIdentity(ctx);
    if (identity.workspaceId !== authority.context.workspaceId) return undefined;
    return { observer: identity.ownerId, tool, args, authority, policyRevision: JSON.stringify(revision) };
  } catch (error) {
    if (error instanceof AdmissionAuthorityRefused) return undefined;
    throw error;
  }
}

/** A file-backed guide can have an empty PG content hash. Bind its actual
 * resolved source and bytes. A stored authored body uses its PG projection. */
async function reviewBodySource(paths: DocPaths, docId: string, contentHash: string | undefined) {
  const repo = await realpath(paths.repoRoot);
  const namespaced = Object.hasOwn(paths.sources ?? {}, docId.split('/')[0]);
  if (!namespaced && contentHash && /^[a-f0-9]{64}$/.test(contentHash)) {
    return { repo, file: null, hash: contentHash };
  }
  const path = docFilePath(paths, docId);
  const content = path && await readDocBody(paths, docId);
  if (!path || content == null) return null;
  return { repo, file: await realpath(path), hash: sha256(content) };
}

export async function observeDocReview(
  original: DocReviewOperation | undefined, paths: DocPaths, docId: string, contentHash?: string,
): Promise<DocReviewObservation | undefined> {
  if (!original) return undefined;
  const source = await reviewBodySource(paths, docId, contentHash).catch(() => null);
  return source ? { ...original, bodySource: source } : undefined;
}

/** Reopen the exact review at use. The historical descriptor is internal
 * evidence for a read-only preflight and never leaves the document store. */
export async function currentDocReviewEligibility(record: Partial<HarnessDocRecord>): Promise<ReviewEligibility> {
  if (!record.reviewedBy || !record.workspaceId || !record.harnessSlug || !record.docId ||
      !record.lastVerifiedSha || !record.lastVerifiedAt || !record.subjectRef || !record.anchorPaths) return 'unknown';
  // A composed page can have different prose in each client projection.
  if (record.contentMode !== 'authored') return 'unknown';
  const { workspaceId, harnessSlug, docId, lastVerifiedSha, lastVerifiedAt, anchorPaths } = record;
  const refs = JSON.stringify(record.subjectRef);
  try {
    const { sql } = getOrgPg();
    const read = async () => (await sql<{ sealed: string; scope: unknown; matches: boolean }[]>`
      SELECT d.last_review ->> 'sealed' AS sealed, d.last_review -> 'scope' AS scope,
             d.last_review -> 'scope' @> harness_shared.harness_doc_review_scope(d)
               AND d.last_review -> 'scope' <@ harness_shared.harness_doc_review_scope(d) AS matches
      FROM harness_shared.harness_docs d
      WHERE workspace_id=${workspaceId} AND harness_slug=${harnessSlug} AND doc_id=${docId}
        AND retired_at IS NULL AND origin='local' AND last_review ->> 'version'='1'
        AND last_verified_sha=${lastVerifiedSha} AND content_hash=${record.contentHash ?? null}
        AND date_trunc('milliseconds', last_verified_at)=date_trunc('milliseconds', ${lastVerifiedAt}::timestamptz)
        AND subject_ref @> ${refs}::text::jsonb AND subject_ref <@ ${refs}::text::jsonb
        AND anchor_paths @> ${anchorPaths}::text[] AND anchor_paths <@ ${anchorPaths}::text[]`)[0];
    const row = await read();
    if (!row?.matches) return 'changed';
    if (!row.sealed) return 'unknown';
    const [opened] = await sql<{ payload: { purpose?: string; scope?: unknown; observation?: unknown } }[]>`
      SELECT pgp_sym_decrypt(decode(${row.sealed}, 'base64'), ${getDbEncryptionKey()})::jsonb AS payload`;
    if (opened?.payload?.purpose !== 'harness-doc-review-v1' || !isDeepStrictEqual(opened.payload.scope, row.scope)) return 'unknown';
    const proof = observation.safeParse(opened.payload.observation);
    if (!proof.success) return 'unknown';
    const { observer, authority, tool, args, policyRevision } = proof.data;
    if (observer !== record.reviewedBy || authority.context?.workspaceId !== workspaceId ||
        authority.context.harnessSlug !== harnessSlug) return 'changed';
    // Background freshness checks use the same registered writer as the
    // original request, even on a host which has not served an MCP call.
    if (tool === 'harness_docs:verify') await import('../../agent-tools/harness_docs/verify');
    else if (tool === 'harness_docs:anchor') await import('../../agent-tools/harness_docs/anchor');
    else await import('../../agent-tools/docs/author');
    const current = await renewReviewWriteAuthority(sql, workspaceId, observer, authority, tool, args);
    if (current !== policyRevision) return 'changed';
    const paths = await resolveHarnessDocPaths(harnessSlug);
    if (!paths) return 'unknown';
    const source = await reviewBodySource(paths, docId, record.contentHash);
    if (!source) return 'unknown';
    if (!isDeepStrictEqual(source, proof.data.bodySource)) return 'changed';
    const final = await read();
    return final?.matches && final.sealed === row.sealed && isDeepStrictEqual(final.scope, row.scope) ? 'eligible' : 'changed';
  } catch (error) {
    return error instanceof AdmissionAuthorityRefused ? 'changed' : 'unknown';
  }
}
