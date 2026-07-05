import { describe, expect, it } from 'vitest';
import { digestTestOutput } from './pre-validator-test-digest';

const GREEN_VITEST = [
  'RUN  v4.1.8 /repo',
  '✓ lib/a.test.ts (12 tests) 44ms',
  '✓ lib/b.test.ts (8 tests) 12ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  20 passed (20)',
  '   Duration  1.2s',
].join('\n');

const RED_VITEST = [
  'RUN  v4.1.8 /repo',
  '✓ lib/a.test.ts (12 tests) 44ms',
  '✗ lib/b.test.ts (8 tests | 2 failed) 120ms',
  '  ✗ b > rejects bad input',
  '    AssertionError: expected 401 to be 200',
  '    Expected: 200',
  '    Received: 401',
  ...Array.from({ length: 40 }, (_, i) => `  noise line ${i}`),
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  2 failed | 18 passed (20)',
].join('\n');

describe('digestTestOutput (P-010)', () => {
  it('green run: exit 0, summary from the suite summary line, no failure section', () => {
    const d = digestTestOutput(GREEN_VITEST, 0, 'npm test');
    expect(d.summary).toMatch(/passed/);
    expect(d.body).toContain('Exit code: 0 (GREEN)');
    expect(d.body).toContain('npm test');
    expect(d.body).not.toContain('## Failure excerpt');
    expect(d.body).toContain('## Output tail');
  });

  it('red run: failure excerpt quoted, summary names the failures', () => {
    const d = digestTestOutput(RED_VITEST, 1, 'npm test');
    expect(d.body).toContain('Exit code: 1 (FAILING)');
    expect(d.body).toContain('## Failure excerpt');
    expect(d.body).toContain('AssertionError: expected 401 to be 200');
    expect(d.summary).toMatch(/failed/);
  });

  it('strips ANSI escapes', () => {
    const colored = '\x1b[32m✓ ok\x1b[0m\n\x1b[31m✗ FAIL thing\x1b[0m\n1 failed';
    const d = digestTestOutput(colored, 1, 'x');
    expect(d.body).not.toContain('\x1b');
  });

  it('bounds the body at maxBytes with a truncation marker', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `FAIL case ${i} something long enough`).join('\n');
    const d = digestTestOutput(huge, 1, 'x', { maxBytes: 4000 });
    expect(Buffer.byteLength(d.body, 'utf8')).toBeLessThan(4200);
    expect(d.body).toContain('digest truncated');
  });

  it('no summary line → exit-code fallback summary', () => {
    const d = digestTestOutput('some output\nwithout summaries', 2, 'x');
    expect(d.summary).toBe('exit 2');
  });
});
