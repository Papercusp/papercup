import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  type ManagedCapabilityDisposition,
  type ManagedCapabilityFamilyId,
} from '@papercusp/orchestrator/managed-capability-contract';
import {
  compareManagedCapabilityInventory, declareRealClientMatrix,
  type ManagedCapabilityMeasuredControl, type RealClientScenario,
} from '@papercusp/orchestrator/managed-capability-matrix';
import type { CapabilityClientFamily } from '@papercusp/orchestrator/managed-capability-policy';
import { listSpecEvidence } from './agent-tools/plans/spec-evidence-store';
import { listSpecClauses } from './agent-tools/plans/spec-clauses-store';
import type { PlatformInstrument } from './rubric-instrument-registry';
import { moduleRepoRoot } from './module-repo-root';

export const MANAGED_INVENTORY_EVIDENCE_INSTRUMENT = 'managed-capability:inventory-claim-integrity';
export const MANAGED_NATIVE_CUTOVER_PLAN = 'managed-agent-capability-contract-and-native-cutover-2026-09-13';
const execute = promisify(execFile);
const LIMIT = 1000;
/** Retained R-13 detector map, including the explicitly promised API e2e path.
 * A different API integration suite cannot silently discharge that obligation. */
export const MANAGED_INVENTORY_REQUIRED_DETECTORS = [
  'packages/operator-core/lib/agent-tools/capability/pty.test.ts',
  'packages/operator-core/lib/agent-tools/capability/pty-resize.integration.test.ts',
  'packages/operator-core/lib/pty-bridge.test.ts',
  'packages/operator-core/lib/agent-tools/capability/patch.test.ts',
  'packages/operator-core/lib/agent-tools/capability/notebook.test.ts',
  'packages/operator-core/lib/agent-tools/capability/read-byte-page-door-fit.test.ts',
  'packages/operator-core/lib/agent-tools/capability/fetch.test.ts',
  'packages/operator-core/lib/agent-tools/capability/fetch-policy.test.ts',
  'packages/operator-core/lib/agent-tools/capability/fetch-policy.integration.test.ts',
  'packages/operator-core/lib/result-door-encoding-contract.test.ts',
  'packages/operator-core/lib/agent-tools/chat/ask_choice.test.ts',
  'packages/operator-core/lib/agent-tools/chat/ask_choice-autonomy.test.ts',
  'libs/generic/tooldef/src/capability-envelope-step.test.ts',
  'packages/operator-core/lib/agent-tools/capability/managed-capability-api.e2e.test.ts',
] as const;
const INVENTORY_SOURCE = 'packages/orchestrator/src/managed-capability-contract.ts';
type PreviousInventory = { family: ManagedCapabilityFamilyId; gapIds: string[] }[];

/** Read literal declarations without importing or executing historical source. */
export async function parseManagedCapabilityInventoryGaps(source: string): Promise<PreviousInventory | undefined> {
  const ts = await import('typescript');
  const file = ts.createSourceFile(INVENTORY_SOURCE, source, ts.ScriptTarget.Latest, true);
  const unwrap = (node: import('typescript').Expression): import('typescript').Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const property = (node: import('typescript').ObjectLiteralExpression, key: string) => {
    const entry = node.properties.find(p => ts.isPropertyAssignment(p) && p.name &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key);
    return entry && ts.isPropertyAssignment(entry) ? unwrap(entry.initializer) : undefined;
  };
  const declaration = file.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(d => ts.isIdentifier(d.name) && d.name.text === 'MANAGED_CAPABILITY_DISPOSITIONS');
  const array = declaration?.initializer ? unwrap(declaration.initializer) : undefined;
  if (!array || !ts.isArrayLiteralExpression(array)) return undefined;
  const rows: PreviousInventory = [];
  for (const entry of array.elements) {
    if (!ts.isObjectLiteralExpression(entry)) return undefined;
    const family = property(entry, 'family'), gaps = property(entry, 'gaps');
    if (!family || !ts.isStringLiteral(family) || !MANAGED_CAPABILITY_FAMILY_IDS.includes(family.text as ManagedCapabilityFamilyId) ||
        !gaps || !ts.isArrayLiteralExpression(gaps)) return undefined;
    const gapIds: string[] = [];
    for (const gap of gaps.elements) {
      if (!ts.isObjectLiteralExpression(gap)) return undefined;
      const id = property(gap, 'id');
      if (!id || !ts.isStringLiteral(id) || !id.text.trim() || gapIds.includes(id.text)) return undefined;
      gapIds.push(id.text);
    }
    if (rows.some(r => r.family === family.text)) return undefined;
    rows.push({ family: family.text as ManagedCapabilityFamilyId, gapIds });
  }
  return rows.length ? rows : undefined;
}

/** Git is the existing immutable before-inventory ledger. Union the complete
 * history so an extra unrelated commit cannot hide an unproved gap removal.
 * A bounded/incomplete or unparseable history supplies no passing baseline. */
export async function retainedInventoryHistory(
  run: (args: string[], root: string) => Promise<string> = async (args, root) =>
    (await execute('git', args, { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout,
): Promise<{ inventory: PreviousInventory; refs: string[] } | undefined> {
  const root = join(moduleRepoRoot(import.meta.url), 'libs/papercusp');
  try {
    // A short path log is not evidence of completeness in a shallow clone.
    if ((await run(['rev-parse', '--is-shallow-repository'], root)).trim() !== 'false') return undefined;
    const stdout = await run(['log', '--format=%H', '--max-count=65', '--', INVENTORY_SOURCE], root);
    const commits = stdout.trim().split(/\s+/).filter(Boolean);
    if (!commits.length || commits.length > 64 || commits.some(sha => !/^[a-f0-9]{40,64}$/.test(sha))) return undefined;
    const byFamily = new Map<ManagedCapabilityFamilyId, Set<string>>();
    for (let i = 0; i < commits.length; i += 4) {
      const snapshots = await Promise.all(commits.slice(i, i + 4).map(async sha => {
        const source = await run(['show', `${sha}:${INVENTORY_SOURCE}`], root);
        return parseManagedCapabilityInventoryGaps(source);
      }));
      for (const snapshot of snapshots) {
        if (!snapshot) return undefined;
        for (const row of snapshot) {
          const gaps = byFamily.get(row.family) ?? new Set<string>();
          for (const id of row.gapIds) gaps.add(id);
          byFamily.set(row.family, gaps);
        }
      }
    }
    return { inventory: [...byFamily].map(([family, gaps]) => ({ family, gapIds: [...gaps] })),
      refs: commits.map(sha => `git:libs/papercusp@${sha}:${INVENTORY_SOURCE}`) };
  } catch { return undefined; }
}

/** Version probes establish only installed version identity, never journey parity. */
async function installedClientVersions(): Promise<Partial<Record<CapabilityClientFamily, string>>> {
  const rows = await Promise.all((['claude', 'codex', 'omp'] as const).map(async client => {
    try {
      const result = await execute(client, ['--version'], { timeout: 5000, maxBuffer: 8192 });
      return [client, result.stdout.trim()] as const;
    } catch { return [client, ''] as const; }
  }));
  return Object.fromEntries(rows.filter(([, version]) => version.length > 0));
}

type Evidence = Awaited<ReturnType<typeof listSpecEvidence>>[number];
type Clauses = Awaited<ReturnType<typeof listSpecClauses>>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The tag selects a recorded observation; it cannot supply the case's verdict,
 * source/spec/environment pins, runtime identity or execution time. Those are
 * joined from the canonical evidence and per-case ledgers below. */
export function managedCapabilityControlsFromEvidence(rows: readonly Evidence[], clauses: Clauses,
  scenarios: readonly RealClientScenario[]): ManagedCapabilityMeasuredControl[] {
  const selected = new Map(scenarios.map(s => [s.id, s]));
  return rows.flatMap(row => {
    const tag = object(row.details.managedCapabilityObservation);
    const scenario = typeof tag?.scenarioId === 'string' ? selected.get(tag.scenarioId) : undefined;
    if (!tag || !scenario || !['positive', 'refusal'].includes(String(tag.role)) ||
        typeof tag.caseTitle !== 'string' || !tag.caseTitle.trim() ||
        typeof tag.occurrence !== 'number' || !Number.isSafeInteger(tag.occurrence) || tag.occurrence < 0) return [];
    const clause = clauses.find(c => c.specId === row.specId && c.planSlug === row.planSlug &&
      c.revision === row.specRevision && c.contentHash === row.specFingerprint);
    const execution = row.testRunExecution;
    const cases = execution?.cases?.filter(c => c.caseKey === tag.caseTitle && c.occurrence === tag.occurrence) ?? [];
    const runtime = execution?.runtimeEnvironment;
    const measured = row.serverMeasurement?.status === 'measured' ? row.serverMeasurement : undefined;
    const current = row.currentness.overall;
    const complete = cases.length === 1 && !execution?.collectionFailed && execution?.finishedAt &&
      runtime && clause?.sourceBar && measured &&
      measured.measuredDimensions.includes('source') && measured.measuredDimensions.includes('environment');
    return [{
      ref: { bindingId: row.id, file: execution?.filePath ?? row.testRunProvenance?.filePath ?? '',
        caseTitle: tag.caseTitle, occurrence: tag.occurrence },
      evidenceRef: `spec-evidence:${row.id}`, scenarioId: scenario.id, family: scenario.family, client: scenario.client,
      identity: { planSlug: row.planSlug, specId: row.specId, specRevision: row.specRevision,
        specFingerprint: row.specFingerprint, barHash: clause?.sourceBar?.barHash ?? '',
        sourceFingerprint: row.fingerprints.sourceFingerprint ?? '',
        clientVersion: typeof tag.clientVersion === 'string' ? tag.clientVersion : '',
        runtimeFingerprint: runtime?.fingerprint ?? '', environmentFingerprint: row.fingerprints.environmentFingerprint ?? '' },
      role: tag.role as 'positive' | 'refusal',
      outcome: complete && cases[0]?.status === 'pass' ? 'pass' as const
        : complete && cases[0]?.status === 'fail' ? 'fail' as const : 'unknown' as const,
      // Rebinding cannot refresh an old execution.
      observedAt: execution?.finishedAt ?? row.observedAt,
      currentness: complete ? current : 'unknown' as const,
      withdrawn: Boolean(row.withdrawal),
      // A generic operational run + a binder-authored live/scenario tag does
      // not establish installed-client execution. Keep its measured outcome,
      // but reserve live qualification for joined native/manual receipts.
      live: false,
    }];
  });
}

export async function measureManagedCapabilityInventory(input: { workspaceId: string; harnessSlug: string }, deps: {
  evidence?: typeof listSpecEvidence;
  clauses?: typeof listSpecClauses;
  versions?: typeof installedClientVersions;
  inventory?: readonly ManagedCapabilityDisposition[];
  scenarios?: readonly RealClientScenario[];
  baseline?: () => ReturnType<typeof retainedInventoryHistory>;
  now?: Date;
} = {}) {
  const inventory = deps.inventory ?? MANAGED_CAPABILITY_DISPOSITIONS;
  const scenarios = deps.scenarios ?? declareRealClientMatrix(undefined, { purpose: 'replacement-acceptance', dispositions: inventory });
  const read = deps.evidence ?? listSpecEvidence;
  const common = { ...input, planSlugs: [MANAGED_NATIVE_CUTOVER_PLAN], limit: LIMIT + 1, includeCaseEvidence: true };
  const [active, history, clauses, clientVersions, baseline] = await Promise.all([
    read(common),
    // Separate audit-only read: withdrawn rows are retained, never counted as proof.
    read({ ...common, includeRetracted: true, measurementMode: 'metadata' }),
    (deps.clauses ?? listSpecClauses)({ ...input, planSlug: MANAGED_NATIVE_CUTOVER_PLAN, limit: LIMIT + 1 }),
    (deps.versions ?? installedClientVersions)(),
    (deps.baseline ?? retainedInventoryHistory)(),
  ]);
  const byId = new Map(history.map(row => [row.id, row]));
  for (const row of active) byId.set(row.id, row);
  const observations = managedCapabilityControlsFromEvidence([...byId.values()], clauses, scenarios);
  const report = compareManagedCapabilityInventory({ scenarios, inventory, observations, clientVersions,
    previousInventory: baseline?.inventory, now: deps.now });
  const missingDetectors = MANAGED_INVENTORY_REQUIRED_DETECTORS.filter(file => !active.some(row =>
    row.currentness.overall === 'current' && !row.withdrawal && !row.testRunExecution?.collectionFailed &&
    (row.testRunExecution?.filePath === file || row.testRunProvenance?.filePath === file) &&
    row.testRunExecution?.cases?.some(c => c.status === 'pass' || c.status === 'fail')));
  const criterion = clauses.find(c => c.sourceBar?.barKey === 'R-13');
  if (observations.some(o => !o.live)) report.unknownReasons.push('installed-client-receipt-qualification-required');
  for (const file of missingDetectors) report.unknownReasons.push(`required-detector-unobserved:${file}`);
  if (!criterion) report.unknownReasons.push('current-r13-criterion-unavailable');
  if (active.length > LIMIT || history.length > LIMIT || clauses.length > LIMIT) {
    report.unknownReasons.push('evidence-population-truncated');
    report.coverage.residue.push('evidence-population-truncated');
    if (report.verdict !== 'fail') report.verdict = 'unknown';
  }
  report.coverage.residue = [...new Set([...report.coverage.residue, ...report.unknownReasons])];
  if (report.verdict === 'pass' && report.unknownReasons.length) report.verdict = 'unknown';
  return { ...report, baselineEvidenceRefs: baseline?.refs ?? [], missingDetectors,
    criterion: criterion ? { specId: criterion.specId, revision: criterion.revision,
      contentHash: criterion.contentHash, sourceBar: criterion.sourceBar } : null };
}

export function managedCapabilityInventoryRescore(): NonNullable<PlatformInstrument['rescore']> {
  return { scope: 'subject', windowMs: 7 * 86400_000, unit: 'count', async resolve(input) {
    if (!input.workspaceId.trim() || input.workspaceId === '*' || !input.harnessSlug ||
        input.subject?.kind !== 'plan' || input.subject.ref !== MANAGED_NATIVE_CUTOVER_PLAN) {
      return { verdict: 'unknown', detail: 'exact_native_cutover_plan_workspace_harness_required' };
    }
    const now = Date.now(), start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now || now - end > 60_000) {
      return { verdict: 'unknown', detail: 'current_completed_observation_window_required' };
    }
    const report = await measureManagedCapabilityInventory({ workspaceId: input.workspaceId, harnessSlug: input.harnessSlug });
    return { verdict: report.verdict, value: report.integrityIssues.length,
      detail: JSON.stringify({ coverage: report.coverage, integrityIssues: report.integrityIssues,
        unknownReasons: report.unknownReasons, criterion: report.criterion }), evidenceRefs: [...report.observations.map(o => o.evidenceRef), ...report.baselineEvidenceRefs] };
  } };
}
