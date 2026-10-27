/**
 * Live canary for the code-intel result status (code-intel-delivery-and-outcomes-2026-10-26
 * P-004, R-9).
 *
 * Every unknown-rate probe run dispatches each native code-intel tool through the REAL
 * dispatcher and the REAL recorder (`PROJECTED_DEPS`) as owner {@link CODE_INTEL_CANARY_OWNER},
 * forcing one call per exit class, then reads the recorded rows back by call id:
 *
 *   - `return`        valid args → exactly one status row of either kind;
 *   - `timeout`       the registered tool with a 1 ms dispatcher timeout → unknown / timeout;
 *   - `scope-refused` an op outside the tool's enum (refused before the handler) → unknown / scope-refused;
 *   - `cancelled`     valid args, the parent signal aborted 1 ms after dispatch → unknown / cancelled.
 *
 * Canary rows never enter the unknown share: `reconcileCodeIntelWindow` counts them apart.
 *
 * NOT forced live (listed in {@link CANARY_UNFORCED}): `index-missing`, `stale` and `partial`
 * depend on index state and payload content, and `exception` needs a throwing handler. Those
 * classes are pinned by the unit tests over `classifyCodeIntelPayload` and by the dispatch test.
 *
 * The valid args name this repository's own files, so the canary runs against the `papercusp`
 * harness ({@link CODE_INTEL_CANARY_HARNESS}).
 */
import { CODE_INTEL_UNKNOWN_REASONS, type CodeIntelResultStatus, type CodeIntelUnknownReason } from './code-intel-result-status';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption';

/** Owner id the canary dispatches as; its rows never enter the unknown share. */
export const CODE_INTEL_CANARY_OWNER = 'system:code-intel-canary';
export const CODE_INTEL_CANARY_HARNESS = 'papercusp';

export type CanaryForced = 'return' | 'timeout' | 'scope-refused' | 'cancelled';
export const CANARY_FORCED: readonly CanaryForced[] = Object.freeze(['return', 'timeout', 'scope-refused', 'cancelled']);

/** Exit classes the canary does not force live, with the reason and where they are pinned. */
export const CANARY_UNFORCED = Object.freeze([
  { reason: 'index-missing', why: 'depends on the index being absent; pinned by classifyCodeIntelPayload unit tests' },
  { reason: 'stale', why: 'depends on index freshness at call time; pinned by classifyCodeIntelPayload unit tests' },
  { reason: 'partial', why: 'depends on payload content; pinned by classifyCodeIntelPayload unit tests' },
  { reason: 'exception', why: 'needs a throwing handler; pinned by code-intel-result-status.dispatch.test.ts' },
] as const);

const ANCHOR = 'packages/operator-core/lib/code-intelligence/code-intel-result-status.ts';
/** One valid, cheap call per native tool. A native tool missing here fails `canaryCases()`. */
export const CANARY_VALID_ARGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  'graph:query': { op: 'callers', name: 'classifyCodeIntelExit', paths: [ANCHOR], limit: 5 },
  'lsp:query': { op: 'workspace_symbols', name: 'classifyCodeIntelExit', file: ANCHOR },
  'code:pack': { op: 'pack', include: [ANCHOR] },
});
export const CANARY_INVALID_OP = '__code_intel_canary_invalid_op__';
/** Dispatcher timeout for the forced-timeout call (seconds). */
export const CANARY_TIMEOUT_SEC = 0.001;
/** Delay before the forced-cancellation abort (ms). */
export const CANARY_ABORT_AFTER_MS = 1;

export interface CanaryCaseSpec {
  readonly toolName: string;
  readonly forced: CanaryForced;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutSec?: number;
  readonly abortAfterMs?: number;
}

/** Every native tool × every forced class. Throws when a native tool has no valid args. */
export function canaryCases(tools: readonly string[] = NATIVE_CODE_INTEL_TOOLS): CanaryCaseSpec[] {
  const cases: CanaryCaseSpec[] = [];
  for (const toolName of tools) {
    const args = CANARY_VALID_ARGS[toolName];
    if (!args) throw new Error(`code-intel canary has no valid args for native tool ${toolName}`);
    cases.push({ toolName, forced: 'return', args });
    cases.push({ toolName, forced: 'timeout', args, timeoutSec: CANARY_TIMEOUT_SEC });
    cases.push({ toolName, forced: 'scope-refused', args: { ...args, op: CANARY_INVALID_OP } });
    cases.push({ toolName, forced: 'cancelled', args, abortAfterMs: CANARY_ABORT_AFTER_MS });
  }
  return cases;
}

export interface CanaryRow {
  readonly toolName: string;
  readonly ownerId: string | null;
  /** The raw `metadata_json.codeIntelResult`. */
  readonly status: unknown;
}

export interface CanaryCaseResult {
  readonly toolName: string;
  readonly forced: CanaryForced;
  readonly callId: string | null;
  readonly statusRows: number;
  readonly recorded: CodeIntelResultStatus | null;
  readonly ok: boolean;
  readonly why?: string;
}

export interface CanaryJudgement {
  readonly ok: boolean;
  readonly cases: readonly CanaryCaseResult[];
  readonly failed: number;
  readonly unforced: typeof CANARY_UNFORCED;
}

function parseStatus(raw: unknown): CodeIntelResultStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const invocationId = typeof r.invocationId === 'string' ? r.invocationId : null;
  if (r.status === 'measured') return { status: 'measured', invocationId };
  if (r.status === 'unknown' && (CODE_INTEL_UNKNOWN_REASONS as readonly unknown[]).includes(r.reason)) {
    return { status: 'unknown', reason: r.reason as CodeIntelUnknownReason, invocationId };
  }
  return null;
}

/** Judge each dispatched case against the rows recorded for its call id. */
export function judgeCanary(
  dispatched: ReadonlyArray<{ readonly spec: CanaryCaseSpec; readonly callId: string | null }>,
  rows: readonly CanaryRow[],
): CanaryJudgement {
  const byCall = new Map<string, CanaryRow[]>();
  for (const row of rows) {
    if (row.ownerId !== CODE_INTEL_CANARY_OWNER) continue;
    const id = parseStatus(row.status)?.invocationId
      ?? (row.status && typeof row.status === 'object' ? (row.status as { invocationId?: unknown }).invocationId : null);
    if (typeof id !== 'string') continue;
    byCall.set(id, [...(byCall.get(id) ?? []), row]);
  }
  const cases = dispatched.map(({ spec, callId }): CanaryCaseResult => {
    const base = { toolName: spec.toolName, forced: spec.forced, callId };
    if (!callId) return { ...base, statusRows: 0, recorded: null, ok: false, why: 'dispatch never started (no call id)' };
    const mine = (byCall.get(callId) ?? []).filter(r => r.toolName === spec.toolName);
    const recorded = mine.length === 1 ? parseStatus(mine[0]!.status) : null;
    if (mine.length !== 1) return { ...base, statusRows: mine.length, recorded, ok: false, why: `expected exactly 1 status row, found ${mine.length}` };
    if (!recorded) return { ...base, statusRows: 1, recorded, ok: false, why: 'status row is unparseable or carries a reason outside the set' };
    if (spec.forced === 'return') return { ...base, statusRows: 1, recorded, ok: true };
    const ok = recorded.status === 'unknown' && recorded.reason === spec.forced;
    const got = recorded.status === 'unknown' ? `unknown/${recorded.reason}` : 'measured';
    return { ...base, statusRows: 1, recorded, ok, ...(ok ? {} : { why: `expected unknown/${spec.forced}, recorded ${got}` }) };
  });
  const failed = cases.filter(c => !c.ok).length;
  return { ok: cases.length > 0 && failed === 0, cases, failed, unforced: CANARY_UNFORCED };
}

export interface CanaryDeps {
  dispatch(spec: CanaryCaseSpec): Promise<{ callId: string | null }>;
  /** Wait for queued invocation records to land. */
  flush(): Promise<void>;
  readRows(since: string): Promise<CanaryRow[]>;
  now?(): number;
}

/** Dispatch every case sequentially, flush the recorder, read back, judge. */
export async function runCodeIntelCanary(deps: CanaryDeps, cases: readonly CanaryCaseSpec[] = canaryCases()): Promise<CanaryJudgement> {
  // Back off one second so a row stamped at the same instant is never missed.
  const since = new Date((deps.now?.() ?? Date.now()) - 1_000).toISOString();
  const dispatched: Array<{ spec: CanaryCaseSpec; callId: string | null }> = [];
  for (const spec of cases) {
    try {
      dispatched.push({ spec, callId: (await deps.dispatch(spec)).callId });
    } catch {
      dispatched.push({ spec, callId: null });
    }
  }
  await deps.flush();
  return judgeCanary(dispatched, await deps.readRows(since));
}

/**
 * Real deps: the registered tool, `dispatchProjectedTool`, and `PROJECTED_DEPS` (the recorder
 * production uses), as owner {@link CODE_INTEL_CANARY_OWNER}.
 */
export async function realCanaryDeps(workspaceId: string, harnessSlug: string = CODE_INTEL_CANARY_HARNESS): Promise<CanaryDeps> {
  await Promise.all([import('../agent-tools/gitnexus/query'), import('../agent-tools/lsp/query'), import('../agent-tools/lsp/pack')]);
  const [{ dispatchProjectedTool, lookupByMcpName }, { PROJECTED_DEPS, flushPendingTelemetry }, { getOrgPg }] = await Promise.all([
    import('@papercusp/tooldef'), import('../projected-tool-deps'), import('@papercusp/db-org'),
  ]);
  return {
    dispatch: async spec => {
      const tool = lookupByMcpName(spec.toolName);
      if (!tool) throw new Error(`native tool ${spec.toolName} is not registered`);
      const effective = spec.timeoutSec === undefined ? tool : { ...tool, timeoutSec: spec.timeoutSec };
      const controller = new AbortController();
      const ctx = {
        workspaceId,
        harnessSlug,
        role: 'operator',
        uiClientId: null,
        isSuperuser: false,
        isPowerUser: false,
        userId: null,
        principal: { kind: 'system', slug: CODE_INTEL_CANARY_OWNER, workspaceId },
        transport: 'in_process',
        signal: controller.signal,
        log: () => {},
      };
      let callId: string | null = null;
      const timer = spec.abortAfterMs === undefined
        ? null
        : setTimeout(() => controller.abort(new Error('code-intel canary forced cancellation')), spec.abortAfterMs);
      try {
        await dispatchProjectedTool(effective, spec.toolName, { ...spec.args }, ctx as never, {
          ...PROJECTED_DEPS,
          onDispatchStart: event => {
            callId = event.callId ?? null;
            PROJECTED_DEPS.onDispatchStart?.(event);
          },
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { callId };
    },
    flush: () => flushPendingTelemetry(),
    readRows: async since => {
      const sql = getOrgPg().sql as unknown as { unsafe(q: string, p: unknown[]): Promise<unknown[]> };
      const rows = (await sql.unsafe(
        `SELECT tool_name, coord_owner_id, metadata_json->'codeIntelResult' AS status
           FROM harness_shared.tool_invocations
          WHERE workspace_id = $1 AND coord_owner_id = $2 AND tool_name = ANY($3::text[])
            AND invoked_at >= $4::timestamptz`,
        [workspaceId, CODE_INTEL_CANARY_OWNER, [...NATIVE_CODE_INTEL_TOOLS], since],
      )) as Array<{ tool_name: string; coord_owner_id: string | null; status: unknown }>;
      return rows.map(r => ({ toolName: r.tool_name, ownerId: r.coord_owner_id, status: r.status }));
    },
  };
}
