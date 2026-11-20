/** Publish-time indexing, recovered by the existing chunk sync / embedding sweep. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { planChunks, resolveChunkSurface, sharedChunkStore, parentShaOf, embeddedChunkText } from '@papercusp/search';
import { visibleTo, type ReportRecord, type ReportVisibility } from '../report-library';
import { REPORTS_CHUNK_SURFACE } from './chunks/registry';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface ReportDocumentEmbedder {
  embed: (text: string) => Promise<number[]>;
  profileId: string;
  mode: string;
}

function reportInput(title: string, summary: string | null, body: string) {
  const text = [title, summary || null, body].filter(v => v !== null).join('\n');
  const header = title.slice(0, 400);
  return { text, header, parentSha: parentShaOf(hash, text, header) };
}

async function reusePredecessor(sql: Sql, report: ReportRecord, parentSha: string, splitterVersion: string,
  embedder: ReportDocumentEmbedder) {
  await sharedChunkStore().transaction(sql, async tx => {
    const [edition] = await tx<{
      supersedes_report_id: string | null; lineage_id: string; visibility: ReportVisibility;
      author_owner_id: string | null; origin_harness_slug: string | null;
    }[]>`SELECT supersedes_report_id, lineage_id, visibility, author_owner_id, origin_harness_slug
      FROM harness_shared.report_library WHERE workspace_id = ${report.workspaceId}
        AND report_id = ${report.reportId} AND retired_at IS NULL FOR SHARE`;
    if (!edition?.supersedes_report_id) return;
    // Author access is an extra branch of the normal report ACL, including on pot reports.
    // Compare the full restricted audience and check the stored publisher's access at use.
    const viewer = { ownerId: edition.author_owner_id, potSlug: edition.origin_harness_slug };
    const [prior] = await tx<{ title: string; summary: string | null; body_md: string }[]>`
      SELECT title, summary, body_md FROM harness_shared.report_library
      WHERE workspace_id = ${report.workspaceId} AND report_id = ${edition.supersedes_report_id}
        AND lineage_id = ${edition.lineage_id} AND retired_at IS NULL
        AND ${visibleTo(tx, viewer)} AND visibility = ${edition.visibility}
        AND (visibility = 'workspace' OR (author_owner_id IS NOT DISTINCT FROM ${edition.author_owner_id}
          AND (visibility = 'owner' OR origin_harness_slug = ${edition.origin_harness_slug})))
      FOR SHARE`;
    if (!prior) return;
    const priorSha = reportInput(prior.title, prior.summary, prior.body_md).parentSha;
    await tx`WITH inputs AS (
        SELECT chunk_sha, header, content, min(embedding::text)::vector AS vector
        FROM harness_shared.text_chunks WHERE surface = 'report'
          AND parent_key = ${[report.workspaceId, edition.supersedes_report_id]}::text[]
          AND parent_sha = ${priorSha} AND splitter_version = ${splitterVersion}
          AND embedding IS NOT NULL AND embedding_mode = ${embedder.mode} AND embedding_profile = ${embedder.profileId}
        GROUP BY chunk_sha, header, content HAVING min(embedding::text) = max(embedding::text)
      )
      UPDATE harness_shared.text_chunks dst SET embedding = inputs.vector, embedding_mode = ${embedder.mode},
        embedding_profile = ${embedder.profileId}, updated_at = now()
      FROM inputs WHERE dst.surface = 'report' AND dst.parent_key = ${[report.workspaceId, report.reportId]}::text[]
        AND dst.parent_sha = ${parentSha} AND dst.splitter_version = ${splitterVersion}
        AND dst.chunk_sha = inputs.chunk_sha AND dst.content = inputs.content AND dst.header IS NOT DISTINCT FROM inputs.header
        AND (dst.embedding IS NULL OR dst.embedding_mode IS DISTINCT FROM ${embedder.mode}
          OR dst.embedding_profile IS DISTINCT FROM ${embedder.profileId})`;
  });
}

export async function indexReport(sql: Sql, report: ReportRecord, embedder?: ReportDocumentEmbedder | null) {
  const surface = resolveChunkSurface(REPORTS_CHUNK_SURFACE);
  const store = sharedChunkStore();
  const key = [report.workspaceId, report.reportId];
  const { text, header, parentSha } = reportInput(report.title, report.summary, report.bodyMd);
  const plan = planChunks(surface, text, header, hash);
  if (plan.truncated) throw new Error('Report exceeds the registered complete-body chunk capacity');
  // Commit missing vectors first: a failed embed leaves an accountable sweep backlog.
  await store.transaction(sql, async tx => {
    // Serialize even the first index, when there are no chunk rows to lock yet.
    await tx`SELECT report_id FROM harness_shared.report_library
      WHERE workspace_id = ${report.workspaceId} AND report_id = ${report.reportId} FOR NO KEY UPDATE`;
    const existing = await store.readExisting(tx, surface, key);
    if (existing.length === plan.chunks.length && existing.every((row, i) =>
      row.chunkIdx === i && row.chunkSha === plan.chunks[i].chunkSha &&
      row.parentSha === parentSha && row.splitterVersion === surface.splitterVersion)) return;
    const old = new Map(existing.filter(c => c.embedding !== null && c.splitterVersion === surface.splitterVersion)
      .map(c => [c.chunkSha, c]));
    await store.replace(tx, surface, key, plan.chunks.map(c => ({
      ...c, embedding: old.get(c.chunkSha)?.embedding ?? null,
      embeddingMode: old.get(c.chunkSha)?.embeddingMode ?? null,
      embeddingProfile: old.get(c.chunkSha)?.embeddingProfile ?? null,
    })), { parentSha, splitterVersion: surface.splitterVersion, version: report.updatedAt });
  });
  if (embedder === undefined) {
    const { resolveBackfillEmbedder } = await import('./embed-backfill');
    const resolved = await resolveBackfillEmbedder();
    embedder = resolved.mode === 'disabled' ? null : {
      embed: resolved.embed, profileId: resolved.profile.profileId, mode: resolved.mode,
    };
  }
  if (!embedder) return { chunks: plan.chunks.length, embedded: 0 };
  if (report.supersedesReportId) await reusePredecessor(sql, report, parentSha, surface.splitterVersion, embedder);
  const pending = await sql<{ chunk_idx: number; chunk_sha: string; row_version: string }[]>`
    SELECT chunk_idx, chunk_sha, xmin::text AS row_version FROM harness_shared.text_chunks
    WHERE surface = 'report' AND parent_key = ${key}::text[]
      AND parent_sha = ${parentSha} AND splitter_version = ${surface.splitterVersion}
      AND (embedding IS NULL OR embedding_profile IS DISTINCT FROM ${embedder.profileId}
           OR embedding_mode IS DISTINCT FROM ${embedder.mode})
    ORDER BY chunk_idx`;
  let embedded = 0;
  for (const row of pending) {
    const chunk = plan.chunks[row.chunk_idx];
    if (!chunk || chunk.chunkSha !== row.chunk_sha) continue;
    const vector = await embedder.embed(embeddedChunkText(chunk.header, chunk.content));
    const rows = await sql`UPDATE harness_shared.text_chunks
      SET embedding = ${JSON.stringify(vector)}::vector,
          embedding_profile = ${embedder.profileId}, embedding_mode = ${embedder.mode}, updated_at = now()
      WHERE surface = 'report' AND parent_key = ${key}::text[] AND chunk_idx = ${chunk.chunkIdx}
        AND chunk_sha = ${chunk.chunkSha} AND xmin::text = ${row.row_version} RETURNING chunk_idx`;
    embedded += rows.length;
  }
  return { chunks: plan.chunks.length, embedded };
}
