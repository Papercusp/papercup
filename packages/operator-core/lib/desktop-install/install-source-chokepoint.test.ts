import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * CHOKEPOINT GUARD for the install-source refusal (WI-37405).
 *
 * `filterInstallSources` is only worth anything if EVERY install-source resolution in
 * `installPapercuspFiles()` actually goes through it. The unit tests prove the decision
 * logic; this proves the wiring — that no resolution site quietly bypasses the guard by
 * calling `firstExisting(<candidates>)` directly.
 *
 * That failure mode is not hypothetical here. The repo has been bitten by exactly this
 * shape before: the tauri dev-slot claim lived on one launcher as a convention each new
 * launcher had to remember, three forgot, and the documented-safe path was itself
 * unprotected (EI-19369470572700441). `tauri-dev-slot-chokepoint.test.js` is the
 * precedent for pinning it structurally instead of trusting reviewers to notice.
 *
 * Deliberately a SOURCE-level assertion. A behavioural test would need a full install
 * against an isolated HOME, and — because a scratch DEST legitimately allows a scratch
 * SOURCE — most temp-dir homes make the guard pass through, so such a test would
 * silently stop testing the refusal.
 */

const SOURCE_PATH = path.join(__dirname, 'papercusp-files.ts');

/** Candidate builders whose results are copied into the shared `~/.papercusp/**` dest. */
const GUARDED_CANDIDATE_BUILDERS = [
  'playbookCandidates',
  'extensionCandidates',
  'cliLauncherCandidates',
  'ccHookDirCandidates',
  'hookDirCandidates',
];

function readInstallFn(): string {
  const src = fs.readFileSync(SOURCE_PATH, 'utf8');
  const start = src.indexOf('export async function installPapercuspFiles');
  expect(start, 'installPapercuspFiles must exist in papercusp-files.ts').toBeGreaterThan(-1);
  // To the next top-level declaration, which is enough to cover the whole function body.
  const rest = src.slice(start + 1);
  const end = rest.search(/\nexport (async )?function |\nexport const /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('install-source guard chokepoint', () => {
  const body = readInstallFn();

  it('routes install-source resolution through the guarded helper', () => {
    expect(body).toContain('const resolveSource =');
    expect(body).toContain('filterInstallSources(');
  });

  it.each(GUARDED_CANDIDATE_BUILDERS)(
    '%s() results are never handed straight to firstExisting()',
    (builder) => {
      // Matches `firstExisting(<builder>(...))`, including across a line break, which is
      // how prettier formats these once the argument list grows.
      const bypass = new RegExp(`firstExisting\\(\\s*${builder}\\s*\\(`);
      expect(
        bypass.test(body),
        `${builder}() is resolved with a bare firstExisting() inside installPapercuspFiles — ` +
          `that bypasses the scratch-source refusal (WI-37405). Use resolveSource('<what>', ${builder}(...)) instead.`,
      ).toBe(false);
    },
  );

  it('the guard helper passes the install DEST, so a scratch dest can allow a scratch source', () => {
    // Without `dest`, an isolated gym writing into its own sandbox HOME would be refused.
    expect(body).toMatch(/filterInstallSources\([\s\S]{0,200}dest:\s*home/);
  });

  /**
   * CALIBRATION. Without this, every assertion above would also pass if `readInstallFn()`
   * silently returned an empty string — the classic way a source-scanning guard rots into
   * a test that measures nothing.
   */
  it('calibration: the extracted function body is real and substantial', () => {
    expect(body.length).toBeGreaterThan(2000);
    expect(body).toContain('installClaudeHooks');
    // A pattern that MUST be found, proving the bypass regexes above can match at all.
    expect(/resolveSource\(\s*'cc hooks'/.test(body)).toBe(true);
  });
});
