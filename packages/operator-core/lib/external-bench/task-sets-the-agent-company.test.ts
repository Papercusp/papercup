/**
 * TheAgentCompany task-set loader unit tests (plan benchmark-suite-theagentcompany-2026-06-17).
 *
 * Focus: the TAC loaders (`the-agent-company-pilot` / `the-agent-company` / `the-agent-company-custom`) read
 * the TAC JSONL, map it through {@link theAgentCompanyRowToBenchTask} (NOT the SWE-bench mappers), carry
 * `benchmark: 'the-agent-company'`, derive the in-container grader inputs (image / category / task_name in
 * graderMeta, NO repo/baseCommit), default a problemStatement when the row omits it, surface `tier`, and that
 * knownTaskSets() advertises the sets + a missing corpus throws honestly. Temp fixtures + env overrides →
 * host-independent (no network / no docker).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knownTaskSets, loadBenchTaskSet, theAgentCompanyRowToBenchTask } from './task-sets';

let dir: string;

// Representative TAC rows (the schema written to the-agent-company/{tasks,pilot}.jsonl): a task name, a
// professional category, the GHCR image, an optional short title, max_points, and a derived tier.
const ROW_SDE = {
  task_name: 'sde-add-one-unit-test',
  category: 'sde',
  image: 'ghcr.io/theagentcompany/sde-add-one-unit-test-image:1.0.0',
  problem_statement: 'Add a unit test for the foo() helper and open an MR.',
  max_points: 5,
  tier: 'easy' as const,
};
const ROW_HR = {
  task_name: 'hr-resume-screening',
  category: 'hr',
  image: 'ghcr.io/theagentcompany/hr-resume-screening-image:1.0.0',
  // no problem_statement → loader defaults one
  max_points: 8,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tac-'));
  writeFileSync(join(dir, 'tasks.jsonl'), [JSON.stringify(ROW_SDE), JSON.stringify(ROW_HR)].join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'pilot.jsonl'), JSON.stringify(ROW_SDE) + '\n', 'utf8');
  process.env.PAPERCUSP_BENCH_TAC_JSONL = join(dir, 'tasks.jsonl');
  process.env.PAPERCUSP_BENCH_TAC_PILOT_JSONL = join(dir, 'pilot.jsonl');
});

afterEach(() => {
  delete process.env.PAPERCUSP_BENCH_TAC_JSONL;
  delete process.env.PAPERCUSP_BENCH_TAC_PILOT_JSONL;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('theAgentCompanyRowToBenchTask', () => {
  it('maps to the the-agent-company family with in-container grader meta (no repo/baseCommit)', () => {
    const t = theAgentCompanyRowToBenchTask(ROW_SDE);
    expect(t.benchmark).toBe('the-agent-company');
    expect(t.instanceId).toBe('sde-add-one-unit-test');
    expect(t.problemStatement).toBe('Add a unit test for the foo() helper and open an MR.');
    expect(t.repo).toBeUndefined();
    expect(t.baseCommit).toBeUndefined();
    expect(t.tier).toBe('easy');
    expect(t.graderMeta.image).toBe('ghcr.io/theagentcompany/sde-add-one-unit-test-image:1.0.0');
    expect(t.graderMeta.category).toBe('sde');
    expect(t.graderMeta.task_name).toBe('sde-add-one-unit-test');
    expect(t.graderMeta.max_points).toBe(5);
    expect(t.graderMeta.tier).toBe('easy');
  });

  it('defaults a problemStatement (the real brief is /instruction/task.md in-container) + category=other', () => {
    const t = theAgentCompanyRowToBenchTask({ task_name: 'admin-x' });
    expect(t.problemStatement).toMatch(/admin-x/);
    expect(t.problemStatement).toMatch(/instruction\/task\.md/);
    expect(t.graderMeta.category).toBe('other');
    expect(t.graderMeta.image).toBe('');
  });
});

describe('loadBenchTaskSet (TheAgentCompany)', () => {
  it('the-agent-company-pilot reads the pilot subset', async () => {
    const tasks = await loadBenchTaskSet('the-agent-company-pilot');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('sde-add-one-unit-test');
    expect(tasks[0].benchmark).toBe('the-agent-company');
  });

  it('the-agent-company reads the full manifest', async () => {
    const tasks = await loadBenchTaskSet('the-agent-company');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['hr-resume-screening', 'sde-add-one-unit-test']);
  });

  it('the-agent-company-custom filters to the requested task ids', async () => {
    const tasks = await loadBenchTaskSet('the-agent-company-custom', ['hr-resume-screening']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('hr-resume-screening');
    // the HR row had no problem_statement → defaulted
    expect(tasks[0].problemStatement).toMatch(/hr-resume-screening/);
  });

  it('the-agent-company-custom with an empty id list rejects', async () => {
    await expect(loadBenchTaskSet('the-agent-company-custom', [])).rejects.toThrow(/non-empty taskIds/);
  });

  it('a missing corpus throws an honest not-provisioned error', async () => {
    process.env.PAPERCUSP_BENCH_TAC_JSONL = join(dir, 'does-not-exist.jsonl');
    await expect(loadBenchTaskSet('the-agent-company')).rejects.toThrow(/not found|provision/i);
  });
});

describe('knownTaskSets', () => {
  it('advertises the TheAgentCompany pilot + full sets with counts from the fixtures', () => {
    const sets = knownTaskSets();
    const pilot = sets.find((s) => s.id === 'the-agent-company-pilot');
    const full = sets.find((s) => s.id === 'the-agent-company');
    expect(pilot).toBeTruthy();
    expect(pilot!.count).toBe(1);
    expect(full).toBeTruthy();
    expect(full!.count).toBe(2);
  });
});
