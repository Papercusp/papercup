/**
 * Core types for the Agent MCP server.
 */

import type { Sql } from 'postgres';
import type { z, ZodTypeAny } from 'zod';

/** A Papercusp capability tier per spec/capabilities §10.6.1. */
export type CapabilityTier = 'low' | 'medium' | 'high';

/** Principal kinds resolved from a bearer token. */
export type PrincipalKind = 'harness' | 'system' | 'pi';

/** Resolved caller identity. */
export interface Principal {
  kind: PrincipalKind;
  /** e.g. `"system:operator"`, `"pi:abc123"`, `"harness-foo"`. */
  slug: string;
  workspaceId: string;
  /** Granted capability strings (e.g. `tasks:read`). */
  capabilities: ReadonlySet<string>;
}

/** Per-call request context. */
export interface ToolContext {
  principal: Principal;
  /**
   * Transaction-bound Sql client with `app.workspace_id` GUC set.
   * Tools must use this; never reach for the bare-pool db.
   */
  tx: Sql;
  /** Logger bound to the tool name + principal. */
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

/** Standard envelope for any tool response. */
export interface ToolResponse<T = unknown> {
  data: T;
  /** True when one or more sources were unavailable; partial result still useful. */
  degraded?: boolean;
  degradedReasons?: string[];
  /** Pagination cursor (for list tools that support it). */
  nextCursor?: string;
}

/** Tool definition produced by `defineTool`. */
export interface ToolDefinition<TArgs extends ZodTypeAny = ZodTypeAny> {
  /** Tool name, e.g. `"tasks:list"`. Defaults to file-path-derived. */
  name: string;
  /** TSDoc-derived description for MCP `tools/list`. */
  description: string;
  /** Capability gate (e.g. `"tasks:read"`). One per tool. */
  capability: string;
  /** Tier looked up from the capability per §10.6.1's table. */
  tier: CapabilityTier;
  /** Argument schema. Doubles as runtime validation and JSON-schema source. */
  args: TArgs;
  /** Implementation. Tools may return any data shape inside ToolResponse. */
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
}

/** Input shape for `defineTool` — same as ToolDefinition minus derived fields. */
export interface ToolDefinitionInput<TArgs extends ZodTypeAny = ZodTypeAny> {
  /** Optional explicit name; defaults to file-path-derived. */
  name?: string;
  /** Optional explicit description; defaults to caller's TSDoc. */
  description?: string;
  capability: string;
  args: TArgs;
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<ToolResponse>;
}
