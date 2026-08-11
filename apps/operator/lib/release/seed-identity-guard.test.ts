/**
 * EI-20108164746219771 step 4 — the staged-seed identity guard.
 *
 * ⚠ EVERY identity literal in this file is SYNTHETIC. A tracked source file must never
 * contain the real build-box values (WI-4776) — the pre-write hook refuses them and the
 * green-checkpoint identity leg would red `main` fleet-wide if one slipped through. The
 * production path derives the real ones at runtime; these tests plant fakes instead.
 *
 * ⚠ THE NON-VACUITY CONTROL IS NOT OPTIONAL (D-009 class). A guard that has never been
 * observed to FAIL is indistinguishable from one that cannot fail — 9 of 21 verification
 * scripts in `papercusp-desktop/bin` turned out to be exactly that. So the "clean" cases
 * below are only meaningful because the paired dirty case is proven to throw on the SAME
 * fixture with the SAME literal set.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertStagedSeedCarriesNoIdentity,
  isLowEntropy,
  judgeSeedIdentity,
  needsWordBoundary,
  resolveIdentityLiterals,
  SEED_REAL_HOSTNAME_ENV,
  type IdentityKey,
  type IdentityLiterals,
} from './seed-identity-guard.js';

const NEUTRAL = 'papercusp-build';
// Synthetic stand-ins for the five real literals, shaped like them but belonging to no one.
const FAKE_HOST = 'zqx-workstation-77';
const FAKE_USER = 'zqxoperator';
// Shaped like a home path but rooted somewhere no machine keeps one: the identity-lint
// leg pattern-matches `/home/<name>` in tracked source and cannot tell a fixture from a
// leak — and it is right not to try. `/fixture/...` exercises the identical code path.
const FAKE_HOME = `/fixture/${FAKE_USER}`;
const FAKE_EMAIL = 'zqx@example.invalid';
const FAKE_SHORT_NAME = 'Zqx'; // 3 chars, alphanumeric ⇒ low-entropy / word-boundary path

const created: string[] = [];
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function stageDir(files: Record<string, Buffer | string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-identity-'));
  created.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body);
  }
  return dir;
}

function literals(entries: Partial<Record<IdentityKey, string>>): IdentityLiterals {
  return new Map(Object.entries(entries) as [IdentityKey, string][]);
}

/** A fake SST: leading NUL so the scanner classifies it binary, then arbitrary bytes. */
function binaryBody(embedded = ''): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x01, 0x02, 0x00]),
    Buffer.from('rocksdb.properties'),
    Buffer.from(embedded, 'latin1'),
    Buffer.from([0x00, 0xff, 0x00]),
  ]);
}

describe('matching asymmetries mirror audit-release-bundle.py', () => {
  it('treats a short alphanumeric literal as word-boundary + low-entropy, a long one as neither', () => {
    expect(needsWordBoundary(FAKE_SHORT_NAME)).toBe(true);
    expect(isLowEntropy(FAKE_SHORT_NAME)).toBe(true);
    expect(needsWordBoundary(FAKE_HOST)).toBe(false);
    expect(isLowEntropy(FAKE_HOST)).toBe(false);
    // A hyphen makes it non-alphanumeric, so it is substring-matched however short.
    expect(needsWordBoundary('a-b')).toBe(false);
  });
});

describe('literal resolution', () => {
  const probe = {
    user: () => FAKE_USER,
    home: () => FAKE_HOME,
    hostname: () => FAKE_HOST,
    gitName: () => FAKE_SHORT_NAME,
    gitEmail: () => FAKE_EMAIL,
  };

  it('resolves all five keys and never scans for the neutral label itself', () => {
    const { literals: lits, unknownHostname } = resolveIdentityLiterals({ env: {}, neutralHostname: NEUTRAL, probe });
    expect([...lits.keys()].sort()).toEqual([
      'build-git-email',
      'build-git-name',
      'build-home-path',
      'build-hostname',
      'build-user-name',
    ]);
    expect(unknownHostname).toBe(false);

    // The neutral hostname is the FIX — published in every SST on purpose. Scanning for it
    // would fail every correctly-neutralized cut.
    const neutralBox = resolveIdentityLiterals({
      env: {},
      neutralHostname: NEUTRAL,
      probe: { ...probe, hostname: () => NEUTRAL },
    });
    expect(neutralBox.literals.has('build-hostname')).toBe(false);
  });

  it('prefers the real hostname handed across the sandbox boundary over gethostname()', () => {
    const { literals: lits, unknownHostname } = resolveIdentityLiterals({
      env: { [SEED_REAL_HOSTNAME_ENV]: FAKE_HOST },
      neutralHostname: NEUTRAL,
      probe: { ...probe, hostname: () => NEUTRAL },
    });
    expect(lits.get('build-hostname')).toBe(FAKE_HOST);
    expect(unknownHostname).toBe(false);
  });

  it('flags the hostname as UNKNOWN inside the namespace with nothing handed down', () => {
    const { unknownHostname } = resolveIdentityLiterals({
      env: {},
      neutralHostname: NEUTRAL,
      probe: { ...probe, hostname: () => NEUTRAL },
    });
    expect(unknownHostname).toBe(true);
  });

  it('drops impersonal CI identities', () => {
    const { literals: lits } = resolveIdentityLiterals({
      env: {},
      neutralHostname: NEUTRAL,
      probe: { user: () => 'runner', home: () => '/root', hostname: () => 'runner-9', gitName: () => undefined, gitEmail: () => undefined },
    });
    expect([...lits.keys()]).toEqual([]);
  });
});

describe('judgeSeedIdentity', () => {
  it('NON-VACUITY CONTROL: the same fixture reds when the literal is present and greens when it is not', async () => {
    const lits = literals({ 'build-hostname': FAKE_HOST });

    const dirty = await stageDir({ 'corestore/db/000009.sst': binaryBody(`host.identity${FAKE_HOST}`) });
    const red = await judgeSeedIdentity({ dir: dirty, literals: lits });
    expect(red.ok).toBe(false);
    expect(red.findings).toHaveLength(1);
    expect(red.findings[0]!.key).toBe('build-hostname');
    expect(red.findings[0]!.binary).toBe(true);
    expect(red.message).toContain('000009.sst');

    const clean = await stageDir({ 'corestore/db/000009.sst': binaryBody(`host.identity${NEUTRAL}`) });
    const green = await judgeSeedIdentity({ dir: clean, literals: lits });
    expect(green.ok).toBe(true);
    expect(green.filesScanned).toBe(1);
  });

  it('finds a high-entropy literal in BINARY bytes — the SST case no content filter can reach', async () => {
    const dir = await stageDir({
      'corestore/db/000012.sst': binaryBody(FAKE_HOME),
      'manifest.json': JSON.stringify({ hive: 'papercusp' }),
    });
    const v = await judgeSeedIdentity({ dir, literals: literals({ 'build-home-path': FAKE_HOME }) });
    expect(v.ok).toBe(false);
    expect(v.findings[0]!.file).toContain('000012.sst');
    expect(v.filesScanned).toBe(2);
  });

  it('does NOT hunt a low-entropy literal through binary (that is how a gate gets switched off)', async () => {
    const lits = literals({ 'build-git-name': FAKE_SHORT_NAME });
    // Present in binary → deliberately ignored.
    const bin = await stageDir({ 'corestore/db/000009.sst': binaryBody(` ${FAKE_SHORT_NAME} `) });
    expect((await judgeSeedIdentity({ dir: bin, literals: lits })).ok).toBe(true);
    // Present in TEXT → caught. Same literal, same guard: the asymmetry is the file kind.
    const txt = await stageDir({ 'notes.txt': `cut by ${FAKE_SHORT_NAME} today` });
    expect((await judgeSeedIdentity({ dir: txt, literals: lits })).ok).toBe(false);
  });

  it('honours the word boundary for a short literal in text', async () => {
    const lits = literals({ 'build-git-name': FAKE_SHORT_NAME });
    const embedded = await stageDir({ 'a.txt': `${FAKE_SHORT_NAME}zzz and w${FAKE_SHORT_NAME}` });
    expect((await judgeSeedIdentity({ dir: embedded, literals: lits })).ok).toBe(true);
    const standalone = await stageDir({ 'a.txt': `by ${FAKE_SHORT_NAME}.` });
    expect((await judgeSeedIdentity({ dir: standalone, literals: lits })).ok).toBe(false);
  });

  it('finds a literal STRADDLING the 4 MiB read-chunk boundary', async () => {
    const chunk = 4 * 1024 * 1024;
    const head = Buffer.alloc(chunk - 5, 0x41); // 'A' filler
    head[0] = 0x00; // classify binary, like a real SST
    const dir = await stageDir({
      'corestore/db/000020.sst': Buffer.concat([head, Buffer.from(FAKE_HOST), Buffer.alloc(64, 0x42)]),
    });
    const v = await judgeSeedIdentity({ dir, literals: literals({ 'build-hostname': FAKE_HOST }) });
    expect(v.ok).toBe(false);
    expect(v.findings[0]!.offset).toBe(chunk - 5);
  });

  it('reports every offending file, not just the first', async () => {
    const dir = await stageDir({
      'corestore/db/000009.sst': binaryBody(FAKE_HOST),
      'corestore/db/000012.sst': binaryBody(FAKE_HOST),
    });
    const v = await judgeSeedIdentity({ dir, literals: literals({ 'build-hostname': FAKE_HOST }) });
    expect(v.findings.map((f) => f.file.split('/').pop()).sort()).toEqual(['000009.sst', '000012.sst']);
  });

  it('is clean on an empty literal set but says so — a scan of nothing is not a pass', async () => {
    const dir = await stageDir({ 'corestore/db/000009.sst': binaryBody(FAKE_HOST) });
    const v = await judgeSeedIdentity({ dir, literals: literals({}) });
    expect(v.ok).toBe(true);
    expect(v.message).toContain('0 build-identity literal(s)');
  });
});

describe('assertStagedSeedCarriesNoIdentity', () => {
  const probe = {
    user: () => FAKE_USER,
    home: () => FAKE_HOME,
    hostname: () => FAKE_HOST,
    gitName: () => undefined,
    gitEmail: () => undefined,
  };

  it('throws on a dirty seed, and the message names the re-cut remedy (no acceptance path exists)', async () => {
    const dir = await stageDir({ 'corestore/db/000009.sst': binaryBody(`host.identity${FAKE_HOST}`) });
    await expect(
      assertStagedSeedCarriesNoIdentity({ dir, neutralHostname: NEUTRAL, env: {}, probe }),
    ).rejects.toThrow(/THE STAGED SEED CARRIES THE BUILD BOX'S IDENTITY/);
    await expect(
      assertStagedSeedCarriesNoIdentity({ dir, neutralHostname: NEUTRAL, env: {}, probe }),
    ).rejects.toThrow(/re-cut it fresh/);
  });

  it('passes a neutralized seed AND says on stderr what it measured', async () => {
    const dir = await stageDir({
      'corestore/db/000009.sst': binaryBody(`host.identity${NEUTRAL}`),
      'manifest.json': JSON.stringify({ hive: 'papercusp' }),
    });
    // The clean-path line is not decoration: it is how a release operator can tell the scan
    // RAN at all. A guard whose success is silent is indistinguishable from one that was
    // skipped — the D-009 failure mode, one level up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const v = await assertStagedSeedCarriesNoIdentity({ dir, neutralHostname: NEUTRAL, env: {}, probe });
      expect(v.ok).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/clean — 2 staged file\(s\) carry none of 3 build-identity/);
    } finally {
      warn.mockRestore();
    }
  });

  it('FAILS CLOSED inside the namespace when the real hostname was not handed down', async () => {
    const dir = await stageDir({ 'corestore/db/000009.sst': binaryBody(`host.identity${NEUTRAL}`) });
    await expect(
      assertStagedSeedCarriesNoIdentity({
        dir,
        neutralHostname: NEUTRAL,
        env: {},
        probe: { ...probe, hostname: () => NEUTRAL },
      }),
    ).rejects.toThrow(new RegExp(SEED_REAL_HOSTNAME_ENV));
  });
});
