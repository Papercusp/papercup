/**
 * WI-6554700010049486: source-conformance checks for three P-011 sampled claims.
 * These guard corrected prose; they do not certify the census or award BAR credit.
 * Restore each obsolete claim as a control so a green projection is not the only
 * evidence that its detector can reject a regression.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const doc = (slug: string) => read(`apps/operator-docs/src/content/docs/${slug}.mdx`);

function holdViolations(body: string): string[] {
  const violations: string[] = [];
  if (!/oldest edit in the current turn/.test(body)) violations.push('turn_oldest_edit_cap_missing');
  if (/60 minutes pass since the edit\*\*/.test(body)) violations.push('obsolete_per_edit_cap');
  if (!/never journaled a turn end is not held/.test(body)) violations.push('non_journaling_exclusion_missing');
  if (/Their edits stay held until the 60-minute cap/.test(body)) violations.push('obsolete_non_journaling_hold');
  if (!/first turn is also unheld/.test(body)) violations.push('first_turn_limit_missing');
  return violations;
}

function originViolations(body: string): string[] {
  const violations: string[] = [];
  if (!body.includes('work_items:get { id, harness }') || !body.includes('results[].workItem.origin'))
    violations.push('item_origin_read_missing');
  if (/Nothing on the read side tells you an item is remote/.test(body))
    violations.push('obsolete_blanket_read_absence');
  if (!/cohort projection described above/.test(body)) violations.push('cohort_scope_missing');
  if (!/missing or clipped field is unknown/.test(body)) violations.push('unknown_origin_limit_missing');
  return violations;
}

/** Resolve the actual array and named step objects rather than maintaining a second order. */
function actualStack(source: string): string[] {
  const file = ts.createSourceFile('dispatch-stack.ts', source, ts.ScriptTarget.Latest, true);
  const initializers = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  const stack = initializers.get('DEFAULT_DISPATCH_STACK');
  if (!stack || !ts.isCallExpression(stack) || stack.expression.getText(file) !== 'Object.freeze')
    throw new Error('DEFAULT_DISPATCH_STACK is not the measured frozen array');
  const array = stack.arguments[0];
  if (!array || !ts.isArrayLiteralExpression(array)) throw new Error('dispatch array unavailable');
  return array.elements.map(element => {
    const object = ts.isIdentifier(element) ? initializers.get(element.text) : element;
    if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('step object unavailable');
    const name = object.properties.find(property => ts.isPropertyAssignment(property)
      && property.name.getText(file) === 'name');
    if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteral(name.initializer))
      throw new Error('step name unavailable');
    return name.initializer.text;
  });
}

function documentedStack(body: string): string[] {
  const list = body.match(/complete ordered default stack[^`]+```text\n([^`]+)```/);
  if (!list) throw new Error('complete dispatch list missing');
  return list[1]!.trim().split('\n').map(line => line.trim());
}

function stackViolations(body: string, source: string): string[] {
  const expected = actualStack(source);
  let observed: string[];
  try { observed = documentedStack(body); }
  catch { return ['complete_dispatch_list_missing']; }
  return JSON.stringify(observed) === JSON.stringify(expected) ? [] : ['dispatch_order_mismatch'];
}

describe('P-011 sampled documentation source conformance', () => {
  const hold = doc('agent-insights/git-sync-turn-scoped-commit-hold');
  const triage = doc('agent-insights/reading-the-loop-routed-triage-corpus');
  const gating = doc('endpoint-system/gating');
  const dispatch = read('libs/generic/tooldef/src/dispatch-stack.ts');

  it('documents the whole-turn cap and exclusion of never-journaling editors', () => {
    expect(holdViolations(hold)).toEqual([]);
    // Pin these statements to the writer's actual SQL, not only its comment.
    const writer = read('packages/operator-core/lib/personal-vault/git-sync-hold.ts');
    expect(writer).toContain('AND e.turn_ended_at IS NOT NULL');
    expect(writer).toContain('AND o.ts > e.turn_ended_at');
    expect(writer).toContain('AND o.ts <= now() - make_interval');
  });

  it('rejects the original per-edit cap claim', () => {
    const altered = hold.replace('60 minutes pass since the oldest edit in the current turn',
      '60 minutes pass since the edit');
    expect(holdViolations(altered)).toContain('obsolete_per_edit_cap');
    expect(holdViolations(altered)).toContain('turn_oldest_edit_cap_missing');
  });

  it('rejects the original claim that never-journaling editors remain held', () => {
    const altered = hold.replace('An editor that has never journaled a turn end is not held',
      'Their edits stay held until the 60-minute cap');
    expect(holdViolations(altered)).toContain('obsolete_non_journaling_hold');
    expect(holdViolations(altered)).toContain('non_journaling_exclusion_missing');
  });

  it('rejects dropping the first-turn limitation', () => {
    expect(holdViolations(hold.replace('first turn is also unheld', 'first turn is protected')))
      .toContain('first_turn_limit_missing');
  });

  it('routes origin reads to the canonical item read with explicit cohort and unknown limits', () => {
    expect(originViolations(triage)).toEqual([]);
  });

  it('rejects the original blanket assertion even when the correct route is also present', () => {
    expect(originViolations(triage + '\nNothing on the read side tells you an item is remote'))
      .toContain('obsolete_blanket_read_absence');
  });

  it('rejects removing the item origin read route', () => {
    expect(originViolations(triage.replace('results[].workItem.origin', 'an unspecified field')))
      .toContain('item_origin_read_missing');
  });

  it('documents every actual dispatch step in its source order', () => {
    expect(actualStack(dispatch).length).toBeGreaterThan(1);
    expect(stackViolations(gating, dispatch)).toEqual([]);
  });

  it.each(['kernel-preflight', 'entity-check', 'premises', 'kernel-enforce'])(
    'rejects omitting the actual %s dispatch step', step => {
      expect(stackViolations(gating.replace(`\n${step}\n`, '\n'), dispatch))
        .toEqual(['dispatch_order_mismatch']);
    },
  );

  it('rejects moving default-deny ahead of kernel-preflight', () => {
    const altered = gating.replace('kernel-preflight\ndefault-deny', 'default-deny\nkernel-preflight');
    expect(stackViolations(altered, dispatch)).toEqual(['dispatch_order_mismatch']);
  });

  it('rejects removing the complete list instead of silently checking no steps', () => {
    expect(stackViolations(gating.replace('```text', '```removed'), dispatch))
      .toEqual(['complete_dispatch_list_missing']);
  });

  it('keeps the native default-deny comment consistent with kernel preflight', () => {
    const comment = dispatch.match(/Default-deny gate \(RFC tooldef-auth[^\n]+/);
    expect(comment?.[0]).toContain('Runs after kernel preflight');
    expect(comment?.[0]).not.toContain('Runs first');
  });
});
