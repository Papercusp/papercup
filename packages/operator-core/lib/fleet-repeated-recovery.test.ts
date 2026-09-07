import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  classifyRepeatedRecoveryByMember,
  classifyRepeatedRecoveryCycles,
  isRecoveryOnlyTool,
  normalizeRecoveryToolName,
  readFleetRepeatedRecoveryStates,
  repeatedRecoveryAlert,
  type RepeatedRecoveryCycleObservation,
} from './fleet-repeated-recovery';

const cycle = (
  cycleIndex: number,
  tools: readonly string[] = ['coord:orient', 'work_items:get', 'loop:checkpoint'],
  over: Partial<RepeatedRecoveryCycleObservation> = {},
): RepeatedRecoveryCycleObservation => ({
  ownerId: 'su-a',
  cycleIndex,
  startedAtMs: 1_000 + cycleIndex * 10_000,
  endedAtMs: 2_000 + cycleIndex * 10_000,
  activityCallCount: tools.length,
  transcriptCallCount: tools.length,
  activityUnnamedCount: 0,
  transcriptUnnamedCount: 0,
  activityTools: tools,
  transcriptTools: tools,
  ...over,
});

/**
 * Deliberately wrong classifier kept permanently in-test as the mutation
 * control. It broadens the recovery allowlist to every named tool while still
 * delegating interval/count validation to the real classifier. That makes it
 * wrong in exactly one dimension without mutating the shared checkout.
 */
function overbroadRecoveryClassifierControl(
  cycles: readonly RepeatedRecoveryCycleObservation[],
) {
  const eraseUsefulWork = (tools: readonly string[]) =>
    tools.map((tool) => (isRecoveryOnlyTool(tool) ? tool : 'coord:orient'));
  return classifyRepeatedRecoveryCycles(
    cycles.map((observation) => ({
      ...observation,
      activityTools: eraseUsefulWork(observation.activityTools),
      transcriptTools: eraseUsefulWork(observation.transcriptTools),
    })),
  );
}

describe('repeated recovery-only classifier', () => {
  it('requires two fully observed recovery-only cycles', () => {
    expect(classifyRepeatedRecoveryCycles([cycle(1)])).toMatchObject({
      status: 'measured',
      consecutiveRecoveryOnlyCycles: 1,
    });
    const state = classifyRepeatedRecoveryCycles([cycle(1), cycle(2)]);
    expect(state).toMatchObject({ status: 'measured', consecutiveRecoveryOnlyCycles: 2 });
    expect(repeatedRecoveryAlert(state)).toMatchObject({
      consecutiveRecoveryOnlyCycles: 2,
      action: 'diagnose',
      takeoverAuthorized: false,
    });
  });

  it('normalizes MCP-advertised names without widening the allowlist', () => {
    expect(normalizeRecoveryToolName('mcp__papercusp-su__work_items_get')).toBe('work_items_get');
    expect(isRecoveryOnlyTool('mcp__papercusp-su__work_items_get')).toBe(true);
    expect(isRecoveryOnlyTool('Read')).toBe(false);
    expect(isRecoveryOnlyTool('capability:read')).toBe(false);
  });

  it('useful investigation resets the streak', () => {
    expect(
      classifyRepeatedRecoveryCycles([
        cycle(1, ['coord:orient', 'dev:pg_query', 'loop:checkpoint']),
        cycle(2),
      ]),
    ).toMatchObject({ status: 'measured', consecutiveRecoveryOnlyCycles: 0 });
  });

  it('an external wait is protected useful work and resets the streak', () => {
    expect(
      classifyRepeatedRecoveryCycles([
        cycle(1, ['coord:orient', 'events:await', 'loop:checkpoint']),
        cycle(2),
      ]),
    ).toMatchObject({ status: 'measured', consecutiveRecoveryOnlyCycles: 0 });
  });

  it('keeps incomplete dual-store coverage unknown', () => {
    expect(
      classifyRepeatedRecoveryCycles([cycle(1, undefined, { activityCallCount: 3, transcriptCallCount: 2 })]),
    ).toEqual({ status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'incomplete-coverage' });
    expect(
      classifyRepeatedRecoveryCycles([cycle(1, undefined, { transcriptUnnamedCount: 1 })]),
    ).toEqual({ status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'incomplete-coverage' });
  });

  it('reports three persistent cycles without turning the threshold into a recurring edge', () => {
    expect(classifyRepeatedRecoveryCycles([cycle(1), cycle(2), cycle(3)])).toMatchObject({
      status: 'measured',
      consecutiveRecoveryOnlyCycles: 3,
    });
  });

  it('suppresses the registered leader and any member with progressing claim activity', () => {
    const states = classifyRepeatedRecoveryByMember(
      [
        { ownerId: 'su-leader', isRegisteredLeader: true },
        { ownerId: 'su-progress', hasProgressingClaim: true },
      ],
      [cycle(1, undefined, { ownerId: 'su-leader' }), cycle(1, undefined, { ownerId: 'su-progress' })],
    );
    expect(states.get('su-leader')).toEqual({
      status: 'suppressed',
      consecutiveRecoveryOnlyCycles: null,
      reason: 'registered-leader',
    });
    expect(states.get('su-progress')).toEqual({
      status: 'suppressed',
      consecutiveRecoveryOnlyCycles: null,
      reason: 'progressing-claim',
    });
  });
});

describe('repeated recovery-only classifier falsifiability control', () => {
  const usefulWork = [cycle(1, ['coord:orient', 'Read', 'loop:checkpoint']), cycle(2)];
  const recoveryOnly = [cycle(1), cycle(2)];

  it('CALIBRATION: the real classifier resets on useful work', () => {
    expect(classifyRepeatedRecoveryCycles(usefulWork)).toMatchObject({
      status: 'measured',
      consecutiveRecoveryOnlyCycles: 0,
    });
  });

  it('CONTROL: an overbroad false classifier fails the same useful-work assertion', () => {
    const falseResult = overbroadRecoveryClassifierControl(usefulWork);
    expect(falseResult).toMatchObject({ status: 'measured', consecutiveRecoveryOnlyCycles: 2 });
    expect(falseResult.consecutiveRecoveryOnlyCycles).not.toBe(0);
  });

  it('CONTROL: the false classifier otherwise matches a genuine recovery-only run', () => {
    expect(overbroadRecoveryClassifierControl(recoveryOnly)).toEqual(
      classifyRepeatedRecoveryCycles(recoveryOnly),
    );
  });
});

describe('readFleetRepeatedRecoveryStates', () => {
  it('uses one bounded batch query and projects the SQL rows through the pure classifier', async () => {
    let sqlText = '';
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      sqlText = strings.join('?');
      return [
        {
          owner_id: 'su-a',
          cycle_index: 1,
          started_at: new Date(1_000),
          ended_at: new Date(2_000),
          activity_call_count: 3,
          transcript_call_count: 3,
          activity_unnamed_count: 0,
          transcript_unnamed_count: 0,
          activity_tools: ['coord:orient', 'work_items:get', 'loop:checkpoint'],
          transcript_tools: ['mcp__papercusp-su__coord_orient', 'mcp__papercusp-su__work_items_get', 'mcp__papercusp-su__loop_checkpoint'],
        },
        {
          owner_id: 'su-a',
          cycle_index: 2,
          started_at: new Date(0),
          ended_at: new Date(1_000),
          activity_call_count: 2,
          transcript_call_count: 2,
          activity_unnamed_count: 0,
          transcript_unnamed_count: 0,
          activity_tools: ['coord:orient', 'loop:checkpoint'],
          transcript_tools: ['coord:orient', 'loop:checkpoint'],
        },
      ];
    }) as unknown as Sql;

    const states = await readFleetRepeatedRecoveryStates([{ ownerId: 'su-a' }], {
      sql,
      workspaceId: 'ws',
      nowMs: Date.parse('2026-09-07T12:00:00Z'),
    });
    expect(states.get('su-a')).toMatchObject({ status: 'measured', consecutiveRecoveryOnlyCycles: 2 });
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sqlText).toContain("a.phase = 'post'");
    expect(sqlText).toContain("p.part_kind = 'tool_use'");
    expect(sqlText).toContain('rn <=');
  });

  it('does not query a member excluded by leader/progress suppression', async () => {
    const sql = vi.fn(async () => {
      throw new Error('suppressed members must not hit the ledger');
    }) as unknown as Sql;
    const states = await readFleetRepeatedRecoveryStates(
      [
        { ownerId: 'su-leader', isRegisteredLeader: true },
        { ownerId: 'su-progress', hasProgressingClaim: true },
      ],
      { sql, workspaceId: 'ws' },
    );
    expect(sql).not.toHaveBeenCalled();
    expect(states.get('su-leader')?.status).toBe('suppressed');
    expect(states.get('su-progress')?.status).toBe('suppressed');
  });
});
