/**
 * Named task-set loader unit tests (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-005).
 *
 * Focus: the `stratified-30` loader — that it reads its JSONL, merges the per-task tier from
 * tiers.json onto each BenchTask (first-class `tier` field + graderMeta.tier), still derives the
 * grader dockerhub_tag / FAIL_TO_PASS the same way as the pilot loader, and that knownTaskSets()
 * advertises the set. Uses temp fixtures + the env overrides so it is host-independent.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knownTaskSets, loadBenchTaskSet, rowToBenchTask } from './task-sets';

let dir: string;

const ROW_EASY = {
  instance_id: 'instance_NodeBB__NodeBB-deadbeef-vnan',
  repo: 'NodeBB/NodeBB',
  base_commit: 'abc1234',
  problem_statement: 'easy problem',
  fail_to_pass: "['test/a.js | should pass']",
  selected_test_files_to_run: '["test/a.js"]',
};
const ROW_HARD = {
  instance_id: 'instance_ansible__ansible-cafe1234-vfeed',
  repo: 'ansible/ansible',
  base_commit: 'def5678',
  problem_statement: 'hard problem',
  fail_to_pass: "['test/b.py | should also pass', 'test/b.py | and this']",
  selected_test_files_to_run: '["test/b.py"]',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strat30-'));
  writeFileSync(join(dir, 'tasks.jsonl'), [JSON.stringify(ROW_EASY), JSON.stringify(ROW_HARD)].join('\n') + '\n', 'utf8');
  writeFileSync(
    join(dir, 'tiers.json'),
    JSON.stringify({
      [ROW_EASY.instance_id]: { tier: 'easy', score: 0.1 },
      [ROW_HARD.instance_id]: { tier: 'hard', score: 0.72 },
    }),
    'utf8',
  );
  process.env.PAPERCUSP_BENCH_STRATIFIED_JSONL = join(dir, 'tasks.jsonl');
  process.env.PAPERCUSP_BENCH_STRATIFIED_TIERS = join(dir, 'tiers.json');
});

afterEach(() => {
  delete process.env.PAPERCUSP_BENCH_STRATIFIED_JSONL;
  delete process.env.PAPERCUSP_BENCH_STRATIFIED_TIERS;
  rmSync(dir, { recursive: true, force: true });
});

describe('stratified-30 task set', () => {
  it('loads every row and merges the tier from tiers.json', async () => {
    const tasks = await loadBenchTaskSet('stratified-30');
    expect(tasks).toHaveLength(2);

    const easy = tasks.find((t) => t.instanceId === ROW_EASY.instance_id)!;
    const hard = tasks.find((t) => t.instanceId === ROW_HARD.instance_id)!;
    expect(easy.tier).toBe('easy');
    expect(hard.tier).toBe('hard');
    // tier is also carried inside graderMeta for downstream per-tier reporting
    expect(easy.graderMeta.tier).toBe('easy');
    expect(hard.graderMeta.tier).toBe('hard');
  });

  it('derives the grader dockerhub_tag + FAIL_TO_PASS the same as the pilot loader', async () => {
    const tasks = await loadBenchTaskSet('stratified-30');
    const easy = tasks.find((t) => t.instanceId === ROW_EASY.instance_id)!;
    // -vnan is stripped from the hash by dockerhubTag()
    expect(easy.graderMeta.dockerhub_tag).toBe('nodebb.nodebb-NodeBB__NodeBB-deadbeef');
    expect(easy.graderMeta.FAIL_TO_PASS).toEqual(['test/a.js | should pass']);

    const hard = tasks.find((t) => t.instanceId === ROW_HARD.instance_id)!;
    expect(hard.graderMeta.dockerhub_tag).toBe('ansible.ansible-ansible__ansible-cafe1234-vfeed');
    expect(hard.graderMeta.FAIL_TO_PASS).toEqual(['test/b.py | should also pass', 'test/b.py | and this']);
  });

  it('falls back to a row-level tier when tiers.json lacks the instance', () => {
    // rowToBenchTask carries an explicit row tier even with no tiers.json lookup
    const t = rowToBenchTask({ ...ROW_EASY, tier: 'medium' });
    expect(t.tier).toBe('medium');
    expect(t.graderMeta.tier).toBe('medium');
  });

  it('omits tier entirely when neither the row nor tiers.json provides one', () => {
    const t = rowToBenchTask(ROW_EASY);
    expect(t.tier).toBeUndefined();
    expect(t.graderMeta.tier).toBeUndefined();
  });

  it('is advertised by knownTaskSets with its on-disk count', () => {
    const sets = knownTaskSets();
    const strat = sets.find((s) => s.id === 'stratified-30');
    expect(strat).toBeDefined();
    expect(strat!.count).toBe(2);
    expect(strat!.label).toMatch(/easy/i);
  });
});
