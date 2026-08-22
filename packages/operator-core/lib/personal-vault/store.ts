import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type {
  PersonalDocumentInput,
  PersonalPrincipalType,
  PersonalSearchInput,
  PersonalSearchResult,
} from './types';

const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizePersonalSource(value: string): string {
  const source = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SOURCE_RE.test(source)) throw new Error(`invalid_personal_source:${value}`);
  return source;
}

export function personalScope(sourceOrScope: string): string {
  const raw = sourceOrScope.trim().toLowerCase();
  const source = raw.startsWith('personal:') ? raw.slice('personal:'.length) : raw;
  return `personal:${normalizePersonalSource(source)}`;
}

export function normalizeParticipant(value: string): string {
  const v = value.trim().toLowerCase();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  return (angle?.[1] ?? v).replace(/^mailto:/, '').replace(/^@/, '');
}

export function dedupeKeyFor(doc: PersonalDocumentInput): string {
  if (doc.dedupeKey?.trim()) return doc.dedupeKey.trim();
  const stable = [
    normalizePersonalSource(doc.source),
    doc.kind.trim().toLowerCase(),
    doc.externalId ?? '',
    doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt ?? '',
    doc.title ?? '',
    doc.text ?? '',
  ].join('\u001f');
  return createHash('sha256').update(stable).digest('hex');
}

export async function isPersonalVaultEnabled(sql: Sql, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await sql<Array<{ enabled: boolean }>>`
    SELECT enabled
      FROM harness_shared.personal_vault_settings
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
     LIMIT 1`;
  return rows[0]?.enabled ?? true;
}

export async function setPersonalVaultEnabled(
  sql: Sql,
  workspaceId: string,
  userId: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.personal_vault_settings
      (workspace_id, user_id, enabled, updated_by)
    VALUES (${workspaceId}, ${userId}, ${enabled}, ${updatedBy})
    ON CONFLICT (workspace_id, user_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()`;
}

export async function upsertPersonalDocuments(
  sql: Sql,
  workspaceId: string,
  userId: string,
  documents: PersonalDocumentInput[],
): Promise<{ insertedOrUpdated: number; ids: string[] }> {
  if (!(await isPersonalVaultEnabled(sql, workspaceId, userId))) throw new Error('personal_vault_disabled');
  const ids: string[] = [];
  for (const doc of documents) {
    const source = normalizePersonalSource(doc.source);
    const participants = [...new Set((doc.participants ?? []).map(normalizeParticipant).filter(Boolean))];
    const participantIds = [...new Set(doc.participantIds ?? [])];
    const occurredAt = doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt ?? null;
    const metadata = JSON.stringify(doc.metadata ?? {});
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, source, kind, external_id, occurred_at,
         participants, participant_ids, title, text, metadata, dedupe_key)
      VALUES
        (${workspaceId}, ${userId}, ${source}, ${doc.kind.trim()}, ${doc.externalId ?? null},
         ${occurredAt}, ${participants}, ${participantIds}, ${doc.title ?? ''}, ${doc.text ?? ''},
         ${metadata}::jsonb, ${dedupeKeyFor(doc)})
      ON CONFLICT (workspace_id, user_id, source, dedupe_key) DO UPDATE
        SET kind = EXCLUDED.kind,
            external_id = EXCLUDED.external_id,
            occurred_at = EXCLUDED.occurred_at,
            participants = EXCLUDED.participants,
            participant_ids = EXCLUDED.participant_ids,
            title = EXCLUDED.title,
            text = EXCLUDED.text,
            metadata = EXCLUDED.metadata,
            embedding = CASE
              WHEN personal_documents.title IS DISTINCT FROM EXCLUDED.title
                OR personal_documents.text IS DISTINCT FROM EXCLUDED.text
              THEN NULL ELSE personal_documents.embedding END,
            embedding_mode = CASE
              WHEN personal_documents.title IS DISTINCT FROM EXCLUDED.title
                OR personal_documents.text IS DISTINCT FROM EXCLUDED.text
              THEN NULL ELSE personal_documents.embedding_mode END,
            updated_at = now()
      RETURNING id`;
    ids.push(rows[0]!.id);
  }
  return { insertedOrUpdated: ids.length, ids };
}

export async function setPersonalSyncState(
  sql: Sql,
  workspaceId: string,
  userId: string,
  sourceInput: string,
  cursor: Record<string, unknown>,
  lastError: string | null = null,
): Promise<void> {
  const source = normalizePersonalSource(sourceInput);
  await sql`
    INSERT INTO harness_shared.personal_sync_state
      (workspace_id, user_id, source, cursor, last_sync_at, last_error)
    VALUES (${workspaceId}, ${userId}, ${source}, ${JSON.stringify(cursor)}::jsonb, now(), ${lastError})
    ON CONFLICT (workspace_id, user_id, source) DO UPDATE
      SET cursor = EXCLUDED.cursor,
          last_sync_at = EXCLUDED.last_sync_at,
          last_error = EXCLUDED.last_error,
          updated_at = now()`;
}

export async function createPersonalGrant(
  sql: Sql,
  input: {
    workspaceId: string;
    userId: string;
    principalType: PersonalPrincipalType;
    principalId: string;
    scopes: string[];
    grantedBy: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; scopes: string[] }> {
  const scopes = [...new Set(input.scopes.map(personalScope))].sort();
  if (!scopes.length) throw new Error('personal_grant_scopes_required');
  const rows = await sql<Array<{ id: string; scopes: string[] }>>`
    INSERT INTO harness_shared.personal_grants
      (workspace_id, user_id, principal_type, principal_id, scopes,
       granted_by, expires_at, metadata)
    VALUES (${input.workspaceId}, ${input.userId}, ${input.principalType}, ${input.principalId.trim()},
            ${scopes}, ${input.grantedBy}, ${input.expiresAt ?? null},
            ${JSON.stringify(input.metadata ?? {})}::jsonb)
    ON CONFLICT (workspace_id, user_id, principal_type, principal_id, scopes)
      WHERE revoked_at IS NULL
    DO UPDATE SET granted_by = EXCLUDED.granted_by,
                  granted_at = now(),
                  expires_at = EXCLUDED.expires_at,
                  metadata = EXCLUDED.metadata
    RETURNING id, scopes`;
  return rows[0]!;
}

export async function revokePersonalGrant(
  sql: Sql,
  workspaceId: string,
  userId: string,
  grantId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.personal_grants
       SET revoked_at = now()
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       AND id = ${grantId} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function listPersonalGrants(sql: Sql, workspaceId: string, userId: string) {
  return sql`
    SELECT id, principal_type, principal_id, scopes, granted_by,
           granted_at, expires_at, revoked_at
      FROM harness_shared.personal_grants
     WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
     ORDER BY granted_at DESC`;
}

export async function personalVaultStats(sql: Sql, workspaceId: string, userId: string) {
  const [counts, unembedded] = await Promise.all([
    sql<Array<{ source: string; documents: number; newest_at: string | null }>>`
      SELECT source, count(*)::int AS documents, max(occurred_at)::text AS newest_at
        FROM harness_shared.personal_documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
       GROUP BY source ORDER BY source`,
    sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.personal_documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND embedding IS NULL`,
  ]);
  return { sources: counts, unembedded: unembedded[0]?.count ?? 0 };
}

export async function purgePersonalSource(
  sql: Sql,
  workspaceId: string,
  userId: string,
  sourceInput?: string | null,
): Promise<{ documents: number; cursors: number; aliases: number; identities: number }> {
  const source = sourceInput ? normalizePersonalSource(sourceInput) : null;
  return sql.begin(async (tx) => {
    const docs = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.personal_documents
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND (${source}::text IS NULL OR source = ${source})
      RETURNING id`;
    const cursors = await tx<Array<{ source: string }>>`
      DELETE FROM harness_shared.personal_sync_state
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND (${source}::text IS NULL OR source = ${source})
      RETURNING source`;
    const aliases = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.personal_identity_aliases
       WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
         AND (${source}::text IS NULL OR source = ${source})
      RETURNING id`;
    const identities = await tx<Array<{ id: string }>>`
      DELETE FROM harness_shared.personal_identities i
       WHERE i.workspace_id = ${workspaceId} AND i.user_id = ${userId}
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.personal_identity_aliases a
            WHERE a.workspace_id = i.workspace_id AND a.user_id = i.user_id
              AND a.identity_id = i.id)
      RETURNING id`;
    return { documents: docs.length, cursors: cursors.length, aliases: aliases.length, identities: identities.length };
  });
}

export async function searchPersonalDocuments(
  sql: Sql,
  workspaceId: string,
  userId: string,
  input: PersonalSearchInput,
): Promise<PersonalSearchResult[]> {
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const snippetChars = Math.max(80, Math.min(1200, input.snippetChars ?? 600));
  const scopes = [...new Set((input.scopes ?? []).map(personalScope))];
  const participants = [...new Set((input.participants ?? []).map(normalizeParticipant).filter(Boolean))];
  const aliases = participants.length
    ? await sql<Array<{ identity_id: string }>>`
        SELECT DISTINCT identity_id
          FROM harness_shared.personal_identity_aliases
         WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
           AND normalized_value = ANY(${participants})`
    : [];
  const participantIds = aliases.map((r) => r.identity_id);
  const scopeFilter = scopes.length ? sql`AND d.scope_key = ANY(${scopes})` : sql``;
  const participantFilter = participants.length
    ? sql`AND (d.participants && ${participants}::text[] OR d.participant_ids && ${participantIds}::uuid[])`
    : sql``;
  const fromFilter = input.timeRange?.from ? sql`AND d.occurred_at >= ${input.timeRange.from}` : sql``;
  const toFilter = input.timeRange?.to ? sql`AND d.occurred_at <= ${input.timeRange.to}` : sql``;
  const vector = input.queryEmbedding?.length ? `[${input.queryEmbedding.join(',')}]` : null;
  const vectorCte = vector
    ? sql`SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS vector_rank
            FROM filtered WHERE embedding IS NOT NULL AND embedding_mode = 'gemma'
           ORDER BY embedding <=> ${vector}::vector LIMIT ${Math.max(limit * 4, 20)}`
    : sql`SELECT id, NULL::bigint AS vector_rank FROM filtered WHERE false`;

  const rows = await sql<Array<{
    id: string; source: string; scope_key: string; kind: string; external_id: string | null;
    occurred_at: string | null; participants: string[]; participant_ids: string[]; title: string;
    snippet: string; metadata: Record<string, unknown>; score: number | string;
    lexical_rank: number | string | null; vector_rank: number | string | null;
  }>>`
    WITH filtered AS (
      SELECT d.*
        FROM harness_shared.personal_documents d
       WHERE d.workspace_id = ${workspaceId} AND d.user_id = ${userId}
         ${scopeFilter} ${participantFilter} ${fromFilter} ${toFilter}
    ), lexical AS (
      SELECT id,
             row_number() OVER (
               ORDER BY ts_rank_cd(text_tsv, websearch_to_tsquery('english', ${input.query})) DESC
             ) AS lexical_rank
        FROM filtered
       WHERE text_tsv @@ websearch_to_tsquery('english', ${input.query})
       ORDER BY ts_rank_cd(text_tsv, websearch_to_tsquery('english', ${input.query})) DESC
       LIMIT ${Math.max(limit * 4, 20)}
    ), vector AS (${vectorCte}), ranked AS (
      SELECT COALESCE(l.id, v.id) AS id,
             l.lexical_rank,
             v.vector_rank,
             COALESCE(1.0 / (60 + l.lexical_rank), 0)
               + COALESCE(1.0 / (60 + v.vector_rank), 0) AS score
        FROM lexical l FULL OUTER JOIN vector v ON v.id = l.id
    )
    SELECT d.id, d.source, d.scope_key, d.kind, d.external_id,
           d.occurred_at::text, d.participants, d.participant_ids, d.title,
           left(d.text, ${snippetChars}) AS snippet, d.metadata,
           r.score, r.lexical_rank, r.vector_rank
      FROM ranked r JOIN filtered d ON d.id = r.id
     ORDER BY r.score DESC, d.occurred_at DESC NULLS LAST
     LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    scopeKey: r.scope_key,
    kind: r.kind,
    externalId: r.external_id,
    occurredAt: r.occurred_at,
    participants: r.participants ?? [],
    participantIds: r.participant_ids ?? [],
    title: r.title,
    snippet: r.snippet,
    metadata: r.metadata ?? {},
    score: Number(r.score),
    lexicalRank: r.lexical_rank == null ? null : Number(r.lexical_rank),
    vectorRank: r.vector_rank == null ? null : Number(r.vector_rank),
  }));
}
