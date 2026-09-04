/**
 * capability:fetch — make an outbound HTTP request. A thin wrapper over the
 * platform `fetch`, routed through dispatch so a distinct `capability:net`
 * capability can be gated by the envelope (P-010,
 * `agent-capability-confinement-2026-06-13`). The OS sandbox's egress policy
 * remains the containment backstop (D-006).
 */

import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { INLINE_OUTPUT_CAP, scratchDir } from './bash-jobs';
import { heuristicScreener, labelExternalContent } from '../../external-content';

const DEFAULT_MAX_BYTES = 100_000;
const HARD_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type BoundedBody = {
  body: string;
  truncated: boolean;
  logPath?: string;
};

/**
 * Read a response without materializing an unbounded body in memory. The first
 * maxBytes are retained for the inline result; once the cap is crossed, the
 * complete stream is written to a scratch file with backpressure and only the
 * bounded prefix remains in memory.
 */
export async function readResponseBody(
  response: Response,
  maxBytes: number,
  stateDir: string | undefined,
): Promise<BoundedBody> {
  if (!response.body) return { body: '', truncated: false };

  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  let stream: WriteStream | undefined;
  let logPath: string | undefined;

  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    if (!stream) return;
    if (stream.write(chunk)) return;
    await once(stream, 'drain');
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;

      if (!truncated && totalBytes <= maxBytes) {
        prefix.push(chunk);
        prefixBytes += chunk.byteLength;
        continue;
      }

      if (!truncated) {
        truncated = true;
        logPath = join(scratchDir(stateDir), `fetch-${crypto.randomUUID().slice(0, 12)}.txt`);
        stream = createWriteStream(logPath, { flags: 'w' });
        // The chunks retained before the threshold are also part of the full
        // spill, so write them before the chunk that crossed the threshold.
        for (const prior of prefix) await writeChunk(prior);
        const remaining = Math.max(0, maxBytes - prefixBytes);
        if (remaining > 0) {
          prefix.push(chunk.subarray(0, remaining));
          prefixBytes += remaining;
        }
      }

      await writeChunk(chunk);
    }

    if (stream) {
      await new Promise<void>((resolve, reject) => {
        stream!.once('error', reject);
        stream!.once('finish', resolve);
        stream!.end();
      });
    }
  } finally {
    reader.releaseLock();
  }

  const inlineLimit = Math.min(maxBytes, INLINE_OUTPUT_CAP);
  const inline = Buffer.concat(prefix.map((chunk) => Buffer.from(chunk))).subarray(0, inlineLimit);
  return {
    body: inline.toString('utf8'),
    truncated,
    ...(logPath ? { logPath } : {}),
  };
}

export default defineTool({
  name: 'capability:fetch',
  description:
    'Make an outbound HTTP(S) request and return status, headers, and (truncated) body. Body beyond the byte cap spills to a file. The sandbox egress policy bounds which hosts are reachable. For MCP streamable-HTTP POSTs, send Accept: application/json, text/event-stream; application/json alone returns 406.',
  guidance: {
    when: 'Fetch a URL — an API, a raw file, a docs page. For MCP streamable-HTTP POSTs, set Accept: application/json, text/event-stream (application/json alone returns 406). For rich page-to-markdown extraction prefer the fetch_plus / firecrawl plugin tools when available.',
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
      const bounded = await readResponseBody(res, maxBytes, ctx.stateDir);
      const { body: bodyOut, truncated, logPath } = bounded;
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });

      // qm-borrowed-ideas-2026-08-01 P-008: this body is remote text entering agent
      // context. LABEL it (source + untrusted notice + a screen verdict) so the
      // reader knows what it is looking at. The body itself is returned VERBATIM —
      // sanitizing it would corrupt a JSON/CSV payload the caller intends to parse
      // (D-004). Provenance is metadata; quarantining is for prose destined for a
      // prompt, which is a different entry point on the same module.
      let host = 'unknown-host';
      try { host = new URL(args.url).host; } catch { /* keep the fallback */ }
      const provenance = labelExternalContent({ kind: 'fetch', host });
      let screened;
      try {
        screened = await heuristicScreener.screen({
          content: bodyOut,
          source: { kind: 'fetch', host },
          signal: ac.signal,
        });
      } catch (e: unknown) {
        // A screener fault must never fail the fetch — but it must be VISIBLE,
        // never a silent fail-open (qm's unscreened-notice rule).
        screened = {
          decision: 'unavailable' as const,
          reason: e instanceof Error ? e.message : 'screener error',
        };
      }

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
              provenance: { ...provenance, screened },
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
