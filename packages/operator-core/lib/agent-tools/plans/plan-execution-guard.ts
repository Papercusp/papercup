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
export { planExecutionMeaning } from './plan-execution-meaning';

// The installed parser has no bundled declarations. Treat its tokens as unknown
// and validate the small token vocabulary this read-only boundary accepts.
const parseShell: (command: string) => unknown[] = createRequire(import.meta.url)('shell-quote').parse;

export type ExecutionPlanBindingSource =
  | 'session-brief'
  | 'control-state'
  | 'active-session'
  | 'plan-item-claim'
  | 'work-item';
export interface ExecutionPlanBinding {
  planSlug: string;
  harnessSlug: string | null;
  source?: ExecutionPlanBindingSource;
  sourceRef?: string | null;
}
export interface PlanExecutionRefusal {
  code: 'plan_execution_not_ready';
  reason: string;
  planSlug?: string;
  blockers: string[];
}
export interface PlanExecutionGuardInput {
  ownerId: string; workspaceId: string; toolName: string; args: unknown;
  observeTiming?: PlanExecutionTimingObserver;
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
  checkPlan: (binding: ExecutionPlanBinding, workspaceId: string, observe?: PlanExecutionTimingObserver) => Promise<string[]>;
  /** Test seam for the bounded selector path; production uses the fixed 650ms budget. */
  goalResolutionBudgetMs?: number;
}

const GOAL_RESOLUTION_BUDGET_MS = 650;

const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'apply_patch', 'capability:edit',
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
  if (isPlanPtoolReadCommand(command)) return true;
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
  if (!tool || !readCommands.has(tool)) return false;
  if (args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) return false;
  if (tool !== 'sed') return true;
  if (args.length < 3 || args[0] !== '-n' ||
      !/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1] ?? '')) return false;
  const inputFiles = args.slice(2);
  return inputFiles.length > 0 && inputFiles.every(arg => arg.length > 0 && !arg.startsWith('-'));
}

const readOnlyPtoolTools = new Set([
  'tools:find', 'plans:get', 'plans:get-input-schema', 'plans:items', 'work_items:get', 'reports:get',
  'plans:evaluate-spec-quality',
  'consult:get_feedback', 'conversations:get', 'coord:inbox', 'coord:read', 'docs:get', 'docs:search',
]);

/**
 * Recognize only a single ptool JSON call with a quoted heredoc. Its body is
 * inert data; the exact target verb is checked against a narrow allowlist below.
 */
function ptoolJsonHeredocTool(command: unknown): string | null {
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
  if (words[0] !== 'ptool' || !/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(words[1] ?? '')) return null;
  const flags = new Set<string>();
  for (let index = 2; index < words.length; index++) {
    const token = words[index]!;
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (!['--json', '--workspace', '--harness', '--url'].includes(flag) || flags.has(flag)) return null;
    const value = equals < 0 ? words[++index] : token.slice(equals + 1);
    if (value === undefined) return null;
    flags.add(flag);
    if (flag === '--json') {
      if (value !== '-') return null;
    } else if (flag === '--url') {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.pathname !== '/' || url.search || url.hash
          || url.port === '0') return null;
      } catch { return null; }
    } else if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  }
  if (!flags.has('--json')) return null;

  try {
    const payload: unknown = JSON.parse(lines.join('\n'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (words[1] !== 'tools:invoke') return words[1]!;
    const nested = payload as Record<string, unknown>;
    if (Object.keys(nested).some(key => !['name', 'args', 'projection'].includes(key))) return null;
    return typeof nested.name === 'string' && nested.args && typeof nested.args === 'object' && !Array.isArray(nested.args)
      ? nested.name : null;
  } catch {
    return null;
  }
}

function isPlanPtoolReadCommand(command: unknown): boolean {
  const tool = ptoolJsonHeredocTool(command);
  return tool !== null && readOnlyPtoolTools.has(tool);
}

function isPlanPtoolControlCommand(command: unknown): boolean {
  const tool = ptoolJsonHeredocTool(command);
  // plans:audit is a canonical plan-control operation; its handler owns audit
  // evidence validation and any activation transition. It does not grant code
  // execution, which remains behind the implementation readiness check.
  return tool === 'consult:reply' || tool === 'consult:decline' || tool === 'plans:start' || tool === 'plans:audit';
}

export function isPlanImplementationCall(toolName: string, args: unknown): boolean {
  const name = toolName.replace(/^functions\./, '').replace(/^mcp__.+?__/, '').replace(/^capability_/, 'capability:');
  if (name === 'write_stdin') {
    const chars = (args as { chars?: unknown } | null)?.chars;
    return typeof chars === 'string' && chars.length > 0;
  }
  if (fileTools.has(name) || executionTools.has(name)) return true;
  if (!shellTools.has(name)) return false;
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = input.command ?? input.cmd;
  return !isPlanResearchCommand(command) &&
    !isPlanPtoolReadCommand(command) &&
    !isPlanPtoolControlCommand(command);
}

/** Read durable authority, never coord_presence or caller-supplied plan/force/purpose. */
export async function readExecutionPlanBindings(ownerId: string, workspaceId: string): Promise<ExecutionPlanBinding[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{
    plan_slug: string | null;
    harness_slug: string | null;
    source: ExecutionPlanBindingSource;
    source_ref: string | null;
  }>>`
    SELECT current_plan_slug AS plan_slug, harness_slug, 'session-brief'::text AS source,
           current_plan_slug AS source_ref
      FROM harness_shared.session_briefs
     WHERE owner_id=${ownerId} AND workspace_id=${workspaceId} AND current_plan_slug IS NOT NULL
    UNION ALL
    SELECT control_state #>> '{scope,plan}', control_state #>> '{scope,harness}',
           'control-state'::text, control_state #>> '{scope,plan}'
      FROM harness_shared.session_briefs
     WHERE owner_id=${ownerId} AND workspace_id=${workspaceId}
       AND control_state #>> '{scope,plan}' IS NOT NULL
    UNION ALL
    SELECT plan_slug, NULL::text, 'active-session'::text, plan_slug
      FROM harness_shared.adv_sessions
     WHERE coord_owner_id=${ownerId} AND workspace_id=${workspaceId} AND plan_slug IS NOT NULL
       AND ended_at IS NULL
    UNION ALL
    SELECT plan_slug, harness_slug, 'plan-item-claim'::text, plan_slug || '#' || item_id
      FROM harness_shared.plan_item_claims
     WHERE owner=${ownerId} AND workspace_id=${workspaceId}
    UNION ALL
    SELECT source_plan_slug, harness_slug, 'work-item'::text, feature_id
      FROM harness_shared.work_items
     WHERE taken_by=${ownerId} AND workspace_id=${workspaceId}
       AND source_plan_slug IS NOT NULL
       AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))`;
  return rows.filter(row => typeof row.plan_slug === 'string' && row.plan_slug.trim())
    .map(row => ({
      planSlug: row.plan_slug!,
      harnessSlug: row.harness_slug,
      source: row.source,
      sourceRef: row.source_ref,
    }));
}

function uniquePlanBindings(bindings: readonly ExecutionPlanBinding[]): ExecutionPlanBinding[] {
  const unique = new Map<string, ExecutionPlanBinding>();
  for (const binding of bindings) {
    const key = JSON.stringify([binding.planSlug, binding.harnessSlug]);
    unique.set(key, { planSlug: binding.planSlug, harnessSlug: binding.harnessSlug });
  }
  return [...unique.values()];
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
  for (const binding of bindings) {
    if (binding.sourceRef && selectedRefs.has(binding.sourceRef)) selectedPlanSlugs.add(binding.planSlug);
  }
  // A declared plan-slug override is itself a resolvable pointer. Work-item
  // overrides match their sourceRef above, while plan-item overrides match their
  // exact ref and contribute the plan slug from that binding.
  if (goal.source === 'author-override') {
    for (const binding of bindings) {
      if (binding.planSlug === goal.ref) selectedPlanSlugs.add(binding.planSlug);
    }
  }

  const selected = bindings.filter(binding =>
    Boolean(binding.sourceRef && selectedRefs.has(binding.sourceRef)) ||
    selectedPlanSlugs.has(binding.planSlug));
  // A plan-item or authored override without matching durable binding evidence is
  // ambiguous. Keep the full census so the guard cannot turn a stale/missing
  // selected binding into permission.
  if (selected.length === 0 && (goal.source === 'plan-item' || goal.source === 'author-override')) {
    return uniquePlanBindings(bindings);
  }
  return uniquePlanBindings(selected);
}

async function readExecutionPlanGoal(ownerId: string, workspaceId: string,
  observe?: PlanExecutionTimingObserver, signal?: AbortSignal): Promise<ExecutionPlanGoalResolution> {
  return runWithWorkspace(workspaceId, async () => {
    const { resolveOwnerGoalWithAssessment } = await measurePlanStage('goal_module', observe,
      () => import('../coordination/agent-goal-sources'));
    return measurePlanStage('goal_read', observe,
      () => resolveOwnerGoalWithAssessment(ownerId, 'self', observe, signal));
  });
}

export async function checkExecutionPlan(binding: ExecutionPlanBinding, workspaceId: string,
  observe?: PlanExecutionTimingObserver): Promise<string[]> {
  const { readPlanExecutionStart } = await import('./plan-execution-authority');
  const proof = await measurePlanStage('start_proof', observe, () => readPlanExecutionStart(binding, workspaceId));
  if (proof.length) return proof;
  return checkPlanExecutionReadiness(binding, workspaceId, observe, 'continuation');
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
    if (uniqueBindings.length === 1) {
      try { input.observeTiming?.({ stage: 'goal_selector_skipped', durationMs: 0 }); }
      catch { /* diagnostics cannot change the guard verdict */ }
    } else if (deps.resolveGoal) {
      const budgetMs = Math.max(1, deps.goalResolutionBudgetMs ?? GOAL_RESOLUTION_BUDGET_MS);
      const bounded = await measurePlanStage('goal_selector', input.observeTiming, () =>
        withBoundedTimeout(
          signal => deps.resolveGoal!(input.ownerId, input.workspaceId, input.observeTiming, signal),
          { fallback: null, timeoutMs: budgetMs, label: 'plan-execution-guard:goal-selector', warn: false },
        ));
      if (bounded.reason === 'timeout') {
        return {
          code: 'plan_execution_not_ready',
          blockers: ['plan_goal_resolution_timeout'],
          reason: `Owner-goal selection exceeded the ${budgetMs}ms guard budget. This implementation write is refused fail-closed before the native pre-tool deadline; retry after goal reads respond within budget.`,
        };
      }
      if (!bounded.degraded) resolution = bounded.value;
    }
    const bindings = resolution && resolution.diagnostics.length === 0
      ? selectExecutionPlanBindings(allBindings, resolution.goal)
      : uniqueBindings;
    for (const binding of bindings) {
      const blockers = await measurePlanStage('binding', input.observeTiming,
        () => deps.checkPlan(binding, input.workspaceId, input.observeTiming));
      if (blockers.length) return { code: 'plan_execution_not_ready', planSlug: binding.planSlug, blockers,
        reason: `Plan '${binding.planSlug}' is not executable (${blockers.join(', ')}). Implementation writes are refused. `
          + 'Repair the plan with plans:edit/audit and finish the standard plans:start process first. '
          + 'Read-only research and canonical plan repair remain available; an ad-hoc item, AUTO or force does not waive activation.' };
    }
    return null;
  } catch {
    return { code: 'plan_execution_not_ready', blockers: ['plan_authority_unavailable'],
      reason: 'Plan execution authority could not be read; implementation writes are refused. Use read-only tools or repair plan authority, then retry.' };
  }
}
