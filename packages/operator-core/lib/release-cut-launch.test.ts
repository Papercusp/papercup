/**
 * release-cut-launch.test.ts — the LOCAL desktop-release cutter's PURE primitives
 * (desktop-update-center-and-release-tooling P-5 Unit B). No real cut, no fs, no spawn:
 * every branch is exercised through injected deps + fake trees, per RELEASE-RUNBOOK D-007
 * (no claim of "verified" rests on a live VM/build run that did not happen).
 *
 * Run: cd packages/operator-core && npx vitest run lib/release-cut-launch.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  isValidVersion,
  isValidChannel,
  isValidSourceSha,
  buildCutEnv,
  buildCutArgv,
  parseCutStartedMarker,
  readCutStatus,
  collectHandoff,
  preflightCut,
  isReleaseArtifact,
  isUpdaterArtifact,
  CUT_UNIT,
  CUT_DONE,
  CUT_LOG,
  CUT_STARTED,
  PLATFORMS,
  cutUnitFor,
  cutLogFor,
  cutDoneFor,
  cutStartedFor,
  legsForPlatform,
  abortLeg,
  deriveBuildSha,
  gatePath,
  readOrCreateGate,
  releaseToolingDrift,
  RELEASE_TOOLING_REFERENCE_BRANCH,
  RELEASE_TOOLING_SUBTREE,
  type GitRunner,
  type ReleaseToolingDrift,
} from './release-cut-launch';

describe('version / channel validation', () => {
  it('accepts X.Y.Z and X.Y.Z-prerelease, rejects junk', () => {
    expect(isValidVersion('0.0.8')).toBe(true);
    expect(isValidVersion('1.2.3-rc.1')).toBe(true);
    expect(isValidVersion('10.20.30-alpha.2')).toBe(true);
    expect(isValidVersion('v1.2.3')).toBe(false);
    expect(isValidVersion('1.2')).toBe(false);
    expect(isValidVersion('')).toBe(false);
    expect(isValidVersion('1.2.3; rm -rf /')).toBe(false);
  });
  it('accepts only the three channels', () => {
    expect(isValidChannel('stable')).toBe(true);
    expect(isValidChannel('beta')).toBe(true);
    expect(isValidChannel('alpha')).toBe(true);
    expect(isValidChannel('nightly')).toBe(false);
  });
  it('accepts only an exact lowercase 40-char source SHA', () => {
    expect(isValidSourceSha('1feac8dd867c6566af834445a58b5a2e43b14649')).toBe(true);
    expect(isValidSourceSha('1feac8dd')).toBe(false);
    expect(isValidSourceSha('1FEAC8DD867C6566AF834445A58B5A2E43B14649')).toBe(false);
  });
});

describe('buildCutEnv — LOCAL-only enforced', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const runtime = { ownerName: 'Avi' };
  it('always disables GitHub publish; adds only requested legs', () => {
    expect(buildCutEnv({}, sourceSha, runtime)).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
    });
    expect(buildCutEnv({ mac: true, windows: true, arm64: true }, sourceSha, runtime)).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
      WITH_MAC: '1',
      WITH_WINDOWS: '1',
      WITH_ARM64: '1',
    });
    // A false/undefined leg is not injected.
    expect(buildCutEnv({ mac: false }, sourceSha, { ownerName: ' Avi ', ownerEmail: ' owner@example.test ', reuseSeed: true })).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      PAPERCUSP_EXPECTED_SOURCE_SHA: sourceSha,
      PAPERCUSP_RELEASE_OWNER_NAME: 'Avi',
      PAPERCUSP_RELEASE_OWNER_EMAIL: 'owner@example.test',
      DEPENDENCY_GENERATION_FORCE_COPY: '1',
      PAPERCUSP_SKIP_DEP_GENERATION: '1',
      PAPERCUSP_SKIP_SEED_CUT: '1',
      PAPERCUSP_SKIP_MOBILE: '1',
    });
  });

  // EI-23917342543376581. The env below is an explicit ALLOWLIST rendered onto a
  // systemd-run command, so a name that is not forwarded here is silently dropped — which
  // is how `release:cut` lost a lever that a manual bin/release-local.sh run has always
  // had. Without it, a head-snapshot scan overrun offers only a FULL seed or an operator
  // quiesce (a fleet-affecting outage). These assert the forwarding AND that a malformed
  // override is ignored rather than fatal: cut-seed-cli refuses a bad value, and killing a
  // ~45-minute release cut over a stray env var would be worse than the derived deadline.
  it('forwards a valid head-snapshot timeout override, and ignores a malformed one', () => {
    expect(
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', headSnapshotTimeoutMs: 5_400_000 }),
    ).toMatchObject({ PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS: '5400000' });

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(
        buildCutEnv({}, sourceSha, { ownerName: 'Avi', headSnapshotTimeoutMs: bad }),
      ).not.toHaveProperty('PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS');
    }

    // Omitting it entirely must leave the env byte-identical to the baseline, so the
    // default path keeps deriving the deadline from the corpus length.
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty(
      'PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS',
    );
  });

  it('only forwards a migration smoke bypass backed by matching exact-source proof', () => {
    const migrationBootSmokeOverride = {
      sourceSha,
      proofRef: 'WI-10003146#exact-source-pass',
      reason: 'Frozen source has the old aggregate Vitest deadline',
    };
    expect(buildCutEnv({}, sourceSha, { ownerName: 'Avi', migrationBootSmokeOverride }))
      .toHaveProperty('PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE', '1');
    expect(buildCutEnv({}, sourceSha, runtime)).not.toHaveProperty('PAPERCUSP_SKIP_MIGRATION_BOOTSMOKE');
    expect(() => buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      migrationBootSmokeOverride: { ...migrationBootSmokeOverride, sourceSha: 'a'.repeat(40) },
    })).toThrow(/source_mismatch/);
    expect(() => buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      migrationBootSmokeOverride: { ...migrationBootSmokeOverride, proofRef: ' ' },
    })).toThrow(/evidence_required/);
  });

  it('refuses a missing runtime owner identity before constructing a cut command', () => {
    expect(() => buildCutEnv({}, sourceSha, { ownerName: '   ' })).toThrow(/release_owner_name_required/);
  });
});

describe('buildCutArgv', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  const argv = buildCutArgv(
    '/root/papercusp-desktop',
    '0.0.8',
    'alpha',
    { mac: true },
    sourceSha,
    '/usr/bin:/bin',
    { ownerName: "Avi O'Neil" },
    undefined,
    '/current/papercusp-desktop',
  );
  const inner = argv[argv.length - 1];

  it('targets the dedicated detached unit + desktop working dir', () => {
    expect(argv).toContain(`--unit=${CUT_UNIT}`);
    expect(argv).toContain('--working-directory=/root/papercusp-desktop');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
  });
  it('runs the cutter LOCAL-only, clears the stale sentinel, records the exit code', () => {
    expect(inner).toContain(`rm -f ${CUT_DONE}`);
    expect(inner).toContain(`> ${CUT_STARTED}`);
    expect(inner).toContain("PAPERCUSP_PUBLISH_GITHUB='0'");
    expect(inner).toContain(`PAPERCUSP_EXPECTED_SOURCE_SHA='${sourceSha}'`);
    expect(inner).toContain(`PAPERCUSP_RELEASE_OWNER_NAME='Avi O'\"'\"'Neil'`);
    expect(inner).toContain("DEPENDENCY_GENERATION_FORCE_COPY='1'");
    expect(inner).toContain("PAPERCUSP_SKIP_DEP_GENERATION='1'");
    expect(inner).toContain("PAPERCUSP_SKIP_MOBILE='1'");
    expect(inner).toContain("WITH_MAC='1'");
    expect(inner).toContain(`bash -c 'source "$1" "$2" "$3"'`);
    expect(inner).toContain("'/root/papercusp-desktop/bin/release-local.sh'");
    expect(inner).toContain("'/current/papercusp-desktop/bin/release-local.sh' '0.0.8' 'alpha'");
    expect(inner).toContain(`> ${CUT_LOG} 2>&1`);
    expect(inner).toContain(`echo "DONE:$?" > ${CUT_DONE}`);
  });
  it('never pushes a tag or creates a GitHub release', () => {
    expect(inner).not.toMatch(/gh release/);
    expect(inner).not.toMatch(/push origin/);
    expect(inner).not.toContain('PAPERCUSP_PUBLISH_GITHUB=1');
  });
});

describe('readCutStatus', () => {
  const noFiles = { existsSync: () => false, readFileSync: () => '', isUnitActive: () => false };

  it('running while the unit is active (no exit code yet)', () => {
    const s = readCutStatus({ ...noFiles, isUnitActive: () => true });
    expect(s.state).toBe('running');
    expect(s.running).toBe(true);
    expect(s.exitCode).toBeNull();
  });
  it('done on DONE:0 once the unit is inactive', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_DONE,
      readFileSync: () => 'DONE:0\n',
    });
    expect(s.state).toBe('done');
    expect(s.exitCode).toBe(0);
  });
  it('failed on a non-zero exit code', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_DONE,
      readFileSync: () => 'DONE:1',
    });
    expect(s.state).toBe('failed');
    expect(s.exitCode).toBe(1);
  });
  it('idle when nothing is running and no sentinel exists', () => {
    expect(readCutStatus(noFiles).state).toBe('idle');
  });
  it('interrupted when a launched unit stops before writing its DONE sentinel', () => {
    const s = readCutStatus({
      isUnitActive: () => false,
      existsSync: (p) => p === CUT_STARTED,
      readFileSync: () => 'STARTED:1723708996',
    });
    expect(s.state).toBe('interrupted');
    expect(s.running).toBe(false);
    expect(s.exitCode).toBeNull();
  });
  it('surfaces the last log lines when a log exists', () => {
    const log = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    const s = readCutStatus({
      isUnitActive: () => true,
      existsSync: (p) => p === CUT_LOG,
      readFileSync: () => log,
    });
    expect(s.logTail).toContain('line59');
    expect(s.logTail).not.toContain('line0\n'); // trimmed to the tail
  });
});

describe('isReleaseArtifact', () => {
  it('matches installer/updater extensions across platforms', () => {
    for (const n of [
      'papercusp-gui_0.0.8_amd64.AppImage',
      'papercusp-gui_0.0.8_amd64.deb',
      'Papercusp GUI_0.0.8_universal.app.tar.gz',
      'Papercusp GUI_0.0.8_x64-setup.exe',
      'Papercusp Server_0.0.8_x64-setup-1.bin', // Inno disk-spanning payload slice (WI-4243)
      'Papercusp Server_0.0.8_x64-setup-12.bin',
    ]) {
      expect(isReleaseArtifact(n)).toBe(true);
    }
    expect(isReleaseArtifact('serve.mjs')).toBe(false);
    expect(isReleaseArtifact('build-provenance.json')).toBe(false);
    expect(isReleaseArtifact('random.bin')).toBe(false); // only -setup-N.bin slices, not any .bin
  });
});

describe('isUpdaterArtifact', () => {
  it('only the updater-feed types require a .sig; native installers do not', () => {
    expect(isUpdaterArtifact('Papercusp GUI.app.tar.gz')).toBe(true);
    expect(isUpdaterArtifact('papercusp-gui_0.0.8_amd64.AppImage')).toBe(true);
    expect(isUpdaterArtifact('app_0.0.8_x64.nsis.zip')).toBe(true);
    expect(isUpdaterArtifact('Papercusp GUI_0.0.8_universal-apple-darwin.dmg')).toBe(false);
    expect(isUpdaterArtifact('Papercusp Server_0.0.8_x64-setup.exe')).toBe(false);
    expect(isUpdaterArtifact('Papercusp Server_0.0.8_x64-setup-1.bin')).toBe(false);
    expect(isUpdaterArtifact('papercusp-gui_0.0.8_amd64.deb')).toBe(false);
  });
});

describe('collectHandoff', () => {
  const root = '/fake/desktop';
  const targetRoot = `${root}/src-tauri/target`;
  const bundle = `${targetRoot}/release/bundle`;
  const appimage = `${bundle}/appimage/papercusp-gui_0.0.8_amd64.AppImage`;
  const deb = `${bundle}/deb/papercusp-gui_0.0.8_amd64.deb`;
  const tree = [
    appimage,
    `${appimage}.sig`,
    deb, // deb has NO .sig → unsigned (informational — deb is not an updater artifact)
    `${bundle}/appimage/papercusp-gui_0.0.7_amd64.AppImage`, // OLD version → excluded
    `${targetRoot}/release/latest.json`,
    `${bundle}/appimage/build-provenance.json`,
    `${targetRoot}/release/deps/papercusp-gui_0.0.8_amd64.AppImage`, // not in a bundle/ dir → excluded
    `${targetRoot}/release/serve.mjs`, // not an artifact
  ];
  // Single-root deps: no relocated cargo target dir, provenance unreadable (walk-only).
  const deps = {
    exists: (p: string) => p === targetRoot || tree.includes(p),
    listFiles: () => tree,
    fileSize: () => 1024,
    sha256: (p: string) => `sha(${p})`,
    readFile: () => '{}',
    cargoTargetRoot: () => null,
    realpath: (p: string) => p,
  };

  it('collects only version-scoped, in-bundle artifacts + their sig/manifest/provenance', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    expect(h.found).toBe(true);
    expect(h.scannedRoots).toEqual([targetRoot]);
    const names = h.artifacts.map((a) => a.name).sort();
    expect(names).toEqual(['papercusp-gui_0.0.8_amd64.AppImage', 'papercusp-gui_0.0.8_amd64.deb']);
    // old version + non-bundle + serve.mjs are all excluded
    expect(names).not.toContain('papercusp-gui_0.0.7_amd64.AppImage');
    expect(h.manifests).toEqual([`${targetRoot}/release/latest.json`]);
    expect(h.provenance).toEqual([`${bundle}/appimage/build-provenance.json`]);
  });
  it('an unsigned NON-updater artifact (deb) is informational, not a blocker (WI-4243)', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    const appEntry = h.artifacts.find((a) => a.name.endsWith('.AppImage'))!;
    const debEntry = h.artifacts.find((a) => a.name.endsWith('.deb'))!;
    expect(appEntry.signed).toBe(true);
    expect(debEntry.signed).toBe(false);
    expect(h.unsignedNames).toEqual([]); // deb is not an updater artifact → no blocker
    expect(h.unsignedInfoNames).toEqual(['papercusp-gui_0.0.8_amd64.deb']);
    expect(appEntry.sha256).toBe(`sha(${appimage})`);
  });
  it('an unsigned UPDATER artifact (AppImage) IS a blocker', () => {
    const noSig = tree.filter((f) => f !== `${appimage}.sig`);
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: (p) => p === targetRoot || noSig.includes(p), listFiles: () => noSig });
    expect(h.unsignedNames).toEqual(['papercusp-gui_0.0.8_amd64.AppImage']);
    expect(h.unsignedInfoNames).toEqual(['papercusp-gui_0.0.8_amd64.deb']);
  });
  it('found:false when no scannable root exists', () => {
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: () => false });
    expect(h.found).toBe(false);
    expect(h.scannedRoots).toEqual([]);
    expect(h.artifacts).toEqual([]);
  });

  it('collects the windows Inno setup.exe AND its -setup-N.bin payload slices; their missing sigs are informational (WI-4243)', () => {
    const inno = `${targetRoot}/windows-vm/bundle/inno`;
    const winTree = [
      `${inno}/Papercusp GUI_0.0.8_x64-setup.exe`,
      `${inno}/Papercusp Server_0.0.8_x64-setup.exe`,
      `${inno}/Papercusp Server_0.0.8_x64-setup-1.bin`,
      `${inno}/Papercusp Server_0.0.8_x64-setup-2.bin`,
    ];
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: (p) => p === targetRoot || winTree.includes(p), listFiles: () => winTree });
    expect(h.artifacts.map((a) => a.name).sort()).toEqual([
      'Papercusp GUI_0.0.8_x64-setup.exe',
      'Papercusp Server_0.0.8_x64-setup-1.bin',
      'Papercusp Server_0.0.8_x64-setup-2.bin',
      'Papercusp Server_0.0.8_x64-setup.exe',
    ]);
    expect(h.unsignedNames).toEqual([]); // none of these are updater artifacts
    expect(h.unsignedInfoNames).toHaveLength(4);
  });

  it('provenance pass catches the VERSIONLESS mac .app.tar.gz updater tarballs (subpath names, WI-4243)', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const dmg = `${macBundle}/dmg/Papercusp GUI_0.0.8_universal-apple-darwin.dmg`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [dmg, tgz, `${tgz}.sig`, prov];
    const provJson = JSON.stringify({
      version: '0.0.8',
      artifacts: [
        { name: 'dmg/Papercusp GUI_0.0.8_universal-apple-darwin.dmg', sig: false },
        { name: 'macos/Papercusp GUI.app.tar.gz', sig: true },
      ],
    });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    const names = h.artifacts.map((a) => a.name).sort();
    // dmg via the walk (version in name); the versionless tarball ONLY via provenance.
    expect(names).toEqual(['Papercusp GUI_0.0.8_universal-apple-darwin.dmg', 'macos/Papercusp GUI.app.tar.gz']);
    const tgzEntry = h.artifacts.find((a) => a.name.endsWith('.app.tar.gz'))!;
    expect(tgzEntry.path).toBe(tgz);
    expect(tgzEntry.signed).toBe(true);
    expect(h.unsignedNames).toEqual([]); // dmg unsigned is informational
    expect(h.unsignedInfoNames).toEqual(['Papercusp GUI_0.0.8_universal-apple-darwin.dmg']);
  });

  it('provenance pass resolves PRE-fix basename-only names via a unique basename match under the provenance dir', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [tgz, `${tgz}.sig`, prov];
    const provJson = JSON.stringify({ version: '0.0.8', artifacts: [{ name: 'Papercusp GUI.app.tar.gz' }] });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]!.path).toBe(tgz);
    expect(h.artifacts[0]!.signed).toBe(true);
  });

  it('a provenance for a DIFFERENT version contributes nothing', () => {
    const macBundle = `${targetRoot}/universal-apple-darwin/release/bundle`;
    const tgz = `${macBundle}/macos/Papercusp GUI.app.tar.gz`;
    const prov = `${macBundle}/build-provenance.json`;
    const macTree = [tgz, prov];
    const provJson = JSON.stringify({ version: '0.0.7', artifacts: [{ name: 'macos/Papercusp GUI.app.tar.gz' }] });
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      exists: (p) => p === targetRoot || macTree.includes(p),
      listFiles: () => macTree,
      readFile: (p) => (p === prov ? provJson : '{}'),
    });
    expect(h.found).toBe(false);
    expect(h.artifacts).toEqual([]);
  });

  it('scans the relocated cargo target_directory as a SECOND root (the linux leg, WI-4243)', () => {
    const cargoRoot = '/fake/cargo-target';
    const linuxDeb = `${cargoRoot}/release/bundle/deb/papercusp-gui_0.0.8_amd64.deb`;
    const linuxTree = [linuxDeb, `${linuxDeb}.sig`];
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      cargoTargetRoot: () => cargoRoot,
      exists: (p) => p === targetRoot || p === cargoRoot || tree.includes(p) || linuxTree.includes(p),
      listFiles: (d) => (d === cargoRoot ? linuxTree : tree),
    });
    expect(h.scannedRoots).toEqual([targetRoot, cargoRoot]);
    expect(h.artifacts.some((a) => a.path === linuxDeb)).toBe(true);
    const linuxEntry = h.artifacts.find((a) => a.path === linuxDeb)!;
    expect(linuxEntry.signed).toBe(true);
  });

  it('de-dupes the cargo root when it is the SAME tree as src-tauri/target (realpath)', () => {
    let listCalls = 0;
    const h = collectHandoff('0.0.8', { root }, {
      ...deps,
      cargoTargetRoot: () => '/fake/cargo-target',
      exists: (p) => p === targetRoot || p === '/fake/cargo-target' || tree.includes(p),
      realpath: () => '/real/shared-target', // both roots resolve to one tree
      listFiles: () => {
        listCalls++;
        return tree;
      },
    });
    expect(h.scannedRoots).toHaveLength(1);
    expect(listCalls).toBe(1);
    expect(h.artifacts).toHaveLength(2); // no duplicated artifacts
  });
});

describe('preflightCut', () => {
  const root = '/root/papercusp-desktop';
  const home = '/home/tester';
  const key = `${home}/.papercusp/signing/papercusp.key`;
  const cutter = `${root}/bin/release-local.sh`;
  const scripts = [
    `${root}/bin/verify-provenance.sh`,
    `${root}/bin/vm-preflight.sh`,
    `${root}/bin/install-and-relaunch-verify.sh`,
  ];
  const migrationLintEntrypoint = '/root/node_modules/@papercusp/operator-core/lib/util/cli-entry.ts';
  const allPresent = new Set([key, cutter, migrationLintEntrypoint, ...scripts]);

  it('go:true when key + cutter + scripts present and no cut in flight', () => {
    const r = preflightCut({}, { root }, { home, exists: (p) => allPresent.has(p), isUnitActive: () => false });
    expect(r.go).toBe(true);
    expect(r.blockers).toEqual([]);
  });
  it('a missing cutter or signing key is a HARD blocker', () => {
    const noCutter = preflightCut({}, { root }, { home, exists: (p) => allPresent.has(p) && p !== cutter, isUnitActive: () => false });
    expect(noCutter.go).toBe(false);
    expect(noCutter.blockers.join()).toMatch(/cutter/);

    const noKey = preflightCut({}, { root }, { home, exists: (p) => allPresent.has(p) && p !== key, isUnitActive: () => false });
    expect(noKey.go).toBe(false);
    expect(noKey.blockers.join()).toMatch(/signing-key/);
  });
  it('a source-only checkout missing the migration-lint runtime is a HARD blocker', () => {
    const r = preflightCut({}, { root }, {
      home,
      exists: (p) => allPresent.has(p) && p !== migrationLintEntrypoint,
      isUnitActive: () => false,
    });
    expect(r.go).toBe(false);
    expect(r.blockers.join()).toMatch(/migration-lint-dependencies/);
    expect(r.checks.find((c) => c.name === 'migration-lint-dependencies')!.detail).toContain(
      'before dependency preparation',
    );
  });
  it('a missing verify script is WARN-only (cut can still run)', () => {
    const r = preflightCut({}, { root }, { home, exists: (p) => allPresent.has(p) && p !== scripts[0], isUnitActive: () => false });
    expect(r.go).toBe(true); // warnOnly does not block
    expect(r.checks.find((c) => c.name.includes('verify-provenance'))!.ok).toBe(false);
  });
  it('a cut already in flight is a HARD blocker', () => {
    const r = preflightCut({}, { root }, { home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === CUT_UNIT });
    expect(r.go).toBe(false);
    expect(r.blockers.join()).toMatch(/no-cut-in-flight/);
  });
  it('requested mac/windows legs add an informational VM reminder', () => {
    const r = preflightCut({ mac: true, windows: true }, { root }, { home, exists: (p) => allPresent.has(p), isUnitActive: () => false });
    expect(r.go).toBe(true);
    expect(r.checks.some((c) => c.name === 'leg:mac')).toBe(true);
    expect(r.checks.some((c) => c.name === 'leg:windows')).toBe(true);
  });
  it('a per-leg in-flight check looks at that platform\'s OWN unit, not the whole-cut one', () => {
    // The whole-cut unit is active, but we're preflighting the 'mac' LEG — a distinct unit —
    // so this must NOT be blocked by an unrelated whole-cut run.
    const r = preflightCut({}, { root, platform: 'mac' }, { home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === CUT_UNIT });
    expect(r.go).toBe(true);
    expect(r.checks.find((c) => c.name === 'no-cut-in-flight')!.detail).toContain('no cut in flight');

    // Conversely, the mac leg's OWN unit being active DOES block it.
    const blocked = preflightCut({}, { root, platform: 'mac' }, { home, exists: (p) => allPresent.has(p), isUnitActive: (u) => u === cutUnitFor('mac') });
    expect(blocked.go).toBe(false);
    expect(blocked.blockers.join()).toMatch(/no-cut-in-flight/);
  });
});

// ─── Per-leg (fleet-split) support — WI-4233 ───────────────────────────────────

describe('cutUnitFor / cutLogFor / cutDoneFor', () => {
  it('platform omitted ⇒ the legacy whole-cut triple, unchanged', () => {
    expect(cutUnitFor()).toBe(CUT_UNIT);
    expect(cutLogFor()).toBe(CUT_LOG);
    expect(cutDoneFor()).toBe(CUT_DONE);
  });
  it('each platform gets its own distinct unit/log/done', () => {
    const seen = new Set<string>();
    for (const p of PLATFORMS) {
      const unit = cutUnitFor(p);
      expect(unit).toBe(`${CUT_UNIT}-${p}`);
      expect(cutLogFor(p)).toBe(`/tmp/${unit}.log`);
      expect(cutDoneFor(p)).toBe(`/tmp/${unit}.done`);
      expect(seen.has(unit)).toBe(false);
      seen.add(unit);
    }
  });
});

describe('legsForPlatform', () => {
  it('maps each platform to exactly its own WITH_* flag (linux needs none)', () => {
    expect(legsForPlatform('linux')).toEqual({});
    expect(legsForPlatform('mac')).toEqual({ mac: true });
    expect(legsForPlatform('windows')).toEqual({ windows: true });
    expect(legsForPlatform('arm64')).toEqual({ arm64: true });
  });
});

describe('buildCutArgv with a platform', () => {
  it('targets the per-leg unit + log + done, not the whole-cut ones', () => {
    const argv = buildCutArgv(
      '/root/papercusp-desktop',
      '0.0.8',
      'alpha',
      { mac: true },
      '1feac8dd867c6566af834445a58b5a2e43b14649',
      '/usr/bin:/bin',
      { ownerName: 'Avi' },
      'mac',
      '/current/papercusp-desktop',
    );
    const inner = argv[argv.length - 1]!;
    const unit = cutUnitFor('mac');
    expect(argv).toContain(`--unit=${unit}`);
    expect(inner).toContain(`rm -f ${cutDoneFor('mac')}`);
    expect(inner).toContain(`> ${cutLogFor('mac')} 2>&1`);
    expect(inner).toContain(`echo "DONE:$?" > ${cutDoneFor('mac')}`);
    expect(inner).not.toContain(CUT_DONE); // sanity: not the bare whole-cut done-file path
  });

  it('reuses verified Linux salvage for a non-Linux leg instead of rebuilding Linux', () => {
    const argv = buildCutArgv(
      '/root/papercusp-desktop',
      '0.0.8',
      'alpha',
      { windows: true },
      '1feac8dd867c6566af834445a58b5a2e43b14649',
      '/usr/bin:/bin',
      { ownerName: 'Avi' },
      'windows',
      '/current/papercusp-desktop',
    );
    const inner = argv[argv.length - 1]!;

    // release-local.sh validates the same-version build-provenance.json before
    // honoring this flag, so this is a verified salvage path rather than a blind
    // skip. The requested Windows leg remains enabled independently.
    expect(inner).toContain("PAPERCUSP_REUSE_LINUX='1'");
    expect(inner).toContain("WITH_WINDOWS='1'");
  });
});

describe('readCutStatus with a platform', () => {
  it('reads that leg\'s own unit/log/done, independent of the whole-cut ones', () => {
    const macDone = cutDoneFor('mac');
    const macLog = cutLogFor('mac');
    const s = readCutStatus({
      platform: 'mac',
      isUnitActive: (u) => u === cutUnitFor('mac'),
      existsSync: (p) => p === macDone || p === macLog,
      readFileSync: (p) => (p === macDone ? 'DONE:0' : 'mac build log'),
    });
    // running:true because isUnitActive matches the mac unit — precedence over the DONE sentinel.
    expect(s.state).toBe('running');
    expect(s.logPath).toBe(macLog);
    expect(s.donePath).toBe(macDone);
    expect(cutStartedFor('mac')).toBe('/tmp/papercup-release-cut-mac.started');
  });
  it('two legs are fully independent — one done, the other still running', () => {
    const done = new Set([cutDoneFor('mac')]);
    const active = new Set([cutUnitFor('windows')]);
    const mac = readCutStatus({
      platform: 'mac',
      isUnitActive: (u) => active.has(u),
      existsSync: (p) => done.has(p),
      readFileSync: () => 'DONE:0',
    });
    const windows = readCutStatus({
      platform: 'windows',
      isUnitActive: (u) => active.has(u),
      existsSync: (p) => done.has(p),
      readFileSync: () => 'DONE:0',
    });
    expect(mac.state).toBe('done');
    expect(windows.state).toBe('running');
  });
});

describe('abortLeg', () => {
  it('stops the platform\'s own unit and reports success', () => {
    const stopped: string[] = [];
    const r = abortLeg('windows', { stopUnit: (u) => stopped.push(u) });
    expect(r.stopped).toBe(true);
    expect(r.unit).toBe(cutUnitFor('windows'));
    expect(stopped).toEqual([cutUnitFor('windows')]);
  });
  it('a failing stop (e.g. unit already inactive) reports stopped:false with the reason, not a throw', () => {
    const r = abortLeg('mac', {
      stopUnit: () => {
        throw new Error('Unit papercup-release-cut-mac.service not loaded.');
      },
    });
    expect(r.stopped).toBe(false);
    expect(r.reason).toMatch(/not loaded/);
  });
});

describe('deriveBuildSha', () => {
  it('a clean tree reports the bare short sha, not dirty', () => {
    const info = deriveBuildSha('/root/papercusp-desktop', { gitShortHead: () => 'abc1234', gitDirty: () => false });
    expect(info).toEqual({ sha: 'abc1234', dirty: false });
  });
  it('dirty in EITHER the desktop root or its parent (the superproject) marks the whole thing dirty', () => {
    const dirtyChild = deriveBuildSha('/root/papercusp-desktop', {
      gitShortHead: () => 'abc1234',
      gitDirty: (r) => r === '/root/papercusp-desktop',
    });
    expect(dirtyChild.dirty).toBe(true);
    const dirtyParent = deriveBuildSha('/root/papercusp-desktop', {
      gitShortHead: () => 'abc1234',
      gitDirty: (r) => r === '/root',
    });
    expect(dirtyParent.dirty).toBe(true);
  });
});

describe('gatePath', () => {
  it('is scoped per (version, channel) so different releases never collide', () => {
    expect(gatePath('0.0.8', 'alpha')).toBe('/tmp/papercup-release-gate-0.0.8-alpha.json');
    expect(gatePath('0.0.8', 'alpha')).not.toBe(gatePath('0.0.9', 'alpha'));
    expect(gatePath('0.0.8', 'alpha')).not.toBe(gatePath('0.0.8', 'beta'));
  });
});

describe('readOrCreateGate', () => {
  it('the first caller derives + writes the gate and gets created:true', () => {
    const written: Record<string, string> = {};
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-first', {
      exists: (p) => Object.prototype.hasOwnProperty.call(written, p),
      readFileSync: (p) => written[p]!,
      writeFileSyncExclusive: (p, data) => {
        written[p] = data;
      },
      derive: () => ({ sha: 'abc1234', dirty: false }),
    });
    expect(created).toBe(true);
    expect(gate).toMatchObject({ version: '0.0.8', channel: 'alpha', buildSha: 'abc1234', dirty: false, derivedBy: 'su-first' });
    expect(gate.derivedAt).toBeTruthy();
  });
  it('a later caller reads back the SAME gate instead of re-deriving — created:false', () => {
    const existing = {
      version: '0.0.8',
      channel: 'alpha' as const,
      buildSha: 'abc1234',
      dirty: false,
      derivedAt: '2026-07-11T00:00:00.000Z',
      derivedBy: 'su-first',
    };
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-second', {
      exists: () => true,
      readFileSync: () => JSON.stringify(existing),
      // If this were called, the test should fail — a later caller must NOT re-derive.
      derive: () => ({ sha: 'DIFFERENT-SHA-would-be-a-bug', dirty: false }),
    });
    expect(created).toBe(false);
    expect(gate).toEqual(existing);
  });
  it('a create race (two first-callers) converges on ONE writer — the loser reads back the winner\'s gate', () => {
    let writeCount = 0;
    const winnerGate = {
      version: '0.0.8',
      channel: 'alpha' as const,
      buildSha: 'winner-sha',
      dirty: false,
      derivedAt: '2026-07-11T00:00:01.000Z',
      derivedBy: 'su-winner',
    };
    const { gate, created } = readOrCreateGate('0.0.8', 'alpha', 'su-loser', {
      exists: () => false, // the loser's own check sees "absent" (race window)...
      readFileSync: () => JSON.stringify(winnerGate),
      writeFileSyncExclusive: () => {
        writeCount++;
        throw new Error('EEXIST: file already exists'); // ...but the exclusive create loses the race
      },
      derive: () => ({ sha: 'loser-sha-would-be-wrong', dirty: false }),
    });
    expect(writeCount).toBe(1);
    expect(created).toBe(false);
    expect(gate.buildSha).toBe('winner-sha'); // reads back the WINNER's sha, not its own derivation
  });
});

/**
 * WI-10002449 — preflight used to check only that release scripts EXIST, never what they
 * CONTAINED, so a cut root frozen weeks ago with superseded tooling returned go:true.
 * Measured on the real paused 0.0.22 root: 187 commits behind, with bin/upload-release.sh
 * at the PRE-fix blob of the stale-artifact bug (EI-23963309971611146). Preflight said go.
 *
 * The check must separate two things a cut tree mixes: product source (pinned on purpose,
 * drift is correct) from release machinery (must be current, drift re-executes old bugs).
 */
describe('release-tooling staleness', () => {
  // Real topology (measured on the paused 0.0.22 root): the cut root is a linked
  // worktree sharing the canonical .git, its submodule is a STANDALONE clone lacking the
  // newer pin, and the shared modules store holds both pins.
  const SUPER = '/cut';
  const SUBJECT = '/cut/papercusp-desktop';
  const COMMON = '/canonical/.git';
  const STORE = '/canonical/.git/modules/papercusp-desktop';
  const SUBJECT_PIN = 'b396279eae52d2b7e96623ee48058423f0e3c9bb';
  const REFERENCE_PIN = '867b7ddf94475461710870d6aa3421bfce73202f';

  /** Keys are `<repo>::<argv joined>`; anything unlisted fails, like a real git would. */
  function fakeGit(table: Record<string, { ok: boolean; stdout: string }>, calls: string[][] = []): GitRunner {
    return (repo, args) => {
      calls.push([repo, ...args]);
      return table[`${repo}::${args.join(' ')}`] ?? { ok: false, stdout: '' };
    };
  }

  const okv = (stdout = '') => ({ ok: true, stdout });
  const FAIL = { ok: false, stdout: '' };

  function behindTable(staleFiles: string[], branch = 'main') {
    return {
      [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
      [`${SUPER}::rev-parse ${branch}:papercusp-desktop`]: okv(`${REFERENCE_PIN}\n`),
      [`${SUPER}::rev-parse --path-format=absolute --git-common-dir`]: okv(`${COMMON}\n`),
      [`${STORE}::cat-file -e ${SUBJECT_PIN}^{commit}`]: okv(),
      [`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`]: okv(),
      [`${STORE}::diff --name-only ${SUBJECT_PIN} ${REFERENCE_PIN} -- ${RELEASE_TOOLING_SUBTREE}`]:
        okv(staleFiles.join('\n') + (staleFiles.length ? '\n' : '')),
      [`${STORE}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`]: okv(),
    };
  }
  const drift = (table: Record<string, { ok: boolean; stdout: string }>, calls?: string[][], referenceBranch?: string) =>
    releaseToolingDrift({ subjectDesktopRoot: SUBJECT, referenceBranch, git: fakeGit(table, calls) });

  describe('releaseToolingDrift', () => {
    it('reads the reference from the GREEN BRANCH pin by default, never from a checkout path', () => {
      // Regression for the vacuous version: a checkout-path reference resolved to the
      // :3070 release checkout at the last DEPLOYED green sha — the same sha as a stale
      // cut root — so stale-vs-stale read 'current'. The reference must be a branch ref.
      const calls: string[][] = [];
      const r = drift(behindTable(['bin/upload-release.sh']), calls);
      expect(RELEASE_TOOLING_REFERENCE_BRANCH).toBe('main');
      expect(calls).toContainEqual([SUPER, 'rev-parse', 'main:papercusp-desktop']);
      expect(calls.some((c) => c.includes('staging:papercusp-desktop'))).toBe(false);
      expect(calls.some((c) => c[0] !== SUBJECT && c[1] === 'rev-parse' && c[2] === 'HEAD')).toBe(false);
      expect(r.state).toBe('behind');
    });

    it('a root pinned at the latest green pin is CURRENT however far the integration tip has moved (EI-24294628776810491)', () => {
      // The treadmill: staging's pin moved (a test-rig script edit) after the root was cut
      // from green main. Measuring against staging refused every exact-source cut; the
      // green pin is the reference, so staging's pin must never even be consulted.
      const calls: string[][] = [];
      const r = drift(
        {
          [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
          [`${SUPER}::rev-parse main:papercusp-desktop`]: okv(`${SUBJECT_PIN}\n`),
          [`${SUPER}::rev-parse staging:papercusp-desktop`]: okv(`${REFERENCE_PIN}\n`),
        },
        calls,
      );
      expect(r.state).toBe('current');
      expect(r.staleFiles).toEqual([]);
      expect(calls.some((c) => c.includes('staging:papercusp-desktop'))).toBe(false);
    });

    it('honours an explicit reference branch', () => {
      const r = drift(behindTable(['bin/release-local.sh'], 'trunk'), undefined, 'trunk');
      expect(r.state).toBe('behind');
    });

    it('identical pins are current', () => {
      const r = drift({
        [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`),
        [`${SUPER}::rev-parse main:papercusp-desktop`]: okv(`${SUBJECT_PIN}\n`),
      });
      expect(r.state).toBe('current');
      expect(r.staleFiles).toEqual([]);
    });

    it('an ancestor pin with differing bin/ files reads BEHIND, with the files sorted', () => {
      const r = drift(behindTable(['bin/upload-release.sh', 'bin/lib/release-artifacts.sh']));
      expect(r.state).toBe('behind');
      expect(r.staleFiles).toEqual(['bin/lib/release-artifacts.sh', 'bin/upload-release.sh']);
      expect(r.subjectPin).toBe(SUBJECT_PIN);
      expect(r.referencePin).toBe(REFERENCE_PIN);
    });

    it('scopes the diff to the release-machinery subtree, not the whole tree', () => {
      const calls: string[][] = [];
      drift(behindTable(['bin/release-local.sh']), calls);
      const diffCall = calls.find((c) => c.includes('diff'));
      expect(diffCall).toBeDefined();
      // Without the pathspec this would report product-source churn as stale machinery.
      expect(diffCall!.slice(-2)).toEqual(['--', RELEASE_TOOLING_SUBTREE]);
    });

    it('a non-ancestor pin reads DIVERGED, not behind — a deliberate pin may be ahead', () => {
      const table = behindTable(['bin/release-local.sh']);
      table[`${STORE}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`] = FAIL;
      const r = drift(table);
      expect(r.state).toBe('diverged');
      expect(r.staleFiles).toEqual(['bin/release-local.sh']);
    });

    it('falls back to the subject clone when the shared store lacks a pin', () => {
      const table: Record<string, { ok: boolean; stdout: string }> = {
        ...behindTable([]),
        [`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`]: FAIL,
        [`${SUBJECT}::cat-file -e ${SUBJECT_PIN}^{commit}`]: okv(),
        [`${SUBJECT}::cat-file -e ${REFERENCE_PIN}^{commit}`]: okv(),
        [`${SUBJECT}::diff --name-only ${SUBJECT_PIN} ${REFERENCE_PIN} -- ${RELEASE_TOOLING_SUBTREE}`]: okv('bin/upload-release.sh\n'),
        [`${SUBJECT}::merge-base --is-ancestor ${SUBJECT_PIN} ${REFERENCE_PIN}`]: okv(),
      };
      const r = drift(table);
      expect(r.state).toBe('behind');
      expect(r.staleFiles).toEqual(['bin/upload-release.sh']);
    });

    it('no store holding BOTH pins is unknown — it must never read as clean', () => {
      // The trap: git diff against an unresolvable object yields an EMPTY file list,
      // byte-identical to "nothing drifted". The real cut-root submodule is a standalone
      // clone lacking the newer pin, so this is the default outcome without the store.
      const table = behindTable(['bin/upload-release.sh']);
      table[`${STORE}::cat-file -e ${REFERENCE_PIN}^{commit}`] = FAIL;
      const r = drift(table);
      expect(r.state).toBe('unknown');
      expect(r.detail).toMatch(/no object store holds both/);
    });

    it('an unresolvable subject HEAD or branch pin is unknown, naming what failed', () => {
      expect(drift({}).detail).toContain(SUBJECT);
      const noBranch = drift({ [`${SUBJECT}::rev-parse HEAD`]: okv(`${SUBJECT_PIN}\n`) });
      expect(noBranch.state).toBe('unknown');
      expect(noBranch.detail).toMatch(/main branch's pin of papercusp-desktop/);
    });
  });

  describe('preflight check: release-tooling-current', () => {
    const root = '/root/papercusp-desktop';
    const home = '/home/tester';
    const present = new Set([
      `${home}/.papercusp/signing/papercusp.key`,
      `${root}/bin/release-local.sh`,
      '/root/node_modules/@papercusp/operator-core/lib/util/cli-entry.ts',
      `${root}/bin/verify-provenance.sh`,
      `${root}/bin/vm-preflight.sh`,
      `${root}/bin/install-and-relaunch-verify.sh`,
    ]);
    const base = { home, exists: (p: string) => present.has(p), isUnitActive: () => false };
    const withDrift = (d: Partial<ReleaseToolingDrift>, currentCutter = '') =>
      preflightCut(
        {},
        { root },
        {
          ...base,
          releaseToolingDrift: () => ({ state: 'current', staleFiles: [], ...d }) as ReleaseToolingDrift,
          readOrchestratorScript: () => currentCutter,
        },
      );
    const check = (r: ReturnType<typeof preflightCut>) =>
      r.checks.find((c) => c.name === 'release-tooling-current')!;

    it('BEHIND with stale machinery is a HARD blocker that names the files and the remedy', () => {
      const r = withDrift({
        state: 'behind',
        staleFiles: ['bin/lib/release-artifacts.sh', 'bin/upload-release.sh'],
        subjectPin: SUBJECT_PIN,
        referencePin: REFERENCE_PIN,
      });
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toMatch(/release-tooling-current/);
      expect(check(r).detail).toContain('bin/upload-release.sh');
      expect(check(r).detail).toMatch(/setup-release-checkout/); // remedy, not just a complaint
      expect(check(r).warnOnly).toBeUndefined();
    });

    it('BEHIND with product-source drift ONLY is not a blocker — an isolated pin is meant to lag', () => {
      const r = withDrift({ state: 'behind', staleFiles: [] });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(true);
      expect(check(r).detail).toMatch(/product-source drift only/);
    });

    it('exact-source cut accepts known frozen scripts only when the current cutter does not execute them', () => {
      const staleFiles = [
        'bin/build-desktop-sidecar.sh',
        'bin/install-and-relaunch-verify.sh',
        'bin/lib/federation-asserts.selftest.sh',
        'bin/live-federation-gate.sh',
        'bin/release-local.sh',
        'bin/vm-rig/boot-headless-current.sh',
      ];
      const current = withDrift(
        { state: 'behind', staleFiles },
        'PAPERCUSP_DESKTOP_TARGET_ROOT="$ROOT" bash "$ORCHESTRATOR_HERE/build-desktop-sidecar.sh"\n',
      );
      expect(current.go).toBe(true);
      expect(check(current).detail).toMatch(/no direct target-tree invocation of these files/);

      const frozen = withDrift({ state: 'behind', staleFiles }, 'bash "$ROOT/bin/build-desktop-sidecar.sh"\n');
      expect(frozen.go).toBe(false);
      expect(frozen.blockers.join()).toContain('bin/build-desktop-sidecar.sh');
    });

    it('cannot waive a frozen script when the current cutter source is unreadable', () => {
      const r = preflightCut(
        {},
        { root },
        {
          ...base,
          releaseToolingDrift: () => ({ state: 'behind', staleFiles: ['bin/build-desktop-sidecar.sh'] }),
          readOrchestratorScript: () => {
            throw new Error('unreadable');
          },
        },
      );
      expect(r.go).toBe(false);
      expect(r.blockers.join()).toContain('bin/build-desktop-sidecar.sh');
    });

    it('DIVERGED is warn-only, so a deliberate pin is surfaced without being refused', () => {
      const r = withDrift({ state: 'diverged', staleFiles: ['bin/release-local.sh'] });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(false);
      expect(check(r).warnOnly).toBe(true);
    });

    it('UNKNOWN is surfaced as unmeasured rather than passed off as clean', () => {
      const r = withDrift({ state: 'unknown', detail: 'git diff failed' });
      expect(check(r).ok).toBe(false);
      expect(check(r).warnOnly).toBe(true);
      expect(check(r).detail).toMatch(/UNMEASURED/);
      expect(r.go).toBe(true); // unmeasured must not wedge a cut
    });

    it('CURRENT machinery leaves preflight green', () => {
      const r = withDrift({ state: 'current', subjectPin: REFERENCE_PIN });
      expect(r.go).toBe(true);
      expect(check(r).ok).toBe(true);
    });

    it('a root that is not a git checkout is unmeasured, and never silently clean', () => {
      // No releaseToolingDrift injected: the default path runs, and `exists` reports no
      // .git, so it must decline to answer instead of shelling out or assuming current.
      const r = preflightCut({}, { root }, base);
      expect(check(r).ok).toBe(false);
      expect(check(r).detail).toMatch(/UNMEASURED/);
      expect(r.go).toBe(true);
    });
  });
});

// ─── Managed-release journal identity (P-001) ──────────────────────────────────
// The manual cut path minted no operation id, so release-local.sh's journal never ran
// and an interrupted cut had nothing to resume from. These cover the threading and,
// more importantly, the refusals that keep a half-configured or foreign cut from
// reading as a good one.

describe('buildCutEnv — managed-release journal identity', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';

  it('threads BOTH ids so release-local.sh enables its phase journal', () => {
    const env = buildCutEnv({}, sourceSha, {
      ownerName: 'Avi',
      releaseTaskId: 'task1',
      releaseOperationId: 'op-1',
      enqueuedAtMs: 1_700_000_000_000,
    });
    expect(env.PAPERCUSP_RELEASE_TASK_ID).toBe('task1');
    expect(env.PAPERCUSP_RELEASE_OPERATION_ID).toBe('op-1');
    expect(env.PAPERCUSP_RELEASE_ENQUEUED_AT_MS).toBe('1700000000000');
  });

  it('emits NEITHER id for an unmanaged cut — unchanged pre-P-001 behavior', () => {
    const env = buildCutEnv({}, sourceSha, { ownerName: 'Avi' });
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_TASK_ID');
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_OPERATION_ID');
    expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_ENQUEUED_AT_MS');
  });

  it('REFUSES a half-set pair at build time instead of failing inside the detached unit', () => {
    // release_task_journal_configure() exits 2 on this, but only after the cut is away —
    // so the caller would see launched:true and learn nothing until it read the log.
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: 'task1' }),
    ).toThrow(/release_journal_identity_incomplete/);
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseOperationId: 'op-1' }),
    ).toThrow(/release_journal_identity_incomplete/);
  });

  it('treats a blank id as absent, so whitespace cannot produce a half-set pair', () => {
    expect(() =>
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: '  ', releaseOperationId: 'op-1' }),
    ).toThrow(/release_journal_identity_incomplete/);
    expect(
      buildCutEnv({}, sourceSha, { ownerName: 'Avi', releaseTaskId: '  ', releaseOperationId: '  ' }),
    ).not.toHaveProperty('PAPERCUSP_RELEASE_TASK_ID');
  });

  it('drops a malformed enqueue stamp rather than failing the cut over it', () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const env = buildCutEnv({}, sourceSha, {
        ownerName: 'Avi',
        releaseTaskId: 'task1',
        releaseOperationId: 'op-1',
        enqueuedAtMs: bad,
      });
      expect(env).not.toHaveProperty('PAPERCUSP_RELEASE_ENQUEUED_AT_MS');
      expect(env.PAPERCUSP_RELEASE_OPERATION_ID).toBe('op-1');
    }
  });
});

describe('buildCutArgv — the started marker carries the operation identity', () => {
  const sourceSha = '1feac8dd867c6566af834445a58b5a2e43b14649';
  function inner(runtime: Parameters<typeof buildCutArgv>[6]): string {
    const argv = buildCutArgv('/root/papercusp-desktop', '0.0.8', 'alpha', {}, sourceSha, '/bin', runtime);
    return argv[argv.length - 1];
  }

  it('stamps OPERATION + TASK into the marker a managed cut writes', () => {
    const cmd = inner({ ownerName: 'Avi', releaseTaskId: 'task1', releaseOperationId: 'op-1' });
    expect(cmd).toContain("printf 'STARTED:%s\\nOPERATION:%s\\nTASK:%s\\n'");
    expect(cmd).toContain("'op-1'");
    expect(cmd).toContain("'task1'");
    expect(cmd).toContain(`> ${CUT_STARTED}`);
  });

  it('writes the plain timestamp-only marker for an unmanaged cut', () => {
    const cmd = inner({ ownerName: 'Avi' });
    expect(cmd).toContain("printf 'STARTED:%s\\n'");
    expect(cmd).not.toContain('OPERATION:');
  });

  it('single-quotes the ids so a hostile id cannot break out of the wrapper', () => {
    const cmd = inner({ ownerName: 'Avi', releaseTaskId: 'task1', releaseOperationId: "o'p" });
    expect(cmd).toContain(`'o'\"'\"'p'`);
  });
});

describe('parseCutStartedMarker', () => {
  it('reads the identified marker', () => {
    expect(parseCutStartedMarker('STARTED:1700000000\nOPERATION:op-1\nTASK:task1\n')).toEqual({
      operationId: 'op-1',
      taskId: 'task1',
      startedAtSec: 1_700_000_000,
    });
  });

  it('accepts the pre-P-001 timestamp-only marker with null ids, rather than failing', () => {
    // An in-flight cut launched by the older wrapper must stay readable across the upgrade.
    expect(parseCutStartedMarker('STARTED:1700000000\n')).toEqual({
      operationId: null,
      taskId: null,
      startedAtSec: 1_700_000_000,
    });
  });

  it('reports nulls for an unparseable marker instead of throwing', () => {
    expect(parseCutStartedMarker('garbage')).toEqual({
      operationId: null,
      taskId: null,
      startedAtSec: null,
    });
  });
});

describe('readCutStatus — operation marker', () => {
  it('surfaces the identity of the cut that owns the sentinels', () => {
    const s = readCutStatus({
      existsSync: (p: string) => p === CUT_STARTED,
      readFileSync: () => 'STARTED:1700000000\nOPERATION:op-1\nTASK:task1\n',
      isUnitActive: () => false,
    });
    expect(s.state).toBe('interrupted');
    expect(s.operation).toEqual({ operationId: 'op-1', taskId: 'task1', startedAtSec: 1_700_000_000 });
  });

  it('reports a null operation when no cut has started on this host', () => {
    expect(readCutStatus({ existsSync: () => false, isUnitActive: () => false }).operation).toBeNull();
  });

  it('keeps the interrupted verdict when the marker exists but cannot be read', () => {
    // The marker's EXISTENCE is the evidence a cut started; only its identity degrades.
    const s = readCutStatus({
      existsSync: (p: string) => p === CUT_STARTED,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      isUnitActive: () => false,
    });
    expect(s.state).toBe('interrupted');
    expect(s.operation).toEqual({ operationId: null, taskId: null, startedAtSec: null });
  });
});
