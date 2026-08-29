/**
 * Recurrence guard for EI-21751634175352001.
 *
 * A nine-error parse failure sat undetected in `infra/images/workspace-host.pkr.hcl`
 * because NOTHING in the tree ever ran packer against it. The neighbouring
 * `gcp-image-family-adapter.test.ts` asserts that the release path CALLS
 * `packer init` then `packer validate` before `build` — but it does so through a
 * fully mocked command runner (see its `commandRunner` fake). That proves the
 * WIRING and can never prove the TEMPLATE ITSELF parses: every assertion there
 * passes just as happily against a template full of syntax errors.
 *
 * This file closes that gap by running the real binary against the real file.
 *
 * `-syntax-only` is deliberate. It parses the template without evaluating
 * expressions, so it needs no plugins (no `packer init`), no credentials, no
 * network and no variables — hermetic enough to sit in the unit suite and finish
 * in milliseconds. The value-EVALUATING full `packer validate` deliberately stays
 * on the release path in `gcp-image-family-adapter.ts`, where it can be handed the
 * real build variables; see that file's comment for why both layers exist.
 *
 * Scope note, so this guard is not over-trusted the way `-syntax-only` was over-
 * trusted on the release preflight before it: passing here means the template
 * PARSES. It does not mean the build will succeed. It cannot see API-contract
 * faults in field values (EI-21763610698235066) or shell-quoting / run-time
 * provisioner faults (EI-21765303428371500, convention D-167) — those are guarded
 * by static template-text assertions in `gcp-image-family-adapter.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const IMAGES_DIR = join(REPO_ROOT, 'infra', 'images');

/**
 * Missing directory returns [] rather than throwing, so the "did we find
 * anything" assertion below reports it as a named failure instead of a
 * collection crash that reads like an infrastructure problem.
 */
function discoverTemplates(): string[] {
  try {
    return readdirSync(IMAGES_DIR)
      .filter((entry) => entry.endsWith('.pkr.hcl'))
      .sort();
  } catch {
    return [];
  }
}

function packerVersion(): string | null {
  const probe = spawnSync('packer', ['version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.status !== 0) return null;
  return (probe.stdout ?? '').trim().split('\n')[0] ?? 'unknown';
}

const TEMPLATES = discoverTemplates();
const PACKER_VERSION = packerVersion();

describe('infra/images packer templates', () => {
  // These two run with or without packer installed. They are what stops the
  // guard from silently degrading into a no-op: if the templates are renamed,
  // moved, or deleted, the per-template checks below would quietly iterate over
  // an empty list and the suite would still be green.
  it('discovers at least one .pkr.hcl template to guard', () => {
    expect(
      TEMPLATES,
      `No *.pkr.hcl found in ${IMAGES_DIR}. If templates moved, update IMAGES_DIR — ` +
        'do not delete this guard: an unparsed template is exactly how EI-21751634175352001 happened.',
    ).not.toHaveLength(0);
  });

  it('still covers the workspace-host template by name', () => {
    expect(TEMPLATES).toContain('workspace-host.pkr.hcl');
  });

  for (const template of TEMPLATES) {
    it(`${template} passes \`packer validate -syntax-only\``, (ctx) => {
      if (PACKER_VERSION === null) {
        // Loud, attributable skip. A machine without packer cannot run this leg,
        // but the reason is stated rather than reported as a pass.
        ctx.skip('packer is not on PATH — cannot parse-check the template on this machine');
        return;
      }

      const result = spawnSync('packer', ['validate', '-syntax-only', join(IMAGES_DIR, template)], {
        cwd: IMAGES_DIR,
        encoding: 'utf8',
        timeout: 120_000,
      });

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      expect(
        result.status,
        `\`packer validate -syntax-only ${template}\` exited ${result.status} ` +
          `under ${PACKER_VERSION}.\n\n${output}`,
      ).toBe(0);
    });
  }
});
