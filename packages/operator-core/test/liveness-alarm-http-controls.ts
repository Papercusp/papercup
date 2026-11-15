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
