/** Portfolio P-005 / R-3: judge every numbered shipping step against executable gate code.
 * Reuses the canonical corpus and the existing ship gate; this is no second gate registry.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { readCorpus, ROOT, SUBJECT_LABEL } from './corpus-subject';

const GATE = 'packages/operator-core/lib/plan-acceptance-gate.ts';
const LIFECYCLE = 'packages/operator-core/lib/agent-tools/plans/set-plan-status.ts';
const HEADING = '## Every plan ships with a graded acceptance rubric';

interface Step { line: number; text: string }
interface Witnesses { codes: Set<string>; calls: Set<string> }

// These are recognizers for the guide's claims, not a substitute list of steps:
// every step is read from the corpus, and an unrecognized addition fails closed.
const claims = [
  { title: /^\*\*Finish or intentionally drop every item\*\*/, codes: ['plan_items_unfinished'], calls: [] },
  { title: /^\*\*Audit the actual code, per item\*\*/, codes: ['acceptance_unaudited'], calls: [] },
  { title: /^\*\*Acceptance bars are seeded at plan activation\*\*/, codes: ['acceptance_rubric_missing'], calls: ['readAndEvaluateAcceptanceBarLifecycle'] },
  { title: /^\*\*Vet its current revision\*\*/, codes: ['acceptance_rubric_unvetted'], calls: ['getAcceptanceRubricVettingStatus'] },
  { title: /^\*\*A NON-implementer grades it\*\*/, codes: ['acceptance_ungraded'], calls: ['isPlanImplementerScorecard'] },
  { title: /^\*\*The implementer records the acceptance call\*\*/, codes: ['acceptance_not_recorded', 'acceptance_rejected'], calls: [] },
  { title: /^\*\*Ship\*\*/, codes: [], calls: [], lifecycleCalls: ['evaluatePlanAcceptanceGate', 'tidyFilingsForTerminalPlan', 'deps.retire'] },
];

function shippingSteps(guide: string): { steps: Step[]; errors: string[] } {
  const lines = guide.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => line === HEADING ? [index] : []);
  if (headings.length !== 1) return { steps: [], errors: [`expected one shipping section, found ${headings.length}`] };
  const steps: Step[] = [];
  for (let index = headings[0]! + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^## /.test(line)) break;
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) steps.push({ line: index + 1, text: numbered[1]! });
    else if (steps.length) steps[steps.length - 1]!.text += `\n${line}`;
  }
  return { steps, errors: steps.length ? [] : ['shipping section contains no numbered steps'] };
}

/** Parse TS so comments, diagnostic strings and unrelated functions cannot vouch
 * for a removed gate. A literal disabled branch cannot vouch either.
 */
function witnesses(source: string, gateOnly: boolean): Witnesses {
  const file = ts.createSourceFile('gate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: Witnesses = { codes: new Set(), calls: new Set() };
  const functions = new Map(file.statements.filter(ts.isFunctionDeclaration)
    .flatMap(statement => statement.name && statement.body ? [[statement.name.text, statement.body] as const] : []));
  const reached = new Set<string>();
  const enter = (name: string): void => {
    if (reached.has(name)) return;
    reached.add(name);
    const body = functions.get(name);
    if (body) visit(body);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) return;
    if (ts.isIfStatement(node) && node.expression.kind === ts.SyntaxKind.FalseKeyword) {
      if (node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (ts.isCallExpression(node)) {
      result.calls.add(node.expression.getText(file));
      if (ts.isIdentifier(node.expression)) enter(node.expression.text);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const refused = properties.some(property => property.name.getText(file) === 'satisfied' &&
        property.initializer.kind === ts.SyntaxKind.FalseKeyword);
      const code = properties.find(property => property.name.getText(file) === 'code');
      if (refused && code && ts.isStringLiteral(code.initializer)) result.codes.add(code.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  if (gateOnly) enter('evaluatePlanAcceptanceGate');
  else {
    const findHandler = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'handler' && node.body) visit(node.body);
      else ts.forEachChild(node, findHandler);
    };
    findHandler(file);
  }
  return result;
}

function judge(guide: string, gate: string, lifecycle: string) {
  const { steps, errors } = shippingSteps(guide);
  const gateWitness = witnesses(gate, true);
  const lifecycleWitness = witnesses(lifecycle, false);
  const seen = new Set<number>();
  const violations = [...errors];
  for (const step of steps) {
    const matches = claims.flatMap((claim, index) => claim.title.test(step.text) ? [index] : []);
    if (matches.length !== 1) {
      violations.push(`${SUBJECT_LABEL}:${step.line}: shipping step has no matching gate claim: ${step.text}`);
      continue;
    }
    const index = matches[0]!;
    if (seen.has(index)) violations.push(`${SUBJECT_LABEL}:${step.line}: duplicate shipping claim`);
    seen.add(index);
    const claim = claims[index]!;
    for (const code of claim.codes) {
      if (!gateWitness.codes.has(code)) violations.push(`${SUBJECT_LABEL}:${step.line}: ${GATE} no longer refuses ${code}`);
    }
    for (const call of claim.calls) {
      if (!gateWitness.calls.has(call)) violations.push(`${SUBJECT_LABEL}:${step.line}: ${GATE} no longer calls ${call}`);
    }
    for (const call of claim.lifecycleCalls ?? []) {
      if (!lifecycleWitness.calls.has(call)) violations.push(`${SUBJECT_LABEL}:${step.line}: ${LIFECYCLE} no longer calls ${call}`);
    }
  }
  return { steps, violations };
}

const gate = () => readFileSync(join(ROOT, GATE), 'utf8');
const lifecycle = () => readFileSync(join(ROOT, LIFECYCLE), 'utf8');
const guideFixture = (steps: string[]) => `${HEADING}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n## Next section\n`;
const titles = [
  '**Finish or intentionally drop every item**', '**Audit the actual code, per item**',
  '**Acceptance bars are seeded at plan activation**', '**Vet its current revision**',
  '**A NON-implementer grades it**', '**The implementer records the acceptance call**', '**Ship**',
];

describe('P-005 — every guide shipping step has a current gate check', () => {
  it('reads the complete current shipping section and matches its executable gates', () => {
    const result = judge(readCorpus(), gate(), lifecycle());
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it('fails for a newly documented step without a gate, including one after the original boundary', () => {
    const result = judge(guideFixture([...titles, '**Require an imaginary approval**']), gate(), lifecycle());
    expect(result.steps).toHaveLength(titles.length + 1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('imaginary approval');
  });

  it.each(claims.flatMap(claim => claim.codes))('fails when the actual %s refusal disappears', code => {
    const changed = gate().replaceAll(`'${code}'`, "'removed_check'");
    expect(judge(readCorpus(), changed, lifecycle()).violations.some(message => message.includes(code))).toBe(true);
  });

  it('does not accept a refusal mentioned only in comments, a string, another function or a disabled branch', () => {
    for (const replacement of [
      "// code: 'plan_items_unfinished', satisfied: false\n",
      'const diagnostic = "code: plan_items_unfinished, satisfied: false";',
      "function unused() { return { code: 'plan_items_unfinished', satisfied: false }; }",
      "export function evaluatePlanAcceptanceGate() { if (false) return { code: 'plan_items_unfinished', satisfied: false }; }",
    ]) {
      const result = judge(guideFixture([titles[0]!]), replacement, lifecycle());
      expect(result.violations.join('\n')).toContain('plan_items_unfinished');
    }
  });

  it('fails when shipping no longer runs the gate or retires its rubric', () => {
    for (const call of ['evaluatePlanAcceptanceGate', 'tidyFilingsForTerminalPlan', 'deps.retire']) {
      const changed = lifecycle().replaceAll(call, 'removed_call');
      expect(judge(guideFixture([titles[6]!]), gate(), changed).violations.join('\n')).toContain(call);
    }
  });

  it('fails closed for a missing, empty, duplicate or wholly changed shipping section', () => {
    for (const guide of ['', `${HEADING}\nNo steps.`, `${guideFixture(titles)}\n${guideFixture(titles)}`,
      guideFixture(['**An unknown shipping requirement**']), guideFixture([titles[0]!, titles[0]!])]) {
      expect(judge(guide, gate(), lifecycle()).violations.length).toBeGreaterThan(0);
    }
  });

  it('handles N-1, N, N+1 and a long reordered guide without cutting its tail', () => {
    for (const subset of [titles.slice(0, -1), titles, [...titles].reverse()])
      expect(judge(guideFixture(subset), gate(), lifecycle()).violations).toEqual([]);
    const unknown = Array.from({ length: 70 }, (_, index) => `**Unmatched obligation ${index}**`);
    const result = judge(guideFixture([...titles, ...unknown]), gate(), lifecycle());
    expect(result.steps).toHaveLength(titles.length + unknown.length);
    expect(result.violations).toHaveLength(unknown.length);
    expect(result.violations.at(-1)).toContain('obligation 69');
  });
});
