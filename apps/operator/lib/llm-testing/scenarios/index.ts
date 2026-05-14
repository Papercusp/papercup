/**
 * Scenario registry — every scenario the framework knows about.
 *
 * Phase 1 ships S01, S02, S08. Phase 2 fills in S03–S07, S09–S12 per
 * plan §10.2.
 */

import type { Scenario } from '../types';
import { S01_STATUS_QUICK } from './operator/S01-status-quick';
import { S02_MULTISTEP_INVESTIGATION } from './operator/S02-multistep-investigation';
import { S08_SILENCE_NUDGE_READY } from './operator/S08-silence-nudge-ready';

export const SCENARIOS: ReadonlyArray<Scenario> = [
  S01_STATUS_QUICK,
  S02_MULTISTEP_INVESTIGATION,
  S08_SILENCE_NUDGE_READY,
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((sc) => sc.id === id);
  if (!s) {
    throw new Error(
      `Unknown scenario id '${id}'. Available: ${SCENARIOS.map((sc) => sc.id).join(', ')}`,
    );
  }
  return s;
}

export function getScenariosForTarget(target: string): Scenario[] {
  return SCENARIOS.filter((s) => s.target === target);
}

export function listScenarioIds(): string[] {
  return SCENARIOS.map((s) => s.id);
}
