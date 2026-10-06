/**
 * Turn each engine's native usage/plan records into the engine-neutral
 * SU-session `usage` and `plan` descriptor fields (plan
 * pui-chat-first-ux-2026-09-28 D-029 / D-031).
 *
 * Every reader is pure and tolerant: a record without the field yields
 * nothing, and a value the engine did not measure is never guessed. Sources,
 * each read from the installed engine rather than assumed:
 * - Claude (claude-agent-sdk sdk.d.ts): assistant `message.usage`
 *   (input + cache_read + cache_creation + output = context), result
 *   `total_cost_usd` (already a running session total) and
 *   `modelUsage[model].contextWindow`; plan = the TodoWrite tool's `todos`.
 * - Codex app-server 0.160.1 (`codex app-server generate-json-schema`):
 *   `thread/tokenUsage/updated` {tokenUsage:{last, total, modelContextWindow}};
 *   no cost. Plan = `turn/plan/updated` {plan:[{step, status}]}.
 * - OMP: assistant `message_end` `message.usage` {input, output, cacheRead,
 *   cacheWrite, totalTokens, cost.total}; window = get_state model.contextWindow.
 */
import type { SuPlanItem, SuPlanItemStatus, SuSessionUsage } from '@papercusp/chat-protocol';

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compact(usage: SuSessionUsage): SuSessionUsage | null {
  const out = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) as SuSessionUsage;
  return Object.keys(out).length ? out : null;
}

/** Claude: one root assistant record's `message.usage` → context + latest call. */
export function claudeAssistantUsage(record: unknown): SuSessionUsage | null {
  const r = rec(record);
  if (r?.type !== 'assistant' || r.parent_tool_use_id || r.isSidechain === true) return null;
  const usage = rec(rec(r.message)?.usage);
  if (!usage) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === undefined && output === undefined) return null;
  const context = (input ?? 0)
    + (count(usage.cache_read_input_tokens) ?? 0)
    + (count(usage.cache_creation_input_tokens) ?? 0)
    + (output ?? 0);
  return compact({ contextTokens: context, inputTokens: input, outputTokens: output });
}

/** Claude: a `result` record → running cost + the model's context window. */
export function claudeResultUsage(record: unknown, model?: string | null): SuSessionUsage | null {
  const r = rec(record);
  if (r?.type !== 'result') return null;
  const byModel = rec(r.modelUsage);
  let contextWindow: number | undefined;
  if (byModel) {
    const own = model ? rec(byModel[model]) : null;
    contextWindow = count(own?.contextWindow);
    // The SDK keys modelUsage by the served model id, which may differ from a
    // requested alias; then the largest window among the models used is the
    // root model's (sub-agents run on smaller models).
    if (contextWindow === undefined) {
      const windows = Object.values(byModel).map((v) => count(rec(v)?.contextWindow)).filter((v): v is number => v !== undefined);
      if (windows.length) contextWindow = Math.max(...windows);
    }
  }
  return compact({ contextWindow, costUsd: count(r.total_cost_usd) });
}

const CLAUDE_TODO_STATUS: Record<string, SuPlanItemStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
};

/** Claude: the TodoWrite tool's input → the plan list, or null when not a todo write. */
export function claudeTodoPlan(toolName: string, input: unknown): SuPlanItem[] | null {
  if (toolName !== 'TodoWrite') return null;
  const todos = rec(input)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((todo) => {
    const t = rec(todo);
    const text = typeof t?.content === 'string' ? t.content.trim() : '';
    const status = CLAUDE_TODO_STATUS[String(t?.status ?? '')];
    return text && status ? [{ text, status }] : [];
  });
}

/** Codex: `thread/tokenUsage/updated` params → usage (Codex reports no cost). */
export function codexTokenUsage(params: unknown): SuSessionUsage | null {
  const tokenUsage = rec(rec(params)?.tokenUsage);
  if (!tokenUsage) return null;
  const last = rec(tokenUsage.last);
  return compact({
    contextTokens: count(last?.totalTokens),
    contextWindow: count(tokenUsage.modelContextWindow),
    inputTokens: count(last?.inputTokens),
    outputTokens: count(last?.outputTokens),
  });
}

const CODEX_STEP_STATUS: Record<string, SuPlanItemStatus> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/** Codex: `turn/plan/updated` params → the plan list. */
export function codexPlan(params: unknown): SuPlanItem[] | null {
  const plan = rec(params)?.plan;
  if (!Array.isArray(plan)) return null;
  return plan.flatMap((step) => {
    const s = rec(step);
    const text = typeof s?.step === 'string' ? s.step.trim() : '';
    const status = CODEX_STEP_STATUS[String(s?.status ?? '')];
    return text && status ? [{ text, status }] : [];
  });
}

/**
 * OMP: an assistant `message_end` message's usage → context + latest call, plus
 * that message's cost so the caller can keep the running session total.
 */
export function ompMessageUsage(message: unknown): { usage: SuSessionUsage; cost?: number } | null {
  const m = rec(message);
  if (m && m.role !== undefined && m.role !== 'assistant') return null;
  const usage = rec(m?.usage);
  if (!usage) return null;
  const input = count(usage.input);
  const output = count(usage.output);
  const total = count(usage.totalTokens)
    ?? (input === undefined && output === undefined
      ? undefined
      : (input ?? 0) + (output ?? 0) + (count(usage.cacheRead) ?? 0) + (count(usage.cacheWrite) ?? 0));
  const result = compact({ contextTokens: total, inputTokens: input, outputTokens: output });
  if (!result) return null;
  return { usage: result, cost: count(rec(usage.cost)?.total) };
}
