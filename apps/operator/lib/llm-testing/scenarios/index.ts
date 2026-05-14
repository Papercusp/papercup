/**
 * Scenario registry — every scenario the framework knows about.
 *
 * Phase 1 ships S01, S02, S08. Phase 2 fills in S03–S12 per
 * plan §10.2. Some scenarios have caveats:
 *   - S04 (cap-time): ledger-assert only; brain time naturally
 *                     enforces the cap.
 *   - S07 (passive):  requires realWorkspace + the pref flipped.
 *   - S11 (voice):    text path with modality='voice'; a real voice
 *                     transport test is a future VoiceTarget.
 *   - S12 (errors):   natural error path (lookup of non-existent
 *                     entity). The deterministic-injection version
 *                     waits on brain-subprocess override plumbing.
 */

import type { Scenario } from '../types';
import { S01_STATUS_QUICK } from './operator/S01-status-quick';
import { S02_MULTISTEP_INVESTIGATION } from './operator/S02-multistep-investigation';
import { S03_CONTINUE_CAP_COUNT } from './operator/S03-continue-cap-count';
import { S04_CONTINUE_CAP_TIME } from './operator/S04-continue-cap-time';
import { S05_SLEEP_TAG } from './operator/S05-sleep-tag';
import { S06_SPAWN_WORKER } from './operator/S06-spawn-worker';
import { S07_PASSIVE_MODE } from './operator/S07-passive-mode';
import { S08_SILENCE_NUDGE_READY } from './operator/S08-silence-nudge-ready';
import { S09_GENERATE_IDEAS } from './operator/S09-generate-ideas';
import { S10_ASK_CHOICE } from './operator/S10-ask-choice';
import { S11_VOICE_CARD_ANSWER } from './operator/S11-voice-card-answer';
import { S12_TOOL_ERROR_RECOVERY } from './operator/S12-tool-error-recovery';
import { S12B_TOOL_ERROR_INJECTED } from './operator/S12b-tool-error-injected';
import { O1_DOCS_QUESTION } from './oracle/O1-docs-question';
import { O2_REFUSE_SPECULATION } from './oracle/O2-refuse-speculation';
import { O3_HARNESS_QUESTION } from './oracle/O3-harness-question';
import { A1_CLARIFYING_QUESTIONS } from './architect/A1-clarifying-questions';
import { A2_SCOPE_PUSHBACK } from './architect/A2-scope-pushback';

export const SCENARIOS: ReadonlyArray<Scenario> = [
  // operator (S01–S12)
  S01_STATUS_QUICK,
  S02_MULTISTEP_INVESTIGATION,
  S03_CONTINUE_CAP_COUNT,
  S04_CONTINUE_CAP_TIME,
  S05_SLEEP_TAG,
  S06_SPAWN_WORKER,
  S07_PASSIVE_MODE,
  S08_SILENCE_NUDGE_READY,
  S09_GENERATE_IDEAS,
  S10_ASK_CHOICE,
  S11_VOICE_CARD_ANSWER,
  S12_TOOL_ERROR_RECOVERY,
  S12B_TOOL_ERROR_INJECTED,
  // oracle (O1–O3) — Phase 4 abstraction validation
  O1_DOCS_QUESTION,
  O2_REFUSE_SPECULATION,
  O3_HARNESS_QUESTION,
  // architect (A1–A2) — third target, harness-scoped
  A1_CLARIFYING_QUESTIONS,
  A2_SCOPE_PUSHBACK,
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
