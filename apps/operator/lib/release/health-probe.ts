/**
 * Post-deploy health probe — plan release-gate-ready-branch-2026-06-04, D-011(d).
 *
 * After the restart, the release-manager reads health before declaring the
 * deploy good (or triggering rollback). This is the scripted smoke: poll the
 * operator's /api/health until it reports healthy or a timeout elapses.
 *
 * Dependency-light (just fetch) so it runs standalone.
 */

export interface HealthResult {
  healthy: boolean;
  status?: number;
  body?: string;
  attempts: number;
  elapsedMs: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProbeOpts {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  log?: (s: string) => void;
  /** Also probe POST /api/mcp initialize → 200 event-stream (MCP hardening). */
  probeMcp?: boolean;
  /** Base URL for MCP probe (defaults to url with /api/mcp appended). */
  mcpUrl?: string;
}

export async function probeHealth(url: string, opts: ProbeOpts = {}): Promise<HealthResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  const started = Date.now();
  let attempts = 0;
  let lastErr: string | undefined;

  while (Date.now() - started < timeoutMs) {
    attempts++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      const body = await res.text();
      let ok = false;
      if (res.ok) {
        // Prefer the explicit {ok:true} contract; fall back to any 2xx.
        ok = true;
        try {
          const j = JSON.parse(body) as { ok?: boolean };
          if (j && typeof j.ok === 'boolean') ok = j.ok;
        } catch {
          /* non-JSON 2xx still counts as up */
        }
      } else {
        lastErr = `status ${res.status}`;
      }

      if (!ok) {
        if (!lastErr) lastErr = `2xx but body not ok: ${body.slice(0, 200)}`;
        opts.log?.(`health attempt ${attempts}: ${lastErr ?? 'not ready'}`);
        await sleep(intervalMs);
        continue;
      }

      // If /api/health passed and MCP probing is enabled, test the MCP endpoint.
      if (opts.probeMcp) {
        const mcpProbeResult = await probeMcpInitialize(
          opts.mcpUrl || url.replace('/api/health', '/api/mcp'),
          { requestTimeoutMs, log: opts.log },
        );
        if (!mcpProbeResult.ok) {
          lastErr = `MCP initialization failed: ${mcpProbeResult.error}`;
          opts.log?.(`health attempt ${attempts}: ${lastErr}`);
          await sleep(intervalMs);
          continue;
        }
      }

      return { healthy: true, status: res.status, body, attempts, elapsedMs: Date.now() - started };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    opts.log?.(`health attempt ${attempts}: ${lastErr ?? 'not ready'}`);
    await sleep(intervalMs);
  }
  return { healthy: false, attempts, elapsedMs: Date.now() - started, error: lastErr };
}

/**
 * Probe the MCP endpoint with a POST /api/mcp initialize request.
 * Returns ok:true only if the response is 200 with Content-Type: text/event-stream.
 */
async function probeMcpInitialize(
  url: string,
  opts: { requestTimeoutMs?: number; log?: (s: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  try {
    // Minimal MCP initialize request (JSON-RPC).
    const initMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'health-probe', version: '1.0.0' },
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // MCP streamable-HTTP REQUIRES both media types in Accept; a spec-compliant
        // endpoint returns 406 without it (endpoint-route/.../agent-tools/catchall.ts
        // gates on `accept.includes('text/event-stream')`). Omitting this header made
        // the post-deploy probe 406 on every deploy of the strict-MCP code → health
        // check failed → auto-rollback → main froze undeployed. (Verified live: no-Accept
        // → 406; with-Accept → 200 text/event-stream.)
        'accept': 'application/json, text/event-stream',
        'authorization': 'Bearer health-probe',
      },
      body: JSON.stringify(initMessage),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      return { ok: false, error: `status ${res.status}` };
    }
    if (!contentType.includes('text/event-stream')) {
      const body = await res.text();
      return { ok: false, error: `expected text/event-stream, got ${contentType}: ${body.slice(0, 100)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// CLI: `tsx health-probe.ts <url> [timeoutMs]`
if (require.main === module) {
  const url = process.argv[2] ?? 'http://127.0.0.1:3070/api/health';
  const timeoutMs = process.argv[3] ? Number(process.argv[3]) : undefined;
  probeHealth(url, { timeoutMs, log: (s) => console.error(`[health] ${s}`) }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.healthy ? 0 : 1);
  });
}
