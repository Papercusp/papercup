/**
 * Native, runtime-witnessed re-verification of a committed get-feedback consult
 * receipt matrix (get-feedback-reliability-usefulness-adoption-2026-10-03 R-6).
 *
 * An evidence-file import (testing:record-run { evidenceFile }) carries no
 * execution-time runtime witness, so a live-plane binding on it can never read
 * environment-current. This check re-reads every claimed receipt from the operator
 * database inside executeOperationalRun, which witnesses the database unit before
 * and after execution (EI-26224370130119919).
 *
 * It lives OUTSIDE record-run.ts on purpose: live spec bindings pin that file, so a
 * new native check there would make other plans' evidence non-current
 * (EI-26555275260059787). executeOperationalRun is imported, never edited.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { executeOperationalRun, resolveOperationalSourceRoot, type OperationalEvidenceArtifact } from './record-run';

type NativeCheckContext = Parameters<typeof executeOperationalRun>[1];
type NativeCheckExecution = Parameters<typeof executeOperationalRun>[2];
type Assertion = OperationalEvidenceArtifact['assertions'][number];

/** The committed check definition: this module (cells + oracle). */
export const CONSULT_RECEIPT_CHECK_PATH = 'packages/operator-core/lib/agent-tools/testing/native-check-consult-receipts.ts';
/** The generator's substantive-answer floor; a shorter post is an acknowledgement, not feedback. */
export const CONSULT_RECEIPT_MIN_ANSWER_CHARS = 400;

type CellDefinition =
  | { mode: 'fork'; targetBackend: string }
  | { mode: 'port'; sourceBackend: string; targetBackend: string };

/**
 * The defined matrix per plan. The definition — not the artifact — fixes which
 * cells must be present, so an artifact that omits a path fails rather than
 * shrinking the matrix (R-6 falsifier: "an unavailable path is omitted").
 */
export const CONSULT_RECEIPT_MATRICES: Readonly<Record<string, Readonly<Record<string, CellDefinition>>>> = {
  'get-feedback-reliability-usefulness-adoption-2026-10-03': {
    'claude-ended-to-claude-fork': { mode: 'fork', targetBackend: 'claude' },
    'claude-ended-to-codex-conversion': { mode: 'port', sourceBackend: 'claude', targetBackend: 'codex' },
    'codex-live-to-codex-session-port': { mode: 'port', sourceBackend: 'codex', targetBackend: 'codex' },
  },
};

const cellName = z.string().min(1).max(200);
const receiptId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)]).transform(String);
const receiptModes = {
  fork: 'fork', 'isolated native fork': 'fork',
  port: 'port', 'isolated conversion': 'port', 'maintained session-port adapter': 'port',
} as const;

const checkedCellSchema = z.object({
  cell: cellName,
  mode: z.enum(['fork', 'port', 'isolated native fork', 'isolated conversion', 'maintained session-port adapter'])
    .transform(mode => receiptModes[mode]),
  status: z.literal('checked').optional(),
  passed: z.boolean().optional(),
  attemptedOnThisBuild: z.literal(true).optional(),
  requestKey: z.string().min(1).max(200),
  conversationId: z.string().regex(/^conv-[a-z0-9-]{1,200}$/),
  portId: z.string().min(1).max(200).nullable().optional(),
  sourceOwnerId: z.string().min(1).max(200),
  answeringOwnerId: z.string().min(1).max(200),
  sourceAdvSessionId: receiptId.optional(),
  targetAdvSessionId: receiptId.optional(),
  answerPostId: receiptId.nullish(),
});
type CheckedReceipt = z.infer<typeof checkedCellSchema>;
type ReceiptCell = CheckedReceipt | { cell: string; failure: string };

// A named failure is still part of the matrix. Only checked receipts can supply
// database lookup keys, including when a failed cell cites a previous trial.
const cellSchema = z.object({ cell: cellName }).passthrough().transform((raw): ReceiptCell => {
  if (raw.status === 'unavailable' || raw.status === 'residual') {
    return { cell: raw.cell, failure: `artifact reports ${raw.status}` };
  }
  const checked = checkedCellSchema.safeParse(raw);
  if (checked.success) return checked.data;
  const fields = checked.error.issues.map(issue => issue.path.join('.'));
  return { cell: raw.cell, failure: `invalid checked receipt: ${fields.join(', ')}` };
});

const matrixArtifactSchema = z.object({
  plan: z.string().min(1).max(200),
  requesterId: z.string().min(1).max(200),
  matrix: z.object({ cells: z.array(cellSchema).min(1).max(32) }).passthrough(),
}).passthrough();
export type ConsultReceiptMatrixArtifact = z.infer<typeof matrixArtifactSchema>;

export interface ConsultReceiptRows {
  database: string;
  port: number;
  consults: Array<{ conversation_id: string; requester_id: string | null; state: string | null; dispatch_attempts: unknown }>;
  posts: Array<{ id: number | string; thread_id: string; author_id: string | null; len: number | string; kind: string | null }>;
  ports: Array<{ id: string; source_backend: string | null; target_backend: string | null; status: string | null;
    delivered_at: unknown; error: unknown; source_adv_session_id: string | null; target_adv_session_id: string | null;
    source_owner_id: string | null; target_owner_id: string | null }>;
}

/** Every read runs in ONE read-only repeatable-read snapshot, so all cells are judged against the same data. */
async function readConsultReceiptRows(workspaceId: string, conversations: string[], portIds: string[]): Promise<ConsultReceiptRows> {
  const { sql } = getOrgPg();
  return sql.begin('isolation level repeatable read, read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    const [identity] = await tx`SELECT current_database() AS database, inet_server_port() AS port`;
    const threads = conversations.map(id => `thr-${id}`);
    const consults = conversations.length === 0 ? [] : await tx`
      SELECT conversation_id, requester_id, state, dispatch_attempts FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ANY(${conversations}::text[])`;
    const posts = threads.length === 0 ? [] : await tx`
      SELECT p.id, p.thread_id, p.author_id, length(p.body) AS len, m.kind
        FROM harness_shared.coord_thread_posts p
        LEFT JOIN harness_shared.consult_post_meta m ON m.workspace_id = p.workspace_id AND m.post_id = p.id
          AND m.author_id = p.author_id AND p.thread_id = 'thr-' || m.conversation_id
       WHERE p.workspace_id = ${workspaceId} AND p.thread_id = ANY(${threads}::text[]) ORDER BY p.id`;
    const ports = portIds.length === 0 ? [] : await tx`
      SELECT p.id::text, p.source_backend, p.target_backend, p.status, p.delivered_at, p.error,
             p.source_adv_session_id::text, p.target_adv_session_id::text,
             src.coord_owner_id AS source_owner_id, tgt.coord_owner_id AS target_owner_id
        FROM harness_shared.session_ports p
        LEFT JOIN harness_shared.adv_sessions src ON src.workspace_id = p.workspace_id AND src.id = p.source_adv_session_id
        LEFT JOIN harness_shared.adv_sessions tgt ON tgt.workspace_id = p.workspace_id AND tgt.id = p.target_adv_session_id
       WHERE p.workspace_id = ${workspaceId} AND p.id::text = ANY(${portIds}::text[])`;
    return { database: String(identity?.database ?? ''), port: Number(identity?.port),
      consults: [...consults], posts: [...posts], ports: [...ports] } as ConsultReceiptRows;
  }) as Promise<ConsultReceiptRows>;
}

type Attempt = { dispatched?: unknown; verified?: unknown; agent?: unknown; operation?: unknown; answeringOwnerId?: unknown; sourceOwnerId?: unknown };

/**
 * The oracle. Judges one snapshot of durable rows against the committed claims and
 * the defined matrix; pure, so its every branch is unit-testable.
 */
export function judgeConsultReceiptMatrix(input: {
  artifact: ConsultReceiptMatrixArtifact;
  definition: Readonly<Record<string, CellDefinition>>;
  rows: Pick<ConsultReceiptRows, 'consults' | 'posts' | 'ports'>;
}): Assertion[] {
  const { artifact, definition, rows } = input;
  const assertions: Assertion[] = [];
  const add = (id: string, passed: boolean, evidence: string) =>
    assertions.push({ id, passed, evidence: evidence.slice(0, 2000) });
  for (const [name, def] of Object.entries(definition)) {
    const claimed = artifact.matrix.cells.filter(cell => cell.cell === name);
    const cell = claimed.length === 1 ? claimed[0]! : undefined;
    if (!cell) {
      add(`cell:${name}`, false, `artifact carries ${claimed.length} entries for defined cell ${name}; exactly one is required`);
      continue;
    }
    if ('failure' in cell) {
      add(`cell:${name}`, false, cell.failure);
      continue;
    }
    const consult = rows.consults.find(row => row.conversation_id === cell.conversationId);
    const attempts = (Array.isArray(consult?.dispatch_attempts) ? consult!.dispatch_attempts : []) as Attempt[];
    // A second rank can fail after the first responder has already answered.
    const attempt = attempts.find(a => a?.dispatched === true && a.verified === true &&
      a.answeringOwnerId === cell.answeringOwnerId && a.sourceOwnerId === cell.sourceOwnerId &&
      a.agent === def.targetBackend && a.operation === (def.mode === 'fork' ? 'fork' : 'convert'));
    const answering = typeof attempt?.answeringOwnerId === 'string' ? attempt.answeringOwnerId : null;
    const source = typeof attempt?.sourceOwnerId === 'string' ? attempt.sourceOwnerId : null;
    const requester = artifact.requesterId;
    // A consult cascade posts once per attempt (a decline, an earlier reply), so the first
    // qualifying post can belong to a session the cascade moved past. Judge the dispatched
    // session's own post; fall back to the first one so a missing dispatched answer still fails.
    const qualifying = rows.posts.filter(post => post.thread_id === `thr-${cell.conversationId}` &&
      post.author_id !== null && post.author_id !== requester && post.author_id !== source &&
      (post.kind === 'answer' || post.kind === 'new_fact') &&
      Number(post.len) >= CONSULT_RECEIPT_MIN_ANSWER_CHARS &&
      (cell.answerPostId == null || String(post.id) === cell.answerPostId));
    const answer = qualifying.find(post => answering !== null && post.author_id === answering) ?? qualifying[0];
    const checks: Record<string, boolean> = {
      artifact_reports_no_failure: cell.passed !== false,
      consult_row_present: consult !== undefined,
      // Canonical replies activate a consult. A decline can exceed the length
      // floor after valid native delivery, while leaving the consult expired.
      consult_has_answer: consult?.state === 'active' || consult?.state === 'closed_answered',
      mode_matches_definition: cell.mode === def.mode,
      requester_matches_claim: consult?.requester_id === requester,
      dispatched_session_matches_claim: answering !== null && answering === cell.answeringOwnerId,
      source_matches_claim: source !== null && source === cell.sourceOwnerId,
      distinct_answering_session: answering !== null && answering !== source && answering !== requester,
      substantive_answer_posted: answer !== undefined,
      answer_author_is_dispatched_session: answer !== undefined && answer.author_id === answering,
    };
    let mechanism: string;
    if (def.mode === 'fork') {
      checks.native_fork_dispatched = attempt?.operation === 'fork';
      checks.fork_backend_matches_definition = attempt?.agent === def.targetBackend;
      mechanism = `fork ${source ?? '-'} -> ${String(attempt?.agent ?? '-')} as ${answering ?? '-'}`;
    } else {
      const port = cell.portId ? rows.ports.find(row => row.id === cell.portId) : undefined;
      checks.port_row_present = port !== undefined;
      checks.port_delivered = port?.status === 'delivered' && port.delivered_at != null && !port.error;
      checks.backends_match_definition = port?.source_backend === def.sourceBackend && port?.target_backend === def.targetBackend;
      checks.distinct_target_session = !!port?.target_adv_session_id && port.target_adv_session_id !== port.source_adv_session_id;
      checks.port_belongs_to_dispatch = port?.source_owner_id === cell.sourceOwnerId && port?.target_owner_id === cell.answeringOwnerId;
      if (cell.sourceAdvSessionId !== undefined) checks.port_source_session_matches = port?.source_adv_session_id === cell.sourceAdvSessionId;
      if (cell.targetAdvSessionId !== undefined) checks.port_target_session_matches = port?.target_adv_session_id === cell.targetAdvSessionId;
      mechanism = `port ${cell.portId ?? 'none'} ${port?.source_backend ?? '-'}->${port?.target_backend ?? '-'} ` +
        `status ${port?.status ?? '-'}; ${String(attempt?.operation ?? '-')} as ${answering ?? '-'}`;
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    add(`cell:${name}`, failed.length === 0,
      `${cell.conversationId} (request key ${cell.requestKey}): ${mechanism}; consult ${consult?.state ?? 'missing'}; ` +
      `answer post ${answer ? `${answer.id} by ${answer.author_id} (${answer.len} chars)` : 'NONE'}; ` +
      `failed=${failed.join(',') || 'none'}`);
  }
  const defined = Object.keys(definition);
  const checked = assertions.filter(a => a.passed).map(a => a.id.slice('cell:'.length));
  const extra = artifact.matrix.cells.map(cell => cell.cell).filter(name => !Object.hasOwn(definition, name));
  add('matrix:all-defined-cells-checked', checked.length === defined.length && extra.length === 0,
    `defined=${defined.join(',')}; checked=${checked.join(',') || 'none'}; undefined-in-artifact=${extra.join(',') || 'none'}`);
  return assertions;
}

/** Execute the receipt-matrix re-verification against the operator database and record it. */
export async function executeConsultReceiptMatrix(
  evidenceFile: string,
  ctx: NativeCheckContext,
  deps?: {
    readSource?: (path: string) => Promise<string>;
    query?: (workspaceId: string, conversations: string[], portIds: string[]) => Promise<ConsultReceiptRows>;
    execution?: NativeCheckExecution;
  },
) {
  if (!/^docs\/evidence\/[A-Za-z0-9._/-]+\.json$/.test(evidenceFile) || evidenceFile.includes('..')) {
    return { ok: false, error: 'invalid_evidence_file' as const };
  }
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return { ok: false, error: 'workspace_required' as const };
  const readSource = deps?.readSource ?? (async (path: string) => {
    const root = await (deps?.execution?.sourceRoot ?? resolveOperationalSourceRoot)();
    if (!root) throw new Error('operational source root unavailable');
    return readFile(join(root, path), 'utf8');
  });
  const query = deps?.query ?? readConsultReceiptRows;
  // The database unit is witnessed before execution, so identify the server first.
  let server: ConsultReceiptRows;
  try { server = await query(workspaceId, [], []); }
  catch { return { ok: false, error: 'operational_database_unavailable' as const }; }
  if (!server.database || !Number.isInteger(server.port) || server.port <= 0) {
    return { ok: false, error: 'operational_database_unavailable' as const };
  }
  return executeOperationalRun({ filePath: CONSULT_RECEIPT_CHECK_PATH,
    name: 'get-feedback native consult receipt matrix (re-verified against the operator database)',
    framework: 'operational',
    command: ['testing:record-native-check', 'consultReceiptMatrix', evidenceFile],
    runtimeUnits: [`postgres:${server.port}`],
    run: async () => {
      const text = await readSource(evidenceFile);
      const digest = createHash('sha256').update(text).digest('hex');
      const assertions: Assertion[] = [];
      const parsed = (() => { try { return matrixArtifactSchema.safeParse(JSON.parse(text)); } catch { return null; } })();
      if (!parsed?.success) {
        return { exitCode: 1, summary: 'Receipt-matrix artifact is not a parseable matrix.', assertions: [{
          id: 'definition:artifact-parsed', passed: false, evidence: `${evidenceFile} sha256:${digest}` }] };
      }
      const artifact = parsed.data;
      const definition = Object.hasOwn(CONSULT_RECEIPT_MATRICES, artifact.plan) ? CONSULT_RECEIPT_MATRICES[artifact.plan] : undefined;
      assertions.push({ id: 'definition:matrix-defined', passed: definition !== undefined,
        evidence: `plan=${artifact.plan}; artifact ${evidenceFile} sha256:${digest}` });
      if (definition) {
        const receipts = artifact.matrix.cells.filter((cell): cell is CheckedReceipt => !('failure' in cell));
        const conversations = [...new Set(receipts.map(cell => cell.conversationId))];
        const portIds = [...new Set(receipts.flatMap(cell => cell.portId ? [cell.portId] : []))];
        const rows = await query(workspaceId, conversations, portIds);
        assertions.push({ id: 'scope:database-unchanged', passed: rows.database === server.database && rows.port === server.port,
          evidence: `witnessed ${server.database}@${server.port}; executed ${rows.database}@${rows.port}` });
        assertions.push(...judgeConsultReceiptMatrix({ artifact, definition, rows }));
      }
      const failed = assertions.some(assertion => !assertion.passed);
      return { exitCode: failed ? 1 : 0, assertions,
        summary: failed ? 'Receipt matrix re-verification failed; inspect the recorded assertions.'
          : `Every defined cell's native receipt and substantive answer re-verified in one read-only snapshot of ${server.database}@${server.port}.` };
    },
  }, ctx, deps?.execution);
}
