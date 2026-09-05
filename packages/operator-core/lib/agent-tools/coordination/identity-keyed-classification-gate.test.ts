/**
 * identity-keyed-classification-gate.test.ts — falsifiability + calibration for
 * the pre-promotion gate that closes EI-20012634773877104's atomicity window.
 *
 * WHAT IS BEING GUARDED
 * ---------------------
 * `scripts/check-identity-keyed-classification.mjs` is called by
 * pull-schema.mjs immediately BEFORE it promotes a candidate schema into
 * `libs/papercusp/libs/db/src/schema/generated.ts`. If the candidate would
 * introduce an identity-keyed column with no ALLOWLIST classification, the
 * promotion is refused — so the inconsistent tree state never reaches disk,
 * git-sync can never sweep it into a commit, and the fleet-wide gate can never
 * cut a candidate on it.
 *
 * A guard that has never failed is a guard nobody has tested, and the failure
 * mode that matters here is the SILENT one: a guard that always passes would
 * look exactly like a guard that is working, right up until the next migration
 * reds main for everyone. So this file proves the gate fires in the positive
 * direction AND that it stays quiet on the real, fully-classified schema.
 *
 * WHY NO IN-TREE MUTATION
 * -----------------------
 * The obvious way to prove a schema guard fires — edit generated.ts, run,
 * restore — is unsafe in this repo: git-sync sweeps the whole working tree on
 * a schedule and would happily commit the mutant while the probe is still
 * running (a trap CLAUDE.md documents, and one no `trap` handler can close).
 * The census test's `IDENTITY_KEYED_SCHEMA_PATH` override exists precisely so
 * the subject can be a COPY outside the tree. Every case below writes its
 * fixture to `os.tmpdir()`; the shared checkout is never touched.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// @ts-expect-error — plain-JS repo guard, intentionally not typed
import { checkIdentityKeyedClassification } from '../../../../../scripts/check-identity-keyed-classification.mjs';

const REAL_SCHEMA = resolve(
  __dirname,
  '../../../../../libs/papercusp/libs/db/src/schema/generated.ts',
);

/** Spawning vitest per case costs ~8s; well past the 5s default. */
const SPAWN_TIMEOUT_MS = 180_000;

describe('identity-keyed classification pre-promotion gate (EI-20012634773877104)', () => {
  it(
    'CALIBRATION: passes on the real, fully-classified schema',
    async () => {
      // If this ever fails, the cases below prove nothing — a guard that
      // rejects everything "catches" every mutant for free.
      const verdict = checkIdentityKeyedClassification({});
      expect(verdict.code, verdict.output?.slice(-1500)).toBe('classified');
      expect(verdict.ok).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'FIRES: refuses a candidate schema carrying an unclassified identity-keyed column',
    async () => {
      // Surgical mutant: the REAL schema plus ONE fabricated identity-keyed
      // column. Every pre-existing column still classifies and every ALLOWLIST
      // entry still matches, so the canary and allowlist-rot assertions stay
      // green and the ONLY thing that can fail is the new column. That is what
      // makes a caught mutant attributable to the property under test rather
      // than to a broken fixture.
      const dir = mkdtempSync(join(tmpdir(), 'identity-keyed-gate-'));
      const candidate = join(dir, 'generated.ts');
      try {
        const real = readFileSync(REAL_SCHEMA, 'utf8');
        // Not `_`-prefixed (stripped upstream) and not `bak_` (frozen-snapshot
        // skip), so it genuinely reaches the classification assertion.
        const mutant = `${real}
export const ei20012634773877104ProbeInHarnessShared = harnessShared.table("ei20012634773877104_probe", {
\townerId: text("owner_id").notNull(),
});
`;
        writeFileSync(candidate, mutant);

        const verdict = checkIdentityKeyedClassification({ schemaPath: candidate });

        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe('unclassified');
        // Pin the REASON, not just the exit status: the guard derives
        // 'unclassified' from any non-zero exit, so asserting only on the code
        // would also accept a fixture that failed for an unrelated reason
        // (a broken canary, an ENOENT) and quietly stop testing this property.
        expect(verdict.output).toContain('no classification');
        expect(verdict.output).toContain('ei20012634773877104_probe.owner_id');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it('distinguishes "could not run" from "unclassified"', () => {
    // pull-schema.mjs hard-BLOCKS promotion on 'unclassified' but only warns on
    // 'check-unavailable', because an instrument that did not run has told us
    // nothing and must not wedge the fleet's migration flow. Collapsing the two
    // would either block every agent on a missing file or silently swallow a
    // real unclassified column, so the distinction is load-bearing.
    const verdict = checkIdentityKeyedClassification({
      schemaPath: join(tmpdir(), 'definitely-does-not-exist-ei20012634773877104.ts'),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('check-unavailable');
  });
});
