import { beforeEach, describe, expect, it } from 'vitest';
import { lookupByMcpName } from '@papercusp/tooldef';
import tool, { goalEvidenceArgs } from './evidence';
import { GOAL_EVIDENCE_ACTION } from './history';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let goalRows: Array<{ workspace_id: string }> = [];

function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/SELECT workspace_id FROM harness_shared\.goals/.test(sql)) return Promise.resolve(goalRows);
    return Promise.resolve([]);
  };
}

const CTX = () => ({
  tx: makeTx() as never,
  uiClientId: 'su-goal-executor',
  principal: { slug: 'system:operator', workspaceId: 'papercusp-workspace' } as never,
  role: 'blender',
  log: () => undefined,
});

beforeEach(() => {
  calls = [];
  goalRows = [{ workspace_id: 'papercusp-workspace' }];
});

describe('blender:attach-goal-evidence — zero-authority write', () => {
  it('appends a finding and never updates the goal row', async () => {
    const result = await tool.handler(
      goalEvidenceArgs.parse({
        goalId: 'goal-1',
        kind: 'finding',
        summary: '  retention fell below the tripwire  ',
        detail: '  Cohort C-17 fell to 31%.  ',
        refs: [' WI-39969 '],
      }) as never,
      CTX() as never,
    );

    const insert = calls.find((call) => /INSERT INTO harness_shared\.audit_log/.test(call.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[2]).toBe('su-goal-executor');
    expect(insert!.params[3]).toBe(GOAL_EVIDENCE_ACTION);
    expect(insert!.params[4]).toBe('goal-1');
    expect(JSON.parse(insert!.params[5] as string)).toEqual({
      kind: 'finding',
      summary: 'retention fell below the tripwire',
      detail: 'Cohort C-17 fell to 31%.',
      refs: ['WI-39969'],
    });
    expect(calls.some((call) => /UPDATE harness_shared\.goals/.test(call.sql))).toBe(false);
    expect((result as { data: { kind: string } }).data.kind).toBe('finding');
  });

  it('degrades without writing when the goal does not exist', async () => {
    goalRows = [];
    const result = (await tool.handler(
      goalEvidenceArgs.parse({ goalId: 'missing', summary: 'fact' }) as never,
      CTX() as never,
    )) as { data: unknown; degraded?: boolean; degradedReasons?: string[] };

    expect(result.data).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toEqual(['goal missing not found']);
    expect(calls.some((call) => /INSERT INTO harness_shared\.audit_log/.test(call.sql))).toBe(false);
  });

  it('refuses blank content and every goal-mutating field at the schema boundary', () => {
    expect(goalEvidenceArgs.safeParse({ goalId: 'goal-1', summary: '   ' }).success).toBe(false);
    expect(
      goalEvidenceArgs.safeParse({
        goalId: 'goal-1',
        summary: 'fact',
        budgetCents: 99999,
      }).success,
    ).toBe(false);
    expect(
      goalEvidenceArgs.safeParse({
        goalId: 'goal-1',
        summary: 'fact',
        killCriterion: 'never stop',
      }).success,
    ).toBe(false);
  });
});

describe('blender:attach-goal-evidence — registration', () => {
  it('is a goals:write tool explicitly available to Blender', () => {
    const registered = lookupByMcpName('blender:attach-goal-evidence')!;
    expect(registered).toBeDefined();
    expect(registered.capabilities).toContain('goals:write');
    expect(registered.agentRoles).toContain('blender');
  });
});
