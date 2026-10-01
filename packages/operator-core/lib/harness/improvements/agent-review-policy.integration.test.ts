import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';

import {
  acceptanceSourceRevision,
  acceptanceSourceRevisionSql,
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  implementationReadinessNormalExclusionSql,
  sealImplementationAcceptance,
  workItemIntakeStageSql,
  type ImplementationAcceptanceAuthority,
  type ImplementationAcceptanceContract,
  type ImplementationAcceptanceSource,
  type WorkItemIntakeStageInput,
} from './agent-review-policy';
import type { OrgSql } from '../../work-items';

let sql: postgres.Sql;

const TITLE = 'Bounded parser drops the trailing token';
const SUMMARY = 'The bounded parser drops the last token of every line.';
const BUG_SOURCE: ImplementationAcceptanceSource = { kind: 'bug', title: TITLE, summary: SUMMARY };

const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};

const REVIEW_AUTHORITY: ImplementationAcceptanceAuthority = {
  kind: 'agent-review',
  reviewer: 'su-reviewer',
  submittedBy: 'su-author',
  round: 1,
};

function sealedContract(
  source: ImplementationAcceptanceSource = BUG_SOURCE,
  authority: ImplementationAcceptanceAuthority = REVIEW_AUTHORITY,
): ImplementationAcceptanceContract {
  const sealed = sealImplementationAcceptance({
    proposal: PROPOSAL,
    authority,
    reason: 'agent-review-approved (grade 5/5)',
    source,
    acceptedAt: '2026-09-05T00:00:00.000Z',
  });
  if (!sealed.ok) throw new Error('fixture contract must seal');
  return sealed.contract;
}

const readinessWith = (acceptance: object | undefined, status: 'ready' | 'unknown' = 'ready') =>
  createImplementationReadiness({
    status,
    source: 'agent-review',
    reason: 'agent-review-approved',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
  });

const acceptedReadiness = (source: ImplementationAcceptanceSource = BUG_SOURCE) => readinessWith(sealedContract(source));

const withoutKey = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

const open = (payload: unknown, overrides: Partial<WorkItemIntakeStageInput> = {}): WorkItemIntakeStageInput => ({
  kind: 'bug',
  status: 'open',
  title: TITLE,
  summary: SUMMARY,
  payload,
  ...overrides,
});

const fixtures: Array<{ id: string; input: WorkItemIntakeStageInput }> = [
  {
    id: 'observation-closed',
    input: open({ lane: 'observation', implementationReadiness: acceptedReadiness() }, { status: 'done' }),
  },
  {
    id: 'candidate-unknown',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'unknown',
        source: 'agent-review',
        reason: 'awaiting-review',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  {
    id: 'candidate-ready-without-contract',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'ready',
        source: 'capture-policy',
        reason: 'legacy-immediate-policy',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  { id: 'accepted-bug', input: open({ implementationReadiness: acceptedReadiness() }) },
  {
    id: 'accepted-feature',
    input: open(
      { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, kind: 'feature' }) },
      { kind: 'feature' },
    ),
  },
  {
    id: 'accepted-null-summary',
    input: open(
      { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, summary: null }) },
      { summary: null },
    ),
  },
  {
    id: 'accepted-policy-authority',
    input: open({
      implementationReadiness: readinessWith(
        sealedContract(BUG_SOURCE, {
          kind: 'policy',
          policy: 'trusted-tool-failure-promotion',
          actor: 'system:tool-failure-watchdog',
        }),
      ),
    }),
  },
  {
    id: 'stale-title-edit',
    input: open({ implementationReadiness: acceptedReadiness() }, { title: `${TITLE} (rescoped)` }),
  },
  {
    id: 'stale-summary-edit',
    input: open({ implementationReadiness: acceptedReadiness() }, { summary: `${SUMMARY} Also the header.` }),
  },
  {
    id: 'invalid-self-review',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' } }),
    }),
  },
  {
    id: 'invalid-unknown-policy',
    input: open({
      implementationReadiness: readinessWith({
        ...sealedContract(),
        authority: { kind: 'policy', policy: 'duplicate-admission', actor: 'system:dedup' },
      }),
    }),
  },
  {
    id: 'invalid-confidence-authority',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { kind: 'confidence', confidence: 0.99 } }),
    }),
  },
  {
    id: 'invalid-string-round',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { ...REVIEW_AUTHORITY, round: '1' } }),
    }),
  },
  {
    // SQL NULL fall-through guard: a missing key must read `incomplete`, never skip
    // the branch and land on `qualifying`.
    id: 'incomplete-missing-contract-version',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'contractVersion')) }),
  },
  {
    id: 'incomplete-missing-authority',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'authority')) }),
  },
  {
    id: 'incomplete-array-authority',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), authority: [REVIEW_AUTHORITY] }) }),
  },
  {
    id: 'incomplete-missing-completion-check',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'completionCheck')) }),
  },
  {
    id: 'incomplete-numeric-reason',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), reason: 5 }) }),
  },
  {
    // btrim() strips only spaces; String.prototype.trim strips every whitespace class.
    id: 'incomplete-newline-only-scope',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), scope: '\n\t' }) }),
  },
  {
    id: 'incomplete-blank-evidence-entry',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), evidence: ['ok', ' \n '] }) }),
  },
  { id: 'proposal-on-unknown', input: open({ implementationReadiness: readinessWith(PROPOSAL, 'unknown') }) },
  {
    id: 'creation-enrollment',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'unknown',
        source: 'creation-enrollment',
        reason: 'no-acceptance-evidence-at-creation',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  { id: 'terminal-by-state', input: open({ implementationReadiness: acceptedReadiness() }, { status: 'done' }) },
  {
    id: 'terminal-by-completion-ref',
    input: open(
      { implementationReadiness: acceptedReadiness() },
      { terminalOwner: 'su-finisher', terminalCompletionRef: 'WI-1#completion' },
    ),
  },
  { id: 'legacy-missing', input: open({}) },
  {
    id: 'malformed-version',
    input: open({ implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } }),
  },
  {
    // SQL NULL fall-through guard for the readiness validity check itself.
    id: 'malformed-missing-schema-version',
    input: open({ implementationReadiness: withoutKey({ ...acceptedReadiness() }, 'schemaVersion') }),
  },
  {
    id: 'malformed-numeric-reason',
    input: open({ implementationReadiness: { ...acceptedReadiness(), reason: 7 } }),
  },
  {
    id: 'malformed-timestamp',
    input: open({ implementationReadiness: { ...acceptedReadiness(), updatedAt: 'not-a-timestamp' } }),
  },
];

beforeAll(async () => {
  const dsn = inject('baselineSchemaDsn');
  await assertPgReachable(dsn, 'agent-review-stage-parity');
  sql = postgres(dsn, { max: 1, onnotice: () => {}, prepare: false });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('workItemIntakeStageSql', () => {
  it('matches the shared TypeScript derivation for every supported fixture', async () => {
    const rows: Array<{ id: string; decision: unknown }> = [];
    for (const { id, input } of fixtures) {
      const [row] = await sql<Array<{ decision: unknown }>>`
        SELECT ${workItemIntakeStageSql(sql as unknown as OrgSql)} AS decision
          FROM (VALUES (
            ${input.kind}::text,
            ${input.status}::text,
            ${input.terminalOwner ?? null}::text,
            ${input.terminalCompletionRef ?? null}::text,
            ${input.payload == null ? null : sql.json(input.payload as postgres.JSONValue)}::jsonb,
            ${input.title ?? null}::text,
            ${input.summary ?? null}::text
          )) AS fixture(item_kind, status, terminal_owner, terminal_completion_ref, payload, title, summary)`;
      rows.push({ id, decision: row.decision });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const expected = [...fixtures]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, input }) => ({ id, decision: deriveWorkItemIntakeStage(input) }));

    expect(rows).toEqual(expected);
    // Pin the load-bearing verdicts so a symmetric regression on both sides still fails.
    const byId = new Map(rows.map((row) => [row.id, row.decision]));
    expect(byId.get('observation-closed')).toMatchObject({ primaryStage: 'observation', countsAsBugWork: false });
    expect(byId.get('accepted-bug')).toMatchObject({ primaryStage: 'accepted', acceptance: 'qualifying' });
    expect(byId.get('stale-title-edit')).toMatchObject({
      primaryStage: 'candidate',
      acceptance: 'stale-revision',
      reReviewRequested: true,
    });
    expect(byId.get('invalid-self-review')).toMatchObject({ acceptance: 'invalid-authority' });
    // R-24 (P-007): duplicate admission and confidence are never acceptance authority —
    // pinned directly so a symmetric SQL+TS widening of the policy allowlist still fails.
    expect(byId.get('invalid-unknown-policy')).toMatchObject({ acceptance: 'invalid-authority', qualifyingAcceptance: false });
    expect(byId.get('invalid-confidence-authority')).toMatchObject({
      acceptance: 'invalid-authority',
      qualifyingAcceptance: false,
    });
    expect(byId.get('incomplete-missing-contract-version')).toMatchObject({ acceptance: 'incomplete' });
    expect(byId.get('incomplete-newline-only-scope')).toMatchObject({ acceptance: 'incomplete' });
    expect(byId.get('malformed-missing-schema-version')).toMatchObject({ primaryStage: 'unknown', readiness: 'malformed' });
    expect(byId.get('creation-enrollment')).toMatchObject({ primaryStage: 'candidate', readiness: 'unknown' });
  });

  it('computes the same source revision in SQL as in TypeScript', async () => {
    for (const source of [BUG_SOURCE, { ...BUG_SOURCE, summary: null }, { kind: 'task', title: 'ünïcødé — title', summary: 'x' }]) {
      const [row] = await sql<Array<{ revision: string }>>`
        SELECT ${acceptanceSourceRevisionSql(sql as unknown as OrgSql)} AS revision
          FROM (VALUES (${source.kind}::text, ${source.title}::text, ${source.summary ?? null}::text))
            AS fixture(item_kind, title, summary)`;
      expect(row.revision).toBe(acceptanceSourceRevision(source));
    }
  });
});

describe('implementationReadinessNormalExclusionSql (claim floor)', () => {
  const stamp = createImplementationReadiness({
    status: 'unknown',
    source: 'creation-enrollment',
    reason: 'no-acceptance-evidence-at-creation',
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  const cases: Array<{ id: string; payload: unknown; passes: boolean }> = [
    { id: 'legacy-absent', payload: {}, passes: true },
    { id: 'null-payload', payload: null, passes: true },
    { id: 'creation-enrollment-legacy-equivalent', payload: { implementationReadiness: stamp }, passes: true },
    { id: 'ready', payload: { implementationReadiness: acceptedReadiness() }, passes: true },
    {
      id: 'capture-policy-unknown',
      payload: { implementationReadiness: { ...stamp, source: 'capture-policy' } },
      passes: false,
    },
    {
      id: 'not-ready',
      payload: { implementationReadiness: { ...stamp, status: 'not-ready', source: 'agent-review' } },
      passes: false,
    },
    { id: 'malformed-object', payload: { implementationReadiness: { status: 'ready' } }, passes: false },
    { id: 'malformed-scalar', payload: { implementationReadiness: 'garbage' }, passes: false },
  ];

  it.each(cases)('$id → passes=$passes, never NULL', async ({ payload, passes }) => {
    const [row] = await sql<Array<{ passes: boolean | null; held: boolean | null }>>`
      SELECT ${implementationReadinessNormalExclusionSql(sql as unknown as OrgSql, 'payload')} AS passes,
             NOT ${implementationReadinessNormalExclusionSql(sql as unknown as OrgSql, 'payload')} AS held
        FROM (VALUES (${payload == null ? null : sql.json(payload as postgres.JSONValue)}::jsonb)) AS fixture(payload)`;
    expect(row).toEqual({ passes, held: !passes });
  });
});
