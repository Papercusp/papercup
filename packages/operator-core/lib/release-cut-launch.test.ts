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
  buildCutEnv,
  buildCutArgv,
  readCutStatus,
  collectHandoff,
  preflightCut,
  isReleaseArtifact,
  CUT_UNIT,
  CUT_DONE,
  CUT_LOG,
  PLATFORMS,
  cutUnitFor,
  cutLogFor,
  cutDoneFor,
  legsForPlatform,
  abortLeg,
  deriveBuildSha,
  gatePath,
  readOrCreateGate,
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
});

describe('buildCutEnv — LOCAL-only enforced', () => {
  it('always disables GitHub publish; adds only requested legs', () => {
    expect(buildCutEnv({})).toEqual({ PAPERCUSP_PUBLISH_GITHUB: '0' });
    expect(buildCutEnv({ mac: true, windows: true, arm64: true })).toEqual({
      PAPERCUSP_PUBLISH_GITHUB: '0',
      WITH_MAC: '1',
      WITH_WINDOWS: '1',
      WITH_ARM64: '1',
    });
    // A false/undefined leg is not injected.
    expect(buildCutEnv({ mac: false })).toEqual({ PAPERCUSP_PUBLISH_GITHUB: '0' });
  });
});

describe('buildCutArgv', () => {
  const argv = buildCutArgv('/root/papercusp-desktop', '0.0.8', 'alpha', { mac: true }, '/usr/bin:/bin');
  const inner = argv[argv.length - 1];

  it('targets the dedicated detached unit + desktop working dir', () => {
    expect(argv).toContain(`--unit=${CUT_UNIT}`);
    expect(argv).toContain('--working-directory=/root/papercusp-desktop');
    expect(argv).toContain('--setenv=PATH=/usr/bin:/bin');
  });
  it('runs the cutter LOCAL-only, clears the stale sentinel, records the exit code', () => {
    expect(inner).toContain(`rm -f ${CUT_DONE}`);
    expect(inner).toContain("PAPERCUSP_PUBLISH_GITHUB='0'");
    expect(inner).toContain("WITH_MAC='1'");
    expect(inner).toContain("bin/release-local.sh '0.0.8' 'alpha'");
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
    ]) {
      expect(isReleaseArtifact(n)).toBe(true);
    }
    expect(isReleaseArtifact('serve.mjs')).toBe(false);
    expect(isReleaseArtifact('build-provenance.json')).toBe(false);
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
    deb, // deb has NO .sig → unsigned
    `${bundle}/appimage/papercusp-gui_0.0.7_amd64.AppImage`, // OLD version → excluded
    `${targetRoot}/release/latest.json`,
    `${bundle}/appimage/build-provenance.json`,
    `${targetRoot}/release/deps/papercusp-gui_0.0.8_amd64.AppImage`, // not in a bundle/ dir → excluded
    `${targetRoot}/release/serve.mjs`, // not an artifact
  ];
  const deps = {
    exists: (p: string) => p === targetRoot,
    listFiles: () => tree,
    fileSize: () => 1024,
    sha256: (p: string) => `sha(${p})`,
  };

  it('collects only version-scoped, in-bundle artifacts + their sig/manifest/provenance', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    expect(h.found).toBe(true);
    const names = h.artifacts.map((a) => a.name).sort();
    expect(names).toEqual(['papercusp-gui_0.0.8_amd64.AppImage', 'papercusp-gui_0.0.8_amd64.deb']);
    // old version + non-bundle + serve.mjs are all excluded
    expect(names).not.toContain('papercusp-gui_0.0.7_amd64.AppImage');
    expect(h.manifests).toEqual([`${targetRoot}/release/latest.json`]);
    expect(h.provenance).toEqual([`${bundle}/appimage/build-provenance.json`]);
  });
  it('flags the unsigned artifact (a ship blocker) and marks the signed one', () => {
    const h = collectHandoff('0.0.8', { root }, deps);
    const appEntry = h.artifacts.find((a) => a.name.endsWith('.AppImage'))!;
    const debEntry = h.artifacts.find((a) => a.name.endsWith('.deb'))!;
    expect(appEntry.signed).toBe(true);
    expect(debEntry.signed).toBe(false);
    expect(h.unsignedNames).toEqual(['papercusp-gui_0.0.8_amd64.deb']);
    expect(appEntry.sha256).toBe(`sha(${appimage})`);
  });
  it('found:false when the target tree does not exist', () => {
    const h = collectHandoff('0.0.8', { root }, { ...deps, exists: () => false });
    expect(h.found).toBe(false);
    expect(h.artifacts).toEqual([]);
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
  const allPresent = new Set([key, cutter, ...scripts]);

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
});
