import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessP007ReuseCensus,
  P007_CHANGED_FILES,
  P007_CALL_GRAPH_EDGES,
} from './p007-reuse-census';

function checkedOutSources(): Record<string, string> {
  const repoRoot = existsSync(resolve(process.cwd(), 'packages')) ? process.cwd() : resolve(process.cwd(), '../..');
  return Object.fromEntries(
    P007_CHANGED_FILES.map(({ path }) => [path, readFileSync(resolve(repoRoot, path), 'utf8')]),
  );
}

describe('P-007 R-006 reuse/call-graph census', () => {
  it('covers every recorded P-003..P-006 changed file and existing consumer edge', () => {
    const result = assessP007ReuseCensus(checkedOutSources());
    expect(result).toMatchObject({
      ok: true,
      checkedFiles: P007_CHANGED_FILES.length,
      checkedEdges: P007_CALL_GRAPH_EDGES.length,
      findings: [],
    });
  });

  it('catches a parallel-surface file added outside the completion population', () => {
    const sources = checkedOutSources();
    sources['packages/operator-core/lib/new-scheduler.ts'] = 'export class NewScheduler {}';
    const result = assessP007ReuseCensus(sources);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'unexpected-file',
      path: 'packages/operator-core/lib/new-scheduler.ts',
    }));
  });

  it.each(P007_CALL_GRAPH_EDGES)('catches a deleted required edge: $description', (edge) => {
    const sources = checkedOutSources();
    const original = sources[edge.path]!;
    const mutant = edge.requiredTokens.reduce((text, token) => text.replaceAll(token, ''), original);
    sources[edge.path] = mutant;
    const result = assessP007ReuseCensus(sources);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: 'missing-edge', path: edge.path, area: edge.area }));
  });
});
