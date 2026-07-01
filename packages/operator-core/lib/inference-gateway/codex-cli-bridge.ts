/**
 * Codex-CLI bridge — serve gateway `/v1/responses` requests by DRIVING THE
 * `codex` CLI on a ChatGPT-SUBSCRIPTION credential, instead of forwarding
 * HTTP to api.openai.com with an OpenAI API bearer.
 *
 * WHY (2026-07-01, owner: "the inference gateway should support all models"):
 * the gateway's codex provider could only consume OpenAI *API* bearers
 * (`sk-…`), while the fleet's actual OpenAI capacity is aviynw's ChatGPT
 * subscription (`~/.codex/auth.json`, `auth_mode:"chatgpt"`) — an OAuth login
 * to a DIFFERENT OpenAI backend that only the codex CLI speaks. Subprocess
 * agents (queen/bee/overwatch) already use it via `codex exec`; in-process
 * gateway callers (scout's `llmCallViaCodexGateway` → POST /v1/responses)
 * could not. This bridge closes that gap: a codex account registered with
 * `credentialRef: "codex-cli:<CODEX_HOME>"` is served by spawning
 * `codex exec --json` and translating its JSONL events into a
 * `/v1/responses`-shaped reply.
 *
 * Wire contract (verified live on codex 0.142.2, 2026-07-01):
 *   {"type":"item.completed","item":{"type":"agent_message","text":…}}   ← reply text
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}} ← usage
 * (Same event shapes the orchestrator's codex-json stream parser consumes —
 * libs/papercusp/packages/orchestrator/src/invoke.ts `format === 'codex-json'`.)
 *
 * Tradeoff: one subprocess per completion (~1-5s overhead) — right for
 * low-volume in-process callers (scout ideation, judges); high-volume agents
 * keep shelling out to codex directly. Non-streaming only: the bridge rejects
 * `stream:true` (scout sends `stream:false`).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import * as os from 'node:os';

/** credentialRef scheme marking a ChatGPT-subscription codex account:
 *  `codex-cli:<CODEX_HOME>` (e.g. `codex-cli:~/.codex`). The path is the
 *  CODEX_HOME the CLI reads its `auth.json` from. */
export const CODEX_CLI_REF_PREFIX = 'codex-cli:';

export interface CodexCliAccount {
  accountId: string;
  /** CODEX_HOME dir holding the subscription auth.json. */
  home: string;
}

/** `codex-cli:<home>` → expanded home path, or null when `ref` is not a
 *  codex-cli credential (bearer refs fall through to the HTTP path). */
export function parseCodexCliRef(ref: string): string | null {
  if (!ref.startsWith(CODEX_CLI_REF_PREFIX)) return null;
  const raw = ref.slice(CODEX_CLI_REF_PREFIX.length).trim();
  if (!raw) return null;
  if (raw === '~') return os.homedir();
  return raw.startsWith('~/') ? `${os.homedir()}${raw.slice(1)}` : raw;
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * Normalize a request-body model spec to the bare id + reasoning effort the
 * codex CLI takes. Accepts `[provider/]<id>[:effort]` plus Papercusp's
 * user-facing `chatgpt:<n>` alias (mirrors the orchestrator's
 * `normalizeModelForBackend`); Papercusp's `max` tier maps to codex `xhigh`.
 * No/unknown effort suffix → `medium` (codex's own default).
 */
export function parseBridgeModel(model: string | undefined): { id: string; effort: string } {
  let m = (model ?? '').trim() || 'gpt-5.5';
  const slash = m.indexOf('/');
  if (slash > 0) m = m.slice(slash + 1);
  const chatgpt = /^chatgpt:(.+)$/i.exec(m);
  if (chatgpt) m = `gpt-${chatgpt[1]}`;
  let effort = 'medium';
  const colon = m.lastIndexOf(':');
  if (colon > 0) {
    const suffix = m.slice(colon + 1).trim().toLowerCase();
    const mapped = suffix === 'max' ? 'xhigh' : suffix;
    if (CODEX_EFFORTS.has(mapped)) {
      effort = mapped;
      m = m.slice(0, colon);
    }
  }
  return { id: m, effort };
}

export interface CodexCliRunOpts {
  /** CODEX_HOME holding the subscription auth.json. */
  home: string;
  /** Bare model id (`gpt-5.4`). */
  model: string;
  /** codex reasoning effort (`minimal|low|medium|high|xhigh`). */
  effort: string;
  /** The full prompt text (instructions already prepended by the caller). */
  prompt: string;
  /** Hard wall-clock cap; the whole process GROUP is killed past it. */
  timeoutMs: number;
  /** Abort (downstream hung up) — kills the process group. */
  signal?: AbortSignal;
  /** Test seam. */
  spawnFn?: typeof nodeSpawn;
  /** Test seam / PATH override. */
  codexBin?: string;
}

export interface CodexCliRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Parse `codex exec --json` JSONL stdout into reply text + usage. Exported for tests. */
export function parseCodexCliEvents(stdout: string): CodexCliRunResult {
  const parts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // non-JSON banner/noise line
    }
    if (!obj || typeof obj !== 'object') continue;
    const ev = obj as {
      type?: string;
      item?: { type?: string; text?: unknown };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      parts.push(ev.item.text);
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      if (typeof ev.usage.input_tokens === 'number') inputTokens = ev.usage.input_tokens;
      if (typeof ev.usage.output_tokens === 'number') outputTokens = ev.usage.output_tokens;
    }
  }
  return { text: parts.join('').trim(), inputTokens, outputTokens };
}

/**
 * One completion through the codex CLI on the subscription credential.
 * Flags mirror the PROVEN subprocess-agent invocation (harness-invoke-once /
 * the 2026-07-01 live verification) with two bridge-specific hardenings:
 * `-s read-only` (an LLM call needs no writes — the agent paths use the srt
 * wrap instead) and the prompt on STDIN via `-` (argv length safety for long
 * scout ideation prompts). Rejects with stderr context on any failure; the
 * caller maps that to a 502.
 */
export function runCodexCliCompletion(opts: CodexCliRunOpts): Promise<CodexCliRunResult> {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const bin = opts.codexBin ?? 'codex';
  const argv = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '-m',
    opts.model,
    '-c',
    `model_reasoning_effort="${opts.effort}"`,
    '-', // prompt from stdin
  ];
  return new Promise<CodexCliRunResult>((resolve, reject) => {
    const child = spawnFn(bin, argv, {
      cwd: os.tmpdir(),
      env: { ...process.env, CODEX_HOME: opts.home },
      // Group leader so the timeout/abort kill covers codex's vendor-binary child too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const killer = setTimeout(() => {
      killGroup();
      settle(() => reject(new Error(`codex-cli bridge: timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
    (killer as { unref?: () => void }).unref?.();
    const onAbort = () => {
      killGroup();
      settle(() => reject(new Error('codex-cli bridge: request aborted')));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => settle(() => reject(new Error(`codex-cli bridge: spawn failed: ${e.message}`))));
    child.on('close', (code) =>
      settle(() => {
        if (code !== 0) {
          reject(new Error(`codex-cli bridge: codex exited ${code}: ${stderr.trim().slice(-400)}`));
          return;
        }
        const r = parseCodexCliEvents(stdout);
        if (!r.text) {
          reject(new Error(`codex-cli bridge: no agent_message in codex output (stderr: ${stderr.trim().slice(-200)})`));
          return;
        }
        resolve(r);
      }),
    );
    try {
      child.stdin?.end(opts.prompt);
    } catch {
      /* close/error path handles it */
    }
  });
}

/** Synthesize the `/v1/responses`-shaped reply body clients expect (the shapes
 *  `extractResponsesText` in llm-client.ts walks: top-level `output_text` +
 *  `output[].content[].{type:'output_text',text}` + `usage`). */
export function codexCliResponsesBody(args: {
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  return {
    id: `resp_codexcli_${Date.now().toString(36)}`,
    object: 'response',
    status: 'completed',
    model: args.model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: args.text }],
      },
    ],
    output_text: args.text,
    usage: { input_tokens: args.inputTokens, output_tokens: args.outputTokens },
    /** Diagnostic marker: this reply came off the subscription CLI, not the API. */
    gateway_codex_cli: true,
  };
}

/** Flatten a Responses-API `input` (string or structured item array) to prompt text. */
export function extractResponsesInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const it = item as { content?: unknown; text?: unknown };
    if (typeof it.text === 'string') {
      parts.push(it.text);
      continue;
    }
    if (Array.isArray(it.content)) {
      for (const c of it.content) {
        const cc = c as { type?: string; text?: unknown };
        if ((cc.type === 'input_text' || cc.type === 'text') && typeof cc.text === 'string') parts.push(cc.text);
      }
    }
  }
  return parts.join('\n');
}
