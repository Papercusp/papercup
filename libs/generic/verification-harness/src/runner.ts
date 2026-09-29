/**
 * The shared verification-harness runner.
 *
 * Runs a contract's phases in declaration order under never-abort discipline (the
 * eval-battery rule, applied to a phase graph): a failing or throwing phase is recorded and
 * the run continues, and only the phases whose dependencies did not pass are marked
 * `blocked`. Every run owns ONE evidence dir (`<evidenceRoot>/<runId>`, a `phases/<id>/`
 * subdir per phase, `result.json` rewritten after every phase so a killed run still leaves
 * its partial result) and repoints `<evidenceRoot>/latest` at it when it ends.
 */
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type HarnessContract,
  type HarnessRunResult,
  type HarnessSelection,
  HarnessContractError,
  type PhaseResult,
  phaseTiers,
  type Tier,
  TIERS,
  validateContract,
} from './contract.js';
import {
  describeGuardRailFailure,
  GUARD_RAIL_SOURCE_ENV,
  type GuardRailProbe,
  type GuardRailReport,
  loadGuardRailsFromCommand,
  runGuardRails,
  selectGuardRails,
} from './guard-rails.js';
import { applyTier, planSelection } from './select.js';
import {
  defaultTierReceiptsPath,
  describeTierRefusal,
  evaluateTierGate,
  loadTierReceipts,
  type PhaseCodeIdentity,
  phaseCodeIdentity,
  recordTierReceipts,
  resolveTier,
  tierGateBlocks,
} from './tier-gate.js';

export type PhaseOutcome = { ok: true; detail?: string } | { ok: false; reasonCode: string; step?: string; detail?: string };

export interface PhaseContext {
  phase: string;
  runId: string;
  /** This phase's own evidence directory (created before the phase runs). */
  evidenceDir: string;
  /** Record the step the phase is in; a failure or throw reports the last one marked. */
  markStep(step: string): void;
}

export interface RunHarnessArgs {
  contract: HarnessContract;
  /** Parent of every run dir; the run lands at `<evidenceRoot>/<runId>`. */
  evidenceRoot: string;
  runPhase: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /** Fast checks that run before any phase; a failure blocks every phase. */
  preflight?: (ctx: PhaseContext) => Promise<PhaseOutcome>;
  /**
   * Guard-rail probes (or a loader for them). The preflight runs those sharing a tag with
   * contract.scopeTags. Omitted: the command named by VH_GUARD_RAIL_SOURCE, if set.
   */
  guardRails?: readonly GuardRailProbe[] | (() => Promise<readonly GuardRailProbe[]>);
  /** Working directory for guard-rail probes and the source command. */
  guardRailCwd?: string;
  selection?: HarnessSelection;
  /** A prior run (result or its dir) whose passed reusable phases may satisfy dependencies. */
  reuseFrom?: HarnessRunResult | string | null;
  runId?: string;
  now?: () => Date;
  /** Required when the contract declares tiers: which rig this run is on. */
  tier?: Tier | null;
  /** The tier receipt store shared by both tiers (default `<evidenceRoot>/tier-receipts.json`). */
  tierReceipts?: string;
  /** Where phase `code` paths resolve (default: guardRailCwd, else the process cwd). */
  codeRoot?: string;
  /** Run the expensive tier despite a tier-gate refusal. The reason is kept on the result. */
  overrideTierGate?: { reason: string } | null;
}

export const PREFLIGHT_PHASE_ID = 'preflight';

export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${process.pid}`;
}

export async function loadRunResult(runDir: string): Promise<HarnessRunResult> {
  const parsed = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8')) as HarnessRunResult;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.phases)) {
    throw new Error(`${runDir}/result.json is not a verification-harness result (schemaVersion 1)`);
  }
  return parsed;
}

export async function writeRunResult(result: HarnessRunResult): Promise<void> {
  await mkdir(result.evidenceDir, { recursive: true });
  const file = path.join(result.evidenceDir, 'result.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** Point `<evidenceRoot>/latest` at the run dir (relative link, replaced atomically). */
export async function linkLatest(evidenceRoot: string, runDir: string): Promise<void> {
  const tmp = path.join(evidenceRoot, `.latest-${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(path.relative(evidenceRoot, runDir), tmp);
  await rename(tmp, path.join(evidenceRoot, 'latest'));
}

export function deriveVerdict(result: Pick<HarnessRunResult, 'preflight' | 'phases' | 'tierGate'>): {
  verdict: HarnessRunResult['verdict'];
  firstFailure: HarnessRunResult['firstFailure'];
} {
  if (tierGateBlocks(result.tierGate)) {
    const p = result.tierGate!.phases.find((q) => q.status === 'refused')!;
    return { verdict: 'tier-refused', firstFailure: { phase: p.phase, step: null, reasonCode: p.reasonCode } };
  }
  if (result.preflight && result.preflight.status !== 'passed') {
    const p = result.preflight;
    return { verdict: 'preflight-failed', firstFailure: { phase: p.phase, step: p.step, reasonCode: p.reasonCode } };
  }
  const bad = result.phases.find((p) => p.status === 'failed') ?? result.phases.find((p) => p.status === 'blocked');
  if (!bad) return { verdict: 'pass', firstFailure: null };
  return { verdict: 'fail', firstFailure: { phase: bad.phase, step: bad.step, reasonCode: bad.reasonCode } };
}

/** One greppable line: `HARNESS_RESULT harness=… verdict=… first_failure=phase/step/reason … evidence=…`. */
export function formatSummaryLine(result: HarnessRunResult): string {
  const count = (s: PhaseResult['status']) => result.phases.filter((p) => p.status === s).length;
  const ff = result.firstFailure;
  const first = ff ? `${ff.phase}/${ff.step ?? '-'}/${ff.reasonCode ?? '-'}` : 'none';
  const gr = result.guardRails;
  const rails = !gr
    ? ''
    : gr.source === 'unconfigured'
      ? ' guard_rails=unconfigured'
      : ` guard_rails=${gr.results.filter((r) => r.ok).length}/${gr.selected}`;
  const tg = result.tierGate;
  const tier = !result.tier
    ? ''
    : ` tier=${result.tier}` +
      (tg ? ` tier_gate=${tg.refused > 0 ? `refused:${tg.refused}${tg.override ? ':overridden' : ''}` : 'admitted'}` : '');
  return (
    `HARNESS_RESULT harness=${result.harness} verdict=${result.verdict} run=${result.runId} first_failure=${first}` +
    ` passed=${count('passed')} failed=${count('failed')} blocked=${count('blocked')} skipped=${count('skipped')}` +
    ` reused=${count('reused')}${rails}${tier} evidence=${result.evidenceDir}`
  );
}

/**
 * Runs the guard rails that apply to `tags` into `evidenceDir`. Returns the report plus a
 * preflight outcome: any rail that does not hold (or a source that cannot answer) fails it.
 */
export async function checkGuardRails(args: {
  tags: readonly string[];
  guardRails?: RunHarnessArgs['guardRails'];
  cwd?: string;
  evidenceDir: string;
}): Promise<{ report: GuardRailReport | null; outcome: PhaseOutcome }> {
  if (args.tags.length === 0) return { report: null, outcome: { ok: true } };
  const sourceCmd = process.env[GUARD_RAIL_SOURCE_ENV]?.trim();
  const source: GuardRailReport['source'] = args.guardRails ? 'arg' : sourceCmd ? 'command' : 'unconfigured';
  if (source === 'unconfigured') {
    return { report: { source, selected: 0, results: [] }, outcome: { ok: true, detail: 'guard rails unconfigured' } };
  }
  let probes: readonly GuardRailProbe[];
  try {
    const g = args.guardRails;
    probes = g ? (typeof g === 'function' ? await g() : g) : await loadGuardRailsFromCommand(sourceCmd!, args.tags, { cwd: args.cwd });
  } catch (err) {
    return {
      report: { source, selected: 0, results: [] },
      outcome: { ok: false, reasonCode: 'guard-rail-source-failed', step: 'guard-rails', detail: err instanceof Error ? err.message : String(err) },
    };
  }
  const selected = selectGuardRails(probes, args.tags);
  const run = await runGuardRails(selected, { cwd: args.cwd, evidenceDir: args.evidenceDir });
  const report: GuardRailReport = { source, selected: selected.length, results: run.results };
  if (run.firstFailure) {
    return {
      report,
      outcome: {
        ok: false,
        reasonCode: `guard-rail:${run.firstFailure.key}`,
        step: 'guard-rails',
        detail: run.results.filter((r) => !r.ok).map(describeGuardRailFailure).join('; '),
      },
    };
  }
  return { report, outcome: { ok: true, detail: `${selected.length} guard rail(s) hold` } };
}

async function runOne(
  id: string,
  fn: (ctx: PhaseContext) => Promise<PhaseOutcome>,
  runId: string,
  runDir: string,
  now: () => Date,
): Promise<PhaseResult> {
  const evidenceDir = path.join(runDir, 'phases', id);
  await mkdir(evidenceDir, { recursive: true });
  let step: string | null = null;
  const started = now();
  let outcome: PhaseOutcome;
  try {
    outcome = await fn({ phase: id, runId, evidenceDir, markStep: (s) => { step = s; } });
  } catch (err) {
    outcome = { ok: false, reasonCode: 'threw', detail: err instanceof Error ? err.message : String(err) };
  }
  const ended = now();
  const base = {
    phase: id,
    evidenceDir,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
  };
  if (outcome.ok) return { ...base, status: 'passed', step, reasonCode: null, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  return {
    ...base,
    status: 'failed',
    step: outcome.step ?? step,
    reasonCode: outcome.reasonCode,
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

function notRun(id: string, runDir: string, status: 'blocked' | 'skipped' | 'reused', reasonCode: string | null, extra: Partial<PhaseResult> = {}): PhaseResult {
  return {
    phase: id,
    status,
    step: null,
    reasonCode,
    evidenceDir: path.join(runDir, 'phases', id),
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    ...extra,
  };
}

export async function runHarness(args: RunHarnessArgs): Promise<HarnessRunResult> {
  const { contract } = args;
  validateContract(contract);
  const now = args.now ?? (() => new Date());
  const selection: HarnessSelection = args.selection ?? { only: null, from: null };
  const tier = resolveTier(contract, args.tier);
  const prior =
    typeof args.reuseFrom === 'string' ? await loadRunResult(args.reuseFrom) : (args.reuseFrom ?? null);
  if (prior && (prior.tier ?? null) !== tier) {
    throw new HarnessContractError(
      `${contract.name}: cannot reuse run ${prior.runId} (${prior.tier ?? 'untiered'}) in a ${tier ?? 'untiered'} run`,
    );
  }
  const plan = applyTier(contract, planSelection(contract, selection, prior), tier, selection);
  const byId = new Map(contract.phases.map((p) => [p.id, p]));
  const gated = (id: string) => tier !== null && phaseTiers(contract, byId.get(id)!).length === TIERS.length;
  const codeRoot = args.codeRoot ?? args.guardRailCwd ?? process.cwd();
  const receiptsPath = args.tierReceipts ?? defaultTierReceiptsPath(args.evidenceRoot);
  const startedAt = now();
  const runId = args.runId ?? newRunId(startedAt);
  const runDir = path.join(args.evidenceRoot, runId);
  await mkdir(runDir, { recursive: true });

  const result: HarnessRunResult = {
    schemaVersion: 1,
    harness: contract.name,
    runId,
    evidenceDir: runDir,
    selection,
    reuseFromRunId: prior?.runId ?? null,
    preflight: null,
    phases: [],
    verdict: 'fail',
    firstFailure: null,
    ...(tier ? { tier } : {}),
    startedAt: startedAt.toISOString(),
    endedAt: null,
  };
  const checkpoint = async () => {
    Object.assign(result, deriveVerdict(result));
    await writeRunResult(result);
  };

  // The tier gate runs BEFORE preflight: an expensive run it refuses pays for nothing. It
  // leaves `latest` alone, because a refused run holds no passes to reuse.
  const gatedHashes = new Map<string, string | null>();
  if (tier === 'expensive') {
    const toRun = plan.filter((s) => s.action === 'run').map((s) => s.phase);
    const identities = new Map<string, PhaseCodeIdentity>();
    for (const id of toRun.filter(gated)) identities.set(id, await phaseCodeIdentity(byId.get(id)!, codeRoot));
    for (const [id, ident] of identities) gatedHashes.set(id, ident.hash);
    const store = await loadTierReceipts(receiptsPath, contract.name);
    result.tierGate = evaluateTierGate({ contract, phases: toRun, identities, store, receiptsPath, override: args.overrideTierGate });
    if (tierGateBlocks(result.tierGate)) {
      const refused = new Map(result.tierGate.phases.filter((p) => p.status === 'refused').map((p) => [p.phase, p]));
      for (const step of plan) {
        const r = refused.get(step.phase);
        result.phases.push(
          step.action === 'skip'
            ? notRun(step.phase, runDir, 'skipped', step.reason ?? 'not-selected')
            : step.action === 'reuse'
              ? notRun(step.phase, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! })
              : notRun(step.phase, runDir, 'blocked', r?.reasonCode ?? 'tier-gate:run-refused', r ? { detail: describeTierRefusal(r) } : {}),
        );
      }
      result.endedAt = now().toISOString();
      await checkpoint();
      return result;
    }
  } else if (tier === 'cheap') {
    result.tierReceipts = { tier: 'cheap', receiptsPath, recorded: [], unrecorded: [] };
  }

  // The harness's own preflight and the guard rails both run (never-abort), so one run reports
  // every broken precondition; the first failure names the reason.
  const tags = contract.scopeTags ?? [];
  if (args.preflight || tags.length > 0) {
    const own = args.preflight;
    result.preflight = await runOne(
      PREFLIGHT_PHASE_ID,
      async (ctx) => {
        const first = own ? await own(ctx) : ({ ok: true } as PhaseOutcome);
        const rails = await checkGuardRails({ tags, guardRails: args.guardRails, cwd: args.guardRailCwd, evidenceDir: ctx.evidenceDir });
        result.guardRails = rails.report;
        if (!first.ok) return rails.outcome.ok ? first : { ...first, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') };
        if (!rails.outcome.ok) return rails.outcome;
        return { ok: true, detail: [first.detail, rails.outcome.detail].filter(Boolean).join('; ') || undefined };
      },
      runId,
      runDir,
      now,
    );
    await checkpoint();
  }
  const preflightFailed = result.preflight !== null && result.preflight.status !== 'passed';

  // A gated phase is hashed right before it runs and again after: an expensive phase whose code
  // moved since the gate admitted it is blocked, and a cheap pass is recorded only when the code
  // that passed is the code that was hashed.
  const runTiered = async (id: string): Promise<PhaseResult> => {
    if (!gated(id)) return runOne(id, args.runPhase, runId, runDir, now);
    const before = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    if (tier === 'expensive' && gatedHashes.has(id) && before !== gatedHashes.get(id)) {
      return notRun(id, runDir, 'blocked', 'tier-gate:code-changed-during-run', {
        detail: `${id}: code changed after the tier gate admitted it; re-run the cheap tier`,
      });
    }
    const r = await runOne(id, args.runPhase, runId, runDir, now);
    if (tier !== 'cheap' || r.status !== 'passed') return r;
    const after = (await phaseCodeIdentity(byId.get(id)!, codeRoot)).hash;
    const receipts = result.tierReceipts!;
    if (before === null || after !== before) {
      receipts.unrecorded.push({
        phase: id,
        reasonCode: before === null ? 'tier-gate:code-unresolved' : 'tier-gate:code-changed-during-run',
      });
      return r;
    }
    await recordTierReceipts(receiptsPath, contract.name, [{ phase: id, codeHash: before, runId, passedAt: r.endedAt! }]);
    receipts.recorded.push({ phase: id, codeHash: before });
    return r;
  };

  const statusOf = new Map<string, PhaseResult['status']>();
  for (const step of plan) {
    const spec = contract.phases.find((p) => p.id === step.phase)!;
    let r: PhaseResult;
    if (step.action === 'skip') {
      r = notRun(spec.id, runDir, 'skipped', step.reason ?? 'not-selected');
    } else if (step.action === 'reuse') {
      r = notRun(spec.id, runDir, 'reused', null, { reusedFromRunId: step.reuseFromRunId! });
    } else if (preflightFailed) {
      r = notRun(spec.id, runDir, 'blocked', 'preflight-failed');
    } else {
      const unmet = (spec.dependsOn ?? []).find((d) => statusOf.get(d) !== 'passed' && statusOf.get(d) !== 'reused');
      r = unmet
        ? notRun(spec.id, runDir, 'blocked', `dependency:${unmet}:${statusOf.get(unmet) ?? 'unknown'}`)
        : await runTiered(spec.id);
    }
    statusOf.set(spec.id, r.status);
    result.phases.push(r);
    await checkpoint();
  }

  result.endedAt = now().toISOString();
  await checkpoint();
  await linkLatest(args.evidenceRoot, runDir);
  return result;
}
