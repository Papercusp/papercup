/**
 * Agent Action Registry — type definitions.
 *
 * See /docs/agents/action-registry §2.1 for the full design rationale.
 *
 * The registry is the single typed source of truth for "what each agent
 * surface can do" — used by the keyboard-shortcut bus, ⌘K command palette,
 * Oracle's MCP server, Pi's MCP server, the OpenAI Realtime fallback shim,
 * and the ElevenLabs Conv AI primary shim.
 */

import type { ZodSchema } from 'zod';

export type AgentId = 'oracle' | 'operator' | 'pi' | 'palette' | 'shortcut';

/** How a command relates to a live browser session. */
export type BrowserRequirement =
  | 'required'   // panel.toggle — useless without a browser tab to mutate
  | 'optional'   // chat.dispatch — server writes the row, browser updates if present
  | 'none';      // harness.start — pure server-side, no browser involvement

/** Concurrency policy when multiple callers fire the same command id. */
export type Concurrency =
  | 'allow'      // panel.toggle — safe in parallel (idempotent)
  | 'queue'      // harness.start — serialize; second call waits for first
  | 'deny';      // harness.delete — second concurrent call returns conflict

/** Tier classification used by voice prompt builder + UI grouping. */
export type Tier =
  | 'reflexive'   // commands: panel.*, navigate, voice.set-mode
  | 'fast-query'  // queries: harness.status, chat.list
  | 'delegation'; // delegate_to_claude only

/** Audit policy for queries. Commands always audit. */
export type QueryAuditPolicy = 'none' | 'sample' | 'full';

export interface CommandContext {
  agent: AgentId;
  workspace: string;        // every handler gets this; never an arg (§3.2)
  sessionId?: string;       // browser session for browser='required' commands
  requestId: string;        // for audit correlation
}

export interface CommandDef<Args = unknown, Result = unknown> {
  id: string;                          // 'panel.toggle'
  kind: 'command';
  description: string;                 // ≤200 chars, shown to LLMs + ⌘K
  promptDescription?: string;          // longer agent-facing description
  schema: ZodSchema<Args>;             // arg validation (see §2.4)
  agents: AgentId[];                   // who's allowed to invoke
  browser: BrowserRequirement;
  concurrent?: Concurrency;            // default 'allow'
  tier: 'reflexive' | 'delegation';
  paletteEntry?: { section: string; title: string; icon?: string; keywords?: string };
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export interface QueryDef<Args = unknown, Result = unknown> {
  id: string;
  kind: 'query';
  description: string;
  promptDescription?: string;
  schema: ZodSchema<Args>;
  agents: AgentId[];
  audit?: QueryAuditPolicy;            // default 'sample'
  tier: 'fast-query';
  handler: (args: Args, ctx: CommandContext) => Promise<Result> | Result;
}

export type Definition = CommandDef | QueryDef;

/** Result shape returned to all callers. Errors are values, never thrown. */
export type CommandResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: CommandErrorPayload };

export interface CommandErrorPayload {
  code: string;                        // 'no-active-session', 'denied', 'conflict', 'invalid-args', 'internal', 'unknown'
  message: string;                     // human-readable, safe to show
  hint?: string;                       // actionable, agent-facing
  retryable: boolean;
}

/**
 * Handlers throw this; registry wraps anything else as code:'internal'.
 * Use this when you want a structured error to flow to the LLM consumer
 * instead of a generic "tool error".
 */
export class CommandError extends Error {
  constructor(public readonly payload: CommandErrorPayload) {
    super(payload.message);
    this.name = 'CommandError';
  }
}
