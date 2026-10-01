/**
 * verify-seed-payload-cli — the THREE-WAY exit contract.
 *
 * The property under test is not "does it detect a bad hash" (the guard next door owns that).
 * It is that "I could not check" stays DISTINGUISHABLE from both "intact" and "broken". WI-39447
 * shipped because a broken seed was indistinguishable from a good one; the first draft of this
 * CLI then crashed on load (top-level await under tsx's CJS preflight) and made every exit code
 * 1, collapsing "broken" into "could not check" — the same class of collapse, one layer down.
 * Both directions of that collapse are therefore pinned here.
 *
 * Falsifiability without mutating the shared tree: the DELIBERATELY-WRONG verifiers below are
 * permanent in-file controls (an always-ok one and an always-fail one). The calibration case is
 * `mismatch is not reported as OK` — if the CLI ever stopped consulting the verifier at all, the
 * always-fail control would go green and that test would fail. The identity leg has its own
 * calibration case for the same reason.
 *
 * Every case injects `env` and `probe`, so no test depends on who is running it or on what
 * `git config user.name` says on this box.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT_MISMATCH,
  EXIT_OK,
  EXIT_UNDETERMINED,
  parseVerifySeedPayloadArgs,
  runVerifySeedPayload,
  type VerifySeedPayloadDeps,
} from './verify-seed-payload-cli.js';
import type { SeedStoreVerifier } from './seed-payload-integrity-guard.js';
import { SEED_REAL_HOSTNAME_ENV } from './seed-identity-guard.js';
import { DEFAULT_NEUTRAL_BUILD_HOSTNAME } from './seed-hostname-neutralization.js';

/** Control: every store is intact. */
const alwaysOk: SeedStoreVerifier = async () => ({ ok: true });
/** Control: every store is corrupt — the shape WI-39447's corestore actually had. */
const alwaysFails: SeedStoreVerifier = async () => ({
  ok: false,
  reason: 'hash mismatch (expected 13b280d77c08…, got fa4fddc22e97…)',
});
/** Control: the verifier itself cannot run (missing deps / partial checkout / VM leg). */
const throwsOnRun: SeedStoreVerifier = async () => {
  throw new Error('Cannot find module @papercusp/operator-core/...');
};

type Probe = NonNullable<VerifySeedPayloadDeps['probe']>;

/**
 * Deterministic machine-identity probes. Anything omitted resolves to NO literal, so a test that
 * names nothing exercises the other legs with the identity leg present but vacuous.
 */
const probing = (over: Partial<Record<keyof Probe, string>> = {}): Probe => ({
  user: () => over.user,
  home: () => over.home,
  hostname: () => over.hostname,
});

/** No machine identity. */
const NO_IDENTITY = probing();

const deps = (verify: SeedStoreVerifier, over: Partial<VerifySeedPayloadDeps> = {}): VerifySeedPayloadDeps => ({
  verify,
  env: {},
  probe: NO_IDENTITY,
  releaseLiterals: () => [],
  ...over,
});

const MANIFEST = {
  seedFormatVersion: 1,
  stores: [{ kind: 'corestore', hash: 'deadbeef', sizeBytes: 123, source: { type: 'resource', path: 'corestore' } }],
};

describe('parseVerifySeedPayloadArgs', () => {
  it('requires --seed rather than silently verifying nothing', () => {
    expect(() => parseVerifySeedPayloadArgs([])).toThrow(/--seed <dir> is required/);
  });

  it('defaults origin to reuse — the DEFAULT shipping path, so its remedy is the likely one', () => {
    expect(parseVerifySeedPayloadArgs(['--seed', '/s'])).toEqual({ seedDir: '/s', origin: 'reuse' });
  });

  it('accepts an explicit origin', () => {
    expect(parseVerifySeedPayloadArgs(['--seed', '/s', '--origin', 'fresh']).origin).toBe('fresh');
  });

  it('rejects an unknown argument instead of ignoring a typo', () => {
    expect(() => parseVerifySeedPayloadArgs(['--sed', '/s'])).toThrow(/unknown argument/);
  });

  it('rejects a bogus --origin', () => {
    expect(() => parseVerifySeedPayloadArgs(['--seed', '/s', '--origin', 'grafted'])).toThrow(/must be/);
  });
});

describe('runVerifySeedPayload — the three-way exit contract', () => {
  let dir: string;
  const silent = () => {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'seed-verify-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeManifest = async (body: unknown = MANIFEST) =>
    writeFile(join(dir, 'manifest.json'), JSON.stringify(body), 'utf8');

  it('reports OK when every store matches', async () => {
    await writeManifest();
    expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk))).toBe(EXIT_OK);
  });

  // CALIBRATION: if the CLI ever stopped consulting the verifier, this is the test that fails.
  it('reports MISMATCH — never OK — when a store fails, so a broken seed cannot read as usable', async () => {
    await writeManifest();
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysFails));
    expect(code).toBe(EXIT_MISMATCH);
    expect(code).not.toBe(EXIT_OK);
  });

  it('reports UNDETERMINED — never OK — when the manifest is absent', async () => {
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk));
    expect(code).toBe(EXIT_UNDETERMINED);
    expect(code).not.toBe(EXIT_OK);
  });

  it('reports UNDETERMINED when the manifest is unparseable JSON', async () => {
    await writeFile(join(dir, 'manifest.json'), '{ not json', 'utf8');
    expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk))).toBe(
      EXIT_UNDETERMINED,
    );
  });

  it('reports UNDETERMINED — not MISMATCH — when the verifier itself cannot run', async () => {
    await writeManifest();
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(throwsOnRun));
    expect(code).toBe(EXIT_UNDETERMINED);
    // The distinction that matters: a broken TOOL must not be reported as a broken SEED, or a
    // VM leg / partial checkout would fail every build with a bogus corruption claim.
    expect(code).not.toBe(EXIT_MISMATCH);
  });

  it('keeps all three verdicts mutually distinct', () => {
    expect(new Set([EXIT_OK, EXIT_MISMATCH, EXIT_UNDETERMINED]).size).toBe(3);
  });

  // The SIBLING gap (D-023): assertSeedNotDegraded judges the final manifest, so it covers both
  // cut branches — but its only production caller is cut-seed-cli, so it never runs on a build
  // that skips the cut. These pin it onto the ship path.
  describe('degradation leg — the guard that previously only ran when a cut ran', () => {
    const CORE = '5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac';
    /** State 2, the 2026-07-21 shipped lie: labelled sparse, starts at 0, ships every block. */
    const DEGRADED = {
      seedFormatVersion: 1,
      stores: [
        { kind: 'git', hash: 'g', sizeBytes: 131_296_503, source: { type: 'resource', path: 'git' } },
        {
          kind: 'corestore',
          hash: 'h',
          sizeBytes: 1_998_388_355,
          source: { type: 'resource', path: 'corestore' },
          meta: { coreKeys: [CORE], coreLengths: { [CORE]: 461_475 }, coreSparseFrom: { [CORE]: 0 } },
        },
      ],
    };

    it('reports MISMATCH for a degraded seed even when every payload hash matches', async () => {
      await writeManifest(DEGRADED);
      // alwaysOk => the payload leg passes; only the degradation leg can red this.
      const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk));
      expect(code).toBe(EXIT_MISMATCH);
    });

    it('still reports OK for an honestly-labelled seed (no false red on a full cut)', async () => {
      const honest = {
        ...DEGRADED,
        stores: [
          DEGRADED.stores[0],
          { ...DEGRADED.stores[1], sizeBytes: 318_544_683, meta: { coreKeys: [CORE], coreLengths: { [CORE]: 76 } } },
        ],
      };
      await writeManifest(honest);
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk))).toBe(EXIT_OK);
    });
  });

  /**
   * The THIRD leg of the same class, and the last one: `assertStagedSeedCarriesNoIdentity`'s only
   * production caller is cut-seed-cli.ts:1350, so it too ran only when a cut ran.
   *
   * The property here is the one the throwing assert form CANNOT express. It throws for two
   * unrelated reasons — "identity found" and "cannot prove clean inside the UTS sandbox" — and on
   * this path those must land on DIFFERENT exit codes, or every sandboxed build reds.
   */
  describe('identity leg — and why it must not use the throwing assert form', () => {
    // `/fixture/...`, never `/home/...` — the same idiom seed-identity-guard.test.ts uses. A
    // hardcoded home path in shipped source reds the green-checkpoint identity-lint leg and
    // freezes `main` for the whole fleet, whether or not the path names a real person.
    const BUILDER_HOME = '/fixture/some-builder';

    /** A staged file carrying the build box's home path — the leak this guard exists to catch. */
    const writeLeakyFile = async (literal: string = BUILDER_HOME) =>
      writeFile(join(dir, 'presence.json'), JSON.stringify({ path: `${literal}/papercupai-workspace` }), 'utf8');

    it('allows owner name/email values while retaining the canonical machine-only scan (D-112)', async () => {
      const organization = 'zqxorganization';
      await writeManifest();
      await writeFile(join(dir, '000237.log'), Buffer.from(`\0state ${organization.toUpperCase()} state`));
      const env = {
        ...process.env,
        PAPERCUSP_RELEASE_OWNER_NAME: `Zqxwerty Testperson;${organization}`,
        PAPERCUSP_RELEASE_OWNER_EMAIL: 'zqx@example.invalid',
      };
      // Both the injected and production resolver paths now ignore owner name/email values.
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk, { env })))
        .toBe(EXIT_OK);
      const lines: string[] = [];
      const productionDeps = deps(alwaysOk, { env, releaseLiterals: undefined });
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, (line) => lines.push(line), productionDeps))
        .toBe(EXIT_OK);
      expect(lines.join('\n')).not.toContain('release-literal:');
    });

    it('keeps the neutral build hostname out of the canonical release scan', async () => {
      await writeManifest();
      await writeFile(join(dir, '000237.log'), Buffer.from(`\0host ${DEFAULT_NEUTRAL_BUILD_HOSTNAME}`));
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, deps(alwaysOk, {
        releaseLiterals: () => [DEFAULT_NEUTRAL_BUILD_HOSTNAME, DEFAULT_NEUTRAL_BUILD_HOSTNAME.toUpperCase()],
      }))).toBe(EXIT_OK);
    });

    it('reports UNDETERMINED when the canonical release literal resolver cannot run', async () => {
      await writeManifest();
      const lines: string[] = [];
      const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, (line) => lines.push(line), deps(alwaysOk, {
        releaseLiterals: () => { throw new Error('audit literal resolver unavailable'); },
      }));
      expect(code).toBe(EXIT_UNDETERMINED);
      expect(lines.join('\n')).toContain('audit literal resolver unavailable');
    });

    it('reports UNDETERMINED when no owner name was supplied, while a definite machine hit stays BROKEN', async () => {
      await writeManifest();
      const unknownOwner = deps(alwaysOk, { env: {}, probe: probing({ home: BUILDER_HOME }) });
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, unknownOwner)).toBe(EXIT_UNDETERMINED);
      await writeLeakyFile();
      expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, unknownOwner)).toBe(EXIT_MISMATCH);
    });

    // CALIBRATION for this leg: if the identity scan were dropped, this goes green and fails.
    it('reports BROKEN — never OK — when the staged bytes carry the build box home path', async () => {
      await writeManifest();
      await writeLeakyFile();
      const code = await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        silent,
        deps(alwaysOk, { probe: probing({ home: BUILDER_HOME }) }),
      );
      expect(code).toBe(EXIT_MISMATCH);
      expect(code).not.toBe(EXIT_OK);
    });

    it('still reports OK when those same literals are absent (no false red on a clean seed)', async () => {
      await writeManifest();
      await writeLeakyFile('/fixture/somebody-else');
      const code = await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        silent,
        deps(alwaysOk, { probe: probing({ home: BUILDER_HOME }) }),
      );
      expect(code).toBe(EXIT_OK);
    });

    it('scans for the REAL hostname when the sandbox handed it down', async () => {
      await writeManifest();
      await writeLeakyFile('buildbox-42');
      const code = await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        silent,
        deps(alwaysOk, {
          env: { [SEED_REAL_HOSTNAME_ENV]: 'buildbox-42' },
          probe: probing({ hostname: DEFAULT_NEUTRAL_BUILD_HOSTNAME }),
        }),
      );
      expect(code).toBe(EXIT_MISMATCH);
    });

    // THE REASON THE ASSERT FORM IS WRONG HERE. Inside `bwrap --unshare-uts` with no
    // PAPERCUSP_SEED_REAL_HOSTNAME, the real hostname is unknowable — the assert throws, and a
    // caller mapping its throw to 1 would red every sandboxed build.
    it('reports UNDETERMINED — never BROKEN — when it cannot prove the hostname is absent', async () => {
      await writeManifest();
      const code = await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        silent,
        deps(alwaysOk, { probe: probing({ hostname: DEFAULT_NEUTRAL_BUILD_HOSTNAME }) }),
      );
      expect(code).toBe(EXIT_UNDETERMINED);
      expect(code).not.toBe(EXIT_MISMATCH);
      // ...and equally never a silent pass: "clean" there would describe the sandbox, not the seed.
      expect(code).not.toBe(EXIT_OK);
    });

    it('says so out loud rather than reporting an unmeasured clean', async () => {
      await writeManifest();
      const lines: string[] = [];
      await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        (m) => lines.push(m),
        deps(alwaysOk, { probe: probing({ hostname: DEFAULT_NEUTRAL_BUILD_HOSTNAME }) }),
      );
      expect(lines.join('\n')).toMatch(new RegExp(SEED_REAL_HOSTNAME_ENV));
    });

    // A resolvable literal is conclusive on its own, so a HIT outranks "cannot prove". This pins
    // the one place the leg deliberately departs from the assert form's ordering.
    it('reports BROKEN for a definite hit even while the hostname is unprovable', async () => {
      await writeManifest();
      await writeLeakyFile();
      const code = await runVerifySeedPayload(
        { seedDir: dir, origin: 'reuse' },
        silent,
        deps(alwaysOk, { probe: probing({ home: BUILDER_HOME, hostname: DEFAULT_NEUTRAL_BUILD_HOSTNAME }) }),
      );
      expect(code).toBe(EXIT_MISMATCH);
      expect(code).not.toBe(EXIT_UNDETERMINED);
    });
  });

  it('surfaces the remedy for a grafted corestore in the reuse message', async () => {
    await writeManifest();
    const lines: string[] = [];
    await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, (m) => lines.push(m), deps(alwaysFails));
    const out = lines.join('\n');
    expect(out).toMatch(/PAPERCUSP_SEED_REUSE_CORESTORE=0/);
    // Never let a reader "fix" a short payload by recomputing the entry over it.
    expect(out).toMatch(/do NOT "fix" this by recomputing/);
  });
});
