import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** signup accepts 2–32 lowercase letters, digits, underscores and hyphens. */
export function privatePlanUsername(role: 'author' | 'reviewer' | 'worker') {
  return role + '-' + randomBytes(11).toString('hex');
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
