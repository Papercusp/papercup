/**
 * Stranded tool-failure sweep against a fully migrated Postgres (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05 P-003 / D-022;
 * EI-25176539351759672).
 *
 * Drives the real candidate query, the real tool_invocations ledger read, the
 * real payload merge, terminal-state write and agent-review enrolment. Only git
 * and the tool-source lookup are injected: they describe a repository, not the
 * database, and a fixed history is what makes the retirement verdict checkable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { GitRead } from '../../candidate-contains';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const { STRANDED_SWEEP_OWNER, sweepStrandedToolFailures } = await import('./stranded-tool-failure-sweep');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const ROOT = '/repo';
const REPORT = 'aaaaaaa1111';
const CURRENT = 'bbbbbbb2222';
const HOUR = 3_600_000;

/** One commit history per tool file; `--since` filters by commit time, as git does. */
function gitWith(history: Record<string, Array<{ sha: string; at: string }>>): GitRead {
  return async (args) => {
    if (args[0] === 'config') return '';
    const path = String(args.at(-1));
    if (args[0] === 'ls-tree') return `100644 blob 0123456789abcdef\t${path}`;
    if (args[0] !== 'log') return null;
    const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
    return (history[path] ?? [])
      .filter((commit) => !since || Date.parse(commit.at) >= Date.parse(since))
      .map((commit) => commit.sha)
      .join('\n');
  };
}

describe('stranded tool-failure sweep (P-003 / D-022)', () => {
  it('verifies, retires and enrols the stranded rows, and leaves taken rows alone', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const t0 = new Date(Date.now() - 6 * HOUR).toISOString();
    const at = (hours: number) => new Date(Date.parse(t0) + hours * HOUR).toISOString();
    const tool = (name: string) => `sweep-${name}:${suffix}`;

    const make = async (name: string) => {
      const filed = await captureImprovement({
        title: `stranded sweep ${name} ${suffix}`,
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-test',
      });
      return filed.issue!.id;
    };
    const ids = {
      retire: await make('retire'),
      recurring: await make('recurring'),
      verified: await make('verified'),
      freshness: await make('freshness'),
      taken: await make('taken'),
    };
    const [{ workspace_id: workspaceId }] = await db.adminSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${ids.retire}`;

    // The failing call a receipt cites, and the failure that keeps a row open.
    const [{ id: receiptCall }] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, status, error_code, serving_build_sha, invoked_at)
      VALUES (${workspaceId}, 'papercusp', ${tool('verified')}, 'error', 'handler_error', ${REPORT}, ${at(0)}::timestamptz)
      RETURNING id`;
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, status, error_code, serving_build_sha, invoked_at)
      VALUES
        (${workspaceId}, 'papercusp', ${tool('retire')}, 'error', 'handler_error', ${REPORT}, ${at(1)}::timestamptz),
        (${workspaceId}, 'papercusp', ${tool('recurring')}, 'error', 'timeout', ${CURRENT}, ${at(4)}::timestamptz),
        -- A success and a different error code never block retirement.
        (${workspaceId}, 'papercusp', ${tool('retire')}, 'ok', NULL, ${CURRENT}, ${at(5)}::timestamptz),
        (${workspaceId}, 'papercusp', ${tool('retire')}, 'invalid-input', 'invalid_input', ${CURRENT}, ${at(5)}::timestamptz)`;

    // Put each row in the state the pre-P-002 producers left it: promoted, awaiting a
    // verifier, no agentReview record, no admission hold.
    const strand = async (id: string, name: string, errorCode: string, reason: string, extra: Record<string, unknown> = {}) => {
      const patch = {
        implementationReadiness: {
          schemaVersion: 'implementation-readiness-v1',
          status: 'unknown',
          source: reason === 'deployment-freshness-unknown' ? 'triage-freshness' : 'capture-policy',
          reason,
          updatedAt: t0,
        },
        toolFailureProbation: {
          state: 'promoted',
          class: 'structural',
          deployedRevision: REPORT,
          report: { toolName: tool(name), errorCode },
        },
        freshnessEnvelope: { observedSourceSha: REPORT, observedRuntimeSha: REPORT, observedAt: t0 },
        ...extra,
      };
      await db.adminSql`
        UPDATE harness_shared.work_items
           SET admission = NULL,
               payload = (payload - 'agentReview' - 'lastSeenAt') || ${JSON.stringify(patch)}::jsonb
         WHERE feature_id = ${id}`;
    };
    await strand(ids.retire, 'retire', 'handler_error', 'corroborated-tool-failure-awaiting-review');
    await strand(ids.recurring, 'recurring', 'timeout', 'corroborated-tool-failure-awaiting-review');
    await strand(ids.verified, 'verified', 'handler_error', 'corroborated-tool-failure-awaiting-review', {
      reproduction: {
        schemaVersion: 'bug-reproduction-v1',
        receipt: { kind: 'encounter', ref: `tool_invocations:${receiptCall}`, buildSha: REPORT },
        filedBy: 'su-peer',
        verification: { status: 'verified', detail: 'filed', checkedAt: t0 },
      },
    });
    await strand(ids.freshness, 'freshness', 'handler_error', 'deployment-freshness-unknown');
    await strand(ids.taken, 'retire', 'handler_error', 'corroborated-tool-failure-awaiting-review');
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by = 'su-busy' WHERE feature_id = ${ids.taken}`;

    // retire + recurring: the tool file changed at +2h. freshness: the tool source is unknown.
    const file = (name: string) => `packages/${name}.ts`;
    const result = await sweepStrandedToolFailures(workspaceId, {
      sql: db.adminSql,
      currentBuild: () => CURRENT,
      repoRoot: ROOT,
      sourceFileFor: (name) => (name === tool('freshness') ? null : `${ROOT}/${file(name.split(':')[0])}`),
      git: gitWith({
        [file('sweep-retire')]: [{ sha: 'c-retire-fix', at: at(2) }],
        [file('sweep-recurring')]: [{ sha: 'c-recurring-fix', at: at(2) }],
      }),
    });
    expect(result.failed).toBe(0);
    expect(result.enrolFailed).toBe(0);

    const rows = await db.adminSql<{
      feature_id: string;
      status: string;
      taken_by: string | null;
      payload: Record<string, unknown>;
    }[]>`
      SELECT feature_id, status, taken_by, payload
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${Object.values(ids)}::text[])`;
    const byId = new Map(rows.map((row) => [row.feature_id, row]));

    // (2) retired with the D-012 evidence, under the sweep's own owner.
    const retired = byId.get(ids.retire)!;
    expect(retired.status).not.toBe('open');
    expect(retired.payload).toMatchObject({
      strandedToolFailureSweep: {
        owner: STRANDED_SWEEP_OWNER,
        outcome: 'retired',
        reportBuild: REPORT,
        currentBuild: CURRENT,
        changeCommits: ['c-retire-fix'],
        lastMatchingFailureAt: at(1),
      },
    });
    expect(String(retired.payload.decidedReason)).toContain('D-012/D-022');

    // (3) a failure after the change keeps the row: it enters agent review instead.
    const recurring = byId.get(ids.recurring)!;
    expect(recurring.status).toBe('open');
    expect(recurring.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: STRANDED_SWEEP_OWNER },
      strandedToolFailureSweep: { outcome: 'review', reason: 'failure-after-last-change' },
    });
    const { claimAgentReview } = await import('./agent-review');
    expect(await claimAgentReview({ id: ids.recurring, reviewer: 'su-reviewer', harnessSlug: 'papercusp' })).toMatchObject({
      claimed: true,
    });

    // (3) an unresolvable freshness never retires: review, for both stranded reasons.
    expect(byId.get(ids.freshness)!.payload).toMatchObject({
      agentReview: { status: 'pending' },
      strandedToolFailureSweep: { outcome: 'review', reason: 'tool-source-unknown' },
    });

    // (1) the cited failing call still resolves on its build: born verified and claimable.
    const verified = byId.get(ids.verified)!;
    expect(verified.payload).toMatchObject({
      implementationReadiness: { status: 'ready', reason: 'born-verified-tool-failure-promotion' },
      reproduction: { verification: { status: 'verified' } },
      strandedToolFailureSweep: { outcome: 'verified' },
    });
    expect(verified.payload).not.toHaveProperty('agentReview');
    const claimability = await readIssueClaimability(
      { field: 'id', op: 'in', value: [ids.verified] },
      { harness: 'papercusp', workspaceId, states: ['open'], assignee: 'su-test', client: db.adminSql },
      { limit: 10 },
    );
    expect(claimability.rows.map((row) => row.id)).toEqual([ids.verified]);

    // Someone else's taken row keeps its own disposition.
    const taken = byId.get(ids.taken)!;
    expect(taken.taken_by).toBe('su-busy');
    expect(taken.payload).not.toHaveProperty('strandedToolFailureSweep');
    expect(taken.payload).not.toHaveProperty('agentReview');

    // A second pass finds nothing left of these rows to do.
    const again = await sweepStrandedToolFailures(
      workspaceId,
      { sql: db.adminSql, currentBuild: () => CURRENT, repoRoot: ROOT, sourceFileFor: () => null, git: gitWith({}) },
      { dryRun: true },
    );
    const ours = new Set(Object.values(ids));
    expect((again.plan ?? []).filter((entry) => ours.has(entry.id))).toEqual([]);
  });
});
