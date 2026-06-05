/**
 * fleet/governor — the layered backpressure governor (papercusp binding).
 *
 * The mechanism (token bucket + bulkhead + circuit breaker + credits, all-or-nothing
 * admission) lives in @papercusp/structured-concurrency's `createGovernor`. This module
 * binds it to the PG governor store (harness_shared.fleet_governor) and keeps the
 * historical `<fn>(sql, opts)` entry points the fleet:governor / fleet:admit tools use.
 */
import type { Sql } from 'postgres';
import {
  createGovernor,
  DEFAULT_CB_COOLDOWN_SEC,
  DEFAULT_CB_THRESHOLD,
  type AdmitInput,
  type AdmitResult,
  type CircuitState,
} from '@papercusp/structured-concurrency';
import { pgGovernorStore } from './pg-stores';

export { DEFAULT_CB_THRESHOLD, DEFAULT_CB_COOLDOWN_SEC };
export type { CircuitState, AdmitInput, AdmitResult } from '@papercusp/structured-concurrency';

const gov = (sql: Sql) => createGovernor(pgGovernorStore(sql));

export async function configureBucket(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; capacity: number; refillPerSec: number; tokens?: number; now?: number },
): Promise<void> {
  await gov(sql).configureBucket(opts);
}

export async function configureCircuit(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; threshold?: number; cooldownSec?: number },
): Promise<void> {
  await gov(sql).configureCircuit(opts);
}

export async function configureCredits(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; credits: number; max?: number },
): Promise<void> {
  await gov(sql).configureCredits(opts);
}

export async function grantCredits(sql: Sql, opts: { workspaceId: string; scopeKey: string; n: number }): Promise<number> {
  return gov(sql).grantCredits(opts);
}

export async function recordCircuitSuccess(sql: Sql, opts: { workspaceId: string; scopeKey: string }): Promise<void> {
  await gov(sql).recordCircuitSuccess(opts);
}

export async function recordCircuitFailure(
  sql: Sql,
  opts: { workspaceId: string; scopeKey: string; now?: number },
): Promise<{ state: CircuitState; failures: number } | null> {
  return gov(sql).recordCircuitFailure(opts);
}

export async function admitSpawn(sql: Sql, input: AdmitInput): Promise<AdmitResult> {
  return gov(sql).admitSpawn(input);
}
