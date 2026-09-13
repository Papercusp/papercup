import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { validateTargetedFileOutcomes, type TargetedFileResult } from './green-checkpoint';

const file = fileURLToPath(new URL('./green-checkpoint.ts', import.meta.url));
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'validateTargetedFileOutcomes');
if (!declaration) throw new Error('validator declaration missing');
const functionSource = declaration.getText(ast);
function load(contents: string): typeof validateTargetedFileOutcomes {
  const javascript = ts.transpileModule(contents, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, unknown> = {};
  // Only the pure validator is compiled; no production host imports or IO run.
  runInNewContext(javascript, { exports, failingFileKey: (f: { workspace: string; file: string }) => JSON.stringify([f.workspace, f.file]) }, { timeout: 1000 });
  return exports.validateTargetedFileOutcomes as typeof validateTargetedFileOutcomes;
}
function mutate(before: string, after: string) {
  expect(functionSource.split(before)).toHaveLength(2);
  return load(functionSource.replace(before, after));
}
const H = 'a'.repeat(40);
const requested = [{ workspace: '@test/a', file: 'a.test.ts' }, { workspace: '@test/a', file: 'b.test.ts' }];
const result = (): TargetedFileResult => ({
  pass: true, summary: 'pass', measuredHead: H,
  perWorkspace: [{ workspace: '@test/a', files: ['a.test.ts', 'b.test.ts'], status: 'pass' }],
});
describe('targeted-outcome semantic mutation controls', () => {
  it('calibrates extracted execution against the imported production validator', () => {
    expect(load(functionSource)(result(), requested, H)).toEqual(validateTargetedFileOutcomes(result(), requested, H));
    expect(validateTargetedFileOutcomes(result(), requested, H)).not.toBeNull();
  });
  it('catches removal of the measured-head guard', () => {
    const r = { ...result(), measuredHead: 'b'.repeat(40) };
    expect(validateTargetedFileOutcomes(r, requested, H)).toBeNull();
    expect(mutate('result.measuredHead !== head', 'false')(r, requested, H)).not.toBeNull();
  });
  it('catches removal of exact requested-population coverage', () => {
    const r = result();
    r.perWorkspace![0]!.files.pop();
    expect(validateTargetedFileOutcomes(r, requested, H)).toBeNull();
    expect(mutate('seen.size !== expected.size', 'false')(r, requested, H)).not.toBeNull();
  });
  it('catches a contradictory aggregate success after a failed group', () => {
    const r = result();
    r.perWorkspace![0]!.status = 'fail';
    expect(validateTargetedFileOutcomes(r, requested, H)).toBeNull();
    expect(mutate('result.pass !== result.perWorkspace.every((g) => g.status === "pass")', 'false')(r, requested, H)).not.toBeNull();
  });
  it('does not write a mutant into the real source', () => {
    expect(readFileSync(file, 'utf8')).toBe(source);
  });
});
