import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD,
  recordZeroToolFireObservation,
  zeroToolEscalationThreshold,
} from './loop-zero-tool-escalation';

interface RoutineState {
  id: string;
  active: boolean;
  metadata: Record<string, unknown>;
  updates: number;
}

/** Minimal stateful postgres-js seam for the helper's one UPDATE + idempotency SELECT. */
function fakeSql(state: RoutineState): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ? ');
    if (/^\s*UPDATE/i.test(query)) {
      const [toolCallsRaw, thresholdRaw, fireTokenRaw, routineIdRaw] = values;
      const toolCalls = Number(toolCallsRaw);
      const threshold = Number(thresholdRaw);
      const fireToken = String(fireTokenRaw);
      if (
        String(routineIdRaw) !== state.id ||
        !state.active ||
        state.metadata.loop_zero_tool_last_fire_token === fireToken
      ) {
        return Promise.resolve([]);
      }
      const prior = Number(state.metadata.loop_zero_tool_streak ?? 0);
      const streak = toolCalls === 0 ? prior + 1 : 0;
      Object.assign(state.metadata, {
        loop_zero_tool_streak: streak,
        loop_zero_tool_last_fire_token: fireToken,
        loop_zero_tool_last_tool_call_count: toolCalls,
        loop_zero_tool_threshold: threshold,
      });
      state.updates += 1;
      return Promise.resolve([{ streak, tool_calls: toolCalls, fire_token: fireToken }]);
    }
    const [routineIdRaw, fireTokenRaw] = values;
    if (
      String(routineIdRaw) !== state.id ||
      !state.active ||
      state.metadata.loop_zero_tool_last_fire_token !== String(fireTokenRaw)
    ) {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      {
        streak: Number(state.metadata.loop_zero_tool_streak),
        tool_calls: Number(state.metadata.loop_zero_tool_last_tool_call_count),
        fire_token: String(state.metadata.loop_zero_tool_last_fire_token),
      },
    ]);
  }) as unknown as Sql;
}

describe('recordZeroToolFireObservation', () => {
  it('counts the same fire once even when the reconcile scans it repeatedly', async () => {
    const state: RoutineState = { id: 'rt-loop', active: true, metadata: {}, updates: 0 };
    const sql = fakeSql(state);

    const first = await recordZeroToolFireObservation(sql, {
      routineId: state.id,
      fireToken: 'fire-1',
      toolCalls: 0,
      threshold: 3,
    });
    const repeated = await recordZeroToolFireObservation(sql, {
      routineId: state.id,
      fireToken: 'fire-1',
      toolCalls: 0,
      threshold: 3,
    });

    expect(first).toMatchObject({ counted: true, streak: 1, atThreshold: false });
    expect(repeated).toMatchObject({ counted: false, streak: 1, atThreshold: false });
    expect(state.updates).toBe(1);
  });

  it('resets the consecutive streak when the dispatched turn authored a tool call', async () => {
    const state: RoutineState = {
      id: 'rt-loop',
      active: true,
      metadata: { loop_zero_tool_streak: 2, loop_zero_tool_last_fire_token: 'fire-2' },
      updates: 0,
    };

    const result = await recordZeroToolFireObservation(fakeSql(state), {
      routineId: state.id,
      fireToken: 'fire-3',
      toolCalls: 4,
      threshold: 3,
    });

    expect(result).toMatchObject({ counted: true, streak: 0, toolCalls: 4, atThreshold: false });
    expect(state.metadata.loop_zero_tool_streak).toBe(0);
  });

  it('marks the bounded Nth zero-tool fire as an escalation threshold', async () => {
    const state: RoutineState = {
      id: 'rt-loop',
      active: true,
      metadata: { loop_zero_tool_streak: 2, loop_zero_tool_last_fire_token: 'fire-2' },
      updates: 0,
    };

    const result = await recordZeroToolFireObservation(fakeSql(state), {
      routineId: state.id,
      fireToken: 'fire-3',
      toolCalls: 0,
      threshold: 3,
    });

    expect(result).toMatchObject({ counted: true, streak: 3, atThreshold: true });
  });
});

describe('zeroToolEscalationThreshold', () => {
  it('defaults invalid values and caps an accidentally unbounded override', () => {
    expect(zeroToolEscalationThreshold(undefined)).toBe(DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD);
    expect(zeroToolEscalationThreshold('0')).toBe(DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD);
    expect(zeroToolEscalationThreshold('not-a-number')).toBe(DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD);
    expect(zeroToolEscalationThreshold('7.9')).toBe(7);
    expect(zeroToolEscalationThreshold('100000')).toBe(100);
  });
});
