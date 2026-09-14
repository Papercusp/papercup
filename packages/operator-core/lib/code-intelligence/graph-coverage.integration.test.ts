import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import * as contracts from './contracts';
import type { CodeIntelAnswer } from './contracts';

function response(body: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}
const health = response({ repositories: [{
  name: 'papercusp', indexedAt: '2026-09-14T13:00:00.000Z',
  lastCommit: 'e4400622e1721fb0b72514bcf4479dc2f1726231',
  staleness: { commitsBehind: 0 },
}] });
const dispatch = async (name: string) =>
  name.endsWith('list_repos') ? health : response({ status: 'not_found' });

function assertMiss(answer: CodeIntelAnswer) {
  expect(answer.sites).toEqual([]);
  expect(answer.freshness.health).toBe('healthy');
  expect(answer.coverage?.sourceCompleteness).toBe('unverified');
  expect(answer.error).toContain('source existence is unverified');
}

describe('graph tool preserves evidence scope through the registered handler', () => {
  it('propagates a fresh-index miss without turning it into source absence', async () => {
    const result = await graphQuery.handler(
      { op: 'symbol', name: 'claimNextIssueWorkItem', repo: 'papercusp' } as never,
      { dispatchTool: dispatch } as never,
    ) as { data: CodeIntelAnswer };
    assertMiss(result.data);
  });

  it('reports ambiguity and backend failure distinctly across the handler', async () => {
    for (const body of [{ status: 'ambiguous' }, { error: 'database unavailable' }]) {
      const result = await graphQuery.handler(
        { op: 'symbol', name: 'helper' } as never,
        { dispatchTool: async (name: string) => name.endsWith('list_repos') ? health : response(body) } as never,
      ) as { data: CodeIntelAnswer };
      expect(result.data.coverage?.sourceCompleteness).toBe('unverified');
      expect(result.data.error).toContain('status' in body ? 'ambiguous' : 'database unavailable');
    }
  });

  it('the same absence oracle kills a completeness mutation in an isolated module', async () => {
    const source = readFileSync(new URL('./gitnexus-facade.ts', import.meta.url), 'utf8');
    const target = "sourceCompleteness: 'unverified'";
    expect(source.split(target)).toHaveLength(2);
    const module = { exports: {} as any };
    const transformed = transformSync(source.replace(target, "sourceCompleteness: 'complete'"), {
      loader: 'ts', format: 'cjs',
    }).code;
    runInNewContext(transformed, {
      module, exports: module.exports,
      require: (name: string) => {
        if (name !== './contracts') throw new Error(`unexpected dependency ${name}`);
        return contracts;
      },
    });
    const answer = await module.exports.gitnexusFacade('symbol', { name: 'claimNextIssueWorkItem' }, dispatch);
    expect(() => assertMiss(answer)).toThrow();
  });
});
