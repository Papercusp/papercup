/** P-001 baseline proof through the actual handler, compiler and forked worker. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import type { CodeIntelAnswer } from './contracts';
import { admitArm } from './fair-comparison-admission';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../docs/evidence/native-code-intelligence-baseline-2026-10-09.json', import.meta.url,
)), 'utf8')) as { routes: Array<{ tool: string; operations: string[]; backend?: string }> };

let root = '';
const put = (path: string, text: string) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'native-baseline-'));
  put('tsconfig.json', JSON.stringify({ compilerOptions: {
    target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true,
  } }));
  put('src/target.ts', 'export function baselineTarget(n: number) { return n + 1; }\n');
  put('src/barrel.ts', 'export * from "./target";\n');
  put('src/consumer.ts', [
    'import { baselineTarget } from "./barrel";',
    '// baselineTarget(99) is a comment',
    'export const label = "baselineTarget(99) is a string";',
    'export const answer = baselineTarget(1);',
    '',
  ].join('\n'));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

const query = async (name: string, paths?: string[]): Promise<CodeIntelAnswer> => {
  const result = await graphQuery.handler(graphQuery.args.parse({ op: 'callers', name, paths }),
    { projectDir: root } as never) as { data: CodeIntelAnswer };
  return result.data;
};
const locations = (answer: CodeIntelAnswer) => answer.sites.map(site => `${site.path}:${site.line1}`).sort();

describe('native baseline real compiler route', () => {
  it('matches the recorded route and an independently enumerated barrel consumer', async () => {
    const answer = await query('baselineTarget');
    const recorded = baseline.routes.find(row => row.tool === 'graph:query' && row.operations.includes('callers'));
    expect(answer.error).toBeNull();
    expect(answer.backend).toBe(recorded?.backend);
    // Literal oracle: declarations, comments and strings are deliberately excluded.
    expect(locations(answer)).toEqual(['src/consumer.ts:4']);
    expect(answer.freshness.health).toBe('healthy');
  }, 60_000);

  it('reconciles changed and deleted callers from current source rather than an old index', async () => {
    put('src/changed.ts', 'import { baselineTarget } from "./target";\nexport const fresh = baselineTarget(2);\n');
    try {
      expect(locations(await query('baselineTarget'))).toEqual(['src/changed.ts:2', 'src/consumer.ts:4']);
      put('src/changed.ts', '// baselineTarget(2) was removed\nexport const fresh = 2;\n');
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
      rmSync(join(root, 'src/changed.ts'));
      expect(locations(await query('baselineTarget'))).toEqual(['src/consumer.ts:4']);
    } finally { rmSync(join(root, 'src/changed.ts'), { force: true }); }
  }, 60_000);

  it('distinguishes a measured empty from an invalid search scope', async () => {
    const empty = await query('absentBaselineSymbol');
    expect(empty.error).toBeNull();
    expect(empty.sites).toEqual([]);
    expect(empty.freshness.health).toBe('healthy');
    const refused = await query('baselineTarget', ['../outside']);
    expect(refused.error).toMatch(/outside the repository/);
    expect(refused.freshness.health).toBe('unhealthy');
  }, 60_000);

  it('preserves the separate internal-comparison and distribution decisions', () => {
    expect(admitArm('gitnexus@1.6.9').admission.distribution?.decision).toBe('excluded');
    expect(() => admitArm('gitnexus@1.6.9', undefined, 'distribution')).toThrow(/excluded from product distribution/);
    expect(() => admitArm('no-third-party', undefined, 'distribution')).toThrow(/no explicit approved decision/);
  });
});
