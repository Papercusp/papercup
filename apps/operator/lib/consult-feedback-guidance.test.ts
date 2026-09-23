import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const GUIDANCE_FILES = [
  'apps/operator/prompts/operator.tools.md',
  'apps/operator/prompts/papercup.tools.md',
  'apps/operator/prompts/papercup-deep.tools.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/agent-base-preamble.md',
];

describe('consult:get_feedback prompt guidance (P-008)', () => {
  for (const relativePath of GUIDANCE_FILES) {
    it(`${relativePath} encourages targeted use and blocks duplicate/live-state consults`, () => {
      const text = readFileSync(join(REPO, relativePath), 'utf8').toLowerCase();
      expect(text).toContain('consult:get_feedback');
      expect(text).toMatch(/first-pass check[\s\S]*local code, docs, or search/);
      expect(text).toContain('live state');
      expect(text).toContain('owner decisions');
      expect(text).toContain('known agent');
      expect(text).toContain('no_available_responder');
      expect(text).toContain('isolated answer session');
      expect(text).toMatch(/does not wake the expert/);
      expect(text).toContain('walled');
    });
  }
});
