import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';

import {
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  workItemIntakeStageSql,
  type WorkItemIntakeStageInput,
} from './agent-review-policy';

let sql: postgres.Sql;

const acceptedReadiness = () =>
  createImplementationReadiness({
    status: 'ready',
    source: 'agent-review',
    reason: 'agent-review-approved',
    updatedAt: '2026-09-05T00:00:00.000Z',
    evidence: {
      acceptance: {
        scope: 'Fix the bounded parser defect.',
        completionCheck: 'The regression fixture passes.',
      },
    },
  });

const fixtures: Array<{ id: string; input: WorkItemIntakeStageInput }> = [
  {
    id: 'observation-closed',
    input: {
      kind: 'bug',
      status: 'done',
      payload: { lane: 'observation', implementationReadiness: acceptedReadiness() },
    },
  },
  {
    id: 'candidate-unknown',
    input: {
      kind: 'bug',
      status: 'open',
      payload: {
        implementationReadiness: createImplementationReadiness({
          status: 'unknown',
          source: 'agent-review',
          reason: 'awaiting-review',
          updatedAt: '2026-09-05T00:00:00.000Z',
        }),
      },
    },
  },
  {
    id: 'candidate-ready-without-contract',
    input: {
      kind: 'bug',
      status: 'open',
      payload: {
        implementationReadiness: createImplementationReadiness({
          status: 'ready',
          source: 'capture-policy',
          reason: 'legacy-immediate-policy',
          updatedAt: '2026-09-05T00:00:00.000Z',
        }),
      },
    },
  },
  {
    id: 'accepted-bug',
    input: {
      kind: 'bug',
      status: 'open',
      payload: { implementationReadiness: acceptedReadiness() },
    },
  },
  {
    id: 'terminal-by-state',
    input: {
      kind: 'bug',
      status: 'done',
      payload: { implementationReadiness: acceptedReadiness() },
    },
  },
  {
    id: 'terminal-by-completion-ref',
    input: {
      kind: 'bug',
      status: 'open',
      terminalOwner: 'su-finisher',
      terminalCompletionRef: 'WI-1#completion',
      payload: { implementationReadiness: acceptedReadiness() },
    },
  },
  { id: 'legacy-missing', input: { kind: 'bug', status: 'open', payload: {} } },
  {
    id: 'malformed-version',
    input: {
      kind: 'bug',
      status: 'open',
      payload: { implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } },
    },
  },
  {
    id: 'malformed-timestamp',
    input: {
      kind: 'bug',
      status: 'open',
      payload: {
        implementationReadiness: {
          ...acceptedReadiness(),
          updatedAt: 'not-a-timestamp',
        },
      },
    },
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
        SELECT ${workItemIntakeStageSql(sql)} AS decision
          FROM (VALUES (
            ${input.kind},
            ${input.status},
            ${input.terminalOwner ?? null},
            ${input.terminalCompletionRef ?? null},
            ${input.payload == null ? null : sql.json(input.payload as postgres.JSONValue)}
          )) AS fixture(item_kind, status, terminal_owner, terminal_completion_ref, payload)`;
      rows.push({ id, decision: row.decision });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const expected = [...fixtures]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, input }) => ({ id, decision: deriveWorkItemIntakeStage(input) }));

    expect(rows).toEqual(expected);
    expect(rows.find((row) => row.id === 'observation-closed')).toMatchObject({
      decision: { primaryStage: 'observation', countsAsBugWork: false },
    });
  });
});
