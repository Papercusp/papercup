/**
 * operator-discovery.mjs — resolve the LIVE operator base URL for the
 * sidecar-shipped CLIs (onboard-launcher, tutorial-runner, ptool).
 *
 * A packaged desktop install runs its operator on a DYNAMICALLY-assigned
 * localhost port (re-picked on every boot) and records it in
 * ~/.papercusp/operator.json — the fixed :3070 exists only on the dev box.
 * Any CLI that defaults straight to :3070 dies with "can't reach the
 * Papercusp server at http://127.0.0.1:3070" on EVERY shipped install
 * (owner hit this live launching the tutorial on the seeded mac install,
 * 2026-07-05, WI-2903 thread). Same discovery convention as
 * psu-launcher.mjs `resolveOperatorUrl()` step 2 (WI-1457) — psu keeps its
 * own richer copy because it additionally probes the dev-box resilient
 * MCP proxy, which these CLIs never need.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The desktop operator's recorded address from ~/.papercusp/operator.json,
 * or null when the file is missing/unreadable (the dev box).
 */
export function discoverOperatorUrl({ home = homedir() } = {}) {
  try {
    const d = JSON.parse(readFileSync(join(home, '.papercusp', 'operator.json'), 'utf8'));
    if (d && typeof d.httpUrl === 'string' && d.httpUrl) return d.httpUrl;
    if (d && d.port) return `http://127.0.0.1:${d.port}`;
  } catch {
    /* no operator.json → not a packaged desktop install */
  }
  return null;
}

/**
 * Standard CLI precedence: explicit --operator-url arg → PAPERCUSP_OPERATOR_URL
 * env override → live desktop discovery (operator.json) → dev-box :3070.
 */
export function resolveOperatorBase(args = {}, env = process.env, opts = {}) {
  return (
    args.operatorUrl ??
    env.PAPERCUSP_OPERATOR_URL ??
    discoverOperatorUrl(opts) ??
    'http://127.0.0.1:3070'
  ).replace(/\/$/, '');
}

/**
 * Resilient fetch for the sidecar CLIs — the shared, smaller sibling of
 * psu-launcher's fetchWithResilience (WI-3141). A packaged desktop operator is
 * routinely MID-BOOT when the user first opens the app and immediately clicks
 * the Setup/Tutorial icon: serve.mjs starts embedded-PG + runs migrations +
 * boots the Hono host, a multi-second window during which a plain fetch fails
 * "connection refused". The onboarding launchers used a bare fetch with NO
 * retry, so that unavoidable first-boot window surfaced as a hard "I can't reach
 * the Papercusp server" and the user had to relaunch until the boot finished
 * (owner 2026-07-05: "after 3 attempts the tutorial FINALLY showed up"). This
 * rides THROUGH it: CONNECTION failures (refused/reset — undici "fetch failed")
 * are retried on a short backoff until `connectBudgetMs` elapses; a bounded
 * per-request timeout stops a wedged host hanging forever; TIMEOUTs are retried
 * a small fixed number of times.
 *
 * A caller-supplied `init.signal` (e.g. the docs-qa stream's AbortController)
 * OWNS abort — once it fires we stop and rethrow — but a CONNECTION failure that
 * happens BEFORE it fires still retries within the budget, so a streamed call
 * also rides through a brief operator blip. `onRetry` fires once, the first time
 * a retry is scheduled, so a caller can show a "still starting…" note.
 *
 * Deps injected for tests (operator-discovery.test.ts) — fetchImpl/sleep/now
 * make the retry timing deterministic without real sockets or timers.
 */
export async function fetchResilient(
  url,
  init = {},
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    timeoutMs = 20_000,
    connectBudgetMs = 30_000,
    timeoutRetries = 1,
    onRetry = null,
  } = {},
) {
  // A caller-supplied AbortSignal owns the request lifetime; without one we cap
  // each attempt with AbortSignal.timeout so a wedged host can't hang forever.
  const callerSignal = init.signal ?? null;
  const connectDeadline = now() + connectBudgetMs;
  let timeoutRetriesLeft = timeoutRetries;
  let announced = false;
  let lastErr;
  for (;;) {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      // The caller's own signal aborted (its deadline/cancel) — never retry it.
      if (callerSignal?.aborted) break;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (isTimeout) {
        // Reachable but slow — a retry costs another full timeout, so keep few.
        if (timeoutRetriesLeft <= 0) break;
        timeoutRetriesLeft -= 1;
        if (!announced) {
          announced = true;
          try {
            onRetry?.();
          } catch {
            /* a notice must never break the fetch */
          }
        }
        await sleep(1_000);
        continue;
      }
      // Connection refused/reset ("fetch failed") — operator mid-boot / recycle.
      // Retry on a short backoff until the wall-clock budget elapses.
      const remaining = connectDeadline - now();
      if (remaining <= 0) break;
      if (!announced) {
        announced = true;
        try {
          onRetry?.();
        } catch {
          /* a notice must never break the fetch */
        }
      }
      await sleep(Math.min(2_000, Math.max(0, remaining)));
    }
  }
  throw lastErr ?? new Error(`could not reach ${url}`);
}
