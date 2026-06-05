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
      if (res.ok) {
        // Prefer the explicit {ok:true} contract; fall back to any 2xx.
        let ok = true;
        try {
          const j = JSON.parse(body) as { ok?: boolean };
          if (j && typeof j.ok === 'boolean') ok = j.ok;
        } catch {
          /* non-JSON 2xx still counts as up */
        }
        if (ok) {
          return { healthy: true, status: res.status, body, attempts, elapsedMs: Date.now() - started };
        }
        lastErr = `2xx but body not ok: ${body.slice(0, 200)}`;
      } else {
        lastErr = `status ${res.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    opts.log?.(`health attempt ${attempts}: ${lastErr ?? 'not ready'}`);
    await sleep(intervalMs);
  }
  return { healthy: false, attempts, elapsedMs: Date.now() - started, error: lastErr };
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
