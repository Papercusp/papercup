/** Maintained Portal executor for structured rubric checks. Never import a spec into Vitest. */
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import postgres from 'postgres';
import { parseTestRunExecutionDetails, type TestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { resolveTestRunsPgUrl } from '@papercusp/test-config/admin-test-runs-reporter';
import { runTestProcess, type TestFilesCoreResult } from './agent-tools/testing/run';
import { mutationProbeRefusal } from './agent-tools/testing/mutation-probe-fence';
import { restrictedHoldRefusal } from './agent-tools/testing/restricted-hold-fence';
import { parkedAuditScorecardEnvironment } from './agent-tools/coordination/parked-agent-audit-oracles';
import { mergeDistilledRuns, readHarnessTestRunEvidence, type HarnessTestRunEvidence, type HarnessTestRunIdQuery } from './testing-run-store';
import type { RecordedTestCase } from './testing-case-filter';

export interface PortalPlaywrightRoute { kind: 'portal-playwright'; root: string; file: string }
export type CriterionTestRoute = { kind: 'vitest' } | PortalPlaywrightRoute | { kind: 'unsupported'; reason: string };
const playwrightClients = new Set(['request', 'chromium', 'firefox', 'webkit', 'devices', 'selectors', 'errors', '_android', '_electron']);
const vitestRegistrars = ['describe', 'suite', 'it', 'test'];
const vitestModifiers = new Set(['concurrent', 'sequential', 'only', 'skip', 'todo', 'fails', 'shuffle']);
const vitestFactories = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);

/** Look for a module-level call to an imported registrar, including curried .each and .skipIf. */
function registersVitest(statement: ts.Statement, registrars: ReadonlySet<string>): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)
    || statement.expression.arguments.length < 2) return false;
  function isRegistrar(target: ts.Expression): boolean {
    if (ts.isIdentifier(target)) return registrars.has(target.text);
    if (ts.isPropertyAccessExpression(target)) {
      if (ts.isIdentifier(target.expression) && registrars.has(target.expression.text + '.' + target.name.text)) return true;
      return vitestModifiers.has(target.name.text) && isRegistrar(target.expression);
    }
    const factory = ts.isCallExpression(target) ? target.expression : ts.isTaggedTemplateExpression(target) ? target.tag : null;
    return !!factory && ts.isPropertyAccessExpression(factory)
      && vitestFactories.has(factory.name.text) && isRegistrar(factory.expression);
  }
  return isRegistrar(statement.expression.expression);
}

function criterionTestFramework(file: string, source: string): 'vitest' | 'playwright' | 'ambiguous' {
  // A module specifier with escapes also needs parsing. Most Vitest files take the fast path.
  if (!source.includes('@playwright/test') && !source.includes('\\')) return 'vitest';
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const registrars = new Set<string>();
  let usesPlaywright = false;
  let mayUsePlaywrightRunner = false;
  let opaqueVitestImport = false;
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) {
        const clause = parent.importClause;
        const bindings = clause?.namedBindings;
        if (node.text === 'vitest' && !clause?.isTypeOnly && clause?.name) opaqueVitestImport = true;
        if (node.text === 'vitest' && bindings && !clause?.isTypeOnly) {
          if (ts.isNamespaceImport(bindings)) {
            for (const name of vitestRegistrars) registrars.add(bindings.name.text + '.' + name);
          } else {
            for (const entry of bindings.elements) {
              if (!entry.isTypeOnly && vitestRegistrars.includes((entry.propertyName ?? entry.name).text))
                registrars.add(entry.name.text);
            }
          }
        }
        if (node.text === '@playwright/test') {
          usesPlaywright = true;
          const clientOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
            && bindings.elements.every(entry => entry.isTypeOnly || playwrightClients.has((entry.propertyName ?? entry.name).text)));
          if (!clientOnly) mayUsePlaywrightRunner = true;
        }
      } else if ((node.text === '@playwright/test' || node.text === 'vitest') && (ts.isExternalModuleReference(parent)
        || (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node && !parent.isTypeOnly)
        || (ts.isCallExpression(parent) && parent.arguments[0] === node && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(parent.expression) && parent.expression.text === 'require'))))) {
        // These forms can expose the whole module, including its test registrar.
        if (node.text === 'vitest') opaqueVitestImport = true;
        else {
          usesPlaywright = true;
          mayUsePlaywrightRunner = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!usesPlaywright) return 'vitest';
  if (mayUsePlaywrightRunner) return opaqueVitestImport || registrars.size > 0 ? 'ambiguous' : 'playwright';
  return ast.statements.some(statement => registersVitest(statement, registrars)) ? 'vitest' : 'ambiguous';
}

/** Pin both the selected specs and the files that select their maintained executor. */
function portalInputSnapshot(root: string, files: string[]): string {
  return JSON.stringify(['package.json', 'playwright.config.ts', ...files].map(file => {
    const path = resolve(root, file);
    return { file, realPath: realpathSync(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }));
}

/** Read literal config ownership without executing app code in the operator. Dynamic configs refuse. */
function portalConfigMatches(config: string, file: string): boolean {
  const source = ts.createSourceFile('playwright.config.ts', config, ts.ScriptTarget.Latest, true);
  let matches = false;
  const visit = (statement: ts.Statement): void => {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) return;
    const node = statement.expression;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineConfig'
      && node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]!)) {
      const properties = node.arguments[0].properties;
      // Spread/computed/duplicate properties could override the literal contract.
      if (!properties.every(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))) return;
      const entries = properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source), p.initializer] as const);
      if (new Set(entries.map(([name]) => name)).size !== entries.length) return;
      const values = new Map(entries);
      const dir = values.get('testDir');
      const match = values.get('testMatch');
      const reporter = values.get('reporter');
      if (!dir || !ts.isStringLiteral(dir) || dir.text !== './e2e' || !match || !ts.isRegularExpressionLiteral(match)
        || !reporter || reporter.getText(source) !== 'portalBrowserReporters()' || values.has('projects')
        || values.has('webServer') || values.has('globalSetup')) return;
      const literal = match.text;
      const end = literal.lastIndexOf('/');
      try { matches = new RegExp(literal.slice(1, end), literal.slice(end + 1)).test(file); } catch { /* unsupported */ }
    }
  };
  source.statements.forEach(visit);
  return matches && config.includes('"@papercusp/operator-core/lib/testing-playwright-reporter"');
}

/** The nearest Portal package owns only its config-selected browser specs; native/other roots stay closed. */
export function resolveCriterionTestRoute(absFile: string): CriterionTestRoute {
  let source: string;
  try { source = readFileSync(absFile, 'utf8'); } catch { return { kind: 'vitest' }; }
  const framework = criterionTestFramework(absFile, source);
  if (framework === 'vitest') return { kind: 'vitest' };
  if (framework === 'ambiguous') return { kind: 'unsupported', reason:
    'uses Playwright with mixed or unconfirmed test registration; a single supported test executor must own the suite' };
  const unsupported = (): CriterionTestRoute => ({ kind: 'unsupported', reason:
    'is a Playwright spec without a supported maintained Portal browser executor; native and other Playwright roots cannot run through the Vitest router' });
  let root = dirname(resolve(absFile));
  for (let depth = 0; depth < 64; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.name === '@papercusp-portal/app') {
        const file = relative(realpathSync(root), realpathSync(absFile)).split(sep).join('/');
        if (!file.startsWith('e2e/') || file.includes('/../') || file.startsWith('../') || isAbsolute(file)
          || pkg.scripts?.['test:e2e:browser'] !== 'playwright test --config=playwright.config.ts'
          || !portalConfigMatches(readFileSync(join(root, 'playwright.config.ts'), 'utf8'), file)) return unsupported();
        return { kind: 'portal-playwright', root: realpathSync(root), file };
      }
    } catch { /* keep walking; missing/invalid Portal config cannot establish ownership */ }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return unsupported();
}

/** Set-based legacy Playwright titles prove cases only when every executed occurrence is unique and recorded. */
export function playwrightRecordedCases(details: TestRunExecutionDetails): RecordedTestCase[] | null {
  const passed = details.passedCaseTitles ?? [];
  const failed = details.failedCaseTitles ?? [];
  if (details.testLayer !== 'e2e' || details.passedCaseTitlesTruncated || passed.length !== details.passed
    || failed.length !== details.failed || new Set([...passed, ...failed]).size !== passed.length + failed.length) return null;
  return [
    ...passed.map(caseKey => ({ caseKey, occurrence: 0, status: 'pass' as const, durationMs: null })),
    ...failed.map(caseKey => ({ caseKey, occurrence: 0, status: 'fail' as const, durationMs: null })),
  ];
}

export type PortalPlaywrightResult = TestFilesCoreResult & {
  /** Complete process logs, including failures before reporter ingestion. */
  outputLogPaths?: string[];
  testRunIds?: number[];
  casesByFile?: Record<string, RecordedTestCase[] | null>;
  testRunIdsByFile?: Record<string, number[]>;
  runIdsByFile?: Record<string, string>;
};

export function partitionCriterionTestFiles(files: string[], root: string): Array<{
  kind: 'vitest' | 'portal-playwright'; root: string; files: string[];
}> {
  const groups = new Map<string, { kind: 'vitest' | 'portal-playwright'; root: string; files: string[] }>();
  for (const file of files) {
    const route = resolveCriterionTestRoute(resolve(root, file));
    if (route.kind === 'unsupported') throw new Error(`${file}: ${route.reason}`);
    const ownerRoot = route.kind === 'portal-playwright' ? route.root : root;
    const key = JSON.stringify([route.kind, ownerRoot]);
    const group = groups.get(key) ?? { kind: route.kind, root: ownerRoot, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Keep each executor's exact IDs/cases while rebasing file grain into the caller's tree. */
export function mergeCriterionTestRuns(runs: PortalPlaywrightResult[], root: string, runId: string): PortalPlaywrightResult {
  const failure = runs.find(run => run.error !== undefined);
  if (failure) return failure;
  const completed = runs.filter((run): run is Extract<PortalPlaywrightResult, { error?: undefined }> => run.error === undefined);
  const idsByFile: Record<string, number[]> = {};
  const runIdsByFile: Record<string, string> = {};
  for (const run of completed) for (const file of Object.keys(run.byFile)) {
    const absolute = resolve(run.root, file);
    idsByFile[absolute] = run.testRunIdsByFile?.[absolute] ?? run.testRunIds ?? [];
    runIdsByFile[absolute] = run.runIdsByFile?.[absolute] ?? run.runId;
  }
  return { ok: completed.every(run => run.ok), runId, root,
    ...mergeDistilledRuns(completed.map(run => ({ ...run,
      byFile: Object.fromEntries(Object.entries(run.byFile).map(([file, counts]) => [resolve(run.root, file), counts])),
      failures: run.failures.map(failure => ({ ...failure, file: resolve(run.root, failure.file) })),
    }))),
    testRunIds: [...new Set(completed.flatMap(run => run.testRunIds ?? []))], testRunIdsByFile: idsByFile, runIdsByFile,
    casesByFile: Object.assign({}, ...completed.map(run => run.casesByFile ?? {})),
  };
}

/** Exact scope/group/file receipts, with no latest-row or aggregate fallback. */
export function judgePortalPlaywrightRows(input: {
  rows: HarnessTestRunEvidence[] | null; route: { root: string; files: string[] };
  runId: string; workspaceId: string; harnessSlug: string;
}): PortalPlaywrightResult {
  const { route, runId, workspaceId, harnessSlug, rows } = input;
  const refuse = (hint: string): PortalPlaywrightResult => ({ ok: false, error: 'no_report', root: route.root, runId, hint });
  if (!rows || rows.length !== route.files.length || new Set(rows.map(row => row.id)).size !== rows.length)
    return refuse('Playwright requires exactly one terminal reporter row per requested file');
  const byFile: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }> = {};
  const casesByFile: Record<string, RecordedTestCase[] | null> = {};
  let passed = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const details = parseTestRunExecutionDetails(row.execution_details);
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.framework !== 'playwright' || !row.finished_at
      || !Number.isFinite(new Date(row.finished_at).getTime()) || row.workspace_id !== workspaceId
      || row.harness_slug !== harnessSlug || row.run_group_id !== runId || !route.files.includes(row.file_path)
      || byFile[row.file_path] || !details || details.root !== route.root || details.filePath !== row.file_path
      || details.workspaceId !== workspaceId || details.harnessSlug !== harnessSlug || details.runGroupId !== runId
      || details.testLayer !== 'e2e' || details.testNamePattern !== null || details.mutationPhase !== null
      || details.collectionFailed || details.commitSha !== row.commit_sha || details.worktreeDirty !== row.worktree_dirty
      || details.passed + details.failed === 0
      || (row.status !== 'pass' && row.status !== 'fail')
      || (row.status === 'pass' && details.failed !== 0) || (row.status === 'fail' && details.failed === 0))
      return refuse(`invalid, duplicate or unexecuted Playwright reporter evidence for ${row.file_path}`);
    byFile[row.file_path] = { passed: details.passed, failed: details.failed, skipped: details.skipped, collectionFailed: false };
    casesByFile[resolve(route.root, row.file_path)] = playwrightRecordedCases(details);
    passed += details.passed; failed += details.failed; skipped += details.skipped;
  }
  return { ok: failed === 0, runId, root: route.root, files: rows.length, passed, failed, skipped,
    byFile, failures: [], failuresTruncated: failed > 0, durationMs: null, testRunIds: rows.map(row => row.id), casesByFile,
    testRunIdsByFile: Object.fromEntries(rows.map(row => [resolve(route.root, row.file_path), [row.id]])) };
}

export async function runPortalPlaywrightChecks(opts: {
  root: string; files: string[]; runId: string; workspaceId?: string; harnessSlug?: string; actorId?: string; timeoutMs?: number;
  /** Existing caller-owned directory that survives private-runtime cleanup. */
  artifactDirectory?: string;
}, deps: {
  process?: typeof runTestProcess;
  readRows?: typeof readHarnessTestRunEvidence;
  connectLedger?: (url: string, options: postgres.Options<{}>) => postgres.Sql<{}>;
  mutationFence?: typeof mutationProbeRefusal;
  restrictedFence?: typeof restrictedHoldRefusal;
} = {}): Promise<PortalPlaywrightResult> {
  const { root, runId } = opts;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const refuse = (error: 'route_error' | 'timeout' | 'aborted', hint: string): PortalPlaywrightResult =>
    ({ ok: false, runId, root, error, hint });
  if (!opts.workspaceId?.trim() || opts.workspaceId === '*' || !opts.harnessSlug?.trim() || opts.harnessSlug === '*'
    || !opts.actorId?.trim()) return refuse('route_error', 'Playwright requires authenticated actor, concrete workspace and harness scope');
  const routes = opts.files.map(file => resolveCriterionTestRoute(resolve(root, file)));
  if (routes.length === 0 || routes.some(route => route.kind !== 'portal-playwright' || route.root !== root))
    return refuse('route_error', 'Playwright executor ownership changed or is ambiguous');
  const files = routes.map(route => (route as PortalPlaywrightRoute).file);
  if (new Set(files).size !== files.length) return refuse('route_error', 'duplicate Playwright file identity');
  let sourceSnapshot: string;
  try { sourceSnapshot = portalInputSnapshot(root, files); }
  catch { return refuse('route_error', 'Playwright spec/config source could not be pinned'); }
  const sourceUnchanged = (): boolean => {
    try { return portalInputSnapshot(root, files) === sourceSnapshot; } catch { return false; }
  };
  for (const fence of [deps.mutationFence ?? mutationProbeRefusal, deps.restrictedFence ?? restrictedHoldRefusal]) {
    const refusal = await fence(root, files);
    if (refusal) return { ok: false, root, runId, ...refusal };
  }
  if (!sourceUnchanged()) return refuse('route_error', 'Playwright spec/config source changed before execution');
  const env = { ...process.env, CI: '1', PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '0',
    PAPERCUSP_SID: opts.actorId, PAPERCUSP_WORKSPACE: opts.workspaceId,
    PAPERCUSP_TEST_RUN_GROUP: runId, PAPERCUSP_TEST_RUN_HARNESS: opts.harnessSlug,
    PAPERCUSP_WORKSPACE_ID: opts.workspaceId, PAPERCUSP_TEST_ATTRIBUTION: '1',
    PAPERCUSP_TEST_RUNS_DB_URL: resolveTestRunsPgUrl(process.env) };
  Object.assign(env, parkedAuditScorecardEnvironment(env, { files, actorId: opts.actorId, workspaceId: opts.workspaceId }));
  if (opts.artifactDirectory) Object.assign(env, { PAPERCUSP_TEST_ARTIFACT_DIR: opts.artifactDirectory });
  // Playwright CLI treats file filters as regexes. Anchor and escape literal paths, never widen to neighbours.
  const filters = files.map(file => `(?:^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const outcome = await (deps.process ?? runTestProcess)('npm', ['run', 'test:e2e:browser', '--'],
    ['--retries=0', '--workers=1', '--forbid-only', ...filters], root, root, env, Math.max(1, deadline - Date.now()), undefined, files.length);
  const diagnostics = outcome.outputLogPaths?.length ? { outputLogPaths: [...outcome.outputLogPaths] } : {};
  if (outcome.timedOut || outcome.aborted || outcome.spawnError || outcome.signal || outcome.code !== 0 || outcome.terminationUnconfirmed)
    return { ...refuse(outcome.timedOut ? 'timeout' : outcome.aborted ? 'aborted' : 'route_error',
      `Playwright process did not finish successfully: code=${outcome.code} signal=${outcome.signal}; ${outcome.spawnError ?? ''}`),
      ...diagnostics, routerOutput: outcome.output.slice(-2000), ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
      ...(outcome.terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) };
  if (!sourceUnchanged()) return { ...refuse('route_error', 'Playwright spec/config source changed during execution'), ...diagnostics };
  // The application can own a private database while its reporter writes to
  // the durable test ledger. Read the same pinned destination as the reporter,
  // rather than the application's ambient getOrgPg() connection.
  const ledger = (deps.connectLedger ?? postgres)(env.PAPERCUSP_TEST_RUNS_DB_URL,
    { max: 1, connect_timeout: 5, idle_timeout: 1 });
  let rows: HarnessTestRunEvidence[] | null;
  try {
    rows = await (deps.readRows ?? readHarnessTestRunEvidence)({ workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug, runGroupId: runId, filePaths: files,
      sql: ledger as unknown as NonNullable<HarnessTestRunIdQuery['sql']> });
  } finally {
    await ledger.end({ timeout: 1 });
  }
  if (!sourceUnchanged()) return { ...refuse('route_error', 'Playwright spec/config source changed while reading reporter evidence'), ...diagnostics };
  return { ...judgePortalPlaywrightRows({ route: { root, files }, runId, workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
    rows }), ...diagnostics };
}
