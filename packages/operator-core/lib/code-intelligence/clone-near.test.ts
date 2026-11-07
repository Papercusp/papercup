import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { minhashTreeSimilarity } from './clone-engine-bench';
import { CLONE_NEAR_POLICY, compareCloneNear, fingerprintCloneNear, measureCloneNearSources } from './clone-near';

const fingerprint = (source: string) => fingerprintCloneNear(ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true));

describe('selected Type-3 product engine conformance', () => {
  it('R6 intelligence enriches candidate evidence without upgrading its certainty', () => {
    const read = 'const rows = await tools.workItems.list({state: "open"}); return rows;';
    const write = 'const items = await tools.workItems.remove({state: "done"}); return items;';
    const measured = measureCloneNearSources(read, write);
    // The AST deliberately erases tool names and literals. Even a score of 1
    // is only a candidate signal when the two effects are plainly different.
    expect(measured).toMatchObject({ status: 'measured', candidate: true, similarity: 1, candidateOnly: true });
    expect(measured.provenance.leftSha256).not.toBe(measured.provenance.rightSha256);
    expect(measured).not.toHaveProperty('equivalent');
    expect(measureCloneNearSources(read, 'const =')).toMatchObject({ status: 'unknown', candidateOnly: true });
    expect(measureCloneNearSources(read, 'x'.repeat(16_385))).toMatchObject({ status: 'unknown', reason: 'source-budget' });
    expect(measureCloneNearSources(read, 'a();'.repeat(200))).toMatchObject({ status: 'unknown', reason: 'syntax-or-node-budget' });
  });

  it('replays the frozen benchmark candidate decisions and exact scores without changing its oracle', () => {
    const evidence = JSON.parse(readFileSync(new URL('./__fixtures__/clone-engine-bench-20261023.json', import.meta.url), 'utf8'));
    expect(CLONE_NEAR_POLICY).toMatchObject({ seeds: 32, rowsPerBand: 4, shingleWidth: 3, threshold: 0.8 });
    expect(evidence.sample).toHaveLength(15);
    for (const pair of evidence.sample) {
      const left = fingerprint(pair.left), right = fingerprint(pair.right);
      expect(left.bands).toHaveLength(8);
      expect(compareCloneNear(left, right), pair.id).toEqual(minhashTreeSimilarity(pair.left, pair.right));
      expect(compareCloneNear(right, left), pair.id).toEqual(compareCloneNear(left, right));
    }
  });

  it('rescoring rejects an ordered-tree negative even when shingle bands collide', () => {
    const a = fingerprint('function f() { return 1; }');
    const b = fingerprint('function f() { if (true) { throw new Error("x"); } }');
    const result = compareCloneNear(a, { ...b, bands: a.bands });
    expect(result.candidate).toBe(true);
    expect(result.similarity).toBeLessThan(CLONE_NEAR_POLICY.threshold);
  });
});
