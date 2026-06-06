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

import type { Scenario } from '@papercusp/testing-shell/llm';
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
// S13–S16: voice-production-test-coverage-2026-06-01 (P-019, voice-mode brain behaviors)
import { S13_VOICE_TERSE_COMPLEX } from './operator/S13-voice-terse-complex';
import { S14_VOICE_NO_CODE } from './operator/S14-voice-no-code';
import { S15_VOICE_ERROR_RECOVERY } from './operator/S15-voice-error-recovery';
import { S16_VOICE_DISAMBIGUATION } from './operator/S16-voice-disambiguation';
// M1–M12: operator-behavior-tests-2026-05-14 (brain-emission contracts)
import { M1_CONTINUE_PAIRED_WITH_SAY } from './operator/M1-continue-paired-with-say';
import { M2_MUTEX_CARD_VS_CONTINUE } from './operator/M2-mutex-card-vs-continue';
import { M3_OPENER_SUBSTANCE } from './operator/M3-opener-substance';
import { M4_ONE_QUESTION_PER_TURN } from './operator/M4-one-question-per-turn';
import { M5_SPAWN_WORKER_HAS_CHUNK } from './operator/M5-spawn-worker-has-chunk';
import { M6_SLEEP_NO_SAY } from './operator/M6-sleep-no-say';
import { M7_AFTER_SAYS_READY_OPTIONS } from './operator/M7-after-says-ready-options';
import { M8_FORMAT_UTTERANCE } from './operator/M8-format-utterance';
// (M9-panel-close-tool removed — the operator-card panel + panel_* verbs were
// retired with the scanner card stream, unify-agent-launches D-005.)
import { M10_IDEAS_NOT_OPERATORS } from './operator/M10-ideas-not-operators';
import { M11_NO_IMPLEMENTATION_ASKS } from './operator/M11-no-implementation-asks';
import { M12_NO_STACKED_QUESTIONS_PROSE } from './operator/M12-no-stacked-questions-prose';
import { O1_DOCS_QUESTION } from './oracle/O1-docs-question';
import { O2_REFUSE_SPECULATION } from './oracle/O2-refuse-speculation';
import { O3_HARNESS_QUESTION } from './oracle/O3-harness-question';
import { A1_CLARIFYING_QUESTIONS } from './architect/A1-clarifying-questions';
import { A2_SCOPE_PUSHBACK } from './architect/A2-scope-pushback';
import { A3_REJECT_THEN_REFINE } from './architect/A3-reject-then-refine';
import { A4_NO_HALLUCINATED_PLAN_ITEMS } from './architect/A4-no-hallucinated-plan-items';
import { A5_TRADEOFF_EXPLANATION } from './architect/A5-tradeoff-explanation';
import { A6_NO_SPEC_WITHOUT_READING } from './architect/A6-no-spec-without-reading';
import { O4_NO_TOOL_USE_FOR_SIMPLE_FACT } from './oracle/O4-no-tool-use-for-simple-fact';
import { O5_HARNESS_SCOPED_ANSWER } from './oracle/O5-harness-scoped-answer';
import { O6_GRACEFUL_NOT_FOUND } from './oracle/O6-graceful-not-found';
// MEM00–MEM10: T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009)
import { MEM00_CONTROL_UNSEEDED } from './memory/MEM00-control-unseeded';
import { MEM01_STAGING_PROBE_PORT } from './memory/MEM01-staging-probe-port';
import { MEM02_RELAY_SALT_ENV } from './memory/MEM02-relay-salt-env';
import { MEM03_MIGRATION_RANGE } from './memory/MEM03-migration-range';
import { MEM04_FLAKY_ISOLATE_FLAG } from './memory/MEM04-flaky-isolate-flag';
import { MEM05_SIGNALING_OWNER } from './memory/MEM05-signaling-owner';
import { MEM06_SHOP_CDN_CHECK } from './memory/MEM06-shop-cdn-check';
import { MEM07_COLUMN_RENAME } from './memory/MEM07-column-rename';
import { MEM08_TTS_ROTATION } from './memory/MEM08-tts-rotation';
import { MEM09_MIC_DEVICE } from './memory/MEM09-mic-device';
import { MEM10_EXPLICIT_SEARCH } from './memory/MEM10-explicit-search';
// SU-S01–S06: su-scenario-suite-2026-05-31 (engineer-collaborator playbook behavioral coverage)
import { SU_S01_HARNESS_SCOPE } from './su/S01-harness-scope';
import { SU_S02_TAURI_ONLY } from './su/S02-tauri-only';
import { SU_S03_PUSH_NOT_POLL } from './su/S03-push-not-poll';
import { SU_S04_DESIGN_FIRST } from './su/S04-design-first';
import { SU_S05_NO_INVENT_WRITE } from './su/S05-no-invent-write';
import { SU_S06_SHARED_TREE_GIT } from './su/S06-shared-tree-git';
// SU-S07/S08: token-efficient-agent-io P-013 — positional write emit + compact read gates
import { SU_S07_POSITIONAL_WRITE } from './su/S07-positional-write';
import { SU_S08_COMPACT_READ } from './su/S08-compact-read';
// SU-S09: token-efficient-coord-injection P-011 — positional [coord+N] read gate
import { SU_S09_COORD_INJECTION_READ } from './su/S09-coord-injection-read';

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
  // operator voice-mode brain behaviors (S13–S16, P-019)
  S13_VOICE_TERSE_COMPLEX,
  S14_VOICE_NO_CODE,
  S15_VOICE_ERROR_RECOVERY,
  S16_VOICE_DISAMBIGUATION,
  // operator brain-emission contracts (M1–M12)
  M1_CONTINUE_PAIRED_WITH_SAY,
  M2_MUTEX_CARD_VS_CONTINUE,
  M3_OPENER_SUBSTANCE,
  M4_ONE_QUESTION_PER_TURN,
  M5_SPAWN_WORKER_HAS_CHUNK,
  M6_SLEEP_NO_SAY,
  M7_AFTER_SAYS_READY_OPTIONS,
  M8_FORMAT_UTTERANCE,
  M10_IDEAS_NOT_OPERATORS,
  M11_NO_IMPLEMENTATION_ASKS,
  M12_NO_STACKED_QUESTIONS_PROSE,
  // oracle (O1–O6) — Phase 4 abstraction validation + P-027 expansion
  O1_DOCS_QUESTION,
  O2_REFUSE_SPECULATION,
  O3_HARNESS_QUESTION,
  O4_NO_TOOL_USE_FOR_SIMPLE_FACT,
  O5_HARNESS_SCOPED_ANSWER,
  O6_GRACEFUL_NOT_FOUND,
  // architect (A1–A6) — third target, harness-scoped + P-027 expansion
  A1_CLARIFYING_QUESTIONS,
  A2_SCOPE_PUSHBACK,
  A3_REJECT_THEN_REFINE,
  A4_NO_HALLUCINATED_PLAN_ITEMS,
  A5_TRADEOFF_EXPLANATION,
  A6_NO_SPEC_WITHOUT_READING,
  // operator T4 boot-recall tier (MEM00 control + MEM01–MEM10;
  // memory-backend-benchmark-2026-06-05 P-009)
  MEM00_CONTROL_UNSEEDED,
  MEM01_STAGING_PROBE_PORT,
  MEM02_RELAY_SALT_ENV,
  MEM03_MIGRATION_RANGE,
  MEM04_FLAKY_ISOLATE_FLAG,
  MEM05_SIGNALING_OWNER,
  MEM06_SHOP_CDN_CHECK,
  MEM07_COLUMN_RENAME,
  MEM08_TTS_ROTATION,
  MEM09_MIC_DEVICE,
  MEM10_EXPLICIT_SEARCH,
  // su engineer-collaborator playbook behavioral coverage (su-scenario-suite-2026-05-31)
  SU_S01_HARNESS_SCOPE,
  SU_S02_TAURI_ONLY,
  SU_S03_PUSH_NOT_POLL,
  SU_S04_DESIGN_FIRST,
  SU_S05_NO_INVENT_WRITE,
  SU_S06_SHARED_TREE_GIT,
  SU_S07_POSITIONAL_WRITE,
  SU_S08_COMPACT_READ,
  SU_S09_COORD_INJECTION_READ,
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
