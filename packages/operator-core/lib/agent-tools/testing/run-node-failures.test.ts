import { describe, expect, it } from 'vitest';
import { createBoundedRouterOutputCapture, parseNodeTestGroupRuns } from './run';

const file = 'scripts/dependency-generation-verifier-source.test.mjs';
const title = 'Git input census drops index-lagged deletions and invalidates earlier build custody';
const message = 'ENOENT: deleted source\nexpected "receipt invalid"';
const diagnostic = (path = file, name = title, detail = message, marker = 'TEST_FILE_ASSERTION_FAILURE') =>
  `${marker} file=${JSON.stringify(path)} name=${JSON.stringify(name)} message=${JSON.stringify(detail)}`;
const group = (files = [file], failed = 1) => [
  'ROUTE cwd=. runner=node:test',
  ...files.map(path => `  requested ${path}`),
  `ℹ tests ${failed + 1}`, 'ℹ pass 1', `ℹ fail ${failed}`,
  `TEST_FILE_GROUP_RESULT cwd=. runner=node:test executed=${files.length} status=${failed ? 'failed' : 'passed'}`,
  `TEST_FILE_RESULT requested=${files.length} executed=${files.length} matched=${files.length} status=${failed ? 'failed' : 'passed'}`,
].join('\n');

describe('node router failure diagnostics', () => {
  it('recovers JSON-escaped stderr details after the terminal stdout marker', () => {
    const [run] = parseNodeTestGroupRuns(`${group()}\n${diagnostic(`/immutable/checkout/${file}`)}`, [file]);
    expect(run).toMatchObject({ passed: 1, failed: 1, failuresTruncated: false });
    expect(run!.failures).toEqual([{ file, test: title, message }]);
  });
  it('preserves non-assertion errors without inventing multi-file counts', () => {
    const other = 'scripts/other.test.mjs';
    const [run] = parseNodeTestGroupRuns(`${group([file, other])}\n${diagnostic(other, 'load', 'module missing', 'TEST_FILE_NON_ASSERTION_FAILURE')}`, [file, other]);
    expect(run!.byFile).toEqual({});
    expect(run!.failures).toEqual([{ file: other, test: 'load', message: 'module missing' }]);
  });
  it('ignores malformed or unrelated markers and retains the fallback', () => {
    const [run] = parseNodeTestGroupRuns(`${group()}\n${diagnostic('unrequested/test.mjs')}\nTEST_FILE_ASSERTION_FAILURE file="broken`, [file]);
    expect(run!.failures).toHaveLength(1);
    expect(run!.failures[0]!.test).toBe('(node:test failure details unavailable)');
  });
  it('bounds structured diagnostics and reports omitted details', () => {
    const output = `${group([file], 2)}\n${diagnostic(file, 'first')}\n${diagnostic(file, 'second')}`;
    const [run] = parseNodeTestGroupRuns(output, [file], { maxFailures: 1 });
    expect(run!.failures).toEqual([{ file, test: 'first', message }]);
    expect(run!.failuresTruncated).toBe(true);
  });
  it('does not change a passing numeric verdict from an unrelated marker', () => {
    const [run] = parseNodeTestGroupRuns(`${group([file], 0)}\n${diagnostic()}`, [file]);
    expect(run).toMatchObject({ passed: 1, failed: 0, failures: [] });
  });

  it.each(['stdout', 'stderr'] as const)('preserves a chunked %s marker through capture finalization', channel => {
    const capture = createBoundedRouterOutputCapture();
    capture.append('stdout', `${group()}\n`);
    const marker = diagnostic(`/immutable/checkout/${file}`);
    capture.append(channel, marker.slice(0, 41));
    capture.append(channel, marker.slice(41));
    capture.finish();
    const [run] = parseNodeTestGroupRuns(capture.nodeTestOutput(), [file]);
    expect(run).toMatchObject({ passed: 1, failed: 1, failuresTruncated: false });
    expect(run!.failures).toEqual([{ file, test: title, message }]);
  });

  it('retains early stderr evidence when later noise evicts the display tail', () => {
    const capture = createBoundedRouterOutputCapture({ tailChars: 512 });
    capture.append('stderr', `${diagnostic()}\n`);
    capture.append('stdout', `${group()}\n`);
    capture.append('stderr', 'unrelated progress\n'.repeat(1000));
    expect(capture.finish()).not.toContain(title);
    const [run] = parseNodeTestGroupRuns(capture.nodeTestOutput(), [file]);
    expect(run!.failures).toEqual([{ file, test: title, message }]);
  });

  it('keeps complete diagnostics within its budget and declares omitted evidence', () => {
    const capture = createBoundedRouterOutputCapture({ tailChars: 512 });
    capture.append('stdout', `${group([file], 100)}\n`);
    for (let i = 0; i < 100; i++) capture.append('stderr', `${diagnostic(file, `failure ${i}`, 'x'.repeat(150))}\n`);
    capture.finish();
    const [run] = parseNodeTestGroupRuns(capture.nodeTestOutput(), [file]);
    expect(run!.failures).toEqual([{ file, test: 'failure 0', message: 'x'.repeat(150) }]);
    expect(run).toMatchObject({ failed: 100, failuresTruncated: true });
  });

  it.each(['oversized', 'router-truncated'] as const)('declares %s evidence even when no complete detail fits', kind => {
    const capture = createBoundedRouterOutputCapture({ tailChars: 512 });
    capture.append('stdout', `${group()}\n`);
    capture.append('stderr', kind === 'oversized'
      ? `${diagnostic(file, title, 'x'.repeat(2000))}\n`
      : 'TEST_FILE_ASSERTION_FAILURES_TRUNCATED omitted=20\n');
    capture.finish();
    const [run] = parseNodeTestGroupRuns(capture.nodeTestOutput(), [file]);
    expect(run).toMatchObject({ failed: 1, failuresTruncated: true });
    expect(run!.failures[0]!.test).toBe('(node:test failure details unavailable)');
  });
});
