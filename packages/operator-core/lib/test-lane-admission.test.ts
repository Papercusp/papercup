import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'packages/operator-core/package.json');
const PC_HEAVY = resolve(REPO_ROOT, 'scripts/pc-heavy.sh');

type PackageManifest = {
  scripts?: Record<string, string>;
};

const scripts = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as PackageManifest).scripts ?? {};

describe('operator-core test-lane admission', () => {
  it.each([
    ['test:lane-pure', 'pure'],
    ['test:lane-stateful', 'stateful'],
  ])('%s routes the full lane through pc-heavy', (scriptName, lane) => {
    const command = scripts[scriptName];

    expect(command, `${scriptName} must remain declared`).toBeTruthy();
    expect(command).toMatch(
      new RegExp(
        `^PC_TEST_LANE=${lane} \\.\\./\\.\\./scripts/pc-heavy\\.sh -- vitest run --passWithNoTests$`,
      ),
    );
  });

  it('keeps the shared wrapper executable from the workspace package directory', () => {
    expect(existsSync(PC_HEAVY)).toBe(true);
    expect(statSync(PC_HEAVY).mode & 0o111).not.toBe(0);
  });
});
