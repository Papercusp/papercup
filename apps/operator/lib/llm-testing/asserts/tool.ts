import { registerEvaluator } from './index';
import type { Violation } from '../types';

registerEvaluator('tool_called', (a, run) => {
  const matches = run.turns.flatMap((t, idx) =>
    t.toolCalls
      .filter((tc) => tc.name === a.name && argsMatch(tc.input, a.withArgsMatching))
      .map(() => idx),
  );
  const min = a.minTimes ?? 1;
  const max = a.maxTimes ?? Infinity;
  const v: Violation[] = [];
  if (matches.length < min) {
    v.push({
      assertKind: 'tool_called',
      severity: 'error',
      claim: `Expected tool '${a.name}' to be called at least ${min}× — saw ${matches.length}`,
      suggestion: `Verify the SUT prompt routes this kind of request to '${a.name}'.`,
    });
  }
  if (matches.length > max) {
    v.push({
      assertKind: 'tool_called',
      severity: 'warn',
      claim: `Tool '${a.name}' called ${matches.length}× — cap was ${max}`,
      evidenceTurnIdx: matches[max],
    });
  }
  return v;
});

registerEvaluator('tool_not_called', (a, run) => {
  const idx = run.turns.findIndex((t) => t.toolCalls.some((tc) => tc.name === a.name));
  if (idx >= 0) {
    return [{
      assertKind: 'tool_not_called',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: `Tool '${a.name}' was called but the scenario forbids it.`,
    }];
  }
  return [];
});

function argsMatch(actual: unknown, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected)) {
    if ((actual as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}
