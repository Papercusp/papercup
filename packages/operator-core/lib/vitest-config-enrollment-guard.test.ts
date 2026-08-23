import { describe, expect, it } from 'vitest';
import {
  collectVitestConfigs,
  findUnenrolledConfigs,
  isReporterEnrolled,
  PLAIN_CONFIG_EXEMPTIONS,
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- guard script is plain .mjs and intentionally has no declaration file.
} from '../../../scripts/check-vitest-config-enrollment.mjs';

describe('Vitest config enrollment guard', () => {
  it('recognizes the shared base and explicit reporter wiring', () => {
    expect(
      isReporterEnrolled(
        `import { defineVitestConfig } from '@papercusp/test-config/vitest-config';\nexport default defineVitestConfig({ layer: 'unit' });`,
      ),
    ).toBe(true);
    expect(
      isReporterEnrolled(
        `import { ADMIN_TEST_RUNS_REPORTER_PATH } from '@papercusp/test-config/vitest-config';\nexport default { test: { reporters: [ADMIN_TEST_RUNS_REPORTER_PATH] } };`,
      ),
    ).toBe(true);
  });

  it('ignores comments and flags a plain config outside the exact exemption set', () => {
    expect(
      findUnenrolledConfigs([
        {
          path: 'libs/generic/new-package/vitest.config.ts',
          content: '// defineVitestConfig is intentionally not called here\nexport default {};',
        },
        {
          path: 'libs/generic/card-stack/vitest.config.ts',
          content: 'export default {};',
        },
      ]),
    ).toEqual(['libs/generic/new-package/vitest.config.ts']);
    expect(PLAIN_CONFIG_EXEMPTIONS.has('libs/generic/new-package/vitest.config.ts')).toBe(false);
  });

  it('does not treat reporter tokens quoted in config data as live enrollment code', () => {
    expect(
      isReporterEnrolled(
        [
          "import { defineVitestConfig } from '@papercusp/test-config/vitest-config';",
          "const explanation = 'defineVitestConfig(';",
          "const reporterName = 'ADMIN_TEST_RUNS_REPORTER_PATH';",
          'export default {};',
        ].join('\n'),
        'vitest.config.ts',
      ),
    ).toBe(false);
  });

  it('keeps every declared workspace config enrolled at repository HEAD', () => {
    const findings = findUnenrolledConfigs(collectVitestConfigs());
    expect(findings, findings.join('\n')).toEqual([]);
  });
});
