import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const operatorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = resolve(operatorRoot, 'TESTING.md');
const frameworkDocPath = resolve(
  operatorRoot,
  '../operator-docs/src/content/docs/testing/index.mdx',
);

describe('operator testing documentation contract', () => {
  it('ships the required project guide with an actionable run matrix', () => {
    expect(existsSync(guidePath)).toBe(true);

    const guide = readFileSync(guidePath, 'utf8');
    for (const heading of [
      "## What this project's tests cover",
      "## What they don't cover",
      '## Run after editing',
      '### Run matrix',
      '## Local dev',
    ]) {
      expect(guide, `missing required section: ${heading}`).toContain(heading);
    }

    for (const command of [
      'npm run test:file -- apps/operator/',
      'npm --workspace @papercusp/web run test:integration',
      'npm --workspace @papercusp/web run test:e2e',
      'npm --workspace @papercusp/web run lint:tests',
      'npm --workspace @papercusp/web run typecheck',
    ]) {
      expect(guide, `missing required command: ${command}`).toContain(command);
    }
  });

  it('keeps the framework testing page aligned with the operator rollout', () => {
    const frameworkDoc = readFileSync(frameworkDocPath, 'utf8');

    expect(frameworkDoc).toContain('Phase 3: TESTING.md present in 16 packages');
    expect(frameworkDoc).toContain('`apps/operator/TESTING.md`');
  });
});
