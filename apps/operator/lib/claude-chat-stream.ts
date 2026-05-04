/**
 * Shared backend for chat-bubble surfaces: spawns `claude -p` with
 * stream-json output, parses content_block events into a small typed
 * event stream that callers re-emit over SSE.
 *
 * Used by:
 *   - /oracle/chat               (Oracle tab, with MCP config + 6 oracle tools)
 *   - /:slug/agent-chats/:id/messages   (per-harness agent chat tabs)
 *
 * Both surfaces previously had near-identical line-parsing + tool-pairing
 * code. This module owns it once.
 *
 * Caller responsibilities (intentionally NOT in here):
 *   - Prompt assembly (each surface loads its own prompt + memory)
 *   - Transcript persistence (agent-chats writes to per-harness DB;
 *     Oracle currently doesn't persist server-side)
 *   - Additional out-of-band events (tutorial_end, ui_command) — emit
 *     these from the route directly before/after iterating runClaudeChat
 *
 * Cancellation: pass a signal; spawn is killed on abort.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface RunClaudeChatOptions {
  /** The full assembled prompt sent to claude on stdin. */
  promptText: string;
  /** cwd for the spawned process. Required so claude's session-scoped
      path restriction can read files referenced in the prompt. */
  cwd?: string;
  /** Inline MCP server config — JSON-stringified and passed via
      `--mcp-config`. Pass `undefined` to spawn without MCP. */
  mcpConfig?: object;
  /** Names to whitelist via `--allowed-tools "a b c"`. Required when
      mcpConfig is set, otherwise claude refuses tool calls in -p mode. */
  allowedTools?: string[];
  /** When set, only tool_use blocks whose name passes this filter are
      surfaced as `tool_call` events. Returning a string lets the caller
      strip a prefix (e.g. `mcp__oracle__navigate` → `navigate`).
      Returning null/undefined skips that tool. Default: emit all tools. */
  toolEventFilter?: (rawName: string) => string | null | undefined;
  /** Permission mode flag. Default: not set (claude prompts). Most
      backends pass 'bypassPermissions' for unattended in-app tools. */
  permissionMode?: 'bypassPermissions' | 'default' | 'ask';
  /** Override the claude binary. Defaults to env CLAUDE_CMD or 'claude'. */
  claudeCmd?: string;
  /** Aborts the spawn. */
  signal?: AbortSignal;
  /**
   * Resume a specific claude session by id. When set, claude continues the
   * existing conversation; when null/undefined, claude starts a fresh one.
   * Voice's delegate_to_claude uses this to route each delegation to either
   * a picked existing claude-session or a brand-new one.
   */
  sessionId?: string;
  /**
   * When `sessionId` is set, controls which flag to use:
   *   - 'resume' → `-r <id>` (fail if no such session in claude's store)
   *   - 'force' → `--session-id <uuid>` (create-or-resume; uuid must be valid)
   * Default: 'force' (create-or-resume) — what delegate_to_claude wants since
   * we manage the session id ourselves.
   */
  sessionMode?: 'resume' | 'force';
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | {
      type: 'result';
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
      finalText: string;
    }
  | { type: 'error'; message: string; stderr?: string };

/**
 * Spawn claude and yield events as they arrive. Always yields exactly
 * one terminal event (`result` on success, `error` on failure) before
 * returning so consumers can rely on it for transcript writing.
 */
export async function* runClaudeChat(
  opts: RunClaudeChatOptions,
): AsyncGenerator<ChatEvent, void, void> {
  const claudeCmd = opts.claudeCmd ?? process.env.CLAUDE_CMD ?? 'claude';
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (opts.mcpConfig) {
    args.push('--mcp-config', JSON.stringify(opts.mcpConfig));
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowed-tools', opts.allowedTools.join(' '));
  }
  if (opts.permissionMode) {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (opts.sessionId) {
    if ((opts.sessionMode ?? 'force') === 'resume') {
      args.push('-r', opts.sessionId);
    } else {
      args.push('--session-id', opts.sessionId);
    }
  }

  let child: ChildProcess;
  try {
    child = spawn(claudeCmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
  } catch (e) {
    yield { type: 'error', message: `failed to spawn ${claudeCmd}: ${(e as Error).message}` };
    return;
  }

  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Track in-flight tool_use content blocks so we can pair the name
  // (from content_block_start) with the streamed input json
  // (input_json_delta) and emit one tool_call event per call when the
  // block stops.
  const liveTools = new Map<number, { name: string; input: string }>();

  let stderrBuf = '';
  let stdoutLineBuf = '';
  let finalText = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const events: ChatEvent[] = [];

  // Buffer events from the line-parser; the generator drains this queue.
  const queue: ChatEvent[] = [];
  let resolveTick: (() => void) | null = null;
  const tick = () => { if (resolveTick) { resolveTick(); resolveTick = null; } };

  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutLineBuf += chunk.toString('utf8');
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
      const line = stdoutLineBuf.slice(0, nl).trim();
      stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        const inner = ev.type === 'stream_event' && ev.event ? ev.event : ev;

        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          const text = inner.delta.text ?? '';
          finalText += text;
          queue.push({ type: 'delta', text });
        } else if (
          inner?.type === 'content_block_start' &&
          inner.content_block?.type === 'tool_use' &&
          typeof inner.content_block.name === 'string' &&
          typeof inner.index === 'number'
        ) {
          liveTools.set(inner.index, { name: inner.content_block.name, input: '' });
        } else if (
          inner?.type === 'content_block_delta' &&
          inner.delta?.type === 'input_json_delta' &&
          typeof inner.index === 'number' &&
          liveTools.has(inner.index)
        ) {
          liveTools.get(inner.index)!.input += inner.delta.partial_json ?? '';
        } else if (
          inner?.type === 'content_block_stop' &&
          typeof inner.index === 'number' &&
          liveTools.has(inner.index)
        ) {
          const entry = liveTools.get(inner.index)!;
          liveTools.delete(inner.index);
          const filtered = opts.toolEventFilter
            ? opts.toolEventFilter(entry.name)
            : entry.name;
          if (filtered) {
            let parsed: unknown;
            try { parsed = entry.input ? JSON.parse(entry.input) : {}; } catch { parsed = entry.input; }
            queue.push({ type: 'tool_call', name: filtered, input: parsed });
          }
        } else if (ev.type === 'result') {
          if (ev.usage) {
            tokensIn = ev.usage.input_tokens ?? tokensIn;
            tokensOut = ev.usage.output_tokens ?? tokensOut;
          }
          if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
          // Sometimes the terminal `result.result` is the most complete
          // assistant text — prefer it if longer than the streamed accum.
          if (typeof ev.result === 'string' && ev.result.length > finalText.length) {
            finalText = ev.result;
          }
        }
      } catch { /* non-JSON line — ignore */ }
      tick();
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  // Wait for both stdin write and child exit before yielding the terminal
  // event. Yield queued events as they arrive in the meantime.
  child.stdin!.write(opts.promptText);
  child.stdin!.end();

  let exitCode: number | null = null;
  let exited = false;
  child.on('exit', (code) => { exitCode = code; exited = true; tick(); });
  child.on('error', () => { exited = true; tick(); });

  // Drain loop.
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (exited) break;
    await new Promise<void>((resolve) => { resolveTick = resolve; });
  }

  if (opts.signal) opts.signal.removeEventListener('abort', onAbort);

  if (exitCode !== 0) {
    yield {
      type: 'error',
      message: `claude exited ${exitCode ?? '?'}`,
      stderr: stderrBuf.slice(-800),
    };
  } else {
    yield {
      type: 'result',
      costUsd,
      tokensIn,
      tokensOut,
      finalText,
    };
  }
}
