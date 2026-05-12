/**
 * HTTP+SSE transport adapter. Used in:
 *   - Non-Tauri browsers (the webapp test surface).
 *   - The Tauri webview when NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT
 *     is set (rollback escape hatch).
 *   - MCP-spawned agents (they go through the signed-URL HTTP path
 *     directly, not this helper).
 *
 * The path comes from the framework default `/api/agent-tools/<name>`
 * (with `:` mapped to `/`). Tools whose Hono shims live elsewhere
 * (e.g. `/api/agent-mcp/operator-scan`) should pass their explicit
 * path via the third overload form — this helper doesn't introspect
 * the tool registry on the client.
 */

import { parseSseStream } from '@restart/sse';
import type {
  EndpointStreamEvent,
  DispatchEndpointStreamOptions,
} from './types';

export async function* dispatchEndpointStreamHttp<TInput>(
  toolName: string,
  input: TInput,
  options: DispatchEndpointStreamOptions & {
    /** Override the URL the request goes to (default: derived from toolName). */
    overrideUrl?: string;
  } = {},
): AsyncIterable<EndpointStreamEvent> {
  const url =
    options.overrideUrl ??
    `${options.baseUrl ?? ''}/api/agent-tools/${toolName.replace(':', '/')}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: options.signal,
  });

  if (!res.ok) {
    yield {
      kind: 'error',
      code: `http_${res.status}`,
      message: `${res.status} ${res.statusText}`,
    };
    return;
  }
  if (!res.body) {
    yield { kind: 'error', code: 'no_body', message: 'response has no body' };
    return;
  }

  for await (const ev of parseSseStream(res.body)) {
    if (ev.event === 'heartbeat') continue;
    if (ev.event === 'done') {
      // Wire format per the SSE-typed-events plan D1:
      // `event: done\ndata: <ToolResult.content as JSON>`. The wire
      // payload is the content array directly, not the envelope. Wrap
      // it to match EndpointStreamEvent's done shape (parity with IPC,
      // which sends the full ToolResult).
      let content: Array<{ type: string; [k: string]: unknown }>;
      try {
        const parsed = JSON.parse(ev.data);
        content = Array.isArray(parsed) ? parsed : [{ type: 'text', text: String(ev.data) }];
      } catch {
        content = [{ type: 'text', text: ev.data }];
      }
      yield { kind: 'done', result: { content } };
      return;
    }
    if (ev.event === 'error') {
      let parsed: { code?: string; message?: string };
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        parsed = { code: 'handler_error', message: ev.data };
      }
      yield {
        kind: 'error',
        code: parsed.code ?? 'handler_error',
        message: parsed.message ?? '',
      };
      return;
    }
    // Other events: pass through. Try JSON-parsing first; fall back
    // to raw string for z.string()-typed events on the wire.
    let data: unknown = ev.data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      /* raw string is correct for z.string() events */
    }
    yield { kind: 'event', name: ev.event ?? 'message', data };
  }
}
