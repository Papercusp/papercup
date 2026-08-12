import { describe, expect, it } from 'vitest';
import {
  evaluatePendingCodeDeployMigration,
  parseRequiredDeployedMarker,
  pendingCodeDeployFailures,
  resolveDeployedReleaseRoot,
  verifyPendingCodeDeployMigration,
} from './migration-deploy-guard';

const PENDING = `-- PENDING-CODE-DEPLOY: keep parked until the companion ships
-- REQUIRES-DEPLOYED: packages/operator-core/lib/issues-engineer.ts#EI-test-companion
SELECT 1;`;

describe('PENDING-CODE-DEPLOY migration guard', () => {
  it('parses a repository-relative required source marker', () => {
    expect(parseRequiredDeployedMarker(PENDING)).toEqual({
      sourcePath: 'packages/operator-core/lib/issues-engineer.ts',
      marker: 'EI-test-companion',
    });
  });

  it('passes only when the deployed source contains the required marker', () => {
    expect(
      evaluatePendingCodeDeployMigration({
        filename: '900-example.sql',
        sqlText: PENDING,
        releaseRoot: '/release',
        deployedSha: 'abcdef1234567890',
        deployedSourceText: '// EI-test-companion\n',
      }).ok,
    ).toBe(true);

    const missing = evaluatePendingCodeDeployMigration({
      filename: '900-example.sql',
      sqlText: PENDING,
      releaseRoot: '/release',
      deployedSha: 'abcdef1234567890',
      deployedSourceText: '// old writer\n',
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('deploy the companion code before applying it');
  });

  it('fails closed when a pending migration omits the required marker', () => {
    const result = evaluatePendingCodeDeployMigration({
      filename: '900-example.sql',
      sqlText: '-- PENDING-CODE-DEPLOY: intentionally parked\nSELECT 1;',
      releaseRoot: '/release',
      deployedSourceText: '// anything',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no valid `REQUIRES-DEPLOYED: path#marker` line');
  });

  it('never accepts an absolute or traversal source path', () => {
    expect(parseRequiredDeployedMarker('-- PENDING-CODE-DEPLOY\n-- REQUIRES-DEPLOYED: ../secret#marker')).toBeNull();
    expect(parseRequiredDeployedMarker('-- PENDING-CODE-DEPLOY\n-- REQUIRES-DEPLOYED: /etc/passwd#marker')).toBeNull();
  });

  it('checks git HEAD through the injected readers and reports the deployed SHA', () => {
    const result = verifyPendingCodeDeployMigration({
      filename: '900-example.sql',
      sqlText: PENDING,
      releaseRoot: '/release',
      resolveHead: () => 'deadbeef1234567890',
      readAtHead: (_root, sourcePath) => `// ${sourcePath}\nEI-test-companion\n`,
    });
    expect(result).toMatchObject({ ok: true, deployedSha: 'deadbeef1234567890', releaseRoot: '/release' });
  });

  it('finds every armed pending migration and leaves unmarked SQL alone', () => {
    const files: Record<string, string> = {
      '900-good.sql': PENDING,
      '901-normal.sql': 'CREATE TABLE normal (id int);',
      '902-bad.sql': '-- PENDING-CODE-DEPLOY\nSELECT 1;',
    };
    const failures = pendingCodeDeployFailures({
      sqlDir: '/sql',
      readdir: () => Object.keys(files),
      readFile: (file) => files[file.replace('/sql/', '')]!,
      releaseRoot: '/release',
      verify: ({ filename, sqlText }) =>
        filename === '900-good.sql'
          ? { ok: true, filename }
          : { ok: false, filename, error: `${filename} blocked in test`, ...(sqlText ? {} : {}) },
    });
    expect(failures).toEqual([{ file: '902-bad.sql', error: '902-bad.sql blocked in test' }]);
  });

  it('prefers the canonical sibling release over a staging process root', () => {
    expect(
      resolveDeployedReleaseRoot('/ws/papercusp-staging/libs/papercusp/libs/db/sql', {
        PAPERCUSP_INTEGRATION_ROOT: '/ws/papercusp',
        PAPERCUSP_RELEASE_ROOT: '/ws/papercusp-staging',
      }),
    ).toBe('/ws/papercusp-release');
  });

  it('does not derive a release-release path when the current process is already deployed', () => {
    expect(resolveDeployedReleaseRoot('/ws/papercusp-release/libs/papercusp/libs/db/sql', {})).toBe(
      '/ws/papercusp-release',
    );
    expect(
      resolveDeployedReleaseRoot('/ws/papercusp-staging/libs/papercusp/libs/db/sql', {
        PAPERCUSP_RELEASE_ROOT: '/ws/papercusp-staging',
      }),
    ).toBe('/ws/papercusp-release');
  });
});
