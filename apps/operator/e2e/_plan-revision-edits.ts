import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export const diagnosticCitationCase = 'records the native author citation edit and reads the exact saved revision';

/** Observe the owned launcher's guard without logging commands, arguments, environment or process output. */
export function profilePlanLivenessGuard(path: string) {
  const started = performance.now();
  const script = readFileSync(path);
  const command = [
    'readonly profile_guard="$1"',
    'shift',
    'set -T',
    `trap '[[ "\${BASH_SOURCE[0]-}" != "$profile_guard" ]] || printf "%d %s\\n" "$LINENO" "$EPOCHREALTIME" >&3' DEBUG`,
    'source "$profile_guard"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', command, 'plan-liveness-diagnosis', path], {
    timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const marks = String(result.output?.[3] ?? '').trim().split('\n').filter(Boolean).map(line => {
    const parsed = /^(\d+) (\d+\.\d+)$/.exec(line);
    assert(parsed, 'Unexpected line timing record from the native guard');
    return { line: Number(parsed[1]), epochSeconds: parsed[2] };
  });
  const code = result.error && 'code' in result.error ? result.error.code : undefined;
  return { scriptSha256: createHash('sha256').update(script).digest('hex'), marks,
    elapsedMs: performance.now() - started, exitCode: result.status, signal: result.signal,
    errorCode: typeof code === 'string' ? code : null };
}

export function retainPlanLivenessProfile() {
  const env = process.env;
  const home = realpathSync(env.PAPERCUSP_HOME!);
  const guard = realpathSync(env.VERIFY_TAURI_LIVENESS_CHECK!);
  assert.equal(guard, join(dirname(home), 'check-live.sh'));
  assert.equal(home, join(dirname(guard), 'papercusp-home'));
  const path = join(env.PLAN_REVISION_EVIDENCE!, 'request.json');
  const request = JSON.parse(readFileSync(path, 'utf8'));
  assert(request.purpose === 'diagnosis' && request.caseTitle === diagnosticCitationCase
    && request.group === env.PAPERCUSP_TEST_RUN_GROUP && request.taskId === env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID
    && request.applicationRef === env.VERIFY_TAURI_SOURCE_REF && request.definitionRef === env.VERIFY_TAURI_TEST_SOURCE_REF);
  writeFileSync(join(dirname(path), 'cli-liveness-profile.json'), JSON.stringify({
    group: request.group, taskId: request.taskId, ...profilePlanLivenessGuard(guard),
  }) + '\n', { flag: 'wx', mode: 0o600 });
}

/** signup accepts 2–32 lowercase letters, digits, underscores and hyphens. */
export function privatePlanUsername(role: 'author' | 'reviewer' | 'worker') {
  return role + '-' + randomBytes(11).toString('hex');
}

/** Native commands can include account credentials in their arguments. Keep
 * the operation, failure class and original test frames without serializing them. */
export function nativePlanFailureDetails(error: unknown) {
  const e = error instanceof Error ? error as NodeJS.ErrnoException : undefined;
  const names = ['Error', 'TypeError', 'AssertionError', 'TimeoutError', 'AbortError', 'AggregateError'];
  const codes = ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ECONNRESET', 'ECONNREFUSED', 'ERR_ASSERTION'];
  const frames = (e?.stack ?? '').split('\n').filter(line => /^\s*at\s/.test(line)).flatMap(line => {
    const location = line.match(/(?:^|[/\\])(testing-native-runtime\.ts|plan-revision-amendment-native\.spec\.mts|plan-revision-amendment-native\.e2e\.test\.ts|_native-bridge-json\.ts|_plan-revision-retry\.ts):(\d+):(\d+)/);
    return location ? [location[1] + ':' + location[2] + ':' + location[3]] : [];
  });
  return { kind: e && names.includes(e.name) ? e.name : 'unknown',
    ...(e?.code && codes.includes(e.code) ? { code: e.code } : {}), frames: [...new Set(frames)] };
}

export function retainNativePlanFailure(door: 'api' | 'ptool' | 'desktop', scenario: NativePlanEdit['scenario'] | 'preflight',
  stage: string, error: unknown, elapsedMs: number) {
  const failure = { door, scenario, stage, elapsedMs, ...nativePlanFailureDetails(error) };
  const env = process.env;
  if (env.PLAN_REVISION_EVIDENCE && env.VERIFY_TAURI_TEST_SOURCE_REF) {
    assert(isAbsolute(env.PLAN_REVISION_EVIDENCE));
    const request = JSON.parse(readFileSync(join(env.PLAN_REVISION_EVIDENCE, 'request.json'), 'utf8'));
    assert(request.taskId && request.group && request.taskId === env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID
      && request.group === env.PAPERCUSP_TEST_RUN_GROUP && request.applicationRef === env.VERIFY_TAURI_SOURCE_REF
      && request.definitionRef === env.VERIFY_TAURI_TEST_SOURCE_REF, 'unexpected native failure evidence destination');
    const { taskId, group, applicationRef, definitionRef } = request;
    writeFileSync(join(env.PLAN_REVISION_EVIDENCE, 'plan-failure-' + randomUUID() + '.json'),
      JSON.stringify({ taskId, group, applicationRef, definitionRef, failure }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return failure;
}

export function planFixtureIdentity(workspace: string, fingerprint: string, env: NodeJS.ProcessEnv = process.env) {
  assert.match(workspace, /^verify-tauri-isolated-[0-9]+$/);
  assert.equal(env.PAPERCUSP_WORKSPACE, workspace);
  if (env.PAPERCUSP_WORKSPACE_ID !== undefined) assert.equal(env.PAPERCUSP_WORKSPACE_ID, workspace);
  assert.equal(env.VERIFY_TAURI_ISOLATED_DB, '1');
  assert.equal(env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1');
  assert.equal(env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.match(env.VERIFY_TAURI_SOURCE_REF ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.VERIFY_TAURI_TEST_SOURCE_REF ?? '', /^[a-f0-9]{40}$/);
  assert(env.OPERATOR_SOURCE_ROOT && isAbsolute(env.OPERATOR_SOURCE_ROOT));
  assert(env.PAPERCUSP_TEST_RUN_GROUP && env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID);
  return { schemaVersion: 1, workspace, fingerprint, applicationRoot: env.OPERATOR_SOURCE_ROOT,
    applicationCommit: env.VERIFY_TAURI_SOURCE_REF, definitionCommit: env.VERIFY_TAURI_TEST_SOURCE_REF,
    group: env.PAPERCUSP_TEST_RUN_GROUP, taskId: env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID };
}

/** Hermetic clients can read the registry seed receipt without inheriting a workspace write pin. */
export function readPreparedPlanHarness(workspace: string, fingerprint: string, env: NodeJS.ProcessEnv = process.env) {
  assert(env.PLAN_REVISION_EVIDENCE && isAbsolute(env.PLAN_REVISION_EVIDENCE));
  const receipt = JSON.parse(readFileSync(join(env.PLAN_REVISION_EVIDENCE, 'fixture.json'), 'utf8'));
  assert.deepEqual(receipt, { ...planFixtureIdentity(workspace, fingerprint, env), harness: 'e2e-fake-plan' },
    'prepared plan fixture does not belong to this application, driver, task and private workspace');
  return 'e2e-fake-plan';
}

export interface NativePlanEdit {
  scenario: 'citation' | 'cosmetic' | 'retry' | 'resumed' | 'material';
  heading: string;
  originalText: string;
  replacementText: string;
}

export const citationEdit: NativePlanEdit = {
  scenario: 'citation',
  heading: 'Reference',
  originalText: 'packages/operator-core/lib/plan-efficiency.ts:1',
  replacementText: 'packages/operator-core/lib/plan-efficiency.ts:2',
};

export const nativePlanEdits: readonly NativePlanEdit[] = [
  citationEdit,
  { ...citationEdit, scenario: 'retry' },
  {
    scenario: 'cosmetic',
    heading: 'Reference note',
    originalText: 'See the reference below',
    replacementText: 'See the reference below.',
  },
  {
    scenario: 'resumed',
    heading: 'Reference',
    originalText: 'packages/operator-core/lib/plan-efficiency.ts:2',
    replacementText: 'packages/operator-core/lib/plan-efficiency.ts:3',
  },
  {
    scenario: 'material',
    heading: 'Acceptance requirement',
    originalText: 'Complete the verification within one minute.',
    replacementText: 'Complete the verification within five minutes.',
  },
];

// Each separately seeded plan exercises the same three native client roles.
const nativePlanEditTimeoutMs = 360_000;
export const nativePlanComparisonTimeoutMs = nativePlanEdits.length * nativePlanEditTimeoutMs;
