import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { APIResponse } from '@playwright/test';
import type { Sql } from 'postgres';

export function assertFixtureApiSuccess(verb: string, data: unknown): asserts data is { ok: true; [key: string]: unknown } {
  const result = data as { ok?: unknown; error?: unknown } | null;
  if (result?.ok !== true || result.error != null) {
    throw new Error(`Fixture API ${verb} refused: ${JSON.stringify(data)}`);
  }
}

// plans:get defaults to structured sections. Exact document readback must
// request mode=full and compare raw, the same bytes used by set-content CAS.
export function assertFixturePlanReadback(data: unknown, expectedHash: unknown, authoredContent: string): void {
  assertFixtureApiSuccess('get', data);
  if (typeof expectedHash !== 'string' || !expectedHash || data.contentHash !== expectedHash || data.raw !== authoredContent) {
    throw new Error(`Fixture plan readback mismatch: ${JSON.stringify({
      expectedHash, actualHash: data.contentHash, hasRaw: typeof data.raw === 'string',
      exactContent: data.raw === authoredContent,
    })}`);
  }
}

export interface FixtureWriteRevision {
  revisionId: string;
  revisionHash: string;
  headHash: string;
  exactDocument: boolean;
  matchesRequest: boolean;
}

export type FixturePlanWrite =
  | { verb: 'new'; title: string; status: 'draft' }
  | { verb: 'add-item'; phase: string; importance: string; text: string }
  | { verb: 'set-content'; content: string; expectedVersion: number; expectedHash: string };

export function readFixtureWriteRevisions(
  sql: Sql, scope: { workspace: string; harness: string; slug: string }, rationale: string, write: FixturePlanWrite,
) {
  let matches;
  switch (write.verb) {
    case 'new':
      matches = sql`p.title=${write.title} AND p.status=${write.status} AND p.version=1
        AND NOT EXISTS (SELECT 1 FROM harness_shared.plan_revisions prior WHERE
          (prior.workspace_id,prior.harness_slug,prior.plan_slug)=(r.workspace_id,r.harness_slug,r.plan_slug) AND prior.seq<r.seq)`;
      break;
    case 'add-item':
      matches = sql`(SELECT count(*)=1 FROM jsonb_array_elements(p.items) i WHERE i->>'text'=${write.text}
                    AND i->>'importance'=${write.importance} AND i->>'phase'=${write.phase})
        AND strpos(r.content_snapshot,${write.text})>0 AND EXISTS (SELECT 1 FROM harness_shared.plan_revisions prior WHERE
          (prior.workspace_id,prior.harness_slug,prior.plan_slug)=(r.workspace_id,r.harness_slug,r.plan_slug)
          AND prior.seq=r.seq-1 AND strpos(prior.content_snapshot,${write.text})=0)`;
      break;
    case 'set-content':
      matches = sql`p.content=${write.content} AND p.version=${write.expectedVersion + 1}
        AND EXISTS (SELECT 1 FROM harness_shared.plan_revisions prior WHERE
          (prior.workspace_id,prior.harness_slug,prior.plan_slug)=(r.workspace_id,r.harness_slug,r.plan_slug)
          AND prior.seq=r.seq-1 AND prior.content_hash=${write.expectedHash})`;
      break;
  }
  return sql<FixtureWriteRevision[]>`SELECT r.id::text AS "revisionId", r.content_hash AS "revisionHash",
    p.content_hash AS "headHash", (r.content_snapshot=p.content AND
      encode(sha256(convert_to(p.content,'UTF8')),'hex')=p.content_hash) AS "exactDocument",
    (${matches}) AS "matchesRequest"
    FROM harness_shared.plan_revisions r JOIN harness_shared.harness_plans p USING (workspace_id,harness_slug,plan_slug)
    WHERE r.workspace_id=${scope.workspace} AND r.harness_slug=${scope.harness} AND r.plan_slug=${scope.slug}
      AND r.rationale=${rationale} ORDER BY r.seq`;
}

export interface FixtureWriteEvidence {
  verb: string;
  rationale: string;
  outcome: 'submitted' | 'accepted' | 'refused' | 'unknown' | 'recovered';
  startedAt: string;
  finishedAt?: string;
  httpStatus?: number;
  transportError?: string;
  revisionReads?: number;
  revisions?: FixtureWriteRevision[];
}

/** A setup POST may commit after its client loses the response. Send once and
 * accept only the original acknowledgement or its exact, still-current revision. */
export async function submitFixturePlanWrite(
  evidence: FixtureWriteEvidence,
  post: () => Promise<Pick<APIResponse, 'ok' | 'status' | 'json'>>,
  recover: () => Promise<FixtureWriteRevision[]>,
): Promise<void> {
  try {
    let payload: unknown;
    try {
      const response = await post();
      evidence.httpStatus = response.status();
      if (!response.ok()) {
        evidence.outcome = 'refused';
        throw new Error('Fixture ' + evidence.verb + ' HTTP ' + response.status());
      }
      payload = await response.json();
    } catch (error) {
      if (evidence.outcome === 'refused') throw error;
      evidence.outcome = 'unknown';
      evidence.transportError = error instanceof Error ? error.message.split('\n', 1)[0] : String(error);
      const rows = await recover();
      evidence.revisions = rows;
      const row = rows[0];
      if (rows.length !== 1 || !row?.revisionId || !row.matchesRequest || !row.exactDocument ||
          !/^[0-9a-f]{64}$/.test(row.revisionHash) || row.headHash !== row.revisionHash) {
        throw new Error('Unconfirmed fixture ' + evidence.verb + ' after a transport failure', { cause: error });
      }
      evidence.outcome = 'recovered';
      return;
    }
    evidence.outcome = 'refused';
    assertFixtureApiSuccess(evidence.verb, payload);
    evidence.outcome = 'accepted';
  } finally {
    evidence.finishedAt = new Date().toISOString();
  }
}

export function fixtureChildFailure(error: unknown): Error {
  const child = error as { message?: string; code?: unknown; signal?: unknown; killed?: boolean; stdout?: string; stderr?: string };
  return new Error(`Isolated fixture child failed: ${JSON.stringify({
    message: child.message, code: child.code, signal: child.signal, killed: child.killed,
    stdout: child.stdout, stderr: child.stderr,
  })}`, { cause: error });
}

// execFile's message echoes the command, including its error strings. Only
// the child's actual stderr and exit disposition can prove a gate refusal.
export function fixtureChildWasGateRefusal(error: unknown): boolean {
  const child = (error as { cause?: unknown } | null)?.cause as
    { code?: unknown; signal?: unknown; killed?: boolean; stderr?: unknown } | undefined;
  return child?.code === 1 && child.signal == null && child.killed !== true &&
    typeof child.stderr === 'string' &&
    /^(?:Error: )?Plan fixture launch precondition failed:/m.test(child.stderr);
}

// Register a real harness only in the maintained disposable rig. The chat
// tools resolve their project before entering the fake model seam.
export async function seedFakeLlmHarness(options: { hive?: boolean } = {}): Promise<string> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return 'main';
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated chat fixture context');
  const database = new URL(admin);
  const slug = options.hive ? 'e2e-fake-plan' : 'e2e-fake-chat';
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared chat fixture database');
  await runFixtureChild(root, admin, ['harness', slug]);
  return slug;
}

// Use the maintained transactional BAR writer, then the actual launch gate.
// This fixture is deliberately confined to the disposable database; it never
// changes admission policy or fabricates a successful gate verdict.
export async function seedFakeLlmPlanAcceptance(harnessSlug: string, planSlug: string): Promise<void> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return;
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated plan fixture context');
  const database = new URL(admin);
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared plan fixture database');
  await runFixtureChild(root, admin, ['plan', harnessSlug, planSlug]);
}

async function runFixtureChild(root: string, admin: string, args: string[]): Promise<void> {
  await promisify(execFile)(process.execPath, [
    resolve(root, 'apps/operator/dist-verify/fake-llm-fixture-child.mjs'), ...args,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 })
    .catch(error => { throw fixtureChildFailure(error); });
}
