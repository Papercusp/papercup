/** Shared scope, identity and error rail for the seven public blueprint
 * operation tools (P-017, plan blueprint-backed-work-item-execution-2026-09-23
 * D-009). Every transport (MCP, /api/agent-tools HTTP, OpenAPI clients)
 * reaches the same projected dispatcher and therefore this one rail:
 *
 * - caller identity comes from the authenticated transport identity
 *   (`resolveAgentIdentity`, the same rail work_items:create attributes by),
 *   never from arguments, so a handle cannot be read or driven by another
 *   caller;
 * - the workspace comes from the session scope, and a handle minted in a
 *   different workspace or (for a harness-scoped session) harness is refused
 *   before the service is reached;
 * - caller-caused service refusals surface as `invalid_input`; any other
 *   error stays a `handler_error` because it is a defect, not a caller mistake. */
import { getOrgPg } from '@papercusp/db-org';
import { HarnessRequiredError, UnauthorizedToolError } from '@papercusp/agent-mcp';
import { InvalidInputError } from '@papercusp/tooldef';
import type { Sql } from 'postgres';
import { resolveAgentIdentity } from '../coordination/identity';
import { isAllHarnessSentinel } from '../_harness-scope';
import { isBlueprintOperationRefusal } from '../../blueprint/operation-refusal';
import type { BlueprintOperationHandle } from '../../blueprint/operation-service';

export interface OperationToolContext {
  workspaceId?: string | null;
  harnessSlug?: string | null;
  principal?: { workspaceId?: string | null } | null;
}

export interface OperationScope {
  sql: Sql;
  workspaceId: string;
  callerId: string;
  /** Concrete session harness, or null for a session not bound to one harness. */
  sessionHarness: string | null;
}

function concrete(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '*' && !isAllHarnessSentinel(trimmed) ? trimmed : null;
}

export function resolveOperationScope(ctx: OperationToolContext): OperationScope {
  const workspaceId = concrete(ctx.workspaceId) ?? concrete(ctx.principal?.workspaceId);
  if (!workspaceId) {
    throw new UnauthorizedToolError('blueprint operations require a concrete workspace scope');
  }
  let callerId: string;
  try {
    callerId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
  } catch {
    throw new UnauthorizedToolError('blueprint operations require an attributable caller identity');
  }
  return { sql: getOrgPg().sql, workspaceId, callerId, sessionHarness: concrete(ctx.harnessSlug) };
}

function refuse(code: string, message: string): never {
  throw new InvalidInputError(`${code}: ${message}`);
}

/** The harness a submission targets: explicit, else the session harness. A
 * harness-scoped session may not submit into a different harness. */
export function submissionHarness(scope: OperationScope, requested: string | undefined): string {
  const harness = concrete(requested) ?? scope.sessionHarness;
  if (!harness) throw new HarnessRequiredError('blueprint:submit needs a harness: pass `harness` or scope the session');
  if (scope.sessionHarness && harness !== scope.sessionHarness) {
    refuse('scope_mismatch', `harness ${harness} is outside this session's harness ${scope.sessionHarness}`);
  }
  return harness;
}

/** A handle is usable only inside the scope it was minted for. */
export function checkHandleScope(scope: OperationScope, handle: BlueprintOperationHandle): void {
  if (handle.workspaceId !== scope.workspaceId) {
    refuse('scope_mismatch', 'blueprint operation handle belongs to a different workspace');
  }
  if (scope.sessionHarness && handle.harnessSlug !== scope.sessionHarness) {
    refuse('scope_mismatch', `blueprint operation handle belongs to harness ${handle.harnessSlug}`);
  }
}

/** Run a service call, mapping typed caller refusals to `invalid_input`. */
export async function runOperation<T>(call: () => Promise<T>): Promise<{ data: T }> {
  try {
    return { data: await call() };
  } catch (error) {
    if (isBlueprintOperationRefusal(error)) refuse(error.code, error.message);
    throw error;
  }
}

export const OPERATION_TOOL_SEE_ALSO = [
  'blueprint:submit (start an operation; returns the handle)',
  'blueprint:status (current phase/outcome)',
  'blueprint:result (settled outcome and validated output)',
  'blueprint:events (cursor-paged event history)',
] as const;
