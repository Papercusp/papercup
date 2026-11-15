import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isolatedRuntimeEvidenceKeys, isolatedRuntimeInheritedEnvironment } from '../../../../scripts/lib/with-test-pg-env.mjs';
import { LIVENESS_ALARM_HTTP_SUBJECTS, parseLivenessAlarmHttpSubject } from '../../test/liveness-alarm-http-controls';

describe('liveness HTTP fixture controls', () => {
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
      import { parseLivenessAlarmHttpSubject } from ${JSON.stringify(controlsUrl)};
      console.log(JSON.stringify({
        subjects: process.argv.slice(1).map(arg => parseLivenessAlarmHttpSubject([arg])),
        ambient: Object.hasOwn(process.env, 'LIVENESS_ALARM_HTTP_SUBJECT'),
        evidence: process.env.LIVENESS_ALARM_HTTP_EVIDENCE_DIR,
      }));
    `, '--', ...LIVENESS_ALARM_HTTP_SUBJECTS.map(subject => `--alarm-subject=${subject}`)], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual({ subjects: [...LIVENESS_ALARM_HTTP_SUBJECTS],
      ambient: false, evidence: '/owned-proof/liveness' });
  }, 35_000);
});
