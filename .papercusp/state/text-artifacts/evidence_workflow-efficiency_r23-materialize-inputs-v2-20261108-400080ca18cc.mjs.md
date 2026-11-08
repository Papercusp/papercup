---
rel_path: "evidence/workflow-efficiency/r23-materialize-inputs-v2-20261108-400080ca18cc.mjs"
updated_at: 1794157628614
_body: "content"
---

// Evidence preparation only. Reads immutable Git objects through the existing
// TypeScript parser. Never imports product code, invokes a tool, runs a test,
// manufactures an expected output, or certifies a replay.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire('/home/marsh-office/papercupai-workspace/papercusp/package.json');
const ts = require('typescript');
const root = '/home/marsh-office/papercupai-workspace/papercusp';
const baseline = '6b87054b1944667bf17fc0c78a815cde8b884f45';
const base = 'packages/operator-core/lib/';
const out = '/home/marsh-office/.papercusp/evidence/workflow-efficiency/r23-concrete-inputs-and-surfaces-v2-20261108.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cache = new Map();
function source(path) {
  if (cache.has(path)) return cache.get(path);
  const bytes = execFileSync('git', ['show', `${baseline}:${path}`], { cwd: root, maxBuffer: 20_000_000 });
  const text = bytes.toString('utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const value = { path, text, sf, sha256: sha(bytes), gitBlob: execFileSync('git', ['rev-parse', `${baseline}:${path}`], { cwd: root, encoding: 'utf8' }).trim() };
  cache.set(path, value);
  return value;
}
function span(node, s) {
  const start = node.getStart(s.sf), end = node.end;
  return { path: s.path, start, end, line: s.sf.getLineAndCharacterOfPosition(start).line + 1, sourceBytes: s.text.slice(start, end), sha256: sha(s.text.slice(start, end)) };
}
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)); }
function unwrap(n) {
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n)) n = n.expression;
  return n;
}
function fail(n, reason) { throw new Error(`${reason}: ${n.getText().slice(0, 140)}`); }
function declaration(n, name) {
  for (let scope = n; scope; scope = scope.parent) {
    // Do not descend into peer blocks or callback bodies: those variables are
    // not visible to this input expression.
    const children = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
    for (const st of children) {
      if (ts.isVariableStatement(st)) {
        const match = st.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name);
        if (match) return match;
      }
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    }
  }
  return null;
}
const dateValue = Symbol('dateValue');
// A deliberately bounded fixture-expression interpreter, not JavaScript eval.
// It can expand historical literal constructors (sample/item/lane); it refuses
// mocks, product calls, SQL, filesystem, time-now/random and unresolved values.
function value(node, env = {}, budget = 160) {
  if (budget <= 0) fail(node, 'expression depth exceeded');
  const n = unwrap(node), next = (a, e = env) => value(a, e, budget - 1);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text.replaceAll('_', ''));
  if (ts.isTemplateExpression(n)) return n.templateSpans.reduce((text, part) => text + String(next(part.expression)) + part.literal.text, n.head.text);
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(n)) {
    if (Object.hasOwn(env, n.text)) return env[n.text];
    if (n.text === 'undefined') return undefined;
    const d = declaration(n, n.text);
    if (d && ts.isVariableDeclaration(d) && d.initializer) {
      if (!(d.parent.flags & ts.NodeFlags.Const)) fail(n, 'mutable fixture binding requires execution');
      return next(d.initializer);
    }
    fail(n, 'unresolved identifier');
  }
  if (ts.isObjectLiteralExpression(n)) {
    const result = {};
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) { const spread = next(p.expression); if (!spread || typeof spread !== 'object') fail(p, 'non-object spread'); Object.assign(result, spread); }
      else if (ts.isPropertyAssignment(p)) {
        const key = ts.isComputedPropertyName(p.name) ? next(p.name.expression) : p.name.text;
        result[key] = next(p.initializer);
      } else if (ts.isShorthandPropertyAssignment(p)) result[p.name.text] = next(p.name);
      else fail(p, 'method is not an input value');
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap(e => ts.isSpreadElement(e) ? next(e.expression) : [next(e)]);
  if (ts.isPrefixUnaryExpression(n)) {
    const x = next(n.operand);
    if (n.operator === ts.SyntaxKind.MinusToken) return -x;
    if (n.operator === ts.SyntaxKind.PlusToken) return +x;
    if (n.operator === ts.SyntaxKind.ExclamationToken) return !x;
  }
  if (ts.isBinaryExpression(n)) {
    const a = next(n.left), op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken) return a ?? next(n.right);
    if (op === ts.SyntaxKind.BarBarToken) return a || next(n.right);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return a && next(n.right);
    const b = next(n.right);
    if (op === ts.SyntaxKind.PlusToken) return a + b;
    if (op === ts.SyntaxKind.MinusToken) return a - b;
    if (op === ts.SyntaxKind.AsteriskToken) return a * b;
    if (op === ts.SyntaxKind.SlashToken) return a / b;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return a === b;
    if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return a !== b;
    if (op === ts.SyntaxKind.EqualsEqualsToken) return a == b;
    if (op === ts.SyntaxKind.ExclamationEqualsToken) return a != b;
  }
  if (ts.isConditionalExpression(n)) return next(n.condition) ? next(n.whenTrue) : next(n.whenFalse);
  if (ts.isPropertyAccessExpression(n)) {
    const target = next(n.expression);
    if (target == null || !Object.hasOwn(target, n.name.text)) return undefined;
    return target[n.name.text];
  }
  if (ts.isNewExpression(n) && n.expression.getText() === 'Date' && n.arguments?.length) {
    return { [dateValue]: new Date(...n.arguments.map(a => next(a))) };
  }
  if (ts.isCallExpression(n)) {
    const callee = n.expression.getText();
    if (callee === 'Date.UTC') return Date.UTC(...n.arguments.map(a => next(a)));
    if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'toISOString') {
      const d = next(n.expression.expression); if (d?.[dateValue]) return d[dateValue].toISOString();
    }
    if (ts.isIdentifier(n.expression)) {
      const d = declaration(n, n.expression.text);
      let fn = d && ts.isFunctionDeclaration(d) ? d : d && ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : null;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) {
        const local = { ...env };
        fn.parameters.forEach((p, i) => {
          if (!ts.isIdentifier(p.name)) fail(p, 'destructured helper parameter');
          local[p.name.text] = n.arguments[i] ? next(n.arguments[i]) : p.initializer ? next(p.initializer) : undefined;
        });
        if (!ts.isBlock(fn.body)) return next(fn.body, local);
        for (const st of fn.body.statements) {
          if (ts.isVariableStatement(st)) {
            for (const vd of st.declarationList.declarations) {
              if (!ts.isIdentifier(vd.name) || !vd.initializer) fail(vd, 'unsupported helper declaration');
              local[vd.name.text] = next(vd.initializer, local);
            }
          } else if (ts.isReturnStatement(st) && st.expression) return next(st.expression, local);
          else fail(st, 'helper has effects or control flow');
        }
      }
    }
    fail(n, 'not a pure historical fixture constructor');
  }
  fail(n, 'unsupported fixture expression');
}
function caseContext(n) {
  for (let p = n.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p) || p.arguments.length < 2 || !ts.isStringLiteral(p.arguments[0])) continue;
    if (p.expression.getText() === 'it' || p.expression.getText() === 'test') return { node: p, name: p.arguments[0].text, variants: [{}], parameterTable: null };
    const factory = p.expression;
    if (!ts.isCallExpression(factory) || !ts.isPropertyAccessExpression(factory.expression) || factory.expression.name.text !== 'each' || !['it', 'test'].includes(factory.expression.expression.getText())) continue;
    const fn = unwrap(p.arguments[1]);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) continue;
    try {
      const table = value(factory.arguments[0]);
      if (!Array.isArray(table)) continue;
      const variants = table.map(row => {
        const args = Array.isArray(row) ? row : [row], env = {};
        fn.parameters.forEach((parameter, i) => {
          if (!ts.isIdentifier(parameter.name)) fail(parameter, 'destructured case parameter');
          env[parameter.name.text] = args[i];
        });
        return env;
      });
      return { node: p, name: p.arguments[0].text, variants, parameterTable: { sourceBytes: factory.arguments[0].getText(), value: table } };
    } catch (e) {
      return { node: p, name: p.arguments[0].text, variants: [{}], parameterTable: { sourceBytes: factory.arguments[0].getText(), unresolved: e.message } };
    }
  }
  return null;
}
const flows = [
  ['P-016', 'claim/conversion/admission/autobind', [
    ['work_items:claim', 'agent-tools/work_items/claim.ts', 'agent-tools/work_items/claim.test.ts', ['body']],
    ['plan_items:convert', 'agent-tools/plan-items/convert.ts', 'agent-tools/plan-items/convert.test.ts', ['body']],
    ['plans:start', 'agent-tools/plans/start.ts', 'agent-tools/plans/__tests__/start-guard.test.ts', ['run', 'tool.handler']],
    ['admission', 'agent-tools/plans/plan-admission-preflight.ts', 'agent-tools/plans/plan-admission-preflight.test.ts', ['evaluateExactPlanAdmission']],
    ['autobind', 'agent-tools/plans/spec-evidence-autobind.ts', 'agent-tools/plans/spec-evidence-autobind.test.ts', ['runSpecEvidenceAutobind']],
  ]],
  ['P-017', 'custody intake/release', [
    ['storage:pin', 'agent-tools/storage/pin.ts', 'agent-tools/storage/pin.test.ts', ['tool.handler']],
    ['intake', 'storage/retention-pins.ts', 'storage/retention-pins.test.ts', ['withWorkItemEvidenceRetention']],
    ['renewal', 'storage/retention-pins.ts', 'storage/retention-pins.test.ts', ['renewWorkItemEvidencePins']],
    ['release', 'storage/retention-pins.ts', 'storage/retention-pins.test.ts', ['removeRetentionPin']],
    ['reclaim', 'storage/disk-reclaim.ts', 'storage/disk-reclaim.integration.test.ts', ['runDiskReclaimOnce']],
  ]],
  ['P-018', 'claim/history/carry/recovery', [
    ['work_items:claim', 'agent-tools/work_items/claim.ts', 'agent-tools/work_items/claim.test.ts', ['body']],
    ['work_items:get', 'agent-tools/work_items/get.ts', 'agent-tools/work_items/get.prior-attempts.test.ts', ['env', 'one', 'get.handler']],
    ['history', 'prior-attempt-context.ts', 'prior-attempt-context.test.ts', ['buildBoundedPriorAttemptBrief', 'compilePriorAttempts', 'getClaimTimePriorAttemptBrief']],
    ['carry', 'carry-doc.ts', 'carry-doc.test.ts', ['buildCarryDoc']],
    ['recovery', 'agent-tools/coordination/compaction-recovery.ts', 'agent-tools/coordination/compaction-recovery.test.ts', ['buildCompactionRecovery', 'buildAutomaticCompactionRecovery']],
    ['coord:orient', 'agent-tools/coordination/tools/orient.ts', 'agent-tools/coordination/tools/orient.test.ts', ['orientTool.handler']],
  ]],
  ['P-019', 'optional context/event delivery', [
    ['claim-context', 'claim-time-enrichment.ts', 'claim-time-enrichment.test.ts', ['buildClaimTimeEnrichment']],
    ['memory-context', 'memory/injection.ts', 'memory/injection.test.ts', ['buildMemoryContextBlock']],
    ['event-delivery', 'endpoint-route/routes/agent-mcp/mid-turn-context.ts', 'endpoint-route/routes/agent-mcp/mid-turn-context.test.ts', ['routes.request', 'routes.fetch', 'post']],
  ]],
  ['P-020', 'ordinary close/remaining responsibility', [
    ['work_items:complete', 'agent-tools/work_items/complete.ts', 'agent-tools/work_items/complete.test.ts', ['oneRaw', 'envRaw', 'one', 'env', 'complete.handler']],
    ['ordinary-progress', 'mission-continuity.ts', 'mission-continuity.test.ts', ['reduceMissionContinuity']],
    ['projection', 'mission-continuity.ts', 'mission-continuity.test.ts', ['projectMissionContinuity']],
    ['task-acceptance', 'mission-continuity-task-acceptance.ts', 'mission-continuity-lifecycle.integration.test.ts', ['taskOp']],
  ]],
  ['P-021', 'runner/setup/reuse', [
    ['setup', 'native-device-fixture.ts', 'native-device-fixture.test.ts', ['provisionFixtureAgentHome']],
    ['runner', 'native-device-fixture.ts', 'native-device-fixture.test.ts', ['runNativeDeviceFixture']],
    ['phase-reuse', '../scripts/source-preview.mjs', 'source-preview-phase-retention.test.ts', ['verifierPhaseRunner', 'runCli', 'selectVerifierDependencySnapshot']],
  ]],
  ['P-022', 'measurement/results emission', [
    ['measurement', 'prior-attempt-measurement.ts', 'prior-attempt-measurement.test.ts', ['measurePriorAttemptContext']],
    ['instrument', 'rubric-instrument-registry.ts', 'rubric-instrument-registry.test.ts', ['instrument.rescore.resolve', 'instrument.rescore!.resolve']],
    ['normal-results-write', 'check-results-ledger.ts', 'check-results-ledger.integration.test.ts', ['recordRubricCheckResults', 'runInstrumentChecks']],
    ['scorecards:emit', 'agent-tools/scorecards/emit.ts', 'agent-tools/scorecards/emit-from-ledger.integration.test.ts', ['emit', 'emitScorecard', 'tool.handler']],
  ]],
  ['P-023', 'acceptance/ship gates', [
    ['acceptance', 'agent-tools/plans/acceptance-after-build.ts', 'agent-tools/plans/acceptance-after-build.test.ts', ['openBuildItems', 'isAcceptanceWork']],
    ['derived-gate', 'agent-tools/plans/derived-ship-gate.ts', 'agent-tools/plans/derived-ship-gate.test.ts', ['attachDerivedShipGates']],
    ['plans:set-plan-status', 'agent-tools/plans/set-plan-status.ts', 'agent-tools/plans/set-plan-status.test.ts', ['body', 'tool.handler']],
  ]],
];
const errors = [];
function load(relative) {
  const path = relative.startsWith('../scripts/') ? relative.replace('../', '') : base + relative;
  try { return source(path); } catch { errors.push({ path, reason: 'not present at named baseline; stage not resolved' }); return null; }
}
function declarations(s) {
  const result = [];
  visit(s.sf, n => {
    if (!ts.isCallExpression(n) || n.expression.getText() !== 'defineTool' || !n.arguments[0] || !ts.isObjectLiteralExpression(n.arguments[0])) return;
    const properties = n.arguments[0].properties;
    const name = properties.find(p => p.name?.getText() === 'name');
    const args = properties.find(p => p.name?.getText() === 'args');
    if (!name || !args || !ts.isPropertyAssignment(name) || !ts.isPropertyAssignment(args)) return;
    const closure = [], unresolved = new Set(), seen = new Set();
    function expand(node) {
      visit(node, id => {
        if (!ts.isIdentifier(id) || seen.has(id.text)) return;
        if (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) return;
        if (ts.isPropertyAssignment(id.parent) && id.parent.name === id) return;
        seen.add(id.text);
        const d = declaration(id, id.text);
        if (d) { closure.push(span(d, s)); if (ts.isVariableDeclaration(d) && d.initializer) expand(d.initializer); }
        else if (!['z', 'undefined', 'Boolean', 'String', 'Number'].includes(id.text)) unresolved.add(id.text);
      });
    }
    expand(args.initializer);
    const guidance = properties.filter(p => ['description', 'guidance', 'emits', 'abortCompletionReceipt'].includes(p.name?.getText())).map(p => span(p, s));
    result.push({ name: name.initializer.text, schemaExpression: span(args.initializer, s), localSchemaDependencies: closure, unresolvedSchemaIdentifiers: [...unresolved].sort(), guidance, runtimeSchemaStatus: 'not evaluated; imported dependencies/refinements require disposition' });
  });
  return result;
}
function adapters(s, names) {
  const result = [], seen = new Set();
  function add(node, name) {
    if (seen.has(name)) return;
    seen.add(name);
    const d = declaration(node, name);
    if (!d) return;
    result.push({ name, ...span(d, s) });
    visit(d, n => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) add(n, n.expression.text);
    });
  }
  for (const name of names) add(s.sf, name);
  return result;
}
function exposedDeclarations(s, targets) {
  const declarations = [];
  const names = new Set(targets.filter(t => /^[a-zA-Z_$][\w$]*$/.test(t)));
  // This is an explicit root-file surface snapshot, not transitive import
  // reachability relabelled as worker exposure.
  for (const st of s.sf.statements) {
    if (!st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ((ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && names.has(st.name?.text)) {
      declarations.push({ name: st.name?.text ?? 'default', kind: ts.SyntaxKind[st.kind], ...span(st, s) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (names.has(d.name.getText())) declarations.push({ name: d.name.getText(), kind: 'exported-variable', ...span(d, s) });
    }
  }
  const toolHandlers = [];
  visit(s.sf, n => {
    if (!ts.isCallExpression(n) || n.expression.getText() !== 'defineTool' || !n.arguments[0] || !ts.isObjectLiteralExpression(n.arguments[0])) return;
    const handler = n.arguments[0].properties.find(p => p.name?.getText() === 'handler');
    if (!handler) return;
    const h = span(handler, s);
    // A source pointer to the actual handler is concrete; copying every export
    // or every reachable import would merely recreate the rejected broad graph.
    toolHandlers.push({ path: h.path, start: h.start, end: h.end, line: h.line, sha256: h.sha256 });
  });
  return { declarations, toolHandlers, unresolvedEntrypoints: [...names].filter(name => !declarations.some(d => d.name === name)),
    scope: 'named concrete root definitions only; wrapper aliases are not product entrypoints; transitive gate/prompt/schema closure still requires review' };
}
const result = {
  schemaVersion: 1, workItem: 'WI-6554700010046517', baselineCommit: baseline,
  status: 'preparation only; independent review, runtime replay and exhaustive closure UNKNOWN',
  method: 'TypeScript AST of immutable Git objects; bounded pure fixture-expression interpretation; SHA256 of actual serialized input JSON, never case/file hash tuples. No expected output is calculated.',
  author: 'su-1a1d1b35-c317-44f4-a10b-51661ce46a8e',
  independentReview: null,
  producer: { path: import.meta.filename, sha256: sha(fs.readFileSync(import.meta.filename)) },
  historicalOracleReview: '/reports?sel=rpt_e91b6cff-eb54-43fe-861f-93002062a681',
  flows: [],
};
for (const [id, requiredFlow, stages] of flows) {
  const flow = { id, requiredFlow, eligibility: 'UNKNOWN', stages: [] };
  for (const [stage, productPath, testPath, calls] of stages) {
    const product = load(productPath), test = load(testPath);
    const records = [], unresolved = [], cases = new Map();
    if (test) visit(test.sf, n => {
      if (!ts.isCallExpression(n) || !calls.includes(n.expression.getText())) return;
      const context = caseContext(n); if (!context) return;
      const caseSource = span(context.node, test);
      if (!cases.has(caseSource.sha256)) cases.set(caseSource.sha256, { testName: context.name, source: caseSource,
        parameterTable: context.parameterTable, parameterBindings: context.variants });
      for (const bindings of context.variants) {
      const inputs = [], failures = [];
      n.arguments.forEach((arg, index) => {
        try {
          const materialized = value(arg, bindings);
          if (materialized === undefined) failures.push({ index, reason: 'undefined, not JSON input' });
          else {
            const jsonBytes = JSON.stringify(materialized);
            inputs.push({ index, value: JSON.parse(jsonBytes), jsonBytes, inputSha256: sha(jsonBytes), expression: span(arg, test) });
          }
        } catch (e) { failures.push({ index, reason: e.message, expression: span(arg, test) }); }
      });
      const record = { testName: context.name, historicalCaseSha256: caseSource.sha256, parameterBindings: bindings, parameterTable: context.parameterTable, callee: n.expression.getText(), call: span(n, test), inputs, failures, allArgumentsMaterialized: failures.length === 0,
        meaning: 'arguments at the named historical call site; wrapper/default/mocks are not executed and do not establish raw wire acceptance' };
      if (failures.length === 0) records.push(record); else unresolved.push(record);
      }
    });
    flow.stages.push({ stage, productPath: product?.path ?? productPath, testPath: test?.path ?? testPath,
      productPin: product ? { sourceSha256: product.sha256, gitBlob: product.gitBlob } : null,
      testPin: test ? { sourceSha256: test.sha256, gitBlob: test.gitBlob } : null,
      toolDeclarations: product ? declarations(product) : [],
      rootSurfaceDefinitions: product ? exposedDeclarations(product, calls) : null,
      testAdapterSource: test ? adapters(test, calls.filter(c => /^[a-zA-Z_$][\w$]*$/.test(c))) : [],
      historicalCases: [...cases.values()],
      targets: calls, materializedHistoricalCalls: records, partiallyMaterializedCalls: unresolved,
      replayStatus: 'not executed; materialized argument bytes do not certify hooks, environment, complete flow, oracle or normal-write output bindings',
    });
  }
  result.flows.push(flow);
}
result.unresolvedSources = errors;
result.sourceManifest = [...cache.values()].map(s => ({ path: s.path, sourceSha256: s.sha256, gitBlob: s.gitBlob }));
result.residue = [
  'Staged historical calls are not one executed end-to-end flow. Each full-flow remains UNKNOWN.',
  'Fixture hooks, mocks, imported constructors, dynamic IDs/paths and provider/runtime selection need exact materialization; unresolved values are never replaced with guessed defaults.',
  'Concrete root tool declarations retain source schema and dependencies, not evaluated JSON schema or exhaustive prompt/adapter/API/gate closure.',
  'Whole-flow literal output oracles, independent author/change disposition, normal-write binding trace, no-residue comparison and six-category controls remain unimplemented/unexecuted.',
  'Canonical prompts remain linked by the separately frozen supplement; selected runtime prompt applicability is not established.',
];
const bytes = JSON.stringify(result, null, 2) + '\n';
fs.writeFileSync(out, bytes);
console.log(JSON.stringify({ path: out, bytes: Buffer.byteLength(bytes), sha256: sha(bytes), flows: result.flows.map(f => ({ id: f.id, stages: f.stages.map(s => ({ stage: s.stage, materialized: s.materializedHistoricalCalls.length, partial: s.partiallyMaterializedCalls.length, tools: s.toolDeclarations.map(d => d.name) })) })), unresolvedSources: errors }));

