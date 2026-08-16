/**
 * verify-seed-payload-cli — does a COMMITTED seed's manifest actually describe its bytes?
 *
 * WHY THIS EXISTS (WI-39447). `ensure-release-seed.sh`'s repair-net decides whether the
 * committed `src-tauri/seed` is "usable" and, when it is, skips the cut entirely. That
 * predicate used to be pure FILE PRESENCE — manifest.json exists, epoch-keys.json exists —
 * so the shipped seed that this work-item is about (corestore 50,165,685 bytes short of its
 * declared sizeBytes, hash 13b280d77c08… vs actual fa4fddc22e97…) read as perfectly usable.
 * A build shipped it silently, and on a fresh install `restoreSeed` skipped the failing store
 * and reported SUCCESS with an EMPTY hive.
 *
 * That is the same defect as the one inside the cutter, one level up: A GUARD THAT JUDGES
 * METADATA CANNOT SEE METADATA THAT DESCRIBES ABSENT BYTES. So this CLI runs the check the
 * INSTALLER itself runs — `defaultSeedRegistry()` → `provider.verify()`, via the shared
 * {@link judgeSeedPayloadIntegrity} judge — rather than re-implementing a size or hash
 * comparison here. Re-implementing is how this file's sibling got burned once already: a
 * local `measure()` that omitted the LOG exclusion produced a false size red. If the cut side
 * and the install side ever disagree, that disagreement is the bug we want surfaced, and it
 * cannot surface while each side runs its own private notion of "intact".
 *
 * Measured cost on the real ~475MB seed: ~1.1s. That is why this runs unconditionally instead
 * of hiding behind an opt-in flag — a Tauri build takes minutes, and a correctness check
 * nobody enables is not a check.
 *
 * EXIT CODES — three-way ON PURPOSE, and the third is the point:
 *   0  payload matches the manifest — safe to treat the committed seed as usable.
 *   1  MISMATCH — the manifest does not describe these bytes. NOT usable.
 *   2  COULD NOT DETERMINE — no manifest, unreadable manifest, or the verifier itself
 *      failed to run (missing deps, not a full checkout, a VM leg).
 *
 * Exit 2 exists so a caller can never read "I could not check" as "it is fine" — the exact
 * false-absence trap that lets a broken artifact through. A caller that collapses 2 into 0
 * has re-created the bug this file was written to close; `ensure-release-seed.sh` instead
 * falls back to the old presence-only predicate AND says out loud that it did.
 */

import { readFile } from 'node:fs/promises';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

import { judgeSeedPayloadIntegrity } from './seed-payload-integrity-guard.ts';

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_UNDETERMINED = 2;

export interface VerifySeedPayloadArgs {
  readonly seedDir: string;
  readonly origin: 'fresh' | 'reuse';
}

/** Parse argv. Throws on a malformed invocation so a typo cannot silently verify nothing. */
export function parseVerifySeedPayloadArgs(argv: readonly string[]): VerifySeedPayloadArgs {
  let seedDir: string | null = null;
  let origin: 'fresh' | 'reuse' = 'reuse';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--seed') {
      const next = argv[i + 1];
      if (!next) throw new Error('--seed requires a directory path');
      seedDir = next;
      i += 1;
    } else if (arg === '--origin') {
      const next = argv[i + 1];
      if (next !== 'fresh' && next !== 'reuse') {
        throw new Error(`--origin must be 'fresh' or 'reuse' (got ${JSON.stringify(next)})`);
      }
      origin = next;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  if (!seedDir) throw new Error('--seed <dir> is required');
  return { seedDir, origin };
}

/**
 * Run the verdict. Returns an exit code rather than calling process.exit so the whole thing is
 * testable without spawning; see the three-way contract in the file header.
 *
 * `origin` only shapes the remedy wording in the guard's message. It defaults to 'reuse'
 * because `--reuse-corestore` is the DEFAULT shipping path (ensure-release-seed.sh:135,
 * PAPERCUSP_SEED_REUSE_CORESTORE=auto), so a graft that inherited an unverified entry is the
 * likeliest cause of a red here — and its remedy (re-cut FRESH; never recompute the entry
 * from the short bytes, which would only make the lie self-consistent) is the one a reader
 * needs to see.
 */
export async function runVerifySeedPayload(
  args: VerifySeedPayloadArgs,
  log: (msg: string) => void = console.error,
  /** Injected in tests; production uses the guard's default (the real installer registry). */
  verify?: SeedStoreVerifier,
): Promise<number> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(`${args.seedDir}/manifest.json`, 'utf8'));
  } catch (err) {
    // UNDETERMINED, not a mismatch: an absent/unreadable manifest is "no seed to judge",
    // which is the pre-existing seed_present() question and not this guard's to answer.
    log(`[seed-verify] cannot read ${args.seedDir}/manifest.json — ${(err as Error).message}`);
    return EXIT_UNDETERMINED;
  }

  try {
    const result = await judgeSeedPayloadIntegrity({
      // The judge reads only `stores`; a manifest missing it fails closed below.
      manifest: manifest as Parameters<typeof judgeSeedPayloadIntegrity>[0]['manifest'],
      dir: args.seedDir,
      origin: args.origin,
    });
    log(result.message);
    return result.ok ? EXIT_OK : EXIT_MISMATCH;
  } catch (err) {
    // The verifier could not RUN (missing provider deps, not a full checkout, a VM leg).
    // Never report that as either verdict.
    log(`[seed-verify] could not verify the seed payload — ${(err as Error).message}`);
    return EXIT_UNDETERMINED;
  }
}

// Run as the CLI only — `isCliEntry` is the repo's bundle-safe `require.main === module`
// (EI-650), and importing this module (the test, a future caller) stays side-effect-free.
// NOTE: no top-level await here on purpose — tsx transforms this file through its CJS
// preflight, where top-level await is a hard TransformError, and a crash-on-load would make
// EVERY exit code 1: the mismatch verdict and the "could not check" verdict would become
// indistinguishable, which is precisely the collapse the three-way contract above exists to
// prevent. It failed exactly that way once before this comment was written.
if (isCliEntry(import.meta.url)) {
  (async () => {
    try {
      return await runVerifySeedPayload(parseVerifySeedPayloadArgs(process.argv.slice(2)));
    } catch (err) {
      console.error(`[seed-verify] ${(err as Error).message}`);
      return EXIT_UNDETERMINED;
    }
  })()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[seed-verify] FATAL:', e instanceof Error ? e.stack : e);
      process.exit(EXIT_UNDETERMINED);
    });
}
