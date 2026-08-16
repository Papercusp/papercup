/**
 * Recurrence guard for WI-39458 — the release identity gate must not certify a
 * finished installer it never opened, and must not miss an identity leak that
 * lives in a tar's OWNERSHIP fields rather than in any member's content.
 *
 * WHAT WENT WRONG (measured on the published 0.0.17 artifacts, not hypothesised):
 *
 *   1. `--scan-dir` handed a finished installer greps the container as opaque
 *      bytes. On `Papercusp Server_0.0.17_x64-setup.zip` (2,240,463,722 B) it
 *      printed "✓ CLEAN — … 3 file(s), 0 archive(s) expanded and scanned" and
 *      exited 0, while the installer's payload carried the build-box username.
 *      The paired control — the same artifact EXTRACTED, then `--scan-dir`'d —
 *      exits 1 DIRTY. The same bytes cannot be both, so the CLEAN was false.
 *
 *   2. Even for an archive the gate DOES expand, `tar` stamps the building
 *      user's account name into every member's uid/gid NAME fields. Those are
 *      metadata: not a member's payload and not a member's path, so neither the
 *      content grep nor the member-name manifest could see them. Measured on the
 *      sidecar's real `db-seed.tar.gz`: 3,959 members carrying the build user,
 *      certified `✓ CLEAN` exit 0.
 *
 * Neither defect was in the machinery — the `uninspectable` guard and the tar
 * manifest were both already correct. (1) was nothing routing installers into
 * the gate at all, and (2) was a manifest that recorded paths but not ownership.
 * That is exactly the kind of omission a passing gate cannot reveal about itself,
 * which is what these guards exist to catch.
 *
 * WHY THE SENTINEL IS DERIVED, NEVER HARDCODED: `check-no-identity-literals`
 * scans superproject source for exactly these values, so writing a real one into
 * this file would red the green-checkpoint the tick it landed — the guard would
 * break the gate it guards. Reading the denylist out of the gate at run time also
 * means a newly-added identity is covered automatically instead of drifting.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
/**
 * Overridable SO THAT THESE GUARDS CAN BE PROVEN FALSIFIABLE without mutating
 * the shared tree — point it at a copy of the gate with the fix backed out and
 * the assertions below must fail. A tree-mutating probe is not an option here:
 * git-sync sweeps the whole tree on a timer and would commit the mutant even if
 * nothing went wrong. See scripts/mutation-probe.sh (copy-out tier).
 */
const GATE =
  process.env.PAPERCUSP_IDENTITY_GATE_PATH ??
  path.join(REPO_ROOT, 'papercusp-desktop', 'bin', 'audit-release-bundle.py');

function gateSource(): string {
  return readFileSync(GATE, 'utf8');
}

/** See identity-gate-archive-expansion.test.ts — the certify path REQUIRES an
 *  asserted owner name, and it must stay SYNTHETIC in tracked source. */
const SYNTHETIC_OWNER = 'Zzsynthetic Gateowner';
const GATE_ENV = { ...process.env, PAPERCUSP_RELEASE_OWNER_NAME: SYNTHETIC_OWNER };

/** A value the gate hunts unconditionally, read from its own denylist. */
function sentinelFromDenylist(): string {
  const block = gateSource().match(/KNOWN_SENSITIVE_IDENTITIES\s*=\s*\{([\s\S]*?)\}/)?.[1];
  if (!block) throw new Error('KNOWN_SENSITIVE_IDENTITIES not found — gate structure changed');
  const values = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  const usable = values.filter((v) => v.length >= 6); // hunted as a plain substring
  if (usable.length === 0) throw new Error('no high-entropy sentinel available in denylist');
  return usable[0];
}

function have(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
}

function runGate(args: string[]) {
  const r = spawnSync('python3', [GATE, ...args], { encoding: 'utf8', env: GATE_ENV });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('release identity gate: tar OWNERSHIP fields are scanned (WI-39458)', () => {
  it('records uname/gname in the member manifest, not just paths', () => {
    const src = gateSource();
    const fn = src.match(/def _expand_tar_memberwise[\s\S]*?\n(?=def )/)?.[0];
    expect(fn, '_expand_tar_memberwise not found — gate structure changed').toBeTruthy();
    // The regression this pins: a manifest of paths alone cannot see the build
    // user that tar writes into every member header.
    expect(fn).toMatch(/member\.uname/);
    expect(fn).toMatch(/member\.gname/);
  });

  it('FAILS on a build-box identity carried ONLY by a compressed tar\'s uid/gid names', () => {
    if (!have('tar') || !have('python3')) {
      console.warn('[identity-gate guard] SKIPPED: tar/python3 unavailable on this host');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-owner-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      // CONTENTS ARE CLEAN ON PURPOSE. If the payload carried the sentinel the
      // content grep would catch it and this test would pass for the wrong
      // reason — proving nothing about ownership fields.
      writeFileSync(path.join(stage, 'PG_VERSION'), '16\n');

      const bundle = path.join(dir, 'bundle');
      mkdirSync(bundle, { recursive: true });
      const tgz = path.join(bundle, 'db-seed.tar.gz');
      execFileSync(
        'tar',
        ['-c', '-z', '-f', tgz, `--owner=${sentinel}`, `--group=${sentinel}`, '-C', stage, '.'],
        { stdio: 'ignore' },
      );
      rmSync(stage, { recursive: true, force: true });

      // PRECONDITION: gzip really does hide the header bytes, so the raw grep is
      // blind and only the expansion pass can possibly see this.
      const raw = spawnSync('grep', ['-acF', sentinel, tgz], { encoding: 'utf8' });
      expect(raw.stdout.trim(), 'tar headers were not actually compressed').toBe('0');

      const { status, out } = runGate(['--scan-dir', bundle]);
      expect(out).toMatch(/expanding 1 archive\(s\)/); // it DID open the archive
      expect(out).toMatch(/CARRIES SENSITIVE IDENTITY/);
      expect(status, 'gate must EXIT NONZERO on an identity in tar uid/gid names').not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('stays CLEAN on the same archive built with --numeric-owner (not a blanket fail)', () => {
    // The negative control. Without it, a gate that simply reds everything would
    // satisfy the test above, and "it fails" would not mean "it detects".
    if (!have('tar') || !have('python3')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-owner-ok-'));
    try {
      const stage = path.join(dir, 'stage');
      mkdirSync(stage, { recursive: true });
      writeFileSync(path.join(stage, 'PG_VERSION'), '16\n');
      const bundle = path.join(dir, 'bundle');
      mkdirSync(bundle, { recursive: true });
      execFileSync(
        'tar',
        ['-c', '-z', '-f', path.join(bundle, 'db-seed.tar.gz'),
         '--owner=0', '--group=0', '--numeric-owner', '-C', stage, '.'],
        { stdio: 'ignore' },
      );
      rmSync(stage, { recursive: true, force: true });

      const { status, out } = runGate(['--scan-dir', bundle]);
      expect(out).toMatch(/✓ CLEAN/);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('release identity gate: --scan-artifact fails closed (WI-39458)', () => {
  it('exposes --scan-artifact and keeps its suffixes OUT of ARCHIVE_SUFFIXES', () => {
    const src = gateSource();
    expect(src).toMatch(/--scan-artifact/);
    expect(src).toMatch(/def scan_artifact\(/);
    // The regression this pins, and it is the one the fix was NOT allowed to
    // make: `_iter_archives` walks the whole tree, so a `.exe` in ARCHIVE_SUFFIXES
    // turns every vendored Windows helper in node_modules into "uninspectable"
    // and reds every cut — converting a false PASS into a permanent false
    // FAILURE. Installer containers must be named explicitly instead.
    const archives = src.match(/^ARCHIVE_SUFFIXES\s*=\s*\(([\s\S]*?)\)/m)?.[1];
    expect(archives, 'ARCHIVE_SUFFIXES not found — gate structure changed').toBeTruthy();
    expect(archives).not.toMatch(/"\.exe"/);
    expect(archives).not.toMatch(/"\.msi"/);
    expect(archives).not.toMatch(/"\.dmg"/);
  });

  it('REFUSES (exit 2) a container it cannot open — never reports it clean', () => {
    if (!have('python3')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-artifact-'));
    try {
      // Random bytes: no extractor on any host can open this, which is the point.
      const opaque = path.join(dir, 'installer.exe');
      execFileSync('sh', ['-c', `head -c 2000000 /dev/urandom > ${JSON.stringify(opaque)}`]);

      const { status, out } = runGate(['--scan-artifact', opaque]);
      expect(out).toMatch(/COULD NOT BE INSPECTED/);
      expect(out).not.toMatch(/✓ CLEAN/);
      // Exit 2, never 1: a caller must be able to tell a BLIND gate from one that
      // found leaks, or it goes hunting a leak that is not there.
      expect(status, 'an unopenable container must be exit 2 (cannot check)').toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('REFUSES a container that opens but recovers an implausible fraction of itself', () => {
    if (!have('python3') || !have('zip')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-ratio-'));
    try {
      // The SFX shape, and the real hazard: a big opaque stub with a small valid
      // archive appended. zipfile happily reads the tail and exits 0 having
      // recovered ~0% — the same "successful extraction that inspected nothing"
      // 7z produces when it misdetects an Inno Setup PE as gzip and recovers
      // ~49KB of a 4.5MB installer. Scanning that 1% and reporting CLEAN would be
      // worse than not scanning, because the verdict reads as evidence.
      const inner = path.join(dir, 'inner');
      mkdirSync(inner, { recursive: true });
      writeFileSync(path.join(inner, 'small.txt'), 'tiny\n');
      execFileSync('sh', ['-c',
        `cd ${JSON.stringify(inner)} && zip -q inner.zip small.txt`]);
      const sfx = path.join(dir, 'spanned.zip');
      execFileSync('sh', ['-c',
        `head -c 10000000 /dev/urandom > ${JSON.stringify(sfx)} && ` +
        `cat ${JSON.stringify(path.join(inner, 'inner.zip'))} >> ${JSON.stringify(sfx)}`]);
      expect(statSync(sfx).size).toBeGreaterThan(9_000_000);

      const { status, out } = runGate(['--scan-artifact', sfx]);
      expect(out).toMatch(/recovered only/);
      expect(out).not.toMatch(/✓ CLEAN/);
      expect(status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('REFUSES an artifact shape it has never been taught, rather than skipping it', () => {
    if (!have('python3')) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-unknown-'));
    try {
      const odd = path.join(dir, 'installer.pkg');
      writeFileSync(odd, 'not a container we know\n');
      const { status, out } = runGate(['--scan-artifact', odd]);
      expect(out).toMatch(/UNRECOGNISED ARTIFACT TYPE/);
      expect(status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('REFUSES a missing artifact rather than passing on zero bytes read', () => {
    if (!have('python3')) return;
    const { status, out } = runGate([
      '--scan-artifact',
      path.join(tmpdir(), 'pc-gate-definitely-absent-9f2a.zip'),
    ]);
    expect(out).toMatch(/ARTIFACT MISSING/);
    expect(status).toBe(2);
  }, 60_000);

  it('CATCHES a leak inside a real container, and stays CLEAN on a clean one', () => {
    if (!have('python3') || !have('zip') || !have('tar')) return;
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-container-'));
    try {
      const mk = (name: string, owner: string) => {
        const stage = path.join(dir, `stage-${name}`);
        mkdirSync(stage, { recursive: true });
        writeFileSync(path.join(stage, 'PG_VERSION'), '16\n');
        const tgz = path.join(dir, `${name}-seed.tar.gz`);
        execFileSync('tar', ['-c', '-z', '-f', tgz,
          `--owner=${owner}`, `--group=${owner}`,
          ...(owner === '0' ? ['--numeric-owner'] : []), '-C', stage, '.'], { stdio: 'ignore' });
        rmSync(stage, { recursive: true, force: true });
        const zip = path.join(dir, `${name}.zip`);
        execFileSync('sh', ['-c',
          `cd ${JSON.stringify(dir)} && zip -q ${JSON.stringify(zip)} ${JSON.stringify(path.basename(tgz))}`]);
        return zip;
      };

      const leaky = runGate(['--scan-artifact', mk('leaky', sentinel)]);
      expect(leaky.out).toMatch(/CARRIES SENSITIVE IDENTITY/);
      expect(leaky.status).toBe(1); // 1 = found leaks, distinct from 2 = blind

      const clean = runGate(['--scan-artifact', mk('clean', '0')]);
      expect(clean.out).toMatch(/✓ CLEAN/);
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('--scan-artifact recurses into a WRAPPED installer (WI-39458)', () => {
  /**
   * The published Windows Server artifact is a `.zip` whose members are an Inno
   * Setup STUB plus its DiskSpan `.bin` slices. Expanding the zip alone
   * "succeeds" and passes the size-ratio check comfortably (~2.2GB out of a
   * 2.2GB container) while leaving ~100% of the real payload in blobs the scan
   * can only grep opaquely — the same false clean, one level down, on the exact
   * artifact this item was filed on. So the wrapper must not be mistaken for the
   * payload.
   */
  function wrappedFixture(dir: string, payload: string, name: string): string {
    const stageDir = path.join(dir, `p-${name}`);
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(path.join(stageDir, 'pgdata.conf'), payload);
    // A zip-with-an-.exe-name stands in for the Inno stub: the point under test
    // is that a WRAPPED installer gets expanded, not which packer made it.
    const stub = path.join(dir, `${name}_x64-setup.exe`);
    execFileSync('sh', ['-c',
      `cd ${JSON.stringify(stageDir)} && zip -q ${JSON.stringify(stub)} pgdata.conf`]);
    const wrapper = path.join(dir, `${name}.zip`);
    execFileSync('sh', ['-c',
      `cd ${JSON.stringify(dir)} && zip -q ${JSON.stringify(wrapper)} ${JSON.stringify(path.basename(stub))}`]);
    return wrapper;
  }

  it('CATCHES a leak two levels down, and stays CLEAN when the payload is clean', () => {
    if (!have('python3') || !have('zip') || !have('7z')) {
      console.warn('[identity-gate guard] SKIPPED: python3/zip/7z unavailable on this host');
      return;
    }
    const sentinel = sentinelFromDenylist();
    const dir = mkdtempSync(path.join(tmpdir(), 'pc-gate-wrap-'));
    try {
      const leaky = runGate([
        '--scan-artifact', wrappedFixture(dir, `owner=${sentinel}\n`, 'Leaky'),
      ]);
      expect(leaky.out).toMatch(/wraps/); // it recognised the wrapped installer
      expect(leaky.out).toMatch(/CARRIES SENSITIVE IDENTITY/);
      expect(leaky.status).toBe(1);

      // The control that makes the above mean something.
      const clean = runGate([
        '--scan-artifact', wrappedFixture(dir, 'nothing to see here\n', 'Clean'),
      ]);
      expect(clean.out).toMatch(/wraps/);
      expect(clean.out).toMatch(/✓ CLEAN/);
      expect(clean.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  /**
   * Exercised BEHAVIOURALLY, by calling the predicate, not by grepping its
   * source. An earlier version of this test asserted the function text did not
   * contain ".bin" and failed against a COMMENT explaining why .bin slices are
   * excluded — i.e. it measured prose, and its verdict would have flipped on a
   * reworded comment while the behaviour stayed identical.
   */
  function isStub(name: string): boolean {
    const r = spawnSync(
      'python3',
      ['-c',
       'import importlib.util,sys;' +
       's=importlib.util.spec_from_file_location("g",sys.argv[1]);' +
       'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);' +
       'print("YES" if m._looks_like_installer_stub(sys.argv[2]) else "NO")',
       GATE, name],
      { encoding: 'utf8', env: GATE_ENV },
    );
    if (r.status !== 0) throw new Error(`predicate call failed: ${r.stderr}`);
    return r.stdout.trim() === 'YES';
  }

  it('treats only a SETUP STUB as a container — never every bundled .exe', () => {
    if (!have('python3')) return;
    // The narrowness is the whole reason this recursion is safe.
    expect(isStub('Papercusp Server_0.0.17_x64-setup.exe')).toBe(true);
    expect(isStub('Papercusp.dmg')).toBe(true);
    expect(isStub('Papercusp.AppImage')).toBe(true);
    // …and the executables we legitimately BUNDLE must stay ordinary files.
    // Handing these to an expander that cannot open them would mark them
    // uninspectable and red every cut — the exact regression that keeps `.exe`
    // out of ARCHIVE_SUFFIXES, re-created one level in.
    expect(isStub('node.exe')).toBe(false);
    expect(isStub('gh.exe')).toBe(false);
    expect(isStub('papercusp-desktop.exe')).toBe(false);
  });

  it('does NOT expand DiskSpan .bin slices independently of their stub', () => {
    if (!have('python3')) return;
    // innoextract needs the STUB to locate its slices, and 7z pointed at a raw
    // slice recovers a misdetected fragment — so a slice must be pulled in BY
    // the stub, never treated as a container in its own right.
    expect(isStub('Papercusp Server_0.0.17_x64-setup-1.bin')).toBe(false);
    expect(isStub('Papercusp Server_0.0.17_x64-setup-2.bin')).toBe(false);
  });
});

describe('release producers do not stamp the build user into shipped tarballs (WI-39458)', () => {
  // The gate above is the BACKSTOP. These pin the fix at the SOURCE, so a leak
  // is not produced in the first place — the same convention stage-source-tree.sh
  // has always used for source.tar.zst.
  it('build-seed.mjs tars the PGDATA seed with numeric ownership', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs'),
      'utf8',
    );
    expect(src).toMatch(/--numeric-owner/);
    expect(src).toMatch(/--owner=0/);
    expect(src).toMatch(/--group=0/);
  });

  it('build-mac-cross.sh tars the updater .app.tar.gz with numeric ownership', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'papercusp-desktop/bin/build-mac-cross.sh'),
      'utf8',
    );
    const line = src.split('\n').find((l) => l.includes('tar') && l.includes('$tgz'));
    expect(line, 'updater tar line not found — build-mac-cross.sh structure changed').toBeTruthy();
    expect(line).toMatch(/--numeric-owner/);
  });
});

describe('the release builds route finished artifacts INTO the gate (WI-39458)', () => {
  // The defect was never that the machinery was weak — it was that nothing
  // handed it the published bytes. A correct gate nobody calls is not a gate.
  it('build-windows-cross.sh scans the finished installers', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'papercusp-desktop/bin/build-windows-cross.sh'),
      'utf8',
    );
    expect(src).toMatch(/--scan-artifact/);
    // Exit 2 (blind) and exit 1 (leak) must not share a message, or a blind gate
    // sends you hunting a leak that is not there.
    expect(src).toMatch(/_artifact_rc -eq 2/);
  });

  it('build-mac-cross.sh scans the finished dmg + updater tarball', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'papercusp-desktop/bin/build-mac-cross.sh'),
      'utf8',
    );
    expect(src).toMatch(/--scan-artifact/);
    expect(src).toMatch(/_artifact_rc -eq 2/);
  });
});
