import { describe, expect, it } from 'vitest';
import type { Scenario } from '@papercusp/testing-shell/llm';

import {
  lintSuScenarioContracts,
  validateSuContracts,
} from './su-contracts';
import { SU_CATALOG } from './su-catalog';
import { SU_S11_LOCK_CONTENTION_PROTOCOL } from '../scenarios/su/S11-lock-contention-protocol';
import { SU_S19_OVERVIEW_STATE_OF_X } from '../scenarios/su/S19-overview-state-of-x';
import { SU_S20_OVERVIEW_NOT_FOR_SINGLE } from '../scenarios/su/S20-overview-not-for-single';

const CURRENT_SU_CONTRACTS = [
  SU_S11_LOCK_CONTENTION_PROTOCOL,
  SU_S19_OVERVIEW_STATE_OF_X,
  SU_S20_OVERVIEW_NOT_FOR_SINGLE,
];

describe('SU hermetic scenario contract validator', () => {
  it('accepts the current S11/S19/S20 contracts and catalog', async () => {
    await expect(validateSuContracts(CURRENT_SU_CONTRACTS)).resolves.toEqual([]);
  });

  it('catches overview guidance drift that collapses the compound/single-fact boundary', async () => {
    const catalog = SU_CATALOG.map((entry) =>
      entry.name === 'harness:overview'
        ? { ...entry, description: 'Read the current harness status.' }
        : entry,
    );

    const violations = await lintSuScenarioContracts([SU_S19_OVERVIEW_STATE_OF_X], { catalog });
    expect(violations.some((violation) => violation.field === 'catalog.harness:overview.description')).toBe(true);
  });

  it('catches an S19 fixture whose advertised count exceeds its payload', async () => {
    const broken: Scenario = {
      ...SU_S19_OVERVIEW_STATE_OF_X,
      toolOverride: {
        override: () => ({
          content: [{
            text: JSON.stringify({
              ok: true,
              issues: {
                count: 2,
                recent: [{ id: 'EI-880', state: 'open' }],
              },
            }),
          }],
        }),
      },
    };

    const violations = await validateSuContracts([broken]);
    expect(violations.some((violation) => violation.field === 'fixture.issues.count')).toBe(true);
  });

  it('catches an S11 protocol action that is absent from the hermetic catalog', async () => {
    const catalog = SU_CATALOG.filter((entry) => entry.name !== 'coord:handoff');
    const violations = await validateSuContracts([SU_S11_LOCK_CONTENTION_PROTOCOL], { catalog });
    expect(violations.some((violation) => violation.field === 'catalog.coord:handoff')).toBe(true);
  });

  it('catches loss of the scripted native-denial premise', async () => {
    const broken: Scenario = {
      ...SU_S11_LOCK_CONTENTION_PROTOCOL,
      triggers: SU_S11_LOCK_CONTENTION_PROTOCOL.triggers?.map((trigger) => ({
        ...trigger,
        text: trigger.text?.replace('PreToolUse:Edit hook denied the edit.', 'a generic lock error'),
      })),
    };

    const violations = await validateSuContracts([broken]);
    expect(violations.some((violation) => violation.field === 'triggers')).toBe(true);
  });
});
