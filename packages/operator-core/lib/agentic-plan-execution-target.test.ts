import { describe, expect, it } from 'vitest';
import { parseAgenticPlanExecutionTarget } from './agentic-plan-execution-target';

describe('parseAgenticPlanExecutionTarget', () => {
  it('normalizes the two-field execution leaf', () => {
    expect(
      parseAgenticPlanExecutionTarget({ appHarnessSlug: ' email ', agentName: ' email-agent ' }),
    ).toEqual({ appHarnessSlug: 'email', agentName: 'email-agent' });
  });

  it('treats absence as an ordinary non-agentic plan run', () => {
    expect(parseAgenticPlanExecutionTarget(undefined)).toBeNull();
    expect(parseAgenticPlanExecutionTarget(null)).toBeNull();
  });

  it.each([
    1,
    [],
    {},
    { appHarnessSlug: 'email' },
    { appHarnessSlug: '*', agentName: 'email-agent' },
    { appHarnessSlug: 'email', agentName: '   ' },
  ])('rejects a present malformed target: %j', (raw) => {
    expect(() => parseAgenticPlanExecutionTarget(raw)).toThrow(/agentic_plan_execution_target_invalid/);
  });
});
