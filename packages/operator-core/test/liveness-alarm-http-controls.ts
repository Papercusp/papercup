import assert from 'node:assert/strict';

export const LIVENESS_ALARM_HTTP_SUBJECTS = [
  'agents-wedged', 'agents-stranded', 'hosted-control-plane-degraded',
  'hosted-reverse-connector-lost', 'platform-lifecycle-budget-exceeded', 'population-acceptance',
] as const;

export type LivenessAlarmHttpSubject = typeof LIVENESS_ALARM_HTTP_SUBJECTS[number];

/** Fixture controls travel in argv; the private runtime deliberately scrubs ambient flags. */
export function parseLivenessAlarmHttpSubject(argv: readonly string[]): LivenessAlarmHttpSubject {
  assert.equal(argv.length, 1, 'liveness fixture requires exactly one --alarm-subject=<subject> argument');
  const prefix = '--alarm-subject=';
  assert.ok(argv[0].startsWith(prefix), 'liveness fixture requires --alarm-subject=<subject>');
  const subject = argv[0].slice(prefix.length);
  assert.ok(LIVENESS_ALARM_HTTP_SUBJECTS.some(value => value === subject),
    `unsupported liveness fixture subject: ${subject}`);
  return subject as LivenessAlarmHttpSubject;
}

/** Compilation belongs to the parent's retained prepare phase, before private PG starts. */
export function parseLivenessAlarmHttpControls(argv: readonly string[]) {
  assert.equal(argv.length, 2, 'liveness fixture requires a subject and one prepared API digest');
  const subjects = argv.filter(value => value.startsWith('--alarm-subject='));
  const prepared = argv.filter(value => value.startsWith('--prepared-api-sha='));
  const subject = parseLivenessAlarmHttpSubject(subjects);
  assert.equal(prepared.length, 1, 'liveness fixture requires one --prepared-api-sha=<sha256>');
  const preparedApiSha = prepared[0].slice('--prepared-api-sha='.length);
  assert.match(preparedApiSha, /^[a-f0-9]{64}$/, 'liveness fixture prepared API digest must be SHA256');
  return { subject, preparedApiSha };
}
