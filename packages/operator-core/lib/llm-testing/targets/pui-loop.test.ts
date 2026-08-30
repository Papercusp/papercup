import { describe, expect, it } from 'vitest';

import { getTarget, listTargets } from './index';
import { getScenariosForTarget } from '../scenarios';
import {
  PUI_LOOP_TARGET_CATALOG,
  PuiLoopTarget,
} from './pui-loop';

describe('pui-loop LLM target', () => {
  it('is registered with the prompt-profile behavior contract', () => {
    expect(listTargets()).toContain('pui-loop');
    const target = getTarget('pui-loop');
    expect(target).toBeInstanceOf(PuiLoopTarget);
    expect(target.id).toBe('pui-loop');
    expect(target.behaviors).toEqual(
      expect.arrayContaining([
        'canonical-su-spine',
        'project-guide-budget',
        'mode-contracts',
        'orientation-fold',
        'tool-guidance-catalog',
        'client-remediation-omitted',
      ]),
    );
  });

  it('offers a bounded owned-loop door/task catalog with no psu-only discovery tools', () => {
    const names = PUI_LOOP_TARGET_CATALOG.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([
      'capability:read',
      'capability:edit',
      'capability:write',
      'capability:bash',
      'tasks:ops',
      'tasks:todo_write',
      'tasks:update_plan',
    ]));
    expect(names).not.toContain('tools:find');
    expect(names).not.toContain('session:request-compaction');
  });

  it('has a runnable scenario registered through the standard llm-test registry', () => {
    expect(getScenariosForTarget('pui-loop').map((scenario) => scenario.id)).toContain(
      'pui-loop-P01-owned-door-read',
    );
  });
});
