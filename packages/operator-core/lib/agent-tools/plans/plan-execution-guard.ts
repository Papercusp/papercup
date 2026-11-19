/** EI-27540173897381380: plan readiness also binds direct implementation writes. */
import { createRequire } from 'node:module';
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspace } from '../../workspace-als';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { parsePlan } from './parser';
import { getPlanRow } from './source';
import { planExecutionMeaning } from './plan-execution-meaning';
import { withBoundedTimeout } from '../../bounded-timeout';
import type { ResolvedGoal } from '../../agent-goal-ref';
import type { AcceptanceBarSnapshotSource } from '../../acceptance-bar-contract-snapshot';
import type { Sql } from 'postgres';
import { parseExecutionPlanRebind } from '../fleet_registry/execution-plan-rebind';
import { PLAN_READINESS_PENDING, READINESS_PENDING_RETRY_AFTER_MS } from './plan-continuation-readiness';
export { planExecutionMeaning } from './plan-execution-meaning';

// The installed parser has no bundled declarations. Treat its tokens as unknown
// and validate the small token vocabulary this read-only boundary accepts.
const parseShell: (command: string) => unknown[] = createRequire(import.meta.url)('shell-quote').parse;

export type ExecutionPlanBindingSource =
  | 'session-brief'
  | 'control-state'
  | 'active-session'
  | 'session-rebind'
  | 'plan-item-claim'
  | 'work-item';
export interface ExecutionPlanBinding {
  planSlug: string;
  harnessSlug: string | null;
  source?: ExecutionPlanBindingSource;
  sourceRef?: string | null;
  canonical?: { itemId: string; lineId: string; ownerId: string; nodeVersion: string; lineVersion: string; planVersion: number; planHash: string };
  canonicalInvalid?: boolean;
  /**
   * WI-6554700010049338: a held work-item with no plan at all. It is a census
   * member (so the goal selector can attribute a write to it) but is never
   * checked itself: it binds no plan, so it grants and refuses nothing.
   */
  unbound?: boolean;
}
export interface PlanExecutionRefusal {
  code: 'plan_execution_not_ready';
  reason: string;
  planSlug?: string;
  blockers: string[];
  /**
   * EI-28849154189042602: set only when no verdict was reached within the admission
   * budget (`plan_readiness_pending`). Nothing is known to be wrong with the plan; the
   * same call should be retried after `retryAfterMs` while the evaluation finishes.
   */
  retryable?: true;
  retryAfterMs?: number;
}
export interface PlanExecutionGuardInput {
  ownerId: string; workspaceId: string; toolName: string; args: unknown;
  observeTiming?: PlanExecutionTimingObserver;
  /** Native port's monotonic deadline; ordinary MCP checks retain their standard budget. */
  readinessDeadlineAtMs?: number;
}
export interface PlanExecutionTiming { stage: string; durationMs: number }
export type PlanExecutionTimingObserver = (timing: PlanExecutionTiming) => void;

/** Diagnostics must never grant, refuse, or interrupt an authority check. */
async function measurePlanStage<T>(stage: string, observe: PlanExecutionTimingObserver | undefined,
  read: () => Promise<T>): Promise<T> {
  if (!observe) return read();
  const startedAt = performance.now();
  try { return await read(); } finally {
    try { observe({ stage, durationMs: performance.now() - startedAt }); } catch { /* diagnostics only */ }
  }
}

/** Fixed input-free labels for the canonical reader's existing measurements. */
const planRowTimingStages = {
  'source.resolveScope': 'plan_row_resolve_scope',
  'source.waitForBegin': 'plan_row_wait_for_begin',
  'source.workspaceSetup': 'plan_row_workspace_setup',
  'source.acquireAndSetup': 'plan_row_acquire_and_setup',
  'source.query': 'plan_row_query',
  'source.finishTransaction': 'plan_row_finish_transaction',
  'source.row': 'plan_row_row',
} as const;

function readTimedPlanRow(slug: string, opts: Parameters<typeof getPlanRow>[1],
  observe: PlanExecutionTimingObserver | undefined): ReturnType<typeof getPlanRow> {
  return measurePlanStage('plan_row', observe, async () => {
    if (!observe) return getPlanRow(slug, opts);
    const timings: Record<string, number> = {};
    try { return await getPlanRow(slug, opts, timings); } finally {
      for (const [source, stage] of Object.entries(planRowTimingStages)) {
        const durationMs = timings[source];
        if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) continue;
        try { observe({ stage, durationMs }); } catch { /* diagnostics only */ }
      }
    }
  });
}

/** Settle concurrent reads before interpreting them in the original refusal order. */
function settledPlanValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
export interface ExecutionPlanGoalResolution {
  goal: ResolvedGoal | null;
  diagnostics: readonly unknown[];
}
export interface PlanExecutionGuardDeps {
  readBindings: (ownerId: string, workspaceId: string) => Promise<ExecutionPlanBinding[]>;
  resolveGoal?: (ownerId: string, workspaceId: string, observe?: PlanExecutionTimingObserver,
    signal?: AbortSignal) => Promise<ExecutionPlanGoalResolution>;
  checkPlan: (binding: ExecutionPlanBinding, workspaceId: string, observe?: PlanExecutionTimingObserver,
    readinessDeadlineAtMs?: number) => Promise<string[]>;
  /** Test seam for the bounded selector path; production uses the fixed 650ms budget. */
  goalResolutionBudgetMs?: number;
}

const GOAL_RESOLUTION_BUDGET_MS = 650;

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'apply_patch', 'lsp:apply', 'capability:edit',
  'capability:write', 'locks:acquire', 'locks:acquire_granular']);
const shellTools = new Set(['Bash', 'bash', 'exec_command', 'shell_command', 'shell', 'capability:bash']);
const executionTools = new Set(['code:run', 'capability:terminal', 'capability:git', 'templates:new-app',
  'capability:launch-agent', 'fleet:launch-on-plan', 'plans:launch', 'plans:run-now', 'plans:arm-schedule']);
const readCommands = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'readlink', 'realpath', 'sed']);

function hasActiveShellExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (!next) return true;
      if (quote !== '"' || /["\\$`]/.test(next)) i++;
      continue;
    }
    if (char === "'" && quote === null) quote = "'";
    else if (char === '"') quote = quote === '"' ? null : '"';
    else if (char === '$' || char === '`') return true;
  }
  return quote !== null;
}

/** A deliberately small read-only shell subset; arbitrary interpreters require activation. */
export function isPlanResearchCommand(command: unknown): boolean {
  if (isPlanCanonicalReadCommand(command)) return true;
  // Native exec batches independent reads with newlines. Check each complete
  // line instead of letting shell-quote merge a later command into file args.
  // Unfinished quotes, continuations and any mutating line still fail closed.
  if (typeof command === 'string' && command.includes('\n')) {
    const lines = command.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim());
    return lines.length > 0 && lines.every(line => isPlanResearchCommand(line));
  }
  // Single-quoted constants such as sed's '$p' do not expand in the shell.
  if (typeof command !== 'string' || /[\n\r]/.test(command) || hasActiveShellExpansion(command)) return false;
  try {
    const tokens = parseShell(command);
    const invocations: string[][] = [];
    let current: string[] = [];
    for (const token of tokens) {
      if (typeof token === 'string') {
        current.push(token);
        continue;
      }
      // Filename globs are argument data. A literal prefix prevents expansion
      // into leading options; command names and external hooks stay restricted.
      if (token && typeof token === 'object' && 'op' in token && token.op === 'glob'
        && 'pattern' in token && typeof token.pattern === 'string'
        && /^[A-Za-z0-9_./]/.test(token.pattern) && current.length > 0) {
        current.push(token.pattern);
        continue;
      }
      if (token && typeof token === 'object' && 'op' in token && typeof token.op === 'string'
        && ['|', '&&', ';'].includes(token.op) && current.length > 0) {
        invocations.push(current);
        current = [];
        continue;
      }
      return false;
    }
    if (current.length === 0) return false;
    invocations.push(current);
    return invocations.every(isReadOnlyPlanResearchInvocation);
  } catch { return false; }
}

function isReadOnlyPlanResearchInvocation(tokens: readonly string[]): boolean {
  const [tool, ...args] = tokens;
  if (tool === 'git') return isReadOnlyGitIdentity(args);
  if (!tool || !readCommands.has(tool)) return false;
  if (args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) return false;
  if (tool !== 'sed') return true;
  if (args.length < 3 || args[0] !== '-n' ||
      !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1] ?? '')) return false;
  const inputFiles = args.slice(2);
  return inputFiles.length > 0 && inputFiles.every(arg => arg.length > 0 && !arg.startsWith('-'));
}

/** Object identity only: no aliases, configuration, external diff/pager or writes. */
function isReadOnlyGitIdentity(input: readonly string[]): boolean {
  const args = [...input];
  if (args[0] === '-C') {
    if (!args[1]?.startsWith('/') || /[\r\n]/.test(args[1])) return false;
    args.splice(0, 2);
  }
  if (args[0] === 'rev-parse' && args.length === 2 && args[1] === '--show-toplevel') return true;
  if (args[0] === 'branch' && args.length === 2 && args[1] === '--show-current') return true;
  if (args[0] === 'cat-file' && args.length === 3 && ['-t', '-e'].includes(args[1]!))
    return /^[a-f0-9]{7,40}(?:\^\{commit\})?$/.test(args[2]!);
  if (args[0] !== 'rev-parse' || args[1] !== '--verify') return false;
  const ref = args[2] === '--end-of-options' && args.length === 4 ? args[3] : args.length === 3 ? args[2] : undefined;
  return typeof ref === 'string' && /^[a-f0-9]{7,40}\^\{commit\}$/.test(ref);
}

const readOnlyPtoolTools = new Set([
  'tools:find', 'plans:get', 'plans:get-input-schema', 'plans:items', 'work_items:get', 'reports:get',
  'plans:evaluate-spec-quality',
  'consult:get_feedback', 'conversations:get', 'coord:inbox', 'coord:read', 'docs:get', 'docs:search',
  'sessions:read', 'sessions:search', 'plans:revisions', 'plans:revision-transcript',
  'journal:push-utilization', 'facts:list', 'capability:read',
  'plans:get-specs', 'plans:get-spec-evidence', 'plans:get-item', 'recipes:search',
  'rubrics:get', 'rubrics:list', 'rubrics:search', 'rubrics:amend-status', 'scorecards:get', 'processes:list',
]);

// These canonical handlers retain their own authorization, custody and content
// checks. Their quoted CLI routes must be usable to establish plan readiness,
// just like direct tool calls; none grants implementation or new autonomy.
const readinessControlPtoolTools = new Set([
  'consult:reply', 'consult:decline', 'plans:start', 'plans:audit', 'plans:set-content',
  'coord:send', 'coord:declare-intent', 'work_items:checkpoint', 'work_items:comment',
  'work_items:release', 'work_items:link', 'loop:checkpoint',
  'scorecards:repair',
  'plans:edit', 'plans:set-specs', 'plans:migrate-acceptance-bars', 'rubrics:amend',
]);

/**
 * Recognize one maintained CLI JSON call with a quoted heredoc. The grading
 * brief also prescribes the exact Node helper for a pinned evaluator whose MCP
 * connection has closed. Neither form may depend on that failed endpoint for
 * execution authority before an already-allowed read/control call can recover it.
 * The body is inert data; both forms use the same narrow target allowlists.
 */
function canonicalJsonHeredocCall(command: unknown): { name: string; args: Record<string, unknown> } | null {
  if (typeof command !== 'string' || command.length > 32_768 || command.includes('\0')) return null;
  const normalized = command.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) return null;
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3) return null;

  const header = lines.shift()!;
  const closingDelimiter = lines.pop()!;
  const match = /^(.*?)[ \t]+<<'([A-Za-z_][A-Za-z0-9_]*)'[ \t]*$/.exec(header);
  if (!match || closingDelimiter !== match[2] || lines.includes(match[2]!)) return null;

  // Only the documented, double-quoted scope references are inert header
  // inputs. The CLI/tool still validates their effective scope; never evaluate
  // an expansion here. Wrong variables and every other expansion remain invalid.
  const literalHeader = match[1]!
    // Suppressing CLI diagnostics does not turn a typed read/repair into an
    // implementation write. Every other redirection remains outside this door.
    .replace(/(^|[ \t])2>\/dev\/null(?=[ \t]|$)/, '$1')
    .replace(/(^|[ \t])--workspace="\$(?:PAPERCUSP_WORKSPACE|\{PAPERCUSP_WORKSPACE\})"(?=[ \t]|$)/g, '$1--workspace=scope')
    .replace(/(^|[ \t])--harness="\$(?:PAPERCUSP_HARNESS_SLUG|\{PAPERCUSP_HARNESS_SLUG\})"(?=[ \t]|$)/g, '$1--harness=scope');
  // Validate complete, balanced shell words before parsing: shell-quote is
  // permissive about unfinished quotes. No other expansions, comments or
  // operators belong here; the quoted JSON body remains inert data.
  // Consume one lexical chunk at a time. An anchored repetition of these
  // variable-length alternatives backtracks exponentially on malformed input.
  const headerWords = /[A-Za-z0-9_./:=\[\]-]+|'[A-Za-z0-9_./:=\[\]-]*'|"[A-Za-z0-9_./:=\[\]-]*"|[ \t]+/y;
  while (headerWords.lastIndex < literalHeader.length) {
    if (!headerWords.exec(literalHeader)) return null;
  }
  let words: string[];
  try {
    const tokens = parseShell(literalHeader);
    if (tokens.some(token => typeof token !== 'string')) return null;
    words = tokens as string[];
  } catch { return null; }
  const nodeHelper = words[0] === 'node' && words[1] === 'scripts/mcp-call.mjs';
  if (!nodeHelper && words[0] !== 'ptool') return null;
  const valueFlags = nodeHelper
    ? new Set(['--json', '--workspace', '--harness', '--port', '--idempotency-key'])
    : new Set(['--json', '--workspace', '--harness', '--url', '--idempotency-key']);
  let verb: string | null = null;
  const flags = new Set<string>();
  // Both maintained CLIs accept value flags before or after the verb.
  // A transport idempotency key identifies a replay; it never authorizes the
  // target verb, which is still classified below and checked by its handler.
  for (let index = nodeHelper ? 2 : 1; index < words.length; index++) {
    const token = words[index]!;
    if (!token.startsWith('--')) {
      if (verb !== null || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(token)) return null;
      verb = token;
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (!valueFlags.has(flag) || flags.has(flag)) return null;
    const value = equals < 0 ? words[++index] : token.slice(equals + 1);
    if (value === undefined) return null;
    flags.add(flag);
    if (flag === '--json') {
      if (value !== '-') return null;
    } else if (flag === '--port') {
      // Match the helper's existing TCP-port contract without accepting an
      // alternate host, identity override, Node option or shell expansion.
      if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) return null;
    } else if (flag === '--idempotency-key') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) return null;
    } else if (flag === '--url') {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.pathname !== '/' || url.search || url.hash
          || url.port === '0') return null;
      } catch { return null; }
    } else if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  }
  if (!verb || !flags.has('--json')) return null;

  try {
    const payload: unknown = JSON.parse(lines.join('\n'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (verb !== 'tools:invoke') return { name: verb, args: payload as Record<string, unknown> };
    const nested = payload as Record<string, unknown>;
    if (Object.keys(nested).some(key => !['name', 'args', 'projection'].includes(key))) return null;
    return typeof nested.name === 'string' && nested.args && typeof nested.args === 'object' && !Array.isArray(nested.args)
      ? { name: nested.name, args: nested.args as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

function isPlanCanonicalReadCommand(command: unknown): boolean {
  const call = canonicalJsonHeredocCall(command);
  return call !== null && (readOnlyPtoolTools.has(call.name) ||
    (call.name === 'scorecards:evaluate' && call.args.eligibilityOnly === true));
}

function isPlanCanonicalControlCommand(command: unknown): boolean {
  const call = canonicalJsonHeredocCall(command);
  const reconcile = call?.args.reconcile;
  // plans:audit is a canonical plan-control operation; its handler owns audit
  // evidence validation and any activation transition. It does not grant code
  // execution, which remains behind the implementation readiness check.
  // Spec-quality persistence establishes readiness. Other scorecard emits can
  // run rubric checks, so they remain implementation; eligibilityOnly above
  // returns before grading and its handler rejects incompatible inputs.
  // Acceptance-rubric creation establishes the completion contract. Its handler
  // retains subject, criterion and vetting checks; standard proposals and
  // ratification remain outside this readiness route.
  // Evidence-based park reconciliation can be the remaining prerequisite to
  // start. Its handler retains sign-off, assignment, fingerprint CAS and audit
  // checks; bare hold/clear and force routes remain implementation operations.
  return call !== null && (readinessControlPtoolTools.has(call.name) ||
    (call.name === 'rubrics:propose' && call.args.kind === 'acceptance') ||
    (call.name === 'work_items:hold_open' && call.args.clear === true &&
      (call.args.force === undefined || call.args.force === false) &&
      reconcile !== null && typeof reconcile === 'object' && !Array.isArray(reconcile)) ||
    (call.name === 'scorecards:emit' && call.args.rubricRef === 'spec-quality'));
}

export function isPlanImplementationCall(toolName: string, args: unknown): boolean {
  const name = toolName.replace(/^functions\./, '').replace(/^mcp__.+?__/, '').replace(/^capability_/, 'capability:')
    .replace(/^lsp_/, 'lsp:');
  if (name === 'write_stdin') {
    const chars = (args as { chars?: unknown } | null)?.chars;
    return typeof chars === 'string' && chars.length > 0;
  }
  if (fileTools.has(name) || executionTools.has(name)) return true;
  if (!shellTools.has(name)) return false;
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = input.command ?? input.cmd;
  return !isPlanResearchCommand(command) &&
    !isPlanCanonicalReadCommand(command) &&
    !isPlanCanonicalControlCommand(command);
}

/** Read durable authority, never coord_presence or caller-supplied plan/force/purpose. */
export async function readExecutionPlanBindings(ownerId: string, workspaceId: string): Promise<ExecutionPlanBinding[]> {
  const { sql } = getOrgPg();
  type CensusRow = {
    plan_slug: string | null;
    harness_slug: string | null;
    source: ExecutionPlanBindingSource;
    source_ref: string | null;
  };
  type HeldRow = { feature_id: string; harness_slug: string; source_plan_slug: string | null;
    plan_slug: string | null; plan_line_id: string | null };
  // These inputs form one authority census. A single statement both avoids
  // three serial native-hook round trips and keeps the rebind, session lane,
  // claims and held work on the same database snapshot. Canonical witnesses
  // below and their final revision rechecks remain fresh.
  const snapshots = await sql<Array<{ rebind: unknown; bindings: CensusRow[]; held: HeldRow[] }>>`
    WITH brief AS MATERIALIZED (
      SELECT current_plan_slug,harness_slug,control_state FROM harness_shared.session_briefs
       WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}
    ), bindings AS (
      SELECT current_plan_slug AS plan_slug,harness_slug,'session-brief'::text AS source,
             current_plan_slug AS source_ref FROM brief WHERE current_plan_slug IS NOT NULL
      UNION ALL
      SELECT control_state #>> '{scope,plan}',control_state #>> '{scope,harness}',
             'control-state'::text,control_state #>> '{scope,plan}' FROM brief
       WHERE control_state #>> '{scope,plan}' IS NOT NULL
      UNION ALL
      SELECT plan_slug,NULL::text,'active-session'::text,plan_slug FROM harness_shared.adv_sessions
       WHERE coord_owner_id=${ownerId} AND workspace_id=${workspaceId} AND plan_slug IS NOT NULL AND ended_at IS NULL
      UNION ALL
      SELECT plan_slug,harness_slug,'plan-item-claim'::text,plan_slug || '#' || item_id
        FROM harness_shared.plan_item_claims WHERE owner=${ownerId} AND workspace_id=${workspaceId}
    ), held AS (
      SELECT feature_id,harness_slug,source_plan_slug,plan_slug,plan_line_id FROM harness_shared.work_items
       WHERE workspace_id=${workspaceId} AND taken_by=${ownerId}
         AND NOT(status=ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
    )
    SELECT (SELECT control_state #> '{lifecycle,executionPlanBinding}' FROM brief LIMIT 1) AS rebind,
           COALESCE((SELECT jsonb_agg(b) FROM bindings b),'[]'::jsonb) AS bindings,
           COALESCE((SELECT jsonb_agg(h) FROM held h),'[]'::jsonb) AS held`;
  if (snapshots.length !== 1) throw new Error('execution_plan_snapshot_unavailable');
  const { bindings: rows, held } = snapshots[0];
  const rebind = parseExecutionPlanRebind(snapshots[0].rebind, ownerId);
  const displaced = new Set([rebind?.previousPlanSlug, ...(rebind?.supersededPlanSlugs ?? [])]);
  const bindings: ExecutionPlanBinding[] = rows.filter(row =>
    (!rebind || row.source !== 'active-session' || !displaced.has(row.plan_slug)) &&
    typeof row.plan_slug === 'string' && row.plan_slug.trim())
    .map(row => ({
      planSlug: row.plan_slug!,
      harnessSlug: row.harness_slug,
      source: row.source,
      sourceRef: row.source_ref,
    }));
  if (rebind?.planSlug) bindings.push({ planSlug: rebind.planSlug, harnessSlug: rebind.harness,
    source: 'session-rebind', sourceRef: rebind.workItemId });
  for (const row of held) {
    // Only truly absent canonical fields permit historical source fallback.
    if (row.plan_slug === null && row.plan_line_id === null) {
      if (row.source_plan_slug) bindings.push({ planSlug: row.source_plan_slug, harnessSlug: row.harness_slug,
        source: 'work-item', sourceRef: row.feature_id });
      // Plan-less held work is visible to goal attribution (WI-6554700010049338).
      else bindings.push({ planSlug: '', harnessSlug: row.harness_slug, source: 'work-item',
        sourceRef: row.feature_id, unbound: true });
      continue;
    }
    const binding: ExecutionPlanBinding = { planSlug: row.plan_slug ?? '', harnessSlug: row.harness_slug,
      source: 'work-item', sourceRef: row.feature_id };
    const canonical = await readCanonicalExecutionIdentity(sql, workspaceId, binding, row.plan_line_id, ownerId);
    if (!canonical) binding.canonicalInvalid = true;
    else binding.canonical = canonical;
    bindings.push(binding);
  }
  return bindings;
}

/** Exact index/graph back-mapping from one snapshot, without loading dependency edges. */
async function readCanonicalExecutionIdentity(sql: Sql, workspaceId: string, binding: ExecutionPlanBinding,
  lineId: string | null, ownerId: string): Promise<ExecutionPlanBinding['canonical'] | null> {
  if (!binding.planSlug?.trim() || !lineId?.trim() || !binding.harnessSlug || !binding.sourceRef) return null;
  const [{claimHoldExclusionSql},{admissionHoldExclusionSql}] = await Promise.all([
    import('../../work-items'),import('../../work-items-admission')]);
  // The join cardinality retains the exact-one plan/index checks. The scoped
  // counts retain both directions of the canonical line/work-item mapping,
  // including duplicates owned or held by someone else. Read all version
  // witnesses in the same statement so no torn intermediate identity is issued.
  const rows = await sql<Array<{ node_version: string; line_version: string;
    plan_version: number; content_hash: string; held: boolean }>>`
    SELECT wi.xmin::text AS node_version, i.xmin::text AS line_version,
      p.version AS plan_version, p.content_hash,
      NOT ((${claimHoldExclusionSql(sql,'wi.payload')}) AND (${admissionHoldExclusionSql(sql,'wi.payload')})) AS held
      FROM harness_shared.harness_plans p
      JOIN harness_shared.plan_items i ON i.workspace_id=p.workspace_id
        AND i.harness_slug=p.harness_slug AND i.plan_slug=p.plan_slug AND i.item_id=${lineId}
      JOIN harness_shared.work_items wi ON wi.workspace_id=p.workspace_id
        AND wi.harness_slug=p.harness_slug AND wi.plan_slug=p.plan_slug
        AND wi.plan_line_id=${lineId} AND wi.feature_id=${binding.sourceRef} AND wi.taken_by=${ownerId}
      WHERE p.workspace_id=${workspaceId} AND p.harness_slug=${binding.harnessSlug} AND p.plan_slug=${binding.planSlug}
        AND (SELECT count(*) FROM harness_shared.work_items other
          WHERE other.workspace_id=p.workspace_id AND other.harness_slug=p.harness_slug
            AND other.plan_slug=p.plan_slug AND other.plan_line_id=${lineId})=1
        AND (SELECT count(*) FROM harness_shared.work_items other
          WHERE other.workspace_id=p.workspace_id AND other.harness_slug=p.harness_slug
            AND other.plan_slug=p.plan_slug AND other.plan_line_id IS NOT NULL
            AND other.feature_id=${binding.sourceRef})=1`;
  if (rows.length !== 1 || rows[0].held) return null;
  return { itemId: binding.sourceRef,lineId,ownerId,nodeVersion:rows[0].node_version,lineVersion:rows[0].line_version,
    planVersion:Number(rows[0].plan_version),planHash:rows[0].content_hash };
}

/** Names the held items a refused write may really be for, and how to attribute it. */
export function otherHeldWorkRemedy(bindings: readonly ExecutionPlanBinding[], refusedPlanSlug: string): string {
  const refs = [...new Set(bindings.filter(binding => binding.source === 'work-item' && binding.sourceRef &&
    (binding.unbound || binding.planSlug !== refusedPlanSlug)).map(binding => binding.sourceRef!))].sort();
  if (!refs.length) return '';
  const override = JSON.stringify({ scope: 'owner', key: 'goal.override', body: '<id>', ttlSec: 3600 });
  return ` You also hold ${refs.join(', ')}. If this write is for one of them, select that held item as your execution goal `
    + `(facts:assert ${override}) and retry; writes for '${refusedPlanSlug}' stay refused until it starts.`;
}

function uniquePlanBindings(bindings: readonly ExecutionPlanBinding[]): ExecutionPlanBinding[] {
  const unique = new Map<string, ExecutionPlanBinding>();
  for (const binding of bindings) {
    // Unbound held work binds no plan; only plan bindings are checked.
    if (binding.unbound) continue;
    const ownsLane = binding.source === 'work-item' || binding.source === 'plan-item-claim';
    const key = JSON.stringify([binding.planSlug, binding.harnessSlug,
      ownsLane || binding.canonical || binding.canonicalInvalid ? binding.sourceRef : null]);
    unique.set(key, ownsLane || binding.canonical || binding.canonicalInvalid ? { ...binding }
      : { planSlug: binding.planSlug, harnessSlug: binding.harnessSlug });
  }
  return [...unique.values()];
}

/**
 * WI-6554700010048224: true when every binding names ONE plan. A single plan reached
 * through several sources dedupes to several bindings: a NULL-harness session row,
 * a harness-scoped claim, and a canonical work item keyed by its own id. Goal
 * selection can only narrow the census, and the full set is checked when it is
 * skipped, so skipping it there grants nothing. Counting bindings instead of plans
 * sent every ordinary single-plan executor through the bounded selector, and its
 * timeout refused all of their implementation writes.
 */
function namesSinglePlan(bindings: readonly ExecutionPlanBinding[]): boolean {
  const slugs = new Set(bindings.map(binding => binding.planSlug));
  const harnesses = new Set(bindings.map(binding => binding.harnessSlug)
    .filter((harness): harness is string => Boolean(harness)));
  return slugs.size === 1 && harnesses.size <= 1;
}

/** Narrow enforcement by source identity only when the resolver and binding census agree. */
export function selectExecutionPlanBindings(
  bindings: readonly ExecutionPlanBinding[],
  goal: ResolvedGoal | null,
): ExecutionPlanBinding[] {
  if (!goal || goal.source === 'fleet-mission' ||
      bindings.some(binding => !binding.source || !binding.sourceRef)) {
    return uniquePlanBindings(bindings);
  }

  const selectedRefs = new Set([goal.ref, goal.corroboratedBy].filter((ref): ref is string => Boolean(ref)));
  const selectedPlanSlugs = new Set<string>();
  const selectedWorkItemRefs = new Set<string>();
  for (const binding of bindings) {
    if (!binding.unbound && binding.sourceRef && selectedRefs.has(binding.sourceRef)) selectedPlanSlugs.add(binding.planSlug);
    if (binding.source === 'work-item' && binding.sourceRef && selectedRefs.has(binding.sourceRef))
      selectedWorkItemRefs.add(binding.sourceRef);
  }
  // A declared plan-slug override is itself a resolvable pointer. Work-item
  // overrides match their sourceRef above, while plan-item overrides match their
  // exact ref and contribute the plan slug from that binding.
  if (goal.source === 'author-override') {
    for (const binding of bindings) {
      if (binding.planSlug === goal.ref) selectedPlanSlugs.add(binding.planSlug);
    }
  }

  const selectsWholePlan = goal.source === 'author-override' && bindings.some(binding => binding.planSlug === goal.ref);
  // An exact held-item goal retains the parent plan's checks without importing
  // another held item's execution floors. A plan-wide goal still checks both.
  const selected = bindings.filter(binding =>
    Boolean(binding.sourceRef && selectedRefs.has(binding.sourceRef)) ||
    (selectedPlanSlugs.has(binding.planSlug) &&
      (binding.source !== 'work-item' || selectsWholePlan || selectedWorkItemRefs.size === 0)));
  // A held-item, plan-item or authored override without matching binding evidence is
  // ambiguous. Keep the full census so the guard cannot turn a stale/missing
  // selected binding into permission.
  if (selected.length === 0 && (goal.source === 'work-item' || goal.source === 'plan-item' || goal.source === 'author-override')) {
    return uniquePlanBindings(bindings);
  }
  return uniquePlanBindings(selected);
}

export async function readExecutionPlanGoal(ownerId: string, workspaceId: string,
  observe?: PlanExecutionTimingObserver, signal?: AbortSignal): Promise<ExecutionPlanGoalResolution> {
  return runWithWorkspace(workspaceId, async () => {
    const { resolveOwnerGoalForAuthority } = await measurePlanStage('goal_module', observe,
      () => import('../coordination/agent-goal-sources'));
    return measurePlanStage('goal_read', observe,
      () => resolveOwnerGoalForAuthority(ownerId, 'self', observe, signal));
  });
}

/**
 * P-010: an old claim is not clearance of the lane's CURRENT prerequisites.
 * Reuse the scheduler's dependency/status semantics, with its fail-closed read
 * option, at the shared native/MCP write boundary. This verdict is never cached.
 */
export async function checkExecutionPlanLane(binding: ExecutionPlanBinding, workspaceId: string): Promise<string[]> {
  const { planItemLaneBlockReason, resolvePlanItemStamp } = await import('../../scheduler/plan-item-lane-guard');
  return runWithWorkspace(workspaceId, async () => {
    let itemIds: string[];
    if (binding.canonical) itemIds = [binding.canonical.lineId];
    else if (binding.source === 'plan-item-claim') {
      const prefix = binding.planSlug + '#';
      const itemId = binding.sourceRef?.startsWith(prefix) ? binding.sourceRef.slice(prefix.length) : '';
      if (!/^P-\d{3,}$/.test(itemId)) return ['plan_item_lane_unavailable'];
      itemIds = [itemId];
    } else if (binding.source === 'work-item') {
      if (!binding.sourceRef || !binding.harnessSlug) return ['plan_item_lane_unavailable'];
      const { getWorkItem } = await import('../../work-items');
      const item = await getWorkItem(binding.sourceRef, binding.harnessSlug);
      if (!item || item.harness !== binding.harnessSlug) return ['plan_item_lane_unavailable'];
      const stamp = await resolvePlanItemStamp(item);
      if (!stamp || stamp.plan_slug !== binding.planSlug) return ['plan_item_lane_unavailable'];
      itemIds = stamp.item_ids;
    } else return [];
    if (!binding.harnessSlug) return ['plan_item_lane_unavailable'];
    const block = await planItemLaneBlockReason({ harness: binding.harnessSlug, payload: null,
      sourcePlanSlug: binding.planSlug, sourcePlanItemIds: itemIds }, { requireCompleteEvidence: true, workspaceId });
    if (block) return ['plan_item_lane_blocked:' + block.reason];
    const { requiredPrerequisiteNativeProofClearance } = await import('../../native-proof-clearance');
    const native = await requiredPrerequisiteNativeProofClearance({ workspaceId, harnessSlug: binding.harnessSlug,
      planSlug: binding.planSlug, planItemIds: itemIds });
    return native ? [native.code + ':' + native.error] : [];
  });
}

export async function checkExecutionPlan(binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver, readinessDeadlineAtMs?: number): Promise<string[]> {
  if (binding.canonicalInvalid) return ['canonical_plan_binding_invalid'];
  const canonicalCurrent = async () => {
    if (!binding.canonical) return true;
    const current = await readCanonicalExecutionIdentity(getOrgPg().sql, workspaceId, binding, binding.canonical.lineId,binding.canonical.ownerId);
    return current !== null && JSON.stringify(current) === JSON.stringify(binding.canonical);
  };
  const [{ readPlanExecutionStart }, { checkContinuationReadiness, readReadinessFence }] = await Promise.all([
    import('./plan-execution-authority'), import('./plan-continuation-readiness')]);
  // The start proof, binding identity and revision fence stay fresh on every call. Only
  // a positive verdict for the exact fenced revision is reused (WI-6554700010049220).
  return measurePlanStage('readiness', observe, () => checkContinuationReadiness(binding, workspaceId, observe, {
    preflight: async () => {
      if (!await canonicalCurrent()) return ['canonical_plan_binding_stale'];
      const start = await measurePlanStage('start_proof', observe, () => readPlanExecutionStart(binding, workspaceId));
      return start.length ? start : measurePlanStage('lane', observe, () => checkExecutionPlanLane(binding, workspaceId));
    },
    readFence: (b, ws) => measurePlanStage('readiness_fence', observe, () => readReadinessFence(b, ws)),
    evaluate: (b, ws, o) => checkPlanExecutionReadiness(b, ws, o, 'continuation'),
    recheck: async () => !await canonicalCurrent() ? ['canonical_plan_binding_stale']
      : measurePlanStage('lane_recheck', observe, () => checkExecutionPlanLane(binding, workspaceId)),
    deadlineAtMs: readinessDeadlineAtMs,
  }));
}

/** Current policy is required both when issuing authority and on every use. */
export async function checkPlanExecutionReadiness(binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver, discoveryAdmission: 'start' | 'continuation' = 'start',
  onSelectedReviewRequired?: (required: boolean) => void): Promise<string[]> {
  return runWithWorkspace(workspaceId, async () => {
    const { sql } = getOrgPg();
    // A known harness already scopes the canonical rendered read. Start it with
    // the independent census, but interpret the census first (including errors).
    // No authority is cached: their hashes and the final revision recheck still
    // fence drift. Unscoped bindings must resolve their harness before reading.
    const [scopeRead, renderedRead] = await Promise.allSettled([
      measurePlanStage('scope', observe, () => sql<Array<{ harness_slug: string; content: string; content_hash: string; op_status: string | null; created_at: Date | string | null }>>`
      SELECT harness_slug, content, content_hash, op_status, created_at FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND plan_slug=${binding.planSlug}
         AND (${binding.harnessSlug}::text IS NULL OR harness_slug=${binding.harnessSlug})`),
      binding.harnessSlug ? readTimedPlanRow(binding.planSlug,
        { harnessSlug: binding.harnessSlug, workspaceId }, observe) : Promise.resolve(null),
    ]);
    const rows = settledPlanValue(scopeRead);
    if (rows.length !== 1) return [rows.length ? 'plan_scope_ambiguous' : 'bound_plan_missing'];
    const row = rows[0]!;
    const opts = { harnessSlug: row.harness_slug, workspaceId };
    const plan = binding.harnessSlug ? settledPlanValue(renderedRead)
      : await readTimedPlanRow(binding.planSlug, opts, observe);
    if (!plan || plan.contentHash !== row.content_hash) return ['plan_revision_changed'];
    const parsed = parsePlan(plan.content);
    if (!['ready', 'active', 'awaiting-acceptance'].includes(parsed.frontmatter.status ?? ''))
      return [`plan_status:${parsed.frontmatter.status ?? 'unknown'}`];
    const scope = { workspaceId, harnessSlug: row.harness_slug, planSlug: binding.planSlug };
    const { evaluateConversationActivationGate } = await import('./plan-activation-gate');
    const [activationRead, auditRead] = await Promise.allSettled([
      measurePlanStage('activation', observe, () => evaluateConversationActivationGate(sql as never, scope)),
      measurePlanStage('audit', observe, () => sql<Array<{ audited_plan_content_hash: string | null; content_snapshot: string | null }>>`
        SELECT a.audited_plan_content_hash, r.content_snapshot
          FROM harness_shared.plan_audits a
          LEFT JOIN harness_shared.plan_revisions r ON r.id=a.audited_plan_revision_id
            AND r.workspace_id=a.workspace_id AND r.harness_slug=a.harness_slug AND r.plan_slug=a.plan_slug
         WHERE a.workspace_id=${workspaceId} AND a.harness_slug=${row.harness_slug} AND a.plan_slug=${binding.planSlug}
           AND a.audit_kind='activation' ORDER BY a.audit_seq DESC LIMIT 1`),
    ]);
    const activation = settledPlanValue(activationRead);
    if (!activation.satisfied) return [activation.code ?? 'conversation_audit_required'];
    const audit = settledPlanValue(auditRead)[0];
    // Preserve the canonical gate's explicit legacy/template exemptions, not an ad-hoc override.
    if (!activation.grandfathered) {
      if (!audit?.audited_plan_content_hash) return ['activation_revision_unmeasured'];
      if (audit.audited_plan_content_hash !== row.content_hash &&
        (!audit.content_snapshot || planExecutionMeaning(audit.content_snapshot) !== planExecutionMeaning(plan.content)))
        return ['activation_audit_stale'];
    }
    const [{ evaluatePlanStartReadiness }, { checkPlanAdmission }, { checkPlanStartable },
      { evaluatePlanSpecQualityGate }, { evaluatePlanStartBarCritique, isPlanStartBarCritiqueInCohort }, { specQualityPlanItemIds },
      { validatePlanCandidateDependencies }] = await Promise.all([
      import('./plan-input-validation'), import('./plan-admission-gate'),
      import('./plan-start-gate'), import('./plan-spec-quality-gate'), import('./plan-start-critique-gate'),
      import('./spec-quality'),
      import('./plan-candidate-dependencies'),
    ]);
    const dependencies = validatePlanCandidateDependencies(parsed, 'started');
    if (dependencies.state === 'rejected' || dependencies.state === 'invalid-draft') return ['plan_dependencies_invalid'];
    // This door enforces the current contract, not proof completion. Measuring
    // every bound artifact here repeats ship-only work on each native tool call.
    // Metadata still reads the live bounded sources; grading/ship reject reuse.
    const items = plan.items.length ? plan.items : parsed.items;
    // Legacy plans only receive diagnostic critiques. Native authority needs no
    // reconstruction of those histories; full start/report readers retain it.
    // Read the cohort on every invocation, and evaluate unknown dates normally.
    const createdMs = row.created_at == null ? Number.NaN : new Date(row.created_at).getTime();
    // These readers share the pinned plan revision, not settled authority.
    // Quality and admission do not depend on the BAR reader's reconciliation.
    // Critique does depend on quality, so keep that edge within its branch.
    const [gateRead, qualityRead, admissionRead] = await Promise.allSettled([
      measurePlanStage('start_gate', observe,
        () => checkPlanStartable(binding.planSlug, opts, null, 'start', {
          proofMode: 'metadata',
          discoveryAdmission,
          ...(observe ? { onRead: (source: AcceptanceBarSnapshotSource, durationMs: number) => {
            try { observe({ stage: `start_gate_snapshot_${source}`, durationMs }); }
            catch { /* Diagnostics do not grant or refuse authority. */ }
          } } : {}),
        })),
      (async () => {
        const quality = await measurePlanStage('spec_quality', observe, () => evaluatePlanSpecQualityGate({ harnessSlug: row.harness_slug,
          planSlug: binding.planSlug, planItemIds: specQualityPlanItemIds(items), planItems: items }));
        const critique = quality.satisfied && quality.applicable && isPlanStartBarCritiqueInCohort(createdMs)
          ? await measurePlanStage('critique', observe, () => evaluatePlanStartBarCritique({ workspaceId, harnessSlug: row.harness_slug,
            planSlug: binding.planSlug, nonDroppedItemCount: specQualityPlanItemIds(items).length,
            contractEnforced: quality.mode === 'enforced' }))
          : null;
        return { quality, critique };
      })(),
      measurePlanStage('admission', observe,
        () => checkPlanAdmission({ slug: binding.planSlug, door: 'run-now', opts, row: plan })),
    ]);
    const gate = settledPlanValue(gateRead);
    if (!gate.ok) return [gate.refusal.code];
    const { quality, critique } = settledPlanValue(qualityRead);
    if (!quality.satisfied) return [quality.code ?? 'spec_quality_not_current'];
    if (critique?.mode === 'enforced' && !critique.verdict.satisfied)
      return [critique.verdict.code ?? 'critique_missing'];
    const inputs = evaluatePlanStartReadiness({ template: plan.template, inputSchema: plan.inputSchema }, plan.templateData);
    if (!inputs.ready) return [inputs.code];
    // checkPlanStartable already evaluates the complete pre-start BAR under pinned
    // plan types on this invocation. Repeating it remeasures every evidence binding.
    // Keep that canonical check fresh on every use; do not cache its verdict.
    const admission = settledPlanValue(admissionRead);
    if (!admission.admitted) return [admission.refusal.code];
    // Never combine successful branches from a revision changed during the reads.
    const current = await measurePlanStage('recheck', observe, () => sql<Array<{ content_hash: string }>>`
      SELECT content_hash FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND harness_slug=${row.harness_slug} AND plan_slug=${binding.planSlug}`);
    if (current.length !== 1 || current[0]!.content_hash !== row.content_hash) return ['plan_revision_changed'];
    // Tell canonical issuance which evidence this successful check relied on.
    // A revoked historical selection cannot veto sufficient ordinary critiques.
    onSelectedReviewRequired?.(critique?.mode === 'enforced' && critique.requiresOwnerSelectedReview !== false);
    return [];
  });
}

export async function checkPlanExecutionGuard(input: PlanExecutionGuardInput,
  deps: PlanExecutionGuardDeps = {
    readBindings: readExecutionPlanBindings,
    resolveGoal: readExecutionPlanGoal,
    checkPlan: checkExecutionPlan,
  },
): Promise<PlanExecutionRefusal | null> {
  if (!isPlanImplementationCall(input.toolName, input.args)) return null;
  try {
    const allBindings = await measurePlanStage('bindings', input.observeTiming,
      () => deps.readBindings(input.ownerId, input.workspaceId));
    // Goal selection only narrows this authoritative census; it cannot add a
    // bound plan. Avoid its store reads when there is nothing to select or only
    // one unique plan remains. The census is still read afresh on every call.
    const uniqueBindings = uniquePlanBindings(allBindings);
    if (uniqueBindings.length === 0) return null;
    let resolution: ExecutionPlanGoalResolution | null = null;
    // WI-6554700010049338: plan-less held work makes the census plural. The
    // durable goal then decides which held item a write is for; skipping the
    // selector here refused every write for that other item.
    const holdsUnboundWork = allBindings.some(binding => binding.unbound);
    // Same-plan siblings can have different execution holds. Only a single
    // held subject can safely share the one-plan goal-read shortcut.
    const holdsMultipleWorkItems = new Set(allBindings.filter(binding => binding.source === 'work-item' && binding.sourceRef)
      .map(binding => binding.sourceRef)).size > 1;
    if (namesSinglePlan(uniqueBindings) && !holdsUnboundWork && !holdsMultipleWorkItems) {
      try { input.observeTiming?.({ stage: 'goal_selector_skipped', durationMs: 0 }); }
      catch { /* diagnostics cannot change the guard verdict */ }
    } else if (deps.resolveGoal) {
      const budgetMs = Math.max(1, deps.goalResolutionBudgetMs ?? GOAL_RESOLUTION_BUDGET_MS);
      const bounded = await measurePlanStage('goal_selector', input.observeTiming, () =>
        withBoundedTimeout(
          signal => deps.resolveGoal!(input.ownerId, input.workspaceId, input.observeTiming, signal),
          { fallback: null, timeoutMs: budgetMs, label: 'plan-execution-guard:goal-selector', warn: false },
        ));
      // A timed-out selection (bounded.degraded, reason 'timeout') is handled
      // like any other degraded one: keep the full census below. Every unique
      // binding must then pass checkPlan, which is at least as strict as any
      // selected subset, so a slow goal read can no longer refuse a census
      // whose plans are all executable (WI-6554700010049036). The pending
      // goal read is still aborted at the budget, and the latency envelope
      // (budget + per-binding checks) equals the existing degraded path.
      if (!bounded.degraded) resolution = bounded.value;
    }
    const bindings = resolution && resolution.diagnostics.length === 0
      ? selectExecutionPlanBindings(allBindings, resolution.goal)
      : uniqueBindings;
    for (const binding of bindings) {
      if (binding.canonicalInvalid) return {code:'plan_execution_not_ready',blockers:['canonical_plan_binding_invalid'],
        reason:'The selected work-item has an invalid canonical identity; historical lineage is not a fallback permit.'};
      const blockers = await measurePlanStage('binding', input.observeTiming,
        () => input.readinessDeadlineAtMs === undefined
          ? deps.checkPlan(binding, input.workspaceId, input.observeTiming)
          : deps.checkPlan(binding, input.workspaceId, input.observeTiming, input.readinessDeadlineAtMs));
      if (blockers.length === 1 && blockers[0] === PLAN_READINESS_PENDING) return {
        code: 'plan_execution_not_ready', planSlug: binding.planSlug, blockers, retryable: true,
        retryAfterMs: READINESS_PENDING_RETRY_AFTER_MS,
        reason: `Plan '${binding.planSlug}' readiness is still being evaluated and continues in the background. `
          + 'Nothing is known to be wrong with the plan and this call was not performed. Retry the same call in about '
          + `${Math.round(READINESS_PENDING_RETRY_AFTER_MS / 1000)}s; the finished evaluation then admits it (or reports the real blockers).` };
      if (blockers.length) return { code: 'plan_execution_not_ready', planSlug: binding.planSlug, blockers,
        reason: `Plan '${binding.planSlug}' is not executable (${blockers.join(', ')}). Implementation writes are refused. `
          + 'Repair the plan with plans:edit/audit and finish the standard plans:start process first. '
          + 'Read-only research and canonical plan repair remain available; an ad-hoc item, AUTO or force does not waive activation.'
          + otherHeldWorkRemedy(allBindings, binding.planSlug) };
    }
    return null;
  } catch {
    return { code: 'plan_execution_not_ready', blockers: ['plan_authority_unavailable'],
      reason: 'Plan execution authority could not be read; implementation writes are refused. Use read-only tools or repair plan authority, then retry.' };
  }
}
