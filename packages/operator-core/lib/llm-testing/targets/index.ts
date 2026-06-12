/**
 * Target registry — maps `Scenario.target` strings to `ChatTarget`
 * factories. Add a target by exporting it here.
 */

import type { ChatTarget } from '@papercusp/testing-shell/llm';
import { ArchitectTarget } from './architect';
import { OperatorTarget } from './operator';
import { OracleTarget } from './oracle';
import { SuTarget } from './su';
import { makeQueenTarget } from './queen';

export type TargetFactory = () => ChatTarget;

const TARGETS: Record<string, TargetFactory> = {
  operator: () => new OperatorTarget(),
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
  queen: () => makeQueenTarget(),
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
