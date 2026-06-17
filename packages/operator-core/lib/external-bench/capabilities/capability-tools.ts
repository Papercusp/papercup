/**
 * capability-tools.ts — the {@link CapabilityTool} wrappers (plan
 * benchmark-capability-injection-redesign-2026-06-17, P-001).
 *
 * Thin functions exposing our REAL systems as agent-callable tools, each bound to a
 * {@link RunSandbox} so every call carries the sandbox scope. They call the genuine MCP
 * verbs through the LOOPBACK run-tool route — the SAME pattern `su-independent-backlog.ts`
 * uses (POST `:3170/api/agent-mcp/run-tool` with `{ name, args }`, then unwrap the tool
 * payload from `result.content[0].text`). So a benchmark arm exercises the production
 * `memory:*` / `work_items:*` / `coord:*` code paths, not a re-implementation.
 *
 * The mapping (palette table + the confirmed tool schemas):
 *   - memory.remember(fact) / memory.search(query) → `memory:remember` / `memory:search`
 *     with `hive_slug = sandbox.hiveSlug` (the hive's shared pool IS the namespace).
 *   - workqueue.enqueue(subtask) / claim() / complete(id) → `work_items:create` /
 *     `work_items:claim_next` / `work_items:complete` scoped to `sandbox.memberSlug` (the
 *     member harness holds the run's work_items — its `harness` arg).
 *   - coord.consult(specialist, q) / handoff(...) / ask(q) → `coord:ask` / `coord:handoff` /
 *     `coord:ask` scoped to the sandbox hive (the `harness` arg restricts to the hive).
 *
 * Each tool carries a `name` + a JSON-schema descriptor so the set can be (a) injected
 * into a turn-generator's tool-set AND (b) allow-listed by the personas plan's
 * `roles[].tools` tool-scoping (D-010). The loopback fetch is dependency-injected
 * ({@link OpenRunSandboxDeps.runTool}) so tests never make a real MCP call.
 */
import type {
  CapabilityTool,
  JsonSchema,
  RunSandbox,
  RunTool,
  RunToolResult,
  SandboxHiveOps,
} from './types';

/**
 * Dependencies for opening a sandbox + materializing capability tools. Inject `hiveOps`
 * (the ephemeral-hive lifecycle seam) + `runTool` (the loopback run-tool) so the whole
 * substrate unit-tests with fakes: NO real hive boot, NO real MCP call, NO opus spend.
 */
export interface OpenRunSandboxDeps {
  /** The workspace the sandbox + its capability calls live in. */
  workspaceId: string;
  /** The ephemeral-hive lifecycle seam (boot/teardown). */
  hiveOps: SandboxHiveOps;
  /** The loopback run-tool seam every capability tool fires through. */
  runTool: RunTool;
  /** Per-sandbox scratch parent for the member harness clone path. Default `/tmp/xbench-capabilities`. */
  scratchParent?: string;
}

/* -------------------------------------------------------------------------- */
/* The LIVE loopback run-tool (mirrors su-independent-backlog.ts)              */
/* -------------------------------------------------------------------------- */

/**
 * The LIVE {@link RunTool} — POSTs `{ name, args }` to the operator's loopback
 * `run-tool` route and unwraps the tool payload, EXACTLY mirroring
 * `su-independent-backlog.ts`'s `placeFifoBatch` request shape + result parsing:
 *   - route via `operatorApiBase()` (PAPERCUSP_OPERATOR_BASE → :3170 staging where the
 *     bench code lives; else PAPERCUSP_HONO_PORT);
 *   - `loopbackFetch` (bounded retry over a restart) POST with the JSON body;
 *   - the route wraps the MCP return as `{ ok, result: { content: [{ text: "<json>" }] } }`
 *     (or a flat `result`) — unwrap to the tool payload.
 *
 * Lazy dynamic imports keep the module import-light so the fake-driven test never loads
 * the loopback fetch. The injected `runTool` is what tests pass instead.
 */
export function liveRunTool(): RunTool {
  return async (name, args) => {
    const { loopbackFetch, readJsonBody } = await import('../../loopback-fetch');
    const { operatorApiBase } = await import('../../operator-api-base');
    const toolUrl = `${operatorApiBase()}/api/agent-mcp/run-tool`;

    const res = await loopbackFetch(toolUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    if (!res.ok) {
      return { ok: false, payload: {}, error: `HTTP ${res.status} ${await res.text().catch(() => '')}` };
    }
    const envelope = await readJsonBody<{ ok: boolean; result?: unknown; error?: string }>(res, toolUrl);
    if (!envelope.ok) {
      return { ok: false, payload: {}, error: envelope.error ?? 'run-tool returned ok:false' };
    }
    return { ok: true, payload: unwrapRunToolPayload(envelope.result) };
  };
}

/**
 * Unwrap a run-tool `result` into the tool payload. The route wraps the MCP return as
 * `{ content: [{ text: "<json>" }] }`; parse that JSON. Tolerates a flat result object
 * (no `content` wrapper) and a non-JSON text body (returns `{ text }`).
 */
export function unwrapRunToolPayload(result: unknown): Record<string, unknown> {
  const wrapped = result as { content?: Array<{ text?: string }> } | undefined;
  const text = wrapped?.content?.[0]?.text;
  if (typeof text === 'string') {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      return { value: parsed };
    } catch {
      return { text };
    }
  }
  if (result && typeof result === 'object') return result as Record<string, unknown>;
  return {};
}

/* -------------------------------------------------------------------------- */
/* Tool-call helper                                                            */
/* -------------------------------------------------------------------------- */

/** Fire a sandbox-bound run-tool call; throw a descriptive error when the call failed. */
async function callTool(sandbox: RunSandbox, name: string, args: Record<string, unknown>): Promise<RunToolResult> {
  const res = await sandbox.runTool(name, args);
  if (!res.ok) {
    throw new Error(`capability tool ${name} failed: ${res.error ?? 'unknown run-tool error'}`);
  }
  return res;
}

/* -------------------------------------------------------------------------- */
/* memory capability — memory:remember / memory:search                         */
/* -------------------------------------------------------------------------- */

export interface MemoryRememberArgs {
  /** The fact to store (verbatim). */
  fact: string;
  /** The memory kind; defaults to `project` (run-scoped working context). */
  kind?: 'user' | 'feedback' | 'project' | 'reference';
}
export interface MemorySearchArgs {
  /** The recall query. */
  query: string;
  /** Max hits; defaults to the verb's default. */
  limit?: number;
}

/** `memory.remember(fact)` → `memory:remember` with `hive_slug = sandbox.hiveSlug`. */
export function memoryRememberTool(sandbox: RunSandbox): CapabilityTool<MemoryRememberArgs, RunToolResult> {
  return {
    name: 'memory.remember',
    capability: 'memory',
    description: 'Store a fact in the sandbox memory pool so later tasks in this run can recall it.',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember (stored verbatim).' },
        kind: { type: 'string', description: 'user | feedback | project | reference (default project).' },
      },
      required: ['fact'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'memory:remember', {
        content: args.fact,
        kind: args.kind ?? 'project',
        // The hive's shared pool IS the per-run namespace — isolated from production mem0
        // and from every other run/arm; accumulates across all tasks in THIS run (D-007).
        hive_slug: sandbox.hiveSlug,
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `memory.search(query)` → `memory:search` scoped to the sandbox hive's pool. */
export function memorySearchTool(sandbox: RunSandbox): CapabilityTool<MemorySearchArgs, RunToolResult> {
  return {
    name: 'memory.search',
    capability: 'memory',
    description: 'Recall facts stored earlier in this run from the sandbox memory pool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: { type: 'number', description: 'Max hits.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'memory:search', {
        query: args.query,
        // memory:search reads hive-scoped pools via harness_slug fan-out; pass the member
        // harness so the search is scoped to THIS sandbox's hive (the member resolves to the
        // hive pool the remember-side wrote under). workspace pins the SU fan-out.
        harness_slug: sandbox.memberSlug,
        ...(args.limit != null ? { limit: args.limit } : {}),
        workspace: sandbox.workspaceId,
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* workqueue capability — work_items:create / claim_next / complete            */
/* -------------------------------------------------------------------------- */

export interface WorkqueueEnqueueArgs {
  /** The subtask title. */
  title: string;
  /** Optional body/summary. */
  summary?: string;
}
export interface WorkqueueClaimArgs {
  /** Optional assignee override (default: the caller). */
  assignee?: string;
}
export interface WorkqueueCompleteArgs {
  /** The work-item id to complete (e.g. WI-NNN). */
  id: string;
  /** A short completion summary. */
  summary?: string;
}

/** `workqueue.enqueue(subtask)` → `work_items:create` (kind feature) scoped to the member harness. */
export function workqueueEnqueueTool(sandbox: RunSandbox): CapabilityTool<WorkqueueEnqueueArgs, RunToolResult> {
  return {
    name: 'workqueue.enqueue',
    capability: 'workqueue',
    description: 'Enqueue a subtask into the sandbox work-queue (decompose a big task into tracked sub-deliverables).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short subtask title.' },
        summary: { type: 'string', description: 'Subtask body / detail.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:create', {
        kind: 'feature',
        title: args.title,
        ...(args.summary != null ? { summary: args.summary } : {}),
        harness: sandbox.memberSlug, // the member harness holds the run's work_items.
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `workqueue.claim()` → `work_items:claim_next` scoped to the member harness. */
export function workqueueClaimTool(sandbox: RunSandbox): CapabilityTool<WorkqueueClaimArgs, RunToolResult> {
  return {
    name: 'workqueue.claim',
    capability: 'workqueue',
    description: 'Claim the next available subtask from the sandbox work-queue.',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', description: 'Who claims it (default: you).' },
      },
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:claim_next', {
        harness: sandbox.memberSlug,
        ...(args.assignee != null ? { assignee: args.assignee } : {}),
        workspace: sandbox.workspaceId,
      }),
  };
}

/** `workqueue.complete(id)` → `work_items:complete` scoped to the member harness. */
export function workqueueCompleteTool(sandbox: RunSandbox): CapabilityTool<WorkqueueCompleteArgs, RunToolResult> {
  return {
    name: 'workqueue.complete',
    capability: 'workqueue',
    description: 'Mark a sandbox work-queue subtask complete.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The work-item id (WI-NNN).' },
        summary: { type: 'string', description: 'A short completion summary.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'work_items:complete', {
        id: args.id,
        harness: sandbox.memberSlug,
        state: 'passed',
        completion: { summary: args.summary ?? `Completed ${args.id}` },
        workspace: sandbox.workspaceId,
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* coord capability — coord:ask / coord:handoff                                */
/* -------------------------------------------------------------------------- */

export interface CoordConsultArgs {
  /** The specialist / role to consult. */
  specialist: string;
  /** The question. */
  question: string;
}
export interface CoordHandoffArgs {
  /** Who to hand off to (peer ids / roles). */
  to: string[];
  /** A summary of the handoff. */
  summary: string;
  /** Optional next action. */
  nextAction?: string;
}
export interface CoordAskArgs {
  /** The question to ask the sandbox peers. */
  question: string;
}

/** `coord.consult(specialist, q)` → `coord:ask` scoped to the sandbox hive (specialist in the body). */
export function coordConsultTool(sandbox: RunSandbox): CapabilityTool<CoordConsultArgs, RunToolResult> {
  return {
    name: 'coord.consult',
    capability: 'coord',
    description: 'Consult a specialist peer inside the sandbox (a scoped coord question to a named role).',
    inputSchema: {
      type: 'object',
      properties: {
        specialist: { type: 'string', description: 'The specialist / role to consult.' },
        question: { type: 'string', description: 'What to ask them.' },
      },
      required: ['specialist', 'question'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'coord:ask', {
        question: `[consult:${args.specialist}] ${args.question}`,
        harness: sandbox.hiveSlug, // scope the question to the sandbox hive — never the live fleet.
        force_open: true,
      }),
  };
}

/** `coord.handoff(...)` → `coord:handoff` scoped to the sandbox hive. */
export function coordHandoffTool(sandbox: RunSandbox): CapabilityTool<CoordHandoffArgs, RunToolResult> {
  return {
    name: 'coord.handoff',
    capability: 'coord',
    description: 'Hand work off to a sandbox peer with a summary + next action.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', description: 'Peer ids / roles to hand off to.', items: { type: 'string' } },
        summary: { type: 'string', description: 'Handoff summary.' },
        nextAction: { type: 'string', description: 'What the recipient should do next.' },
      },
      required: ['to', 'summary'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'coord:handoff', {
        to: args.to,
        summary: args.summary,
        ...(args.nextAction != null ? { next_action: args.nextAction } : {}),
      }),
  };
}

/** `coord.ask(q)` → `coord:ask` scoped to the sandbox hive. */
export function coordAskTool(sandbox: RunSandbox): CapabilityTool<CoordAskArgs, RunToolResult> {
  return {
    name: 'coord.ask',
    capability: 'coord',
    description: 'Ask the sandbox peers a question (a scoped coord question).',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    invoke: (args) =>
      callTool(sandbox, 'coord:ask', {
        question: args.question,
        harness: sandbox.hiveSlug, // scope to the sandbox hive — never the live fleet.
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* All-tool factories, grouped by capability (the materializer consumes these) */
/* -------------------------------------------------------------------------- */

/** A factory binding one tool to a sandbox — what the profile materializer calls. */
export type CapabilityToolFactory = (sandbox: RunSandbox) => CapabilityTool;

/** Every tool factory for one capability. The profile materializer picks by capability. */
export const CAPABILITY_TOOL_FACTORIES: Record<string, CapabilityToolFactory[]> = {
  memory: [memoryRememberTool, memorySearchTool],
  workqueue: [workqueueEnqueueTool, workqueueClaimTool, workqueueCompleteTool],
  coord: [coordConsultTool, coordHandoffTool, coordAskTool],
};

/** Build every tool for one capability, bound to the sandbox. */
export function toolsForCapability(capability: string, sandbox: RunSandbox): CapabilityTool[] {
  return (CAPABILITY_TOOL_FACTORIES[capability] ?? []).map((make) => make(sandbox));
}
