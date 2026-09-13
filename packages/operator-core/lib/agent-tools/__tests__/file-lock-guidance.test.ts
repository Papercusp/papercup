/**
 * Pins the file-lock routing contract at every canonical prompt source.
 *
 * `locks:list` is the named-resource registry and accepts `resource`; the
 * file-lock read is `locks:queue { paths: [...] }`. This source guard keeps
 * role overlays and the su base persona from drifting back to the misleading
 * "who holds a file -> locks:list" advice.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const canonicalSources = [
  'apps/operator/prompts/architect.tools.md',
  'apps/operator/prompts/validator.tools.md',
  'apps/operator/prompts/worker.tools.md',
  'apps/operator/prompts/scoper.tools.md',
  'apps/operator/prompts/debugger.tools.md',
  'apps/operator/prompts/reviewer.tools.md',
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
  'apps/operator/prompts/pot-instances/papercup-pot.su.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
  'packages/operator-core/lib/agent-tools/coordination/tools/ask.ts',
  'packages/operator-core/lib/agent-tools/coordination/tools/presence.ts',
].map((relative) => resolve(repoRoot, relative));

const manualLockGuidanceSources = [
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
  'libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
].map((relative) => resolve(repoRoot, relative));

describe('canonical file-lock guidance', () => {
  it('routes file-holder reads to locks:queue and reserves locks:list for resources', () => {
    for (const path of canonicalSources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toContain('who holds a file → `locks:list`');
      expect(source, path).toContain('locks:queue');
    }
  });

  it('documents the repository-relative and external path domains for manual locks', () => {
    for (const path of manualLockGuidanceSources) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('`locks:acquire` requires a non-empty');
      expect(source, path).toContain('repository-relative POSIX');
      expect(source, path).toContain('InvalidPathError');
      expect(source, path).toContain('external_paths');
    }
  });
});
