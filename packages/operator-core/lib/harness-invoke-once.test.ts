/**
 * Coverage for buildInvokeOnce — assembles the `node <tsx> <invoke-once.ts>`
 * command + env that three operator sites use to spawn a one-shot TS agent.
 * Locks in the documented, previously-bug-causing env nuances:
 *   - CLAUDE = AGENT_CMD ?? CLAUDE ?? 'omp -p'
 *   - DATABASE_URL uses `||` so an EMPTY string falls through to the admin URL
 *     (an empty value reaching the agent reads as "no PG DSN" and breaks spawn-mcp)
 *   - PAPERCUSP_USE_PG_STATE uses `??` so an explicit '0' override survives
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./harness-paths', () => ({
  tsxBin: () => '/bin/tsx-cli',
  invokeOnceBin: () => '/bin/invoke-once.ts',
}));
vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => 'postgres://admin/resolved',
}));

import { applyRoleModel, buildInvokeOnce, resolveSpawnBackendModel, type InvokeOnceSpec } from './harness-invoke-once';

const spec = (over: Partial<InvokeOnceSpec> = {}): InvokeOnceSpec => ({
  projectDir: '/proj',
  stateDir: '/proj/.papercusp',
  harnessDir: '/harness-pkg',
  role: 'worker',
  extras: ['MODE=proposal', 'FEATURE_ID=F-1'],
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe('buildInvokeOnce — command + core env', () => {
  it('runs node with the tsx cli + invoke-once bin', () => {
    const { command, args } = buildInvokeOnce(spec());
    expect(command).toBe('node');
    expect(args).toEqual(['/bin/tsx-cli', '/bin/invoke-once.ts']);
  });

  it('threads the project/state/harness dirs, role, and JSON-encoded extras', () => {
    const { env } = buildInvokeOnce(spec());
    expect(env.PROJECT_DIR).toBe('/proj');
    expect(env.STATE_DIR).toBe('/proj/.papercusp');
    expect(env.HARNESS_DIR).toBe('/harness-pkg');
    expect(env.LOG_DIR).toBe('/proj/.papercusp/logs');
    expect(env.ROLE).toBe('worker');
    expect(env.EXTRAS_JSON).toBe(JSON.stringify(['MODE=proposal', 'FEATURE_ID=F-1']));
  });

  it('sets RESULT_PATH only when a resultPath is given', () => {
    expect(buildInvokeOnce(spec()).env.RESULT_PATH).toBeUndefined();
    expect(buildInvokeOnce(spec({ resultPath: '/tmp/r.out' })).env.RESULT_PATH).toBe('/tmp/r.out');
  });

  it('merges extraEnv and skips undefined values', () => {
    const { env } = buildInvokeOnce(spec({ extraEnv: { SCOPER_MODE: 'x', SKIP: undefined } }));
    expect(env.SCOPER_MODE).toBe('x');
    expect(env.SKIP).toBeUndefined();
  });
});

describe('buildInvokeOnce — env-resolution nuances', () => {
  it("CLAUDE defaults to 'omp -p' when neither AGENT_CMD nor CLAUDE is set", () => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    expect(buildInvokeOnce(spec()).env.CLAUDE).toBe('omp -p');
  });

  it('CLAUDE prefers AGENT_CMD over CLAUDE', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('CLAUDE', 'should-not-win');
    expect(buildInvokeOnce(spec()).env.CLAUDE).toBe('claude -p');
  });

  it('DATABASE_URL: an EMPTY string falls through to the resolved admin URL (|| not ??)', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(buildInvokeOnce(spec()).env.DATABASE_URL).toBe('postgres://admin/resolved');
  });

  it('PAPERCUSP_DATABASE_URL tracks DATABASE_URL so the worker pg-bootstrap hits the SAME DB', () => {
    // pg-bootstrap.defaultDsn reads PAPERCUSP_DATABASE_URL (NOT DATABASE_URL), then
    // ~/.papercusp/embedded-pg.json, then :5432/papercusp. If unset, a worker whose
    // operator DB ≠ that fallback (the gym) connects to the wrong DB. Mirror DATABASE_URL
    // onto PAPERCUSP_DATABASE_URL so the worker's bootstrap tracks the operator's DB.
    vi.stubEnv('PAPERCUSP_DATABASE_URL', undefined as unknown as string);
    vi.stubEnv('DATABASE_URL', 'postgres://gym/db');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://gym/db');
  });

  it('PAPERCUSP_DATABASE_URL: an explicit value is kept (not overwritten by DATABASE_URL)', () => {
    vi.stubEnv('PAPERCUSP_DATABASE_URL', 'postgres://explicit/pg');
    vi.stubEnv('DATABASE_URL', 'postgres://other/db');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://explicit/pg');
  });

  it('PAPERCUSP_DATABASE_URL: empty DATABASE_URL falls through to the resolved admin URL', () => {
    vi.stubEnv('PAPERCUSP_DATABASE_URL', undefined as unknown as string);
    vi.stubEnv('DATABASE_URL', '');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_DATABASE_URL).toBe('postgres://admin/resolved');
  });

  it('DATABASE_URL: an explicit value is kept', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://explicit/db');
    expect(buildInvokeOnce(spec()).env.DATABASE_URL).toBe('postgres://explicit/db');
  });

  it("PAPERCUSP_USE_PG_STATE defaults to '1' but an explicit '0' override survives (??)", () => {
    vi.stubEnv('PAPERCUSP_USE_PG_STATE', undefined as unknown as string);
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_USE_PG_STATE).toBe('1');
    vi.stubEnv('PAPERCUSP_USE_PG_STATE', '0');
    expect(buildInvokeOnce(spec()).env.PAPERCUSP_USE_PG_STATE).toBe('0');
  });
});

describe('applyRoleModel — per-role model override', () => {
  it('overrides the global --model for a role with an AGENT_MODELS entry', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model sonnet');
  });

  it('leaves a role with NO entry on the base command (fast default)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'director')).toBe('claude -p --model haiku');
  });

  it('parses a <model>:<effort> spec → appends --model AND --effort', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'merge-resolver': 'claude-opus-4-8:xhigh' }));
    expect(applyRoleModel('claude -p --model haiku', 'merge-resolver')).toBe(
      'claude -p --model claude-opus-4-8 --effort xhigh',
    );
  });

  it('strips a pre-existing --effort and replaces it; keeps a colon-bearing model id when the suffix is not an effort', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus:max', reviewer: 'vendor/model:7b' }));
    // pre-existing --effort low is stripped, the role's max wins
    expect(applyRoleModel('claude -p --model haiku --effort low', 'worker')).toBe('claude -p --model opus --effort max');
    // ':7b' is not a known effort → the whole string stays as the model id (no --effort)
    expect(applyRoleModel('claude -p --model haiku', 'reviewer')).toBe('claude -p --model vendor/model:7b');
  });

  it('appends --model when the base command has none; handles --model=<x> form', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p', 'worker')).toBe('claude -p --model sonnet');
    expect(applyRoleModel('claude -p --model=haiku', 'worker')).toBe('claude -p --model sonnet');
  });

  it('no / unparseable / empty-entry AGENT_MODELS → base unchanged (fail-safe)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', 'not json');
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: '', scoper: 123 }));
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model haiku');
    expect(applyRoleModel('claude -p --model haiku', 'scoper')).toBe('claude -p --model haiku');
  });

  it('buildInvokeOnce overrides BOTH AGENT_CMD and CLAUDE per-role (resolveAgentCmd prefers AGENT_CMD)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model haiku');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    const w = buildInvokeOnce(spec({ role: 'worker' })).env;
    // Both must be the role command — only setting CLAUDE is masked by the
    // inherited AGENT_CMD (resolveAgentCmd reads AGENT_CMD ?? CLAUDE).
    expect(w.AGENT_CMD).toBe('claude -p --model sonnet');
    expect(w.CLAUDE).toBe('claude -p --model sonnet');
    const d = buildInvokeOnce(spec({ role: 'director' })).env;
    expect(d.AGENT_CMD).toBe('claude -p --model haiku');
    expect(d.CLAUDE).toBe('claude -p --model haiku');
  });
});

describe('applyRoleModel — committed ROLE_MODEL_DEFAULTS floor (EI-7)', () => {
  it('release-manager resolves to opus:xhigh with AGENT_MODELS UNSET (no silent downgrade)', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model opus --effort xhigh');
  });

  it('the committed default applies even when AGENT_MODELS is set for OTHER roles only', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'sonnet' }));
    expect(applyRoleModel('claude -p --model haiku', 'release-manager')).toBe('claude -p --model opus --effort xhigh');
  });

  it('an explicit AGENT_MODELS entry OVERRIDES the committed default (env wins)', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-manager': 'claude-opus-4-8:max' }));
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model claude-opus-4-8 --effort max');
  });

  it('malformed AGENT_MODELS still yields the committed default (fail-safe to the floor, not the CLI default)', () => {
    vi.stubEnv('AGENT_MODELS', 'not json');
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model opus --effort xhigh');
  });

  it('a role with neither an entry nor a committed default is still left unchanged', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p --model haiku', 'worker')).toBe('claude -p --model haiku');
  });

  it('resolveSpawnBackendModel keys release-manager to its committed opus bucket without env (RB-012)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(resolveSpawnBackendModel('release-manager')).toEqual({ backend: 'claude-code', model: 'opus' });
  });
});

describe('resolveSpawnBackendModel — governor bucket key for a pipeline spawn (RB-012)', () => {
  beforeEach(() => {
    // Hermetic baseline: the dev box's .env.local carries a real AGENT_MODELS
    // map (with a `worker` entry) — without this stub, applyRoleModel overrides
    // the AGENT_CMD model these tests assert (broke the green-checkpoint run,
    // which inherits the operator host's env).
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
  });

  it("default `omp -p` → omp backend (self-pacing), no model", () => {
    vi.stubEnv('AGENT_CMD', undefined as unknown as string);
    vi.stubEnv('CLAUDE', undefined as unknown as string);
    expect(resolveSpawnBackendModel('worker')).toEqual({ backend: 'omp', model: '' });
  });

  it('claude command → claude-code backend + the --model id', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model claude-opus-4-8');
    expect(resolveSpawnBackendModel('worker')).toEqual({ backend: 'claude-code', model: 'claude-opus-4-8' });
  });

  it('codex command → codex backend; -m short flag is read', () => {
    vi.stubEnv('AGENT_CMD', 'codex exec -m gpt-5.5');
    expect(resolveSpawnBackendModel('worker')).toEqual({ backend: 'codex', model: 'gpt-5.5' });
  });

  it('per-role AGENT_MODELS override flows into the resolved model (so opus/sonnet get separate buckets)', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model claude-sonnet-4-6');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ architect: 'claude-opus-4-8' }));
    expect(resolveSpawnBackendModel('architect')).toEqual({ backend: 'claude-code', model: 'claude-opus-4-8' });
    expect(resolveSpawnBackendModel('worker')).toEqual({ backend: 'claude-code', model: 'claude-sonnet-4-6' });
  });

  it('--model=<x> equals form is parsed', () => {
    vi.stubEnv('AGENT_CMD', 'claude -p --model=claude-haiku-4-5');
    expect(resolveSpawnBackendModel('worker')).toEqual({ backend: 'claude-code', model: 'claude-haiku-4-5' });
  });
});
