/**
 * The `record` admission source (enterprise-data-sources-2026-10-01 P-020, D-011, D-030).
 *
 * A record is an ingested ticket stored as a work_items row tagged nature='record' (for GitHub
 * Issues, the deterministic TKT-… row github-issues-connector.ts writes). A record is DATA: it
 * is never claimable. Admitting it mints a separate issue-family work item that links back to
 * the record with rel 'about'.
 *
 * Identity: the record's own id. It is deterministic over (workspace, data source, provider
 * object), so it is stable across re-polls and re-ingest.
 *
 * Write-back: a plain-text comment on the source ticket. For GitHub the coordinates
 * (owner/repo, issue number) come from the durable admission's source_ref, never from the
 * caller, and the client is the operator's own gh identity (getOctokit), the same credential
 * the connector reads with.
 */
import { getOctokit } from '../identity/octokit-client';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  DEFAULT_FIELD_AUTHORITY,
  registerAdmissionSource,
  type AdmissionRefusal,
  type AdmissionSourceResolver,
  type ResolvedAdmissionSource,
} from './admission-sources';

export const RECORD_SOURCE_KIND = 'record';

export interface RecordRef {
  recordId: string;
}

/** The slice of the GitHub client write-back uses. */
export interface RecordWriteBackClient {
  issues: {
    createComment(args: { owner: string; repo: string; issue_number: number; body: string }): Promise<{
      data: { id?: number | null; html_url?: string | null };
    }>;
  };
}

export interface RecordSourceDeps {
  githubClient?: () => Promise<RecordWriteBackClient | null>;
}

interface RecordRow {
  feature_id: string;
  title: string | null;
  summary: string | null;
  nature: string | null;
  payload: Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function refuse(code: string, message: string): AdmissionRefusal {
  return { refused: true, code, message };
}

/** The resolved snapshot of a record row. Exported so the rule path and the re-sync share it. */
export function recordSnapshot(payload: Record<string, unknown>, rowTitle?: string | null): {
  title: string;
  body: string;
  permalink: string | null;
} {
  const externalId = str(payload.externalId);
  const title = str(payload.title) || str(rowTitle) || externalId;
  return {
    title: externalId && title !== externalId ? `${externalId}: ${title}` : title,
    body: typeof payload.body === 'string' ? payload.body : '',
    permalink: str(payload.url) || null,
  };
}

export function createRecordAdmissionSource(deps: RecordSourceDeps = {}): AdmissionSourceResolver<RecordRef> {
  const githubClient =
    deps.githubClient ?? (async () => (await getOctokit()) as unknown as RecordWriteBackClient | null);
  return {
    kind: RECORD_SOURCE_KIND,
    parseRef(raw) {
      const recordId = str(raw.recordId);
      if (!recordId) throw new Error('admission_source_invalid: record source needs { recordId }');
      if (recordId.length > 200) throw new Error('admission_source_invalid: recordId is too long');
      return { recordId };
    },
    async resolve(ctx, ref): Promise<ResolvedAdmissionSource | AdmissionRefusal> {
      const [row] = await ctx.db<RecordRow[]>`
        SELECT feature_id, title, summary, nature, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ${ref.recordId}
         LIMIT 1`;
      if (!row) return refuse('source_not_found', `no record '${ref.recordId}' in this workspace`);
      if (row.nature !== 'record') {
        return refuse('not_a_record', `'${ref.recordId}' is not a record (nature=${row.nature ?? 'work'}); only DATA is admitted`);
      }
      const payload = row.payload ?? {};
      const dataSourceId = str(payload.dataSourceId) || null;
      const snap = recordSnapshot(payload, row.title);
      return {
        dataSourceId,
        sourceKey: row.feature_id,
        title: snap.title,
        body: snap.body,
        permalink: snap.permalink,
        recordWorkItemId: row.feature_id,
        sourceRef: {
          recordId: row.feature_id,
          ...(str(payload.provider) ? { provider: str(payload.provider) } : {}),
          ...(str(payload.externalId) ? { externalId: str(payload.externalId) } : {}),
          ...(str(payload.container) ? { container: str(payload.container) } : {}),
          ...(Number.isInteger(payload.number) ? { number: payload.number } : {}),
          ...(snap.permalink ? { url: snap.permalink } : {}),
        },
        fieldAuthority: DEFAULT_FIELD_AUTHORITY,
      };
    },
    async writeBack({ admission, text }) {
      const ref = admission.sourceRef;
      if (str(ref.provider) !== 'github') throw new Error(`write_back_unsupported_provider:${str(ref.provider) || 'unknown'}`);
      const [owner, repo] = str(ref.container).split('/');
      const issueNumber = Number(ref.number);
      if (!owner || !repo || !Number.isInteger(issueNumber)) throw new Error('write_back_coordinates_missing');
      const client = await githubClient();
      if (!client) throw new Error('github_not_authenticated');
      const { data } = await client.issues.createComment({ owner, repo, issue_number: issueNumber, body: text });
      return { posted: true, externalRef: str(data.html_url) || (data.id != null ? String(data.id) : null) };
    },
  };
}

/** The process-wide registration. Idempotent across module re-imports (same object). */
export const recordAdmissionSource = pinModuleState(
  '@papercusp/operator-core.work-admission.record-source',
  () => createRecordAdmissionSource(),
);
registerAdmissionSource(recordAdmissionSource);
