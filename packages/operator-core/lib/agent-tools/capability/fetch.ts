/**
 * capability:fetch — make an outbound HTTP request. A thin wrapper over the
 * platform `fetch`, routed through dispatch so a distinct `capability:net`
 * capability can be gated by the envelope (P-010,
 * `agent-capability-confinement-2026-06-13`). The OS sandbox's egress policy
 * remains the containment backstop (D-006).
 */

import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';

const DEFAULT_MAX_BYTES = 100_000;
const HARD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export default defineTool({
  name: 'capability:fetch',
  description:
    'Make an outbound HTTP(S) request and return status, headers, and (truncated) body. Body beyond the byte cap spills to a file. The sandbox egress policy bounds which hosts are reachable.',
  guidance: {
    when: 'Fetch a URL — an API, a raw file, a docs page. For rich page-to-markdown extraction prefer the fetch_plus / firecrawl plugin tools when available.',
    notWhen: 'Reading a local file — use capability:read. Running a network CLI — use capability:bash (curl/wget).',
    chaining: 'Standalone. Large bodies spill to a log path you can capability:read.',
  },
  capability: 'capability:net',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  timeoutSec: 60,
  args: z.object({
    url: z.string().url().describe('Absolute http(s) URL.'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().describe('Default GET.'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers.'),
    body: z.string().optional().describe('Request body (string).'),
    max_bytes: z.number().int().positive().max(HARD_MAX_BYTES).optional().describe(`Max body bytes returned inline (default ${DEFAULT_MAX_BYTES}); beyond spills to a file.`),
    timeout_ms: z.number().int().positive().max(120_000).optional().describe(`Request timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`),
  }),
  async handler(args, ctx) {
    const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Combine the dispatch abort signal with our own timeout.
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort();
    if (ctx.signal.aborted) ac.abort();
    else ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await fetch(args.url, {
        method: args.method ?? 'GET',
        headers: args.headers,
        body: args.body,
        signal: ac.signal,
      });
      const full = await res.text();
      const truncated = Buffer.byteLength(full, 'utf8') > maxBytes;
      let bodyOut = full;
      let logPath: string | undefined;
      if (truncated) {
        logPath = join(scratchDir(ctx.stateDir), `fetch-${crypto.randomUUID().slice(0, 12)}.txt`);
        try { createWriteStream(logPath, { flags: 'w' }).end(full); } catch { /* ignore */ }
        bodyOut = full.slice(0, Math.min(maxBytes, INLINE_OUTPUT_CAP));
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: res.ok,
              status: res.status,
              status_text: res.statusText,
              headers,
              truncated,
              ...(logPath ? { log_path: logPath } : {}),
              body: bodyOut,
            }),
          },
        ],
        isError: !res.ok,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'fetch_failed', message: msg }) }],
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
  },
});
