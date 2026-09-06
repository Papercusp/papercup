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
import { normalizeMcpName } from '@papercusp/tooldef';
import type { LoopPressure } from '../../../event-loop-lag-monitor';

export const ADMISSION_CONTROL_ENABLED = process.env.PAPERCUSP_MCP_ADMISSION_CONTROL !== '0';
export const ADMISSION_RETRY_AFTER_SEC = Math.max(
  1,
  Number(process.env.PAPERCUSP_MCP_ADMISSION_RETRY_AFTER_SEC) || 1,
);

/**
 * EI-21392098254217280 — the proxy has an admission ceiling, but the operator
 * worker used to accept an unbounded number of requests after they crossed the
 * proxy boundary. A CPU-bound worker could therefore spend all of its event
 * loop budget on MCP handshakes and tool dispatches before any one request had
 * a chance to finish. Keep the defaults deliberately below the proxy's global
 * ceiling: this is a per-worker guard, not a replacement for the proxy's
 * cross-worker bulkhead.
 */
function intEnv(name: string, fallback: number, min = 0): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.trunc(parsed)) : fallback;
}

export const OPERATOR_ADMISSION_MAX_IN_FLIGHT = intEnv('PAPERCUSP_MCP_OPERATOR_MAX_IN_FLIGHT', 64);
export const OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE = intEnv(
  'PAPERCUSP_MCP_OPERATOR_CONTROL_PLANE_RESERVE',
  8,
);
export const OPERATOR_ADMISSION_DIAGNOSTIC_RESERVE = intEnv(
  'PAPERCUSP_MCP_OPERATOR_DIAGNOSTIC_RESERVE',
  2,
);
export const OPERATOR_ADMISSION_MAX_HANDSHAKES = intEnv(
  'PAPERCUSP_MCP_OPERATOR_MAX_HANDSHAKES',
  OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE,
);

export type McpAdmissionClass = 'ordinary' | 'handshake' | 'diagnostic' | 'other';

export interface McpAdmissionCapacity {
  maxInFlight: number;
  controlPlaneReserve: number;
  diagnosticReserve: number;
  maxHandshakes: number;
}

export interface McpAdmissionSnapshot {
  inFlight: number;
  handshakesInFlight: number;
  diagnosticsInFlight: number;
  ordinaryInFlight: number;
}

export interface McpAdmissionLease {
  classification: McpAdmissionClass;
  release: () => void;
}

export interface McpAdmissionDecision {
  response: Response | null;
  lease: McpAdmissionLease | null;
  classification: McpAdmissionClass;
}

const DEFAULT_CAPACITY: McpAdmissionCapacity = {
  maxInFlight: OPERATOR_ADMISSION_MAX_IN_FLIGHT,
  controlPlaneReserve: OPERATOR_ADMISSION_CONTROL_PLANE_RESERVE,
  diagnosticReserve: OPERATOR_ADMISSION_DIAGNOSTIC_RESERVE,
  maxHandshakes: OPERATOR_ADMISSION_MAX_HANDSHAKES,
};

let admissionSnapshot: McpAdmissionSnapshot = {
  inFlight: 0,
  handshakesInFlight: 0,
  diagnosticsInFlight: 0,
  ordinaryInFlight: 0,
};

export function getMcpAdmissionSnapshot(): McpAdmissionSnapshot {
  return { ...admissionSnapshot };
}

/** Test-only reset. The gate is process-local state by design. */
export function resetMcpAdmissionForTests(): void {
  admissionSnapshot = {
    inFlight: 0,
    handshakesInFlight: 0,
    diagnosticsInFlight: 0,
    ordinaryInFlight: 0,
  };
}

/**
 * EI-20241040709445172 — diagnostics needed to prove or recover from critical
 * pressure must not be rejected by the pressure gate itself. Keep this list
 * deliberately narrow: both tools are read-only and internally bounded, so
 * admitting them cannot add an unbounded unit of work to the saturated loop.
 *
 * The outer MCP proxy has the matching capacity-reserve list. This inner gate
 * still needs its own exemption because direct ptool/staging calls bypass that
 * proxy, and because a proxy-reserved request can otherwise be shed here after
 * it reaches the operator.
 */
/**
 * EI-21574538947513211 adds `dev:dogfood_substrate_status`, measured: a bounded 149-index
 * `ownLogProbe` walk at concurrency 20 drew 94 explicit retryable -32000 sheds with reason
 * `loop_pressure_critical`. That is this gate rejecting the very tool used to OBSERVE the
 * pressure it is reacting to — the failure mode the exemption above exists to prevent, arriving
 * through the one diagnostic that was never listed.
 *
 * It meets the stated bar rather than widening it. `attachOwnLogProbe` takes a SINGLE
 * non-negative `index` and performs exactly one `handle.ownLog.get(index)` against an
 * ALREADY-OPEN Corestore — its own contract is that it "never opens a second Corestore or joins
 * transport just to inspect a row", and a relocated handle routes over the bounded
 * `substrate:getOwnLogOp` RPC. The tool is read-only throughout. The 149-index figure was the
 * CALLER issuing 149 separate cheap calls, not one unbounded unit of work; per-call cost is what
 * this list is about.
 *
 * ⚠ Know what listing a tool actually grants — it is BOTH legs, not just the pressure one.
 * `isCriticalPressureDiagnosticCall` is read by `classifyMcpBody` (⇒ never pressure-shed) AND by
 * `classifyMcpRequest` (⇒ classified 'diagnostic', which `shouldShedForCapacity` returns false
 * for). `diagnosticReserve` is a floor carved out of the ORDINARY ceiling for diagnostics, NOT a
 * cap on them, so a listed tool is bounded only by the global `maxInFlight`. Do not add anything
 * here whose per-call cost you have not read. `work_items:get` is admitted only for one item with
 * the default shallow read; bulk, detail, and thread reads remain shed under critical pressure.
 */
const CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS = new Set(
  ['dev:service_health', 'dev:pg_query', 'dev:dogfood_substrate_status', 'work_items:get'].map(normalizeMcpName),
);
const TOOLS_INVOKE_NAME = normalizeMcpName('tools:invoke');
const WORK_ITEMS_GET_NAME = normalizeMcpName('work_items:get');

function isBoundedWorkItemsGetArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as {
    id?: unknown;
    ids?: unknown;
    detail?: unknown;
    threadLimit?: unknown;
  };
  const singleId = typeof record.id === 'string' && record.id.trim().length > 0 && record.ids === undefined;
  const singleIds = Array.isArray(record.ids)
    && record.ids.length === 1
    && typeof record.ids[0] === 'string'
    && record.id === undefined;
  if (!singleId && !singleIds) return false;
  if (record.detail !== undefined && record.detail !== false) return false;
  if (record.threadLimit !== undefined && record.threadLimit !== 0) return false;
  return true;
}

function isCriticalPressureDiagnostic(toolName: unknown, args?: unknown): boolean {
  if (typeof toolName !== 'string') return false;
  const normalized = normalizeMcpName(toolName);
  if (!CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS.has(normalized)) return false;
  return normalized !== WORK_ITEMS_GET_NAME || isBoundedWorkItemsGetArgs(args);
}

function isCriticalPressureDiagnosticCall(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
  if (!params || typeof params.name !== 'string') return false;
  const normalizedName = normalizeMcpName(params.name);
  if (normalizedName === TOOLS_INVOKE_NAME) {
    const invokeArgs = params.arguments;
    if (!invokeArgs || typeof invokeArgs !== 'object' || Array.isArray(invokeArgs)) return false;
    const target = (invokeArgs as { name?: unknown; args?: unknown }).name;
    return isCriticalPressureDiagnostic(target, (invokeArgs as { args?: unknown }).args);
  }
  return isCriticalPressureDiagnostic(params.name, params.arguments);
}

const MCP_HANDSHAKE_METHODS = new Set(['initialize', 'ping', 'tools/list']);
export const MCP_HEALTH_PROBE_CLIENT = 'mcp-health';

function isMcpHealthProbe(requestUrl: string | undefined): boolean {
  if (!requestUrl) return false;
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('client') === MCP_HEALTH_PROBE_CLIENT;
  } catch {
    return false;
  }
}

/**
 * Classify a peeked MCP POST body: is it (or a batch containing) a `tools/call`?
 * That's the only sheddable shape — every other JSON-RPC method is cheap protocol
 * traffic we keep serving even when saturated. The narrow bounded diagnostic set
 * above is also admitted so the pressure condition remains observable/recoverable.
 * Also returns the request id to echo in the JSON-RPC error envelope (first
 * sheddable tools/call id in a batch; null if none).
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
      if (isCriticalPressureDiagnosticCall(m)) continue;
      sheddable = true;
      const mid = (m as { id?: unknown }).id;
      if (id === null && (typeof mid === 'string' || typeof mid === 'number')) id = mid;
    }
  }
  return { sheddable, id };
}

/**
 * Classify the bounded part of the MCP transport. The `other` class remains
 * fail-open: notifications and resource/prompt traffic are cheap protocol
 * work, while initialize/tools/list/ping and tools/call are the traffic that
 * can create the observed CPU queue. A named health probe is diagnostic even
 * though it is an initialize request, so it retains the diagnostic reserve.
 */
export function classifyMcpRequest(bodyText: string, requestUrl?: string): McpAdmissionClass {
  if (isMcpHealthProbe(requestUrl)) return 'diagnostic';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'other';
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let ordinaryToolCall = false;
  let diagnosticToolCall = false;
  let handshake = messages.length > 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      handshake = false;
      continue;
    }
    const method = (message as { method?: unknown }).method;
    if (typeof method !== 'string') {
      handshake = false;
      continue;
    }
    if (MCP_HANDSHAKE_METHODS.has(method)) continue;
    handshake = false;
    if (method !== 'tools/call') continue;
    if (isCriticalPressureDiagnosticCall(message)) diagnosticToolCall = true;
    else ordinaryToolCall = true;
  }
  if (ordinaryToolCall) return 'ordinary';
  if (diagnosticToolCall) return 'diagnostic';
  if (handshake) return 'handshake';
  return 'other';
}

/** The load-shed decision (PURE): shed iff admission control is enabled AND the loop
 *  is in the CRITICAL band. Method-level sheddability is decided separately (needs the
 *  body); this is the cheap gate checked first so the common case never reads the body. */
export function shouldShedForPressure(pressure: LoopPressure, enabled: boolean): boolean {
  return enabled && pressure === 'critical';
}

/** Pure capacity decision used by the live gate and its focused regression tests. */
export function shouldShedForCapacity(
  classification: McpAdmissionClass,
  snapshot: McpAdmissionSnapshot,
  capacity: McpAdmissionCapacity = DEFAULT_CAPACITY,
): boolean {
  if (capacity.maxInFlight <= 0 || classification === 'other') return false;
  if (snapshot.inFlight >= capacity.maxInFlight) return true;
  if (classification === 'handshake' && capacity.maxHandshakes > 0 && snapshot.handshakesInFlight >= capacity.maxHandshakes) {
    return true;
  }
  if (classification === 'diagnostic') return false;
  const reserved = Math.max(0, capacity.controlPlaneReserve) + Math.max(0, capacity.diagnosticReserve);
  const ordinaryCeiling = Math.max(1, capacity.maxInFlight - reserved);
  if (classification === 'ordinary') return snapshot.inFlight >= ordinaryCeiling;
  // A regular handshake can consume the control-plane reserve, but it may not
  // consume the diagnostic reserve.
  const handshakeCeiling = Math.max(1, capacity.maxInFlight - Math.max(0, capacity.diagnosticReserve));
  return snapshot.inFlight >= handshakeCeiling;
}

/** The 429 backpressure response the proxy absorbs. A JSON-RPC error envelope so a
 *  direct (non-proxy) client still gets a structured, retryable signal. */
export function admissionShedResponse(
  id: string | number | null,
  retryAfterSec: number = ADMISSION_RETRY_AFTER_SEC,
  reason = 'loop_pressure_critical',
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: 'operator MCP admission is saturated — request shed, retry shortly',
        data: { retryable: true, reason },
      },
    }),
    {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
    },
  );
}

function releaseAdmission(classification: McpAdmissionClass): void {
  admissionSnapshot = {
    inFlight: Math.max(0, admissionSnapshot.inFlight - 1),
    handshakesInFlight: Math.max(
      0,
      admissionSnapshot.handshakesInFlight - (classification === 'handshake' ? 1 : 0),
    ),
    diagnosticsInFlight: Math.max(
      0,
      admissionSnapshot.diagnosticsInFlight - (classification === 'diagnostic' ? 1 : 0),
    ),
    ordinaryInFlight: Math.max(
      0,
      admissionSnapshot.ordinaryInFlight - (classification === 'ordinary' ? 1 : 0),
    ),
  };
}

function acquireCapacity(classification: McpAdmissionClass): McpAdmissionLease | null {
  if (shouldShedForCapacity(classification, admissionSnapshot)) return null;
  if (classification === 'other') return null;
  admissionSnapshot = {
    inFlight: admissionSnapshot.inFlight + 1,
    handshakesInFlight: admissionSnapshot.handshakesInFlight + (classification === 'handshake' ? 1 : 0),
    diagnosticsInFlight: admissionSnapshot.diagnosticsInFlight + (classification === 'diagnostic' ? 1 : 0),
    ordinaryInFlight: admissionSnapshot.ordinaryInFlight + (classification === 'ordinary' ? 1 : 0),
  };
  let released = false;
  return {
    classification,
    release: () => {
      if (released) return;
      released = true;
      releaseAdmission(classification);
    },
  };
}

/**
 * Acquire the operator-side lease. The original Request body is never
 * consumed: classification peeks through `clone()`, leaving mcp-handler's
 * parser untouched. A malformed/unreadable body is admitted so the protocol
 * layer can return its own structured parse error rather than a misleading
 * overload response.
 */
export async function acquireAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
): Promise<McpAdmissionDecision> {
  if (req.method !== 'POST' || !enabled) {
    return { response: null, lease: null, classification: 'other' };
  }
  let bodyText: string;
  try {
    bodyText = await req.clone().text();
  } catch {
    return { response: null, lease: null, classification: 'other' };
  }
  const classification = classifyMcpRequest(bodyText, req.url);
  const { sheddable, id } = classifyMcpBody(bodyText);
  if (sheddable && shouldShedForPressure(pressure, enabled)) {
    return {
      response: admissionShedResponse(id, ADMISSION_RETRY_AFTER_SEC, 'loop_pressure_critical'),
      lease: null,
      classification,
    };
  }
  const lease = acquireCapacity(classification);
  if (classification !== 'other' && !lease) {
    const idForResponse = sheddable ? id : null;
    return {
      response: admissionShedResponse(idForResponse, ADMISSION_RETRY_AFTER_SEC, 'operator_admission_capacity'),
      lease: null,
      classification,
    };
  }
  return { response: null, lease, classification };
}

/**
 * Hold an admitted request's capacity lease for the complete handler turn.
 * The transport must not release the lease after the admission decision but
 * before mcp-handler has finished its CPU-bound handshake/dispatch work.
 */
export async function withMcpAdmission(
  req: Request,
  pressure: LoopPressure,
  enabled: boolean,
  run: () => Promise<Response>,
): Promise<Response> {
  const decision = await acquireAdmission(req, pressure, enabled);
  if (decision.response) return decision.response;
  try {
    return await run();
  } finally {
    decision.lease?.release();
  }
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
  const decision = await acquireAdmission(req, pressure, enabled);
  decision.lease?.release();
  return decision.response;
}
