// baseline.test.js — the seed app's PRE-EXISTING green suite. It must stay GREEN at the
// seeded commit (the planted bugs are LATENT — not exercised here), so the Hive's run
// starts from a passing baseline and `regressionsFromTests` (HE-04) has a real floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord } from '../src/parser.js';
import { rankItems, scoreItem } from '../src/ranker.js';
import { runPipeline } from '../src/pipeline.js';

test('parseRecord parses well-formed records', () => {
  assert.deepEqual(parseRecord('weight=2;signal=3'), { weight: '2', signal: '3' });
});

test('scoreItem multiplies weight by signal', () => {
  assert.equal(scoreItem({ weight: 2, signal: 3 }), 6);
});

test('rankItems orders by descending score', () => {
  const ranked = rankItems([
    { weight: 1, signal: 1 },
    { weight: 2, signal: 3 },
    { weight: 1, signal: 2 },
  ]);
  assert.deepEqual(ranked.map(scoreItem), [6, 2, 1]);
});

test('runPipeline ranks parsed records', () => {
  const out = runPipeline(['weight=2;signal=3', 'weight=1;signal=1']);
  assert.equal(out.length, 2);
  assert.equal(scoreItem(out[0]), 6);
});
