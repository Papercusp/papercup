/**
 * Target registry — maps `Scenario.target` strings to `ChatTarget`
 * factories. Add a target by exporting it here.
 */

import type { ChatTarget } from '../types';
import { ArchitectTarget } from './architect';
import { OperatorTarget } from './operator';
import { OracleTarget } from './oracle';

export type TargetFactory = () => ChatTarget;

const TARGETS: Record<string, TargetFactory> = {
  operator: () => new OperatorTarget(),
  oracle: () => new OracleTarget(),
  architect: () => new ArchitectTarget(),
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

export { OperatorTarget, OracleTarget, ArchitectTarget };
