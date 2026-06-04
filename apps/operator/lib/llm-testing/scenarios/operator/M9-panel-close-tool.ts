/**
 * M9 — panel-close-tool
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: panel verbs map 1:1 to panel tools.
 * From operator.tools.md: "When the user says panel-related action
 * verbs right after a panel-related turn, the antecedent is the panel
 * and you MUST call the matching tool."
 *
 * toolOverride: stub panel_close so the brain isn't blocked by the
 * tool actually executing against a (test-fixture) panel.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

const STUB_PANEL_TOOLS: ToolDispatchOverride = {
  override: (name) => {
    if (name === 'panel_close' || name === 'panel_open' || name === 'panel_state') {
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, stubbed: true }) }],
      });
    }
    return Promise.resolve('pass-through' as const);
  },
};

export const M9_PANEL_CLOSE_TOOL: Scenario = {
  id: 'op-M9-panel-close-tool',
  version: 1,
  target: 'operator',
  description:
    'After the operator surfaces a panel item in turn 0, the user says "close it" in turn 1. The operator must emit a panel_close tool call (NOT acknowledge in words and skip the tool — the tool call IS the action).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  toolOverride: STUB_PANEL_TOOLS,
  asserts: [
    { kind: 'tool_called', name: 'panel_close', minTimes: 1 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M9_PANEL_CLOSE_TOOL;
