/**
 * P-010 admission control (mcp-reliability-hardening-2026-07-11).
 *
 * When the request-worker event loop is CRITICALLY saturated, dispatching yet
 * another `tools/call` only deepens the saturation (every tool is main-thread
 * work). Shed it PRE-DISPATCH with HTTP 429 + Retry-After: the tool never runs
 * (no side effect ⇒ a retry is write-safe), and the resilient MCP proxy (P-005)
 * ABSORBS the 429 — drains, waits Retry-After, retries within its window — so the
 * agent just waits a beat instead of seeing an error (the same shape that makes a
 * deploy restart invisible).
 *
 * Only POST `tools/call` is shed; initialize / tools/list / notifications / ping /
 * resources / prompts are cheap protocol traffic and MUST stay live (they carry
 * discovery + recovery). Gated on the CRITICAL band only — `elevated` still admits
 * (that band drives background-tick shedding, not request rejection). Fail-open: no
 * lag monitor ⇒ loopPressure() is 'ok' ⇒ never sheds. Env kill-switch
 * PAPERCUSP_MCP_ADMISSION_CONTROL=0; Retry-After default 1s (pressure clears fast
 * once we stop admitting — the proxy clamps its own wait regardless).
 *
 * Lives in its own module (not inline in _mcp-handler.ts) so the pure decision
 * logic is unit-testable without pulling the handler's heavy side-effect graph
 * (it registers every first-party tool on import).
 */
import type { LoopPressure } from '../../../event-loop-lag-monitor';

export const ADMISSION_CONTROL_ENABLED = process.env.PAPERCUSP_MCP_ADMISSION_CONTROL !== '0';
export const ADMISSION_RETRY_AFTER_SEC = Math.max(
  1,
  Number(process.env.PAPERCUSP_MCP_ADMISSION_RETRY_AFTER_SEC) || 1,
);

/**
 * Classify a peeked MCP POST body: is it (or a batch containing) a `tools/call`?
 * That's the only sheddable shape — every other JSON-RPC method is cheap protocol
 * traffic we keep serving even when saturated. Also returns the request id to echo
 * in the JSON-RPC error envelope (first tools/call id in a batch; null if none).
 * PURE + unit-tested.
 */
export function classifyMcpBody(bodyText: string): { sheddable: boolean; id: string | number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { sheddable: false, id: null }; // unparseable → let the handler reject it (never shed blind)
  }
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  let id: string | number | null = null;
  let sheddable = false;
  for (const m of msgs) {
    if (m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call') {
      sheddable = true;
      const mid = (m as { id?: unknown }).id;
      if (id === null && (typeof mid === 'string' || typeof mid === 'number')) id = mid;
    }
  }
  return { sheddable, id };
}

/** The load-shed decision (PURE): shed iff admission control is enabled AND the loop
 *  is in the CRITICAL band. Method-level sheddability is decided separately (needs the
 *  body); this is the cheap gate checked first so the common case never reads the body. */
export function shouldShedForPressure(pressure: LoopPressure, enabled: boolean): boolean {
  return enabled && pressure === 'critical';
}

/** The 429 backpressure response the proxy absorbs. A JSON-RPC error envelope so a
 *  direct (non-proxy) client still gets a structured, retryable signal. */
export function admissionShedResponse(
  id: string | number | null,
  retryAfterSec: number = ADMISSION_RETRY_AFTER_SEC,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'operator event loop critically saturated — request shed, retry shortly',
        data: { retryable: true, reason: 'loop_pressure_critical' },
      },
    }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
    },
  );
}

/**
 * Admission gate (testable core): returns a 429 Response to shed, or null to admit.
 * Peeks the body via `req.clone()` so the ORIGINAL `req` stays intact for the handler.
 * `pressure`/`enabled` are injected so this is unit-testable without booting a monitor.
 */
export async function evaluateAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
): Promise<Response | null> {
  if (req.method !== 'POST') return null; // GET/SSE reconnects etc. — never shed
  if (!shouldShedForPressure(pressure, enabled)) return null; // fast path: no clone, no body read
  let bodyText: string;
  try {
    bodyText = await req.clone().text();
  } catch {
    return null; // couldn't peek the body → admit (fail-open; never shed blind)
  }
  const { sheddable, id } = classifyMcpBody(bodyText);
  if (!sheddable) return null; // not a tools/call → cheap → admit
  return admissionShedResponse(id);
}
