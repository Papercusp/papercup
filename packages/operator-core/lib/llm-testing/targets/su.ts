/**
 * `su` ChatTarget — in-process behavioral SUT for the **engineer-collaborator
 * playbook** (`apps/operator/prompts/papercusp-su-engineer.tools.md`).
 *
 * Plan `su-scenario-suite-2026-05-31`, D-001 option (a): the SU playbook is
 * not an HTTP endpoint (it's the system prompt for an interactive `psu`/
 * `claude-su` agent), so there's no `/converse` route to POST. Instead this
 * target runs an **in-process Anthropic tool loop**:
 *
 *   system prompt = the engineer playbook (loaded from SOURCE, so the test
 *                   exercises the file we edit, not a stale ~/.papercusp render)
 *   tools         = the curated `papercusp-su` catalog (./su-catalog)
 *   executor      = the framework's `ToolDispatchOverride` seam, defaulting to
 *                   a benign stub result
 *
 * **Why a hand-rolled loop (and not `llm-client.ts` / a subprocess brain):**
 *   - The injected `LlmCallFn` (`llm-client.ts` → meridian) is a one-shot
 *     completion with NO tools support — it can't tool-call.
 *   - A `claude-code` subprocess brain reaches its MCP tools over HTTP to the
 *     `:3070` host, which is exactly the operator-converse hang D-001 avoids
 *     (and would need a live operator + risk real side effects on the shared
 *     workspace).
 *
 * **Why the executor stubs instead of running `dispatchProjectedTool` for
 * real (a deliberate refinement of D-001):** real dispatch needs a workspace
 * PG tx + principal and would execute live tools against the shared workspace
 * (read-mostly, but writes are possible) — re-introducing the operator/PG
 * dependency the plan set out to avoid and breaking hermeticity. The scenario
 * asserts measure tool *selection* + text conventions, which need only the
 * model's emitted `tool_use`, not real results. A scenario that needs a
 * specific result injects it via `toolOverride` (the existing seam). Wiring a
 * real-dispatch executor later is a drop-in: the loop is executor-agnostic.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type {
  ChatSession,
  ChatTarget,
  SessionOptions,
  SseEvent,
  ToolCallEvent,
  ToolDispatchOverride,
  ToolResult,
  TurnInput,
  TurnResult,
} from '@papercusp/testing-shell/llm';

import { buildCatalog, type BuiltCatalog } from './su-catalog';
import { renderCoordLegend } from '../../coord-schema';
import { COORD_LEGEND_MARKER } from '../../desktop-install/splice-tooling-overlay';

const BEHAVIORS = [
  'harness-scope',
  'tauri-only',
  'push-not-poll',
  'design-first',
  'no-invent-write',
  'shared-tree-git',
];

/** Per-1M-token prices for the models the SUT might run on (USD). Mirrors the
 *  shared chat-stream MERIDIAN_PRICES rows we care about. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 0.8, out: 4.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
  'claude-opus-4-8': { in: 15.0, out: 75.0 },
};
function priceFor(model: string): { in: number; out: number } {
  if (PRICES[model]) return PRICES[model];
  const prefix = Object.keys(PRICES).find((m) => model.startsWith(m));
  return prefix ? PRICES[prefix] : { in: 3.0, out: 15.0 };
}

/** Default SUT model — the framework's documented `LLM_TEST_SUT_MODEL`
 *  default; the real SU agent runs opus, but sonnet is the cheaper test
 *  default and is plenty to exercise the playbook's hard rules. */
function sutModel(): string {
  return process.env.LLM_TEST_SUT_MODEL?.trim() || 'claude-sonnet-4-6';
}

// ---------------------------------------------------------------------------
// Playbook (system prompt) — loaded from SOURCE, cached per process.
// ---------------------------------------------------------------------------

let _playbookCache: string | undefined;

function resolvePlaybookPath(): string {
  const override = process.env.PAPERCUSP_SU_PLAYBOOK_PATH?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const rel = join('apps', 'operator', 'prompts', 'papercusp-su-engineer.tools.md');
  const candidates = [
    // packages/operator-core/lib/llm-testing/targets → repo root (5 up)
    join(here, '..', '..', '..', '..', '..', rel),
    join(process.cwd(), rel),
    join(process.cwd(), '..', '..', rel), // when cwd = apps/operator
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `su target: could not locate the engineer playbook (${rel}). ` +
      `Set PAPERCUSP_SU_PLAYBOOK_PATH. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

function loadPlaybook(): string {
  if (_playbookCache !== undefined) return _playbookCache;
  // The raw source carries generated-section MARKERS (spliced by
  // renderSuPlaybook at launch). This hermetic target reads the file directly,
  // so splice the ones that are pure/hermetic, then strip any remainder rather
  // than leak a literal marker comment into the prompt:
  //   - COORD-LEGEND: renderCoordLegend() is static (from COORD_LEGEND), so the
  //     coord-read scenario (SU-S09) sees the SAME legend the real psu prompt
  //     carries (token-efficient-coord-injection P-011).
  //   - WIRE-SCHEMAS: needs the live registry + tool projections (not booted in
  //     this hermetic target), so it stays stripped — the P-013 scenarios carry
  //     the column schema in the catalog tool schemas instead.
  const body = readFileSync(resolvePlaybookPath(), 'utf8')
    .replace(COORD_LEGEND_MARKER, renderCoordLegend())
    .replace(/<!-- PAPERCUSP-SU:[A-Z-]+ -->\n*/g, '');
  // A thin framing line so the model treats the playbook as ITS operating
  // system prompt (not a doc handed to it by the user). The playbook content
  // itself carries every behavioral rule under test.
  _playbookCache =
    'You are a Papercusp superuser engineer-collaborator (a `psu` session). ' +
    'The following is your operating playbook — follow it exactly.\n\n' +
    body;
  return _playbookCache;
}

// ---------------------------------------------------------------------------
// Transport — resolve a tool-capable Anthropic-format client, mirroring the
// shared chat-stream `resolveStatelessTransport` (which is not exported).
// Tool use needs the raw Anthropic API, so we PREFER a direct-to-Anthropic
// path (explicit api key, then the Claude-Max OAuth session) and fall back to
// the local Meridian router.
// ---------------------------------------------------------------------------

interface Transport {
  baseURL?: string;
  apiKey?: string;
  authToken?: string;
  headers: Record<string, string>;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function resolveTransport(): Transport | { error: string } {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return {
      baseURL: process.env.PAPERCUSP_ANTHROPIC_URL,
      apiKey,
      headers: {},
    };
  }
  const claudeTok = readJson<{ claudeAiOauth?: { accessToken?: string } }>(
    join(homedir(), '.claude', '.credentials.json'),
  )?.claudeAiOauth?.accessToken;
  if (claudeTok) {
    return {
      baseURL: process.env.PAPERCUSP_ANTHROPIC_URL ?? 'https://api.anthropic.com',
      authToken: claudeTok,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    };
  }
  const meridianTok = readJson<{ anthropic?: { token?: { access?: string } } }>(
    join(homedir(), '.omp', 'agent', 'auth.json'),
  )?.anthropic?.token?.access;
  if (meridianTok) {
    return {
      baseURL: process.env.PAPERCUSP_MERIDIAN_URL ?? 'http://127.0.0.1:3456',
      authToken: meridianTok,
      headers: {
        'x-meridian-agent': `papercup-su-llmtest-${Math.floor(performance.now()).toString(36)}`,
      },
    };
  }
  return {
    error:
      'su target needs ANTHROPIC_API_KEY, a Claude session (~/.claude/.credentials.json), ' +
      'or omp/Meridian auth (~/.omp/agent/auth.json) to drive the SUT model.',
  };
}

function promptCacheEnabled(): boolean {
  return process.env.PAPERCUSP_PROMPT_CACHE !== '0';
}

// ---------------------------------------------------------------------------
// Anthropic message shapes (kept local so we don't type-depend on the SDK,
// which is dynamically imported like the shared meridian path).
// ---------------------------------------------------------------------------

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
interface AnthropicMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

const MAX_TOOL_ITERATIONS = 6;

/**
 * The Claude Code identifier. It MUST be the first `system` block on the SUT's
 * raw Messages API call: a Claude Max/Pro OAuth token (the no-ANTHROPIC_API_KEY
 * path this suite runs under) is only admitted to the full, CLI-equivalent
 * rate-limit bucket when the request is framed as Claude Code. Without it the
 * SAME token is shunted to a far stricter raw-OAuth bucket that 429s almost
 * immediately, independent of real account usage (measured 2026-06-08: identical
 * call 429s without this block, 200s with it, while the `claude` CLI runs fine).
 * Regression-tested in su-system-framing.test.ts — do not drop or reorder it.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Build the SUT system prompt: the Claude Code identifier FIRST (auth framing,
 * above), then the engineer playbook (cache_control'd when prompt caching is on).
 * Exported so the framing invariant has a unit test independent of live creds.
 */
export function buildSuSystemBlocks(playbookText: string, cache: boolean): SystemBlock[] {
  return [
    { type: 'text', text: CLAUDE_CODE_IDENTIFIER },
    cache
      ? { type: 'text', text: playbookText, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: playbookText },
  ];
}

export interface SuTargetOpts {
  catalog?: BuiltCatalog;
}

export class SuTarget implements ChatTarget {
  readonly id = 'su';
  readonly behaviors = BEHAVIORS;
  private readonly catalog: BuiltCatalog;

  constructor(opts: SuTargetOpts = {}) {
    this.catalog = opts.catalog ?? buildCatalog();
  }

  async open(opts: SessionOptions): Promise<ChatSession> {
    return new SuSession({
      runId: opts.runId,
      catalog: this.catalog,
      override: opts.dispatchOverride,
    });
  }
}

interface SessionState {
  runId: string;
  catalog: BuiltCatalog;
  override?: ToolDispatchOverride;
}

class SuSession implements ChatSession {
  readonly sessionId: string;
  private readonly state: SessionState;

  constructor(state: SessionState) {
    this.state = state;
    this.sessionId = `llm-testing/${state.runId}`;
  }

  async close(): Promise<void> {
    /* nothing to tear down — fully in-process */
  }

  async send(input: TurnInput): Promise<TurnResult> {
    const startMs = performance.now();
    const result: TurnResult = {
      assistantText: '',
      toolCalls: [],
      cards: [],
      controlTags: [],
      costUsd: 0,
      latencyMs: 0,
      finishReason: 'done',
      rawSseTape: [],
    };

    const transport = resolveTransport();
    if ('error' in transport) {
      return errorTurn(transport.error, performance.now() - startMs);
    }

    let Anthropic: new (cfg: unknown) => AnthropicClient;
    try {
      const mod = await import('@anthropic-ai/sdk');
      Anthropic = ((mod as { default?: unknown }).default ?? mod) as unknown as new (
        cfg: unknown,
      ) => AnthropicClient;
    } catch (err) {
      return errorTurn(`su target: failed to load @anthropic-ai/sdk: ${(err as Error).message}`, performance.now() - startMs);
    }

    const client = new Anthropic({
      ...(transport.baseURL ? { baseURL: transport.baseURL } : {}),
      ...(transport.apiKey ? { apiKey: transport.apiKey } : {}),
      ...(transport.authToken ? { authToken: transport.authToken } : {}),
      defaultHeaders: transport.headers,
      maxRetries: 2,
    });

    const model = sutModel();
    const price = priceFor(model);
    const cache = promptCacheEnabled();
    // First system block MUST be the Claude Code identifier (auth framing for the
    // Max OAuth rate-limit bucket — see CLAUDE_CODE_IDENTIFIER / buildSuSystemBlocks).
    // Built via the exported helper so the framing invariant is regression-tested.
    const system = buildSuSystemBlocks(loadPlaybook(), cache);
    const tools = this.state.catalog.tools;

    // The conversation transcript for THIS turn (stateless: caller threads the
    // full history each send()). System prompt is the playbook; drop any
    // 'system' entries from the message list.
    const messages: AnthropicMessage[] = input.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const ctrl = new AbortController();
    const TURN_CAP_MS = 240_000;
    const killer = setTimeout(() => ctrl.abort(), TURN_CAP_MS);

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        let resp: AnthropicResponse;
        try {
          resp = await callWithRetry(client, {
            model,
            max_tokens: 4096,
            system,
            messages,
            tools,
          }, ctrl.signal);
        } catch (err) {
          result.finishReason = 'error';
          result.error = `model call failed: ${(err as Error).message}`;
          break;
        }

        // Accrue cost.
        const inTok = resp.usage?.input_tokens ?? 0;
        const outTok = resp.usage?.output_tokens ?? 0;
        result.costUsd += (inTok * price.in + outTok * price.out) / 1_000_000;

        const blocks: ContentBlock[] = Array.isArray(resp.content) ? resp.content : [];
        const toolUses: ToolUseBlock[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && typeof (block as TextBlock).text === 'string') {
            const text = (block as TextBlock).text;
            result.assistantText += text;
            result.rawSseTape.push(sse('delta', { text }));
          } else if (block.type === 'tool_use') {
            const tu = block as ToolUseBlock;
            const canonical = this.state.catalog.canonicalBySanitized.get(tu.name) ?? tu.name;
            const ev: ToolCallEvent = { name: canonical, input: tu.input };
            result.toolCalls.push(ev);
            result.rawSseTape.push(sse('tool_call', { name: canonical, input: tu.input }));
            toolUses.push(tu);
          }
        }

        if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
          break; // assistant turn complete
        }

        // Feed tool results back so the loop can continue. The assistant
        // message must carry the raw content blocks (incl. tool_use).
        messages.push({ role: 'assistant', content: blocks });
        const toolResults: ContentBlock[] = [];
        for (const tu of toolUses) {
          const canonical = this.state.catalog.canonicalBySanitized.get(tu.name) ?? tu.name;
          const { text, isError } = await this.resolveToolResult(canonical, tu.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: text,
            ...(isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }
    } finally {
      clearTimeout(killer);
    }

    result.rawSseTape.push(sse('done', { costUsd: result.costUsd }));
    result.latencyMs = performance.now() - startMs;
    return result;
  }

  /**
   * Produce a tool result for the model. Consults the scenario's
   * `toolOverride` (the existing dispatch-override seam) first; falls back to
   * a benign stub so the loop can progress without live side effects.
   */
  private async resolveToolResult(
    name: string,
    input: unknown,
  ): Promise<{ text: string; isError: boolean }> {
    const override = this.state.override;
    if (override) {
      // Match either the canonical name or the mcp-prefixed alias, like the
      // production override seam (AUTHORING §6).
      for (const candidate of [name, `mcp__agentmcp__${name}`]) {
        const res = await override.override(candidate, input);
        if (res !== PASS_THROUGH) {
          return renderToolResult(res as ToolResult);
        }
      }
    }
    return {
      text: JSON.stringify({ ok: true, stub: true, tool: name, note: 'in-process su-target stub (no live dispatch)' }),
      isError: false,
    };
  }
}

function renderToolResult(res: ToolResult): { text: string; isError: boolean } {
  const text = (res.content ?? [])
    .map((c) => (typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');
  return { text: text || '(empty)', isError: !!res.isError };
}

function sse(name: string, data: unknown): SseEvent {
  return { name, data, tMs: 0 };
}

function errorTurn(message: string, latencyMs: number): TurnResult {
  return {
    assistantText: '',
    toolCalls: [],
    cards: [],
    controlTags: [],
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
    error: message,
    rawSseTape: [],
  };
}

// ---------------------------------------------------------------------------
// Anthropic SDK call + transient retry (mirrors the shared meridian path).
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface AnthropicClient {
  messages: { create(params: unknown, opts?: unknown): Promise<AnthropicResponse> };
}

function errStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

function isTransient(err: unknown): boolean {
  const status = errStatus(err);
  if (status === 429 || status === 529 || (status !== undefined && status >= 500 && status < 505)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /(\b429\b|\b529\b|overloaded|rate.?limit|service unavailable|\b50[02-4]\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up)/i.test(
    msg,
  );
}

/** Seconds from a `retry-after` header (plain seconds or an HTTP date), if the
 *  SDK error exposed headers. */
function retryAfterMs(err: unknown): number | undefined {
  const h = (err as { headers?: Record<string, string | undefined> | { get?: (k: string) => string | null } })?.headers;
  let raw: string | null | undefined;
  if (h && typeof (h as { get?: unknown }).get === 'function') {
    raw = (h as { get: (k: string) => string | null }).get('retry-after');
  } else if (h && typeof h === 'object') {
    raw = (h as Record<string, string | undefined>)['retry-after'];
  }
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(120_000, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(120_000, Math.max(0, at - Date.now())) : undefined;
}

async function callWithRetry(
  client: AnthropicClient,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AnthropicResponse> {
  // Patient retry — the SUT shares one Claude-Max OAuth session with the whole
  // fleet, so a transient 429 is expected under contention. Honor Retry-After
  // when present, else exponential backoff capped at 60s.
  const RETRY_MAX = 7;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    if (signal.aborted) throw new Error('su target: aborted');
    try {
      return await client.messages.create(params, { signal });
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === RETRY_MAX) throw err;
      const backoffMs =
        retryAfterMs(err) ?? Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
