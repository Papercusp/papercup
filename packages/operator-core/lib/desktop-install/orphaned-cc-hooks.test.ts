import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { CC_HOOK_FILES } from './papercusp-files';

// THE CLASS GUARD behind EI-20782070131658758.
//
// A CC hook only ever runs if its filename appears in CC_HOOK_FILES: that list drives both
// the copy-to-disk loop AND (via `present`) every registration in mergeClaudeHookSettings.
// A hook script that exists in the repo but is missing from the list is INERT — it installs
// nowhere, registers nowhere, and fires never. Nothing reported that, because the failure is
// an ABSENCE: no error, no red test, just a guard that silently does not exist at runtime.
//
// This has now happened THREE times, each caught only by the incident the guard was written
// to prevent — the guard being present in the tree the whole time:
//   WI-5543               pretooluse-content-lint.mjs
//   WI-5542               pretooluse-secrets-guard.mjs   ("the hard backstop", per its header)
//   EI-20782070131658758  pretooluse-control-bytes-content-guard.mjs — written 2026-08-03
//                         WITH a passing dedicated test file, still unwired 15 days later,
//                         while the NUL-byte corruption it blocks was re-filed as a new bug.
//
// A passing unit test for a guard says the guard WORKS, not that it RUNS. That gap is the
// whole bug class, and this file is the only thing that closes it.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const HOOK_SRC_DIR = join(REPO_ROOT, 'apps/operator/scripts/hooks/cc');

/** Files in the hook source dir that are actual hook payloads. */
function hookScriptsOnDisk(): string[] {
  return readdirSync(HOOK_SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter(isHookPayload)
    .sort();
}

/**
 * A hook payload is a script the installer could copy. Excluded, deliberately:
 *  - `.tmp`     — stranded temp files from an interrupted install (7 are tracked in git today)
 *  - `.d.mts`   — emitted type declarations that sit beside two of the .mjs hooks
 *  - `.bak*`    — hand-kept backups
 * Each exclusion is a SUFFIX rule, never a filename allowlist: an allowlist of names is how a
 * genuinely-orphaned hook gets quietly parked to make a red test green, which is this bug again.
 */
function isHookPayload(name: string): boolean {
  if (/\.(tmp|d\.mts)$/.test(name)) return false;
  if (/\.bak(-|\.|$)/.test(name)) return false;
  return /\.(sh|mjs|py)$/.test(name);
}

describe('CC hook registry — no orphaned hook scripts (EI-20782070131658758)', () => {
  it('every hook script in the source dir is listed in CC_HOOK_FILES', () => {
    const listed = new Set(CC_HOOK_FILES);
    const orphans = hookScriptsOnDisk().filter((n) => !listed.has(n));

    expect(
      orphans,
      orphans.length === 0
        ? ''
        : `These hook scripts exist but are NOT in CC_HOOK_FILES, so they never install and ` +
          `never run:\n  ${orphans.join('\n  ')}\n\n` +
          `Add each to CC_HOOK_FILES in papercusp-files.ts AND register it in ` +
          `mergeClaudeHookSettings (the list alone only copies the file to disk — a hook that ` +
          `is copied but unregistered is still inert). If one is deliberately copied-but-not-` +
          `registered (posttooluse-objective-title.sh is the sole precedent), it still belongs ` +
          `in CC_HOOK_FILES; the registration is what you omit.`,
    ).toEqual([]);
  });

  it('every CC_HOOK_FILES entry actually exists on disk', () => {
    // The mirror failure, and just as silent: installClaudeHooks swallows ENOENT per file
    // (`catch (e) { if (e.code !== 'ENOENT') throw e }`), so ONE typo'd or renamed filename
    // drops that hook from the install with no error anywhere.
    const missing = CC_HOOK_FILES.filter((n) => !existsSync(join(HOOK_SRC_DIR, n)));

    expect(
      missing,
      missing.length === 0
        ? ''
        : `CC_HOOK_FILES names files that do not exist in ${HOOK_SRC_DIR}:\n  ${missing.join('\n  ')}\n` +
          `installClaudeHooks skips a missing file silently (ENOENT is caught per-file), so ` +
          `these hooks are not installed and nothing reports it.`,
    ).toEqual([]);
  });

  it('the control-bytes content guard is registered (the EI-20782070131658758 regression)', () => {
    // Named explicitly rather than left to the sweep above: this is the specific guard whose
    // 15-day absence let a `Write` put a raw NUL into a .ts file and turn it binary/ungreppable.
    expect(CC_HOOK_FILES).toContain('pretooluse-control-bytes-content-guard.mjs');
  });

  // FALSIFIABILITY CONTROL — kept permanently, per the repo rule that a guard which has never
  // failed is a guard you have not tested. It runs the sweep's own predicate against a
  // deliberately-incomplete list, in memory, mutating nothing on the shared tree. If this ever
  // reports "caught nothing", the two sweeps above are vacuous and pass no matter what.
  it('control: the sweep DOES flag a hook missing from the list', () => {
    const onDisk = hookScriptsOnDisk();
    expect(onDisk.length).toBeGreaterThan(10); // the instrument read a real directory

    const withoutOne = new Set(CC_HOOK_FILES.filter((n) => n !== 'pretooluse-secrets-guard.mjs'));
    const orphans = onDisk.filter((n) => !withoutOne.has(n));

    expect(orphans).toEqual(['pretooluse-secrets-guard.mjs']);
  });
});
