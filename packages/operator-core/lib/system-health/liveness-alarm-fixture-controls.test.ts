import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isolatedRuntimeEvidenceKeys, isolatedRuntimeInheritedEnvironment } from '../../../../scripts/lib/with-test-pg-env.mjs';
import { LIVENESS_ALARM_HTTP_SUBJECTS, parseLivenessAlarmHttpControls, parseLivenessAlarmHttpSubject } from '../../test/liveness-alarm-http-controls';

describe('liveness HTTP fixture controls', () => {
  const digest = 'a'.repeat(64);

  it.each(LIVENESS_ALARM_HTTP_SUBJECTS)('requires the prepared artifact for %s in either argument order', subject => {
    const args = [`--alarm-subject=${subject}`, `--prepared-api-sha=${digest}`];
    expect(parseLivenessAlarmHttpControls(args)).toEqual({ subject, preparedApiSha: digest });
    expect(parseLivenessAlarmHttpControls([...args].reverse())).toEqual({ subject, preparedApiSha: digest });
  });

  it.each([
    [], ['--alarm-subject=agents-stranded'], [`--prepared-api-sha=${digest}`],
    ['--alarm-subject=agents-stranded', '--prepared-api-sha='],
    ['--alarm-subject=agents-stranded', '--prepared-api-sha=bad'],
    ['--alarm-subject=agents-stranded', `--prepared-api-sha=${'a'.repeat(63)}`],
    ['--alarm-subject=agents-stranded', `--prepared-api-sha=${'a'.repeat(65)}`],
    ['--alarm-subject=unknown', `--prepared-api-sha=${digest}`],
    ['--alarm-subject=agents-stranded', '--unrecognized'],
    [`--prepared-api-sha=${digest}`, `--prepared-api-sha=${digest}`],
    ['--alarm-subject=agents-stranded', `--prepared-api-sha=${digest}`, `--prepared-api-sha=${digest}`],
  ])('rejects incomplete, duplicate or malformed preparation controls %j before allocation', (...args) => {
    expect(() => parseLivenessAlarmHttpControls(args)).toThrow(/liveness fixture/);
  });

  it.each(LIVENESS_ALARM_HTTP_SUBJECTS)('selects the explicit %s subject', subject => {
    expect(parseLivenessAlarmHttpSubject([`--alarm-subject=${subject}`])).toBe(subject);
  });

  it.each([
    [], ['--alarm-subject='], ['--alarm-subject=unknown'], ['--alarm-subject=agents-wedged-extra'],
    ['--alarm-subject', 'agents-wedged'], ['agents-wedged'],
    ['--alarm-subject=agents-wedged', '--alarm-subject=agents-wedged'],
    ['--alarm-subject=agents-wedged', '--alarm-subject=agents-stranded'],
    ['--alarm-subject=agents-wedged', '--unrecognized'],
  ])('rejects invalid argv %j instead of falling back to wedged', (...argv) => {
    expect(() => parseLivenessAlarmHttpSubject(argv)).toThrow(/liveness fixture/);
  });

  it('preserves each explicit subject in a child after the real inherited-environment scrub', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const { environment, discardedKeys } = isolatedRuntimeInheritedEnvironment({ ...process.env,
      LIVENESS_ALARM_HTTP_SUBJECT: 'ambient-invalid-subject',
      LIVENESS_ALARM_HTTP_EVIDENCE_DIR: '/owned-proof/liveness',
      PAPERCUSP_OPERATOR_URL: 'https://live.invalid', PAPERCUSP_SID: 'live-owner',
    }, isolatedRuntimeEvidenceKeys('PAPERCUSP_TEST_OWNED_DB_DIR'));
    expect(discardedKeys).toEqual(expect.arrayContaining([
      'LIVENESS_ALARM_HTTP_SUBJECT', 'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_SID',
    ]));
    const controlsUrl = pathToFileURL(resolve(root, 'packages/operator-core/test/liveness-alarm-http-controls.ts')).href;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { parseLivenessAlarmHttpControls } from ${JSON.stringify(controlsUrl)};
      console.log(JSON.stringify({
        controls: process.argv.slice(1).map(arg => parseLivenessAlarmHttpControls([arg, '--prepared-api-sha=${digest}'])),
        ambient: Object.hasOwn(process.env, 'LIVENESS_ALARM_HTTP_SUBJECT'),
        evidence: process.env.LIVENESS_ALARM_HTTP_EVIDENCE_DIR,
      }));
    `, '--', ...LIVENESS_ALARM_HTTP_SUBJECTS.map(subject => `--alarm-subject=${subject}`)], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual({ controls: LIVENESS_ALARM_HTTP_SUBJECTS.map(subject => ({ subject, preparedApiSha: digest })),
      ambient: false, evidence: '/owned-proof/liveness' });
  }, 35_000);
});
