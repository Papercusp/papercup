/**
 * Target registry — maps `Scenario.target` strings to `ChatTarget`
 * factories. Add a target by exporting it here.
 */

import type { ChatTarget } from '@papercusp/testing-shell/llm';
import { ArchitectTarget } from './architect';
import { OperatorTarget } from './operator';
import { OracleTarget } from './oracle';
import { SuTarget } from './su';
import { makeQueenTarget } from './mug';
import { makeBeeTarget } from './cup';
import { makeOverwatchTarget } from './overwatch';
import { onboardingTutorTarget } from './onboarding-tutor';

export type TargetFactory = () => ChatTarget;

const TARGETS: Record<string, TargetFactory> = {
  operator: () => new OperatorTarget(),
  // sentinel — the SAME converse brain loaded with role='sentinel' (the
  // Sentinel-as-Herald persona). The agent-mcp/operator-converse route honors
  // the explicit body.role, so this exercises Sentinel-only behavior the
  // operator role can't reach — notably the `<handoff_to_queen>` routing
  // (sentinel-as-claude-tui-2026-06-22; converse.ts only honors handoffs for
  // role==='sentinel'). Same HTTP transport as `operator`.
  papercup: () => new OperatorTarget({ role: 'papercup' }),
  oracle: () => new OracleTarget(),
  // Architect is harness-scoped; the chat route returns a 400 without
  // a harnessSlug in the body. Default to 'sheets' (the long-standing
  // dev harness present in harness_shared.projects). Scenarios can
  // override per-turn via input.meta.harnessSlug.
  architect: () => new ArchitectTarget({ defaultHarnessSlug: 'sheets' }),
  // su — in-process behavioral SUT for the engineer-collaborator playbook
  // (su-scenario-suite-2026-05-31). Unlike the HTTP-chat targets above it
  // runs a hand-rolled Anthropic tool loop in-process (playbook-as-system-
  // prompt + the papercusp-su catalog); see ./su.
  su: () => new SuTarget(),
  // queen — the hive Queen's blueprint prompt on the same in-process loop
  // (scout-idea-grading B-06/B-08: does she GRADE routed drafts while triaging?).
  mug: () => makeQueenTarget(),
  // bee — the hive bee's base prompt on the same in-process loop
  // (hybrid-bee-scheduler P-003: does the bee PULL its next item via scheduler:get_next
  // rather than self-scanning work_items:list and picking itself?).
  cup: () => makeBeeTarget(),
  // overwatch — the system-health supervisor's blueprint persona on the same loop
  // (overwatch-role-2026-06-15 B-11: does it NUDGE-not-replace + OBSERVE-not-idea?).
  kettle: () => makeOverwatchTarget(),
  // onboarding-tutor — the first-run/tutorial launch context on the same
  // in-process loop (agent-first-onboarding-2026-07-03 P-008: section
  // protocol, progress checkpointing, question-detour return).
  'onboarding-tutor': () => onboardingTutorTarget(),
};

export function registerTarget(id: string, factory: TargetFactory): void {
  TARGETS[id] = factory;
}

export function getTarget(id: string): ChatTarget {
  const factory = TARGETS[id];
  if (!factory) throw new Error(`Unknown target '${id}'. Registered: ${Object.keys(TARGETS).join(', ')}`);
  return factory();
}

export function listTargets(): string[] {
  return Object.keys(TARGETS);
}

export { OperatorTarget, OracleTarget, ArchitectTarget, SuTarget };
