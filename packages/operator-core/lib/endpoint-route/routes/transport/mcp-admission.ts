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
 * it reaches the operator. `scheduler:get_next`, `loop:status`, and bounded `dev:telemetry`
 * are included below as recovery calls. The scheduler self-pull claims at most one item and
 * its handler has an
 * explicit whole-call deadline, but it is admitted only for its known, bounded
 * argument shape (unlike a generic ordinary tools/call).
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
 * here whose per-call cost you have not read. `tools:find` is the bounded catalog-discovery door
 * used to locate recovery tools and already has a proxy-side control-plane reservation; direct
 * ptool/staging calls need the same inner exemption. `capability:read` is admitted only for a
 * single byte page from an authorized scratch spill, so result-door recovery can proceed while
 * pressure is critical without opening the broad file-read surface. `work_items:get` is admitted
 * only for one item with the default shallow read; bulk, detail, and thread reads remain shed
 * under critical pressure. `scorecards:list` is admitted only for an exact rubric+subject audit
 * read; broad history remains shed. `rubrics:get` is admitted only for one rubric (the full
 * criteria body is required by a judge); multi-rubric reads remain shed. A judge's
 * `scorecards:emit` is admitted only for one terminal grading-integrity audit of one scorecard;
 * ordinary scorecard writes remain shed. The three read-only judge audit probes
 * (`plans:evaluate-spec-test-adequacy`, `gates:degenerate-check`, and
 * `plans:get-spec-evidence`) are admitted only for the judge role and bounded argument shapes;
 * their ordinary callers remain shed. `work_items:checkpoint` is admitted only for a single
 * item, because a bounded durability write is needed to preserve successor state during the
 * pressure condition; bulk checkpoint batches remain shed. `scorecards:get` is admitted only
 * for one bounded issue-id evidence read. `improvements:capture` is admitted only for the
 * tool-failure shorthand, whose nested metadata is bounded and is the required recovery record
 * for a shed tool call; ordinary captures remain shed. `dev:telemetry` requires an explicit
 * small result page so its aggregate query cannot become an unbounded pressure escape hatch.
 */
const CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS = new Set(
  [
    'dev:service_health',
    'dev:pg_query',
    'dev:dogfood_substrate_status',
    'tools:find',
    'work_items:get',
    'loop:status',
  ].map(normalizeMcpName),
);
const DEV_TELEMETRY_NAME = normalizeMcpName('dev:telemetry');
const CRITICAL_DEV_TELEMETRY_MAX_HOURS = 24;
const CRITICAL_DEV_TELEMETRY_MAX_LIMIT = 50;
const CRITICAL_DEV_TELEMETRY_MAX_WORKSPACE_IDS = 32;
const CRITICAL_DEV_TELEMETRY_MAX_STRING_CHARS = 120;
const DEV_TELEMETRY_TRANSPORTS = new Set(['http', 'mcp', 'ipc', 'in_process', 'unknown']);
const SCHEDULER_GET_NEXT_NAME = normalizeMcpName('scheduler:get_next');
const LOOP_STATUS_NAME = normalizeMcpName('loop:status');
const CRITICAL_SCHEDULER_MAX_HARNESS_CHARS = 200;
const CRITICAL_SCHEDULER_MAX_HELD_PATH_CHARS = 512;
const CRITICAL_SCHEDULER_MAX_HELD_PATHS = 500;
const CRITICAL_SCHEDULER_STATES = new Set(['open', 'failing']);
const CRITICAL_LOOP_STATUS_MAX_STRING_CHARS = 120;
const TOOLS_INVOKE_NAME = normalizeMcpName('tools:invoke');
const WORK_ITEMS_GET_NAME = normalizeMcpName('work_items:get');
const WORK_ITEMS_CHECKPOINT_NAME = normalizeMcpName('work_items:checkpoint');
const SCORECARDS_LIST_NAME = normalizeMcpName('scorecards:list');
const SCORECARDS_GET_NAME = normalizeMcpName('scorecards:get');
const SCORECARDS_EMIT_NAME = normalizeMcpName('scorecards:emit');
const RUBRICS_GET_NAME = normalizeMcpName('rubrics:get');
const IMPROVEMENTS_CAPTURE_NAME = normalizeMcpName('improvements:capture');
const EVALUATE_SPEC_TEST_ADEQUACY_NAME = normalizeMcpName('plans:evaluate-spec-test-adequacy');
const DEGENERATE_CHECK_NAME = normalizeMcpName('gates:degenerate-check');
const GET_SPEC_EVIDENCE_NAME = normalizeMcpName('plans:get-spec-evidence');
const CRITICAL_SCORECARDS_LIST_MAX_ROWS = 25;
const CRITICAL_SCORECARDS_GET_ISSUE_ID_MAX = 120;
const CRITICAL_TOOL_FAILURE_MESSAGE_MAX = 4_000;
const CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX = 2_000;
const CRITICAL_JUDGE_AUDIT_MAX_ROWS = 25;
const CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS = 25;
const CRITICAL_JUDGE_AUDIT_MAX_MIN_DECISIONS = 100_000;
const CRITICAL_JUDGE_AUDIT_MAX_SINCE_HOURS = 24;
const CAPABILITY_READ_NAME = normalizeMcpName('capability:read');
const CRITICAL_CAPABILITY_READ_MAX_BYTES = 4_096;

const PLAN_CLASS_RUBRIC_REFS = new Set([
  'plan-class-feature-ship',
  'plan-class-bugfix',
  'plan-class-migration',
  'plan-class-investigation',
]);
const SPEC_EVIDENCE_KINDS = new Set([
  'test',
  'fixture',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'manual',
  'operational',
]);
const TOOL_FAILURE_DIRECT_EVIDENCE_KINDS = new Set([
  'valid-input-reproduction',
  'server-contract-mismatch',
  'hard-internal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function isBoundedStringArray(value: unknown, max = CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= max &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

function isBoundedEvidenceCurrent(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > CRITICAL_JUDGE_AUDIT_MAX_ARRAY_ITEMS) return false;
  return value.every((entry) => {
    if (!isRecord(entry)) return false;
    if (typeof entry.evidenceKind !== 'string' || !SPEC_EVIDENCE_KINDS.has(entry.evidenceKind)) return false;
    if (
      typeof entry.evidenceRef !== 'string' ||
      entry.evidenceRef.trim().length === 0 ||
      entry.evidenceRef.length > 2_000
    ) {
      return false;
    }
    if (
      typeof entry.sourceFingerprint !== 'string' ||
      entry.sourceFingerprint.trim().length === 0 ||
      entry.sourceFingerprint.length > 256
    ) {
      return false;
    }
    for (const field of ['testFingerprint', 'fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint']) {
      if (
        entry[field] !== undefined &&
        entry[field] !== null &&
        (typeof entry[field] !== 'string' || (entry[field] as string).length > 256)
      ) {
        return false;
      }
    }
    return true;
  });
}

function isBoundedJudgeEvaluateArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (typeof args.slug !== 'string' || args.slug.trim().length === 0) return false;
  if (typeof args.classRef !== 'string' || !PLAN_CLASS_RUBRIC_REFS.has(args.classRef)) return false;
  if (!isBoundedPositiveInt(args.limit, CRITICAL_JUDGE_AUDIT_MAX_ROWS)) return false;
  if (args.harness !== undefined && (typeof args.harness !== 'string' || args.harness.trim().length === 0))
    return false;
  for (const field of ['workItemIds', 'evidenceRefs', 'specIds']) {
    if (args[field] !== undefined && !isBoundedStringArray(args[field])) return false;
  }
  if (
    args.planItemIds !== undefined &&
    (!isBoundedStringArray(args.planItemIds) || !args.planItemIds.every((id) => /^P-\d{3,}$/.test(id)))
  ) {
    return false;
  }
  if (args.current !== undefined) {
    const current = args.current;
    if (Array.isArray(current)) {
      if (!isBoundedEvidenceCurrent(current)) return false;
    } else if (
      !isRecord(current) ||
      typeof current.supplied !== 'boolean' ||
      !isBoundedEvidenceCurrent(current.fingerprints)
    ) {
      return false;
    }
  }
  if (args.specRevision !== undefined && !isBoundedPositiveInt(args.specRevision, Number.MAX_SAFE_INTEGER))
    return false;
  if (
    args.specFingerprint !== undefined &&
    (typeof args.specFingerprint !== 'string' || args.specFingerprint.trim().length === 0)
  ) {
    return false;
  }
  if ((args.specRevision === undefined) !== (args.specFingerprint === undefined)) return false;
  if (args.replaySnapshot !== undefined && typeof args.replaySnapshot !== 'boolean') return false;
  if (args.includeDraft !== undefined && typeof args.includeDraft !== 'boolean') return false;
  if (args.evaluatorBuild !== undefined && !isRecord(args.evaluatorBuild)) return false;
  if (args.now !== undefined && (typeof args.now !== 'string' || args.now.trim().length === 0)) return false;
  // listSpecClauses is uncapped unless the evaluator narrows it through exact
  // evidence/spec selectors. Require both an explicit evidence page cap and a
  // selector so this recovery exception cannot admit the generic evaluator path.
  return ['workItemIds', 'evidenceRefs', 'specIds'].some((field) => args[field] !== undefined);
}

function isBoundedJudgeDegenerateCheckArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  for (const field of ['sinceHours', 'minDecisions']) {
    if (args[field] !== undefined && typeof args[field] !== 'number') return false;
  }
  const sinceHours = args.sinceHours;
  if (
    sinceHours !== undefined &&
    (typeof sinceHours !== 'number' ||
      !Number.isFinite(sinceHours) ||
      sinceHours <= 0 ||
      sinceHours > CRITICAL_JUDGE_AUDIT_MAX_SINCE_HOURS)
  ) {
    return false;
  }
  if (
    args.minDecisions !== undefined &&
    !isBoundedPositiveInt(args.minDecisions, CRITICAL_JUDGE_AUDIT_MAX_MIN_DECISIONS)
  ) {
    return false;
  }
  return true;
}

function isBoundedJudgeSpecEvidenceArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  if (typeof args.slug !== 'string' || args.slug.trim().length === 0) return false;
  if (args.harness !== undefined && (typeof args.harness !== 'string' || args.harness.trim().length === 0))
    return false;
  if (!isBoundedPositiveInt(args.limit, CRITICAL_JUDGE_AUDIT_MAX_ROWS)) return false;
  for (const field of ['workItemIds', 'specIds', 'sourceValIds', 'evidenceRefs']) {
    if (args[field] !== undefined && !isBoundedStringArray(args[field])) return false;
  }
  if (
    args.evidenceKinds !== undefined &&
    (!isBoundedStringArray(args.evidenceKinds, 8) || !args.evidenceKinds.every((kind) => SPEC_EVIDENCE_KINDS.has(kind)))
  ) {
    return false;
  }
  if (
    args.currentness !== undefined &&
    (!isBoundedStringArray(args.currentness, 3) ||
      !args.currentness.every((value) => value === 'current' || value === 'stale' || value === 'unknown'))
  ) {
    return false;
  }
  if (args.current !== undefined && !isBoundedEvidenceCurrent(args.current)) return false;
  const hasSelector = ['workItemIds', 'specIds', 'sourceValIds', 'evidenceKinds', 'evidenceRefs', 'currentness'].some(
    (field) => args[field] !== undefined,
  );
  return hasSelector;
}

function isBoundedScratchCapabilityReadArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const paths = [record.uri, record.file_path].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (paths.length !== 1) return false;
  const path = paths[0];
  const scratchSpill =
    path.startsWith('papercusp://scratch/') ||
    /(?:^|[/\\])\.papercusp[/\\]scratch[/\\].+\.spill$/.test(path);
  if (!scratchSpill) return false;
  if (!Number.isInteger(record.byte_offset) || (record.byte_offset as number) < 0) return false;
  if (
    !Number.isInteger(record.byte_limit) ||
    (record.byte_limit as number) < 1 ||
    (record.byte_limit as number) > CRITICAL_CAPABILITY_READ_MAX_BYTES
  ) return false;
  for (const field of ['offset', 'limit', 'tail', 'raw', 'content_indexes', 'evidence_class']) {
    if (record[field] !== undefined) return false;
  }
  return true;
}

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

/**
 * Keep the telemetry rollup available for pressure diagnosis, but require the small,
 * explicit page used by recovery callers. The handler's default limit is 100 and its
 * schema permits a 168-hour/500-row query, both of which are too broad for the critical
 * reserve. `hours` may be omitted because the handler default is the allowed 24-hour window.
 */
export function isBoundedDevTelemetryArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['workspaceIds', 'transports', 'hours', 'limit']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    !Number.isInteger(args.limit) ||
    (args.limit as number) < 1 ||
    (args.limit as number) > CRITICAL_DEV_TELEMETRY_MAX_LIMIT
  ) {
    return false;
  }
  if (
    args.hours !== undefined &&
    (!Number.isInteger(args.hours) ||
      (args.hours as number) < 1 ||
      (args.hours as number) > CRITICAL_DEV_TELEMETRY_MAX_HOURS)
  ) {
    return false;
  }
  if (args.workspaceIds !== undefined && args.workspaceIds !== null) {
    if (
      !Array.isArray(args.workspaceIds) ||
      args.workspaceIds.length > CRITICAL_DEV_TELEMETRY_MAX_WORKSPACE_IDS ||
      !args.workspaceIds.every(
        (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= CRITICAL_DEV_TELEMETRY_MAX_STRING_CHARS,
      )
    ) {
      return false;
    }
  }
  if (args.transports !== undefined && args.transports !== null) {
    if (
      !Array.isArray(args.transports) ||
      args.transports.length > DEV_TELEMETRY_TRANSPORTS.size ||
      !args.transports.every(
        (transport) => typeof transport === 'string' && DEV_TELEMETRY_TRANSPORTS.has(transport),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `scheduler:get_next` is the authoritative fleet self-pull and is already
 * reserved by the outer MCP proxy. Direct ptool/staging calls still pass
 * through this inner gate, so admit only the exact bounded request surface
 * documented by the handler: one claim, at most 500 short held paths, and the
 * two claimable states. Unknown keys are rejected rather than allowing a large
 * opaque payload to ride the critical-pressure recovery lane.
 */
function isBoundedSchedulerGetNextArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const allowed = new Set(['harness', 'heldPaths', 'states', 'rigAvailable', 'ignoreContextPressure']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  if (
    args.harness !== undefined &&
    (typeof args.harness !== 'string' ||
      args.harness.trim().length === 0 ||
      args.harness.length > CRITICAL_SCHEDULER_MAX_HARNESS_CHARS)
  ) {
    return false;
  }
  if (args.heldPaths !== undefined) {
    if (
      !Array.isArray(args.heldPaths) ||
      args.heldPaths.length > CRITICAL_SCHEDULER_MAX_HELD_PATHS ||
      !args.heldPaths.every(
        (path) => typeof path === 'string' && path.length <= CRITICAL_SCHEDULER_MAX_HELD_PATH_CHARS,
      )
    ) {
      return false;
    }
  }
  if (
    args.states !== undefined &&
    (!Array.isArray(args.states) ||
      args.states.length > 20 ||
      !args.states.every((state) => typeof state === 'string' && CRITICAL_SCHEDULER_STATES.has(state)))
  ) {
    return false;
  }
  for (const field of ['rigAvailable', 'ignoreContextPressure']) {
    if (args[field] !== undefined && typeof args[field] !== 'boolean') return false;
  }
  return true;
}

/**
 * `loop:status` is a read-only recovery probe needed to reconcile a resumed
 * fleet member, but its admission exception must still reject opaque payloads
 * before schema parsing. The handler accepts only these three owner-scoped
 * strings (plus the compatibility harness string), each capped by its tool
 * schema; an omitted arguments object is equivalent to `{}`.
 */
function isBoundedLoopStatusArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (!isRecord(args)) return false;
  const allowed = new Set(['harness', 'ownerId', 'owner']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return false;
  return ['harness', 'ownerId', 'owner'].every(
    (field) =>
      args[field] === undefined ||
      (typeof args[field] === 'string' && args[field].length <= CRITICAL_LOOP_STATUS_MAX_STRING_CHARS),
  );
}

/**
 * A single checkpoint is the smallest durable recovery write: it preserves the
 * successor state needed to resume after the pressure condition clears. Keep the
 * exemption to one identified item so a bulk checkpoint request cannot turn the
 * pressure reserve into an unbounded write lane. The checkpoint tool validates the
 * operation-specific fields and body/check-row caps after admission.
 */
function isBoundedWorkItemsCheckpointArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as { id?: unknown; items?: unknown };
  const single =
    typeof record.id === 'string' &&
    record.id.trim().length > 0 &&
    record.items === undefined;
  if (single) return true;
  if (record.id !== undefined || !Array.isArray(record.items) || record.items.length !== 1) {
    return false;
  }
  const item = record.items[0];
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as { id?: unknown }).id === 'string' &&
    ((item as { id: string }).id).trim().length > 0
  );
}

/**
 * A grading-integrity audit needs one scorecard's complete evidence while the
 * operator is under pressure. Require both selective predicates and reject a
 * deliberately wide page so this recovery exemption cannot become a history
 * export lane. The default page remains acceptable because the exact
 * rubric+subject pair is the audit's bounded identity; callers that override it
 * are capped at a small page.
 */
export function isBoundedScorecardsListArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const rubricRef = typeof record.rubricRef === 'string' && record.rubricRef.trim().length > 0;
  const subjectRef = typeof record.subjectRef === 'string' && record.subjectRef.trim().length > 0;
  if (!rubricRef || !subjectRef) return false;
  if (
    record.limit !== undefined &&
    (!Number.isInteger(record.limit) ||
      (record.limit as number) < 1 ||
      (record.limit as number) > CRITICAL_SCORECARDS_LIST_MAX_ROWS)
  ) {
    return false;
  }
  for (const field of ['sourceHive', 'harness', 'since']) {
    if (record[field] !== undefined && typeof record[field] !== 'string') return false;
  }
  for (const field of ['includeSynthesized', 'includeSuperseded', 'includeRetracted']) {
    if (record[field] !== undefined && typeof record[field] !== 'boolean') return false;
  }
  return true;
}

/**
 * `scorecards:get` is the evidence-first read used by grading-integrity audits.
 * Its handler accepts one issue id plus an optional criterion page cursor and
 * performs one bounded projection per call. Keep the critical-pressure
 * exemption tied to that paginated identity rather than the broader scorecards
 * history reader.
 */
function isBoundedScorecardsGetArgs(args: unknown): boolean {
  if (!isRecord(args)) return false;
  const keys = Object.keys(args);
  if (keys.some((key) => !['issueId', 'criterionKey', 'evidenceOffset'].includes(key))) return false;
  if (
    typeof args.issueId !== 'string' ||
    args.issueId.trim().length === 0 ||
    args.issueId.length > CRITICAL_SCORECARDS_GET_ISSUE_ID_MAX
  ) {
    return false;
  }
  if (args.criterionKey !== undefined) {
    if (
      typeof args.criterionKey !== 'string' ||
      args.criterionKey.trim().length === 0 ||
      args.criterionKey.length > 200
    ) {
      return false;
    }
  }
  if (args.evidenceOffset !== undefined) {
    if (!Number.isInteger(args.evidenceOffset) || (args.evidenceOffset as number) < 0) return false;
    // The handler cannot resume a page without knowing which criterion owns it.
    if (args.criterionKey === undefined) return false;
  }
  return true;
}

function isBoundedToolFailureString(value: unknown, max: number, required = false): value is string {
  if (value === undefined && !required) return true;
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

/**
 * Preserve the incident record for an admission shed without opening the full
 * capture surface under critical pressure. The shorthand derives its title/body
 * from one strict, field-bounded `toolFailure` object; any authored capture fields
 * remain on the ordinary pressure-shed path and can be retried after recovery.
 */
function isBoundedImprovementsCaptureArgs(args: unknown): boolean {
  if (!isRecord(args) || Object.keys(args).some((key) => key !== 'toolFailure')) return false;
  const failure = args.toolFailure;
  if (!isRecord(failure)) return false;
  if (!isBoundedToolFailureString(failure.toolName, 160, true)) return false;
  if (!isBoundedToolFailureString(failure.message, CRITICAL_TOOL_FAILURE_MESSAGE_MAX, true)) return false;
  for (const [field, max] of [
    ['errorCode', 160],
    ['schemaRevision', 160],
    ['fieldPath', 300],
    ['runtimeVersion', 160],
  ] as const) {
    if (!isBoundedToolFailureString(failure[field], max)) return false;
  }
  if (failure.status !== undefined) {
    const status = failure.status;
    if (
      !(
        (typeof status === 'string' && status.length <= 80) ||
        (typeof status === 'number' && Number.isFinite(status) && String(status).length <= 80)
      )
    ) {
      return false;
    }
  }
  for (const field of ['reproduced', 'clearServerMismatch', 'hardInternal']) {
    if (failure[field] !== undefined && typeof failure[field] !== 'boolean') return false;
  }
  if (failure.directEvidence !== undefined) {
    const evidence = failure.directEvidence;
    if (!isRecord(evidence) || Object.keys(evidence).some((key) => !['kind', 'expected', 'actual'].includes(key))) {
      return false;
    }
    if (
      typeof evidence.kind !== 'string' ||
      !TOOL_FAILURE_DIRECT_EVIDENCE_KINDS.has(evidence.kind) ||
      !isBoundedToolFailureString(evidence.expected, CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX, true) ||
      !isBoundedToolFailureString(evidence.actual, CRITICAL_TOOL_FAILURE_DIRECT_EVIDENCE_MAX, true)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A judge needs the complete criteria body from one rubric while the operator is
 * under critical pressure. Keep the exemption to a single lookup: rubrics:get
 * also accepts a bulk `rubricRefs` form whose full criteria bodies would turn the
 * recovery reserve into a history/export lane.
 */
function isBoundedRubricsGetArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const singleAliases = ['rubricRef', 'ref', 'slug', 'id'].filter(
    (field) => typeof record[field] === 'string' && (record[field] as string).trim().length > 0,
  );
  const rubricRefs = record.rubricRefs;
  const singleRubricRefs =
    Array.isArray(rubricRefs) &&
    rubricRefs.length === 1 &&
    typeof rubricRefs[0] === 'string' &&
    rubricRefs[0].trim().length > 0;
  if ((singleAliases.length === 0) === !singleRubricRefs || singleAliases.length > 1) return false;
  if (rubricRefs !== undefined && !singleRubricRefs) return false;
  if (
    record.revision !== undefined &&
    (!Number.isInteger(record.revision) || (record.revision as number) < 1)
  ) {
    return false;
  }
  if (record.harness !== undefined && typeof record.harness !== 'string') return false;
  return true;
}

/**
 * The MCP admission gate runs before the handler resolves the signed principal, so it cannot
 * inspect `ctx.principal`. The role query is still useful as a narrow routing hint here: the
 * signed-spawn verifier will reject a forged role before dispatch. Require the exact judge role
 * and the full bounded audit shape before reserving capacity for a scorecard write.
 */
function isJudgeRoleRequest(requestUrl?: string): boolean {
  if (!requestUrl) return false;
  try {
    return new URL(requestUrl, 'http://127.0.0.1').searchParams.get('role')?.trim() === 'judge';
  } catch {
    return false;
  }
}

function isBoundedJudgeGradingAuditEmitArgs(args: unknown, requestUrl?: string): boolean {
  if (!isJudgeRoleRequest(requestUrl) || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as { rubricRef?: unknown; terminal?: unknown; subject?: unknown };
  if (record.rubricRef !== 'grading-integrity' || record.terminal !== true) return false;
  if (!record.subject || typeof record.subject !== 'object' || Array.isArray(record.subject)) return false;
  const subject = record.subject as { kind?: unknown; ref?: unknown };
  return subject.kind === 'scorecard' && typeof subject.ref === 'string' && subject.ref.trim().length > 0;
}

function isCriticalPressureDiagnostic(toolName: unknown, args?: unknown, requestUrl?: string): boolean {
  if (typeof toolName !== 'string') return false;
  const normalized = normalizeMcpName(toolName);
  if (normalized === DEV_TELEMETRY_NAME) return isBoundedDevTelemetryArgs(args);
  if (normalized === SCHEDULER_GET_NEXT_NAME) return isBoundedSchedulerGetNextArgs(args);
  if (normalized === LOOP_STATUS_NAME) return isBoundedLoopStatusArgs(args);
  if (normalized === CAPABILITY_READ_NAME) return isBoundedScratchCapabilityReadArgs(args);
  if (normalized === WORK_ITEMS_CHECKPOINT_NAME) return isBoundedWorkItemsCheckpointArgs(args);
  if (normalized === SCORECARDS_LIST_NAME) return isBoundedScorecardsListArgs(args);
  if (normalized === SCORECARDS_GET_NAME) return isBoundedScorecardsGetArgs(args);
  if (normalized === SCORECARDS_EMIT_NAME) return isBoundedJudgeGradingAuditEmitArgs(args, requestUrl);
  if (normalized === RUBRICS_GET_NAME) return isBoundedRubricsGetArgs(args);
  if (normalized === IMPROVEMENTS_CAPTURE_NAME) return isBoundedImprovementsCaptureArgs(args);
  if (normalized === EVALUATE_SPEC_TEST_ADEQUACY_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeEvaluateArgs(args);
  }
  if (normalized === DEGENERATE_CHECK_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeDegenerateCheckArgs(args);
  }
  if (normalized === GET_SPEC_EVIDENCE_NAME) {
    return isJudgeRoleRequest(requestUrl) && isBoundedJudgeSpecEvidenceArgs(args);
  }
  if (!CRITICAL_PRESSURE_DIAGNOSTIC_TOOLS.has(normalized)) return false;
  return normalized !== WORK_ITEMS_GET_NAME || isBoundedWorkItemsGetArgs(args);
}

function isCriticalPressureDiagnosticCall(message: unknown, requestUrl?: string): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const params = (message as { params?: { name?: unknown; arguments?: unknown } }).params;
  if (!params || typeof params.name !== 'string') return false;
  const normalizedName = normalizeMcpName(params.name);
  if (normalizedName === TOOLS_INVOKE_NAME) {
    const invokeArgs = params.arguments;
    if (!invokeArgs || typeof invokeArgs !== 'object' || Array.isArray(invokeArgs)) return false;
    const target = (invokeArgs as { name?: unknown; args?: unknown }).name;
    return isCriticalPressureDiagnostic(target, (invokeArgs as { args?: unknown }).args, requestUrl);
  }
  return isCriticalPressureDiagnostic(params.name, params.arguments, requestUrl);
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
export function classifyMcpBody(bodyText: string, requestUrl?: string): { sheddable: boolean; id: string | number | null } {
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
      if (isCriticalPressureDiagnosticCall(m, requestUrl)) continue;
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
    if (isCriticalPressureDiagnosticCall(message, requestUrl)) diagnosticToolCall = true;
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
  return acquireMcpBodyAdmission(bodyText, req.url, pressure, enabled);
}

/** Same operator bulkhead for native protocol transports; no HTTP intermediary. */
export function acquireMcpBodyAdmission(
  bodyText: string,
  requestUrl: string,
  pressure: LoopPressure,
  enabled: boolean,
): McpAdmissionDecision {
  if (!enabled) return { response: null, lease: null, classification: 'other' };
  const classification = classifyMcpRequest(bodyText, requestUrl);
  const { sheddable, id } = classifyMcpBody(bodyText, requestUrl);
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
