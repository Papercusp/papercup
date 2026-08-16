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
 * always-fail control would go green and that test would fail.
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
} from './verify-seed-payload-cli.ts';
import type { SeedStoreVerifier } from './seed-payload-integrity-guard.ts';

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
    expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, alwaysOk)).toBe(EXIT_OK);
  });

  // CALIBRATION: if the CLI ever stopped consulting the verifier, this is the test that fails.
  it('reports MISMATCH — never OK — when a store fails, so a broken seed cannot read as usable', async () => {
    await writeManifest();
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, alwaysFails);
    expect(code).toBe(EXIT_MISMATCH);
    expect(code).not.toBe(EXIT_OK);
  });

  it('reports UNDETERMINED — never OK — when the manifest is absent', async () => {
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, alwaysOk);
    expect(code).toBe(EXIT_UNDETERMINED);
    expect(code).not.toBe(EXIT_OK);
  });

  it('reports UNDETERMINED when the manifest is unparseable JSON', async () => {
    await writeFile(join(dir, 'manifest.json'), '{ not json', 'utf8');
    expect(await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, alwaysOk)).toBe(
      EXIT_UNDETERMINED,
    );
  });

  it('reports UNDETERMINED — not MISMATCH — when the verifier itself cannot run', async () => {
    await writeManifest();
    const code = await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, silent, throwsOnRun);
    expect(code).toBe(EXIT_UNDETERMINED);
    // The distinction that matters: a broken TOOL must not be reported as a broken SEED, or a
    // VM leg / partial checkout would fail every build with a bogus corruption claim.
    expect(code).not.toBe(EXIT_MISMATCH);
  });

  it('keeps all three verdicts mutually distinct', () => {
    expect(new Set([EXIT_OK, EXIT_MISMATCH, EXIT_UNDETERMINED]).size).toBe(3);
  });

  it('surfaces the remedy for a grafted corestore in the reuse message', async () => {
    await writeManifest();
    const lines: string[] = [];
    await runVerifySeedPayload({ seedDir: dir, origin: 'reuse' }, (m) => lines.push(m), alwaysFails);
    const out = lines.join('\n');
    expect(out).toMatch(/PAPERCUSP_SEED_REUSE_CORESTORE=0/);
    // Never let a reader "fix" a short payload by recomputing the entry over it.
    expect(out).toMatch(/do NOT "fix" this by recomputing/);
  });
});
