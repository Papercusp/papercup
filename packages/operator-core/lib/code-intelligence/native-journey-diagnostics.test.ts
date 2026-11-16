import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyHostBundleEvidence,
  diffSourceHashes,
  failedBundleSteps,
  formatSourceDrift,
  hostBundleFailureEvidence,
  logExcerpt,
} from './native-journey-diagnostics';

const hash = (digit: string) => digit.repeat(64);
const context = { stage: 'during the first-touch journey', testFile: 'pkg/native-ecosystem.e2e.test.ts' };

describe('diffSourceHashes', () => {
  it('reports nothing when every hash is unchanged, regardless of key order', () => {
    expect(diffSourceHashes({ 'a.ts': hash('1'), 'b.ts': hash('2') }, { 'b.ts': hash('2'), 'a.ts': hash('1') })).toEqual([]);
  });

  it('names changed, added and removed paths in path order', () => {
    expect(diffSourceHashes(
      { 'z.ts': hash('1'), 'a.ts': hash('2'), 'gone.ts': hash('3') },
      { 'z.ts': hash('9'), 'a.ts': hash('2'), 'new.ts': hash('4') },
    )).toEqual([
      { path: 'gone.ts', before: hash('3'), after: null },
      { path: 'new.ts', before: null, after: hash('4') },
      { path: 'z.ts', before: hash('1'), after: hash('9') },
    ]);
  });
});

describe('formatSourceDrift', () => {
  it('is empty when nothing drifted', () => {
    expect(formatSourceDrift([], context)).toBe('');
  });

  it('names the drifted source with short hashes, says it is not a product verdict, and gives the as-committed re-run', () => {
    // The observed incident: inject/core.mjs changed under a running first-touch journey.
    const message = formatSourceDrift(diffSourceHashes(
      { 'apps/operator/scripts/hooks/inject/core.mjs': `065d69e0${'a'.repeat(56)}` },
      { 'apps/operator/scripts/hooks/inject/core.mjs': `4fd2bd98${'b'.repeat(56)}` },
    ), context);
    expect(message).toContain('Live-tree source drift during the first-touch journey: 1 hashed journey source(s) changed');
    expect(message).toContain('apps/operator/scripts/hooks/inject/core.mjs: 065d69e0aaaa -> 4fd2bd98bbbb');
    expect(message).toContain('not a product verdict');
    expect(message).toContain('node scripts/lint-as-committed.mjs test:file --any --ref=<sha> -- pkg/native-ecosystem.e2e.test.ts');
  });

  it('marks a path that appeared or disappeared as absent on that side', () => {
    const message = formatSourceDrift([{ path: 'new.ts', before: null, after: hash('4') }], context);
    expect(message).toContain('new.ts: (absent) -> 444444444444');
  });

  it('lists every drifted path, not a sample', () => {
    const before = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`s${String(index).padStart(2, '0')}.ts`, hash('1')]));
    const after = Object.fromEntries(Object.keys(before).map(path => [path, hash('2')]));
    const message = formatSourceDrift(diffSourceHashes(before, after), context);
    expect(message).toContain('30 hashed journey source(s)');
    for (const path of Object.keys(before)) expect(message).toContain(`  ${path}: 111111111111 -> 222222222222`);
  });
});

describe('failedBundleSteps', () => {
  it('reports non-zero end rows and counts rows that do not parse', () => {
    const journal = [
      '{"at":1.0,"pid":7,"step":"compiler-resolve","event":"start"}',
      '{"at":1.5,"pid":7,"step":"compiler-resolve","event":"end","status":0}',
      '{"at":2.0,"pid":7,"step":"esbuild","event":"start"}',
      '{"at":9.0,"pid":7,"step":"esbuild","event":"end","status":1}',
      '{"at":9.1,"pid":7,"step":"publi',
      '',
    ].join('\n');
    expect(failedBundleSteps(journal)).toEqual({ failed: ['esbuild (status 1)'], unparseable: 1 });
  });

  it('reports nothing for a clean journal', () => {
    expect(failedBundleSteps('{"at":1,"pid":3,"step":"esbuild","event":"end","status":0}\n')).toEqual({ failed: [], unparseable: 0 });
  });
});

describe('logExcerpt', () => {
  const errorLines = (count: number) => Array.from({ length: count }, (_, index) => `✘ [ERROR] failure #${index + 1}`);

  it.each([19, 20, 21])('shows at most 20 error lines and counts the rest (%i error lines)', count => {
    const excerpt = logExcerpt(`${[...errorLines(count), 'done'].join('\n')}\n`, { maxErrorLines: 20, tailLines: 2 });
    const shown = Math.min(count, 20);
    expect(excerpt).toContain(`error lines (${shown} of ${count}):`);
    expect(excerpt).toContain(`failure #${shown}\n`);
    if (count > 20) expect(excerpt).toContain(`… ${count - 20} more error line(s) omitted`);
    else expect(excerpt).not.toContain('omitted');
    expect(excerpt).toContain(`last 2 of ${count + 1} line(s):`);
  });

  it('keeps an early compiler error that a tail-only cut would drop', () => {
    const text = ['✘ [ERROR] Could not resolve "./missing"', ...Array.from({ length: 200 }, (_, index) => `progress ${index}`)].join('\n');
    const excerpt = logExcerpt(text);
    expect(excerpt).toContain('✘ [ERROR] Could not resolve "./missing"');
    expect(excerpt).toContain('last 20 of 201 line(s):');
    expect(excerpt).toContain('progress 199');
    expect(excerpt).not.toContain('progress 179');
  });

  it('labels an over-long line with how much was cut', () => {
    const excerpt = logExcerpt(`error: ${'x'.repeat(700)}`);
    expect(excerpt).toContain(`… [+${'error: '.length + 700 - 500} chars]`);
  });
});

describe('host bundle evidence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const handlerIn = () => {
    const root = mkdtempSync(join(tmpdir(), 'native-journey-diagnostics-'));
    dirs.push(root);
    return { root, handlerPath: join(root, 'handler.mjs') };
  };

  it('surfaces build-error.log, the failed step and every place the evidence was kept', () => {
    const { root, handlerPath } = handlerIn();
    writeFileSync(`${handlerPath}.build-error.log`, '✘ [ERROR] Could not resolve "./inject/core.mjs"\n');
    writeFileSync(`${handlerPath}.build-steps.jsonl`, '{"at":1,"pid":3,"step":"esbuild","event":"end","status":1}\n');
    const copied = copyHostBundleEvidence(handlerPath, join(root, 'artifacts'));
    expect(copied).not.toBeNull();
    expect(readFileSync(join(copied!, 'handler.mjs.build-error.log'), 'utf8')).toContain('Could not resolve');
    expect(readFileSync(join(copied!, 'handler.mjs.build-steps.jsonl'), 'utf8')).toContain('"status":1');

    const evidence = hostBundleFailureEvidence(handlerPath, [root, copied!]);
    expect(evidence).toContain('handler.mjs.build-error.log:\nerror lines (1 of 1):\n✘ [ERROR] Could not resolve "./inject/core.mjs"');
    expect(evidence).toContain('handler.mjs.restricted-hold-gate.log: not written');
    expect(evidence).toContain('failed bundle steps: esbuild (status 1)');
    expect(evidence).toContain(`full bundle evidence retained at: ${root}, ${copied}`);
  });

  it('copies nothing without an artifact dir or without evidence files', () => {
    const { root, handlerPath } = handlerIn();
    expect(copyHostBundleEvidence(handlerPath, join(root, 'artifacts'))).toBeNull();
    writeFileSync(`${handlerPath}.build-error.log`, 'error: boom\n');
    expect(copyHostBundleEvidence(handlerPath, undefined)).toBeNull();
    expect(hostBundleFailureEvidence(handlerPath, [])).toContain('handler.mjs.build-steps.jsonl: not written\nbundle evidence was not retained');
  });
});
