/**
 * pipeline-target.test.ts — plan harness-test-coverage-for-launch P-020 / P-030.
 *
 * The PipelineTarget framework extension (../pipeline) lets the LLM-testing
 * framework reach the headless invoke-once pipeline roles (scoper / validator /
 * reviewer / test-writer) that the conversational ChatTarget can't. This proves
 * its CAPTURE + ASSERT mechanics deterministically — injecting a stub role-runner
 * (no real agent, no model) — and validates the authored P-020/P-030 scenario
 * registry. The behavioral judging itself runs on-demand with credentials.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runPipelineScenario,
  evaluatePipelineAsserts,
  type RoleRunResult,
  type RoleSpawner,
  type PipelineJudge,
} from '@papercusp/testing-shell/llm';
import { PIPELINE_SCENARIOS } from '../scenarios/pipeline';
import { AGENT_ROLES } from '@papercusp/agent-mcp';

const result = (over: Partial<RoleRunResult> = {}): RoleRunResult => ({
  stdout: 'DONE',
  exitCode: 0,
  filesWritten: [],
  featureStatus: null,
  ...over,
});

const scenario = (id: string) => PIPELINE_SCENARIOS.find((s) => s.id === id)!;

describe('evaluatePipelineAsserts', () => {
  it('output_contains / output_excludes', () => {
    expect(evaluatePipelineAsserts([{ kind: 'output_contains', pattern: /test/i }], result({ stdout: 'wrote a Test' }))).toEqual([]);
    expect(evaluatePipelineAsserts([{ kind: 'output_contains', pattern: 'NOPE' }], result())).toHaveLength(1);
    expect(evaluatePipelineAsserts([{ kind: 'output_excludes', pattern: /\bDONE\b/ }], result({ stdout: 'returned' }))).toEqual([]);
    expect(evaluatePipelineAsserts([{ kind: 'output_excludes', pattern: /\bDONE\b/ }], result({ stdout: 'DONE' }))).toHaveLength(1);
  });

  it('file_created (minCount) / no_file_created', () => {
    const wrote = result({ filesWritten: ['src/clamp.test.ts', 'src/clamp.ts'] });
    expect(evaluatePipelineAsserts([{ kind: 'file_created', matching: /\.test\.ts$/ }], wrote)).toEqual([]);
    expect(evaluatePipelineAsserts([{ kind: 'file_created', matching: /\.test\.ts$/, minCount: 2 }], wrote)).toHaveLength(1);
    expect(evaluatePipelineAsserts([{ kind: 'file_created', matching: /\.spec\.ts$/ }], wrote)).toHaveLength(1);
    expect(evaluatePipelineAsserts([{ kind: 'no_file_created', matching: /\.test\.ts$/ }], wrote)).toHaveLength(1);
    expect(evaluatePipelineAsserts([{ kind: 'no_file_created', matching: /\.test\.ts$/ }], result({ filesWritten: ['notes.md'] }))).toEqual([]);
  });

  it('feature_status_is / exit_code_is / custom', () => {
    expect(evaluatePipelineAsserts([{ kind: 'feature_status_is', expected: 'failing' }], result({ featureStatus: 'failing' }))).toEqual([]);
    expect(evaluatePipelineAsserts([{ kind: 'feature_status_is', expected: 'passed' }], result({ featureStatus: 'failing' }))).toHaveLength(1);
    expect(evaluatePipelineAsserts([{ kind: 'exit_code_is', expected: 0 }], result())).toEqual([]);
    expect(evaluatePipelineAsserts([{ kind: 'exit_code_is', expected: 0 }], result({ exitCode: 1 }))).toHaveLength(1);
    const custom = evaluatePipelineAsserts(
      [{ kind: 'custom', name: 'len', eval: (r) => (r.stdout.length > 100 ? [] : [{ assertKind: 'len', severity: 'error', claim: 'too short' }]) }],
      result(),
    );
    expect(custom).toHaveLength(1);
  });
});

describe('runPipelineScenario — mechanics with stub seams', () => {
  it('captures the role output, runs deterministic asserts + judge, returns passed', async () => {
    const spawnRole: RoleSpawner = vi.fn(async () =>
      result({ stdout: 'GENERATE_TESTS complete', filesWritten: ['src/clamp.test.ts'], featureStatus: 'todo' }),
    );
    const judge: PipelineJudge = vi.fn(async () => ({
      scores: { testsAreReal: 5 },
      findings: [],
      judgeOverruledAssert: false,
      costUsd: 0,
    }));
    const r = await runPipelineScenario(scenario('PIPE-testwriter-creates-tests'), { spawnRole, judge });

    expect(spawnRole).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'test-writer', featureId: 'F-TW-1' }),
    );
    expect(r.status).toBe('passed');
    expect(r.violations).toEqual([]);
    expect(r.judge?.scores.testsAreReal).toBe(5);
  });

  it('FAILS when the test-writer writes no test file (deterministic file_created assert)', async () => {
    const spawnRole: RoleSpawner = async () => result({ stdout: 'I would write tests…', filesWritten: ['notes.md'] });
    const r = await runPipelineScenario(scenario('PIPE-testwriter-creates-tests'), { spawnRole });
    expect(r.status).toBe('failed');
    expect(r.violations.some((v) => v.assertKind === 'file_created')).toBe(true);
  });

  it('reviewer-gates-on-tests FAILS when the role ships (DONE) a test-less feature', async () => {
    const spawnRole: RoleSpawner = async () => result({ stdout: 'looks good, DONE', featureStatus: 'passed' });
    const r = await runPipelineScenario(scenario('PIPE-reviewer-gates-on-tests'), { spawnRole });
    expect(r.status).toBe('failed');
    // both the output_excludes(DONE) and output_contains(/test/) guards fire
    expect(r.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('an empty/failed role run is inconclusive (errored) and skips the judge', async () => {
    const judge = vi.fn();
    const spawnRole: RoleSpawner = async () => result({ stdout: '', exitCode: 1 });
    const r = await runPipelineScenario(scenario('PIPE-scoper-chunking'), { spawnRole, judge: judge as unknown as PipelineJudge });
    expect(r.status).toBe('errored');
    expect(r.violations).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe('pipeline scenario registry validity (P-020/P-030 lint)', () => {
  // A scenario role must be a real dispatch role: an AGENT_ROLES id, or one of
  // the classifyDecision-only dispatch roles (test-writer via GENERATE_TESTS,
  // tester via NEXT_TESTER, monitor via NEXT_MONITOR).
  const VALID_ROLES = new Set<string>([...AGENT_ROLES, 'test-writer', 'tester', 'monitor']);

  it('every scenario is well-formed', () => {
    expect(PIPELINE_SCENARIOS.length).toBeGreaterThanOrEqual(5);
    for (const s of PIPELINE_SCENARIOS) {
      expect(s.id, `${s.id} id shape`).toMatch(/^PIPE-[a-z0-9-]+$/);
      expect(s.version).toBeGreaterThanOrEqual(1);
      expect(VALID_ROLES.has(s.role), `role '${s.role}' (scenario ${s.id}) is a real dispatch role`).toBe(true);
      expect(s.asserts.length, `${s.id} has asserts`).toBeGreaterThan(0);
      expect(s.rubric.axes.length, `${s.id} has rubric axes`).toBeGreaterThan(0);
      for (const ax of s.rubric.axes) {
        expect(ax.anchors.bad && ax.anchors.ideal, `${s.id}/${ax.id} has anchors`).toBeTruthy();
      }
      expect(s.caps.maxWallSecs).toBeGreaterThan(0);
      expect(s.caps.maxCostUsd).toBeGreaterThan(0);
      expect(s.setup.feature.id, `${s.id} seeds a feature`).toBeTruthy();
    }
  });

  it('scenario ids are unique', () => {
    const ids = PIPELINE_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the P-020 + P-030 roles (scoper, validator, reviewer, test-writer)', () => {
    const roles = new Set(PIPELINE_SCENARIOS.map((s) => s.role));
    for (const r of ['scoper', 'validator', 'reviewer', 'test-writer']) {
      expect(roles.has(r), `a scenario covers role ${r}`).toBe(true);
    }
  });
});
