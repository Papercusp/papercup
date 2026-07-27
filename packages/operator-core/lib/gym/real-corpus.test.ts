/**
 * The real gym corpus (plan gym-real-fitness-signal-2026-07-27, P-001; ruling D-003).
 *
 * These tests guard the properties that make the corpus REAL rather than a nicer-looking
 * set of toys. The toy corpus it replaces passed a `node --check` syntax gate, which is
 * why a worker could "declare done after only a syntax check" and still score.
 */
import { describe, expect, it } from 'vitest';
import {
  REAL_GYM_TASKS,
  buildRealCorpusSubstrate,
  realCorpusTasks,
  type RealGymTask,
} from './real-corpus';

describe('REAL_GYM_TASKS — corpus shape', () => {
  it('covers the three pools, so the anchors keep their jobs', () => {
    const pools = REAL_GYM_TASKS.map((t) => t.pool).sort();
    // train drives the proposer; dev-anchor guards optimization; real-anchor is scored
    // but never optimized (the falsifiability check).
    expect(pools).toEqual(['dev-anchor', 'real-anchor', 'train']);
  });

  it('every task cites auditable provenance — a task without a source is not real', () => {
    for (const t of REAL_GYM_TASKS) {
      expect(t.sourceRef.length, t.taskId).toBeGreaterThan(20);
      expect(t.sourceRef, t.taskId).toMatch(/papercusp/i);
    }
  });

  it('every task ships a REAL oracle test that exercises more than a happy path', () => {
    for (const t of REAL_GYM_TASKS) {
      // The oracle must import from the file the agent implements…
      expect(t.oracleTest, t.taskId).toContain(`./${t.implPath}`);
      // …and must contain several cases; a single-assertion oracle is a toy.
      const cases = t.oracleTest.match(/\bit\(/g) ?? [];
      expect(cases.length, `${t.taskId} oracle case count`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the stub does NOT solve the task — a do-nothing agent must fail', () => {
    for (const t of REAL_GYM_TASKS) {
      expect(t.stubFile, t.taskId).toContain('not implemented');
      // The stub must still declare the export the oracle imports, or the task is
      // unsolvable-by-construction rather than merely unsolved. Scope the extraction to
      // the IMPL import — the oracle also imports vitest, whose symbols the stub must
      // obviously not declare.
      const implImport = new RegExp(
        `import \\{([^}]+)\\} from '\\./${t.implPath.replace('.', '\\.')}'`,
      ).exec(t.oracleTest);
      expect(implImport, `${t.taskId} oracle must import from ./${t.implPath}`).toBeTruthy();
      const exported = implImport![1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(exported.length, `${t.taskId} imports`).toBeGreaterThan(0);
      for (const sym of exported) {
        expect(t.stubFile, `${t.taskId} stub must declare ${sym}`).toContain(sym);
      }
    }
  });

  it('task ids are unique and stable (they key gym_runs rows)', () => {
    const ids = REAL_GYM_TASKS.map((t) => t.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^real-/); // distinguishable from gym-loop-*
  });
});

describe('buildRealCorpusSubstrate', () => {
  const files = buildRealCorpusSubstrate();
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it('gates on RUNNING THE TESTS, not on a syntax check', () => {
    const pkg = JSON.parse(byPath.get('package.json')!) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.test).toContain('vitest run');
    expect(pkg.devDependencies.vitest).toBeTruthy();
    // No `--reporter=basic`: that reporter was removed in vitest 4 and makes the gate
    // fail with ERR_LOAD_URL before any test executes (found by running the substrate).
    expect(pkg.scripts.test).not.toContain('--reporter=basic');
    // The old toy substrate's ONLY gate was `node --check` — a syntactically valid stub
    // passed it. Here that command may exist but must not be the test gate.
    expect(pkg.scripts.test).not.toContain('node --check');
  });

  it('writes every task\'s stub AND its real test file', () => {
    for (const t of REAL_GYM_TASKS) {
      expect(byPath.has(t.implPath), t.implPath).toBe(true);
      expect(byPath.get(t.testPath), t.testPath).toBe(t.oracleTest); // VERBATIM
    }
  });

  it('tells the agent the tests are the oracle and must not be edited', () => {
    expect(byPath.get('README.md')).toMatch(/do not edit the test files/i);
  });

  it('accepts a task subset, so a cycle can run one task in isolation', () => {
    const one = buildRealCorpusSubstrate([REAL_GYM_TASKS[0] as RealGymTask]);
    expect(one.some((f) => f.path === REAL_GYM_TASKS[0]!.implPath)).toBe(true);
    expect(one.some((f) => f.path === REAL_GYM_TASKS[1]!.implPath)).toBe(false);
  });
});

describe('realCorpusTasks', () => {
  const rows = realCorpusTasks();

  it('labels every row corpus=real — this is what flips the release gate', () => {
    for (const r of rows) expect(r.corpus).toBe('real');
    expect(rows).toHaveLength(REAL_GYM_TASKS.length);
  });

  it('puts the provenance and the oracle rule in the context the agent sees', () => {
    for (const r of rows) {
      expect(r.projectContext).toMatch(/oracle/i);
      expect(r.projectContext).toMatch(/npm test/);
      expect(r.projectContext).toMatch(/Provenance:/);
    }
  });

  it('leaves repo pinning to the runner, exactly as the synthetic path does', () => {
    for (const r of rows) {
      expect(r.repoUrl).toBe('__SET_AT_RUNTIME__');
      expect(r.repoCommit).toBe('__SET_AT_RUNTIME__');
    }
  });
});
