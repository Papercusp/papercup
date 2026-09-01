import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROMPT = resolve(
  __dirname,
  '../../../libs/papercusp/packages/harness/blueprints/base/prompts/content-fixer.md',
);

describe('content-fixer shared probe contract', () => {
  it('uses the canonical integration-root runner when the dispatched CWD lacks the npm script', () => {
    const text = readFileSync(PROMPT, 'utf8');

    expect(text).toContain('PAPERCUSP_INTEGRATION_ROOT');
    expect(text).toContain('scripts/content-lint-runner.mjs');
    expect(text).toContain('--file="$TARGET_ABS" --as="$TARGET_REL"');
    expect(text).toContain('content-lint runner unavailable');
    const probeSection = text.split('## The shared probe — ONE command, every detector', 2)[1] ?? '';
    expect(probeSection).not.toContain('npm run content-lint -- --file=<scope>/<file>');
  });
});
