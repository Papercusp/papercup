/** Publish-time indexing, recovered by the existing chunk sync / embedding sweep. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { planChunks, resolveChunkSurface, sharedChunkStore, parentShaOf, embeddedChunkText } from '@papercusp/search';
import type { ReportRecord } from '../report-library';
import { REPORTS_CHUNK_SURFACE } from './chunks/registry';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface ReportDocumentEmbedder {
  embed: (text: string) => Promise<number[]>;
  profileId: string;
  mode: string;
}

export async function indexReport(sql: Sql, report: ReportRecord, embedder?: ReportDocumentEmbedder | null) {
  const surface = resolveChunkSurface(REPORTS_CHUNK_SURFACE);
  const store = sharedChunkStore();
  const key = [report.workspaceId, report.reportId];
  const text = [report.title, report.summary || null, report.bodyMd].filter(v => v !== null).join('\n');
  const header = report.title.slice(0, 400);
  const plan = planChunks(surface, text, header, hash);
  if (plan.truncated) throw new Error('Report exceeds the registered complete-body chunk capacity');
  const parentSha = parentShaOf(hash, text, header);
  // Commit missing vectors first: a failed embed leaves an accountable sweep backlog.
  await store.transaction(sql, async tx => {
    // Serialize even the first index, when there are no chunk rows to lock yet.
    await tx`SELECT report_id FROM harness_shared.report_library
      WHERE workspace_id = ${report.workspaceId} AND report_id = ${report.reportId} FOR NO KEY UPDATE`;
    const existing = await store.readExisting(tx, surface, key);
    if (existing.length === plan.chunks.length && existing.every((row, i) =>
      row.chunkIdx === i && row.chunkSha === plan.chunks[i].chunkSha &&
      row.parentSha === parentSha && row.splitterVersion === surface.splitterVersion)) return;
    const old = new Map(existing.filter(c => c.embedding !== null).map(c => [c.chunkSha, c]));
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
