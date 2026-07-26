import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  buildRunOpts,
  classifyArtifact,
  collectedLinuxBundleRoot,
  computeMobileRegression,
  computeReleaseCompleteness,
  formatCompletenessAlert,
  formatMobileRegressionAlert,
  releaseBundleRoots,
  releaseTag,
  scanArtifacts,
  scanMobileArtifactSources,
  scanMobileArtifacts,
} from './record-release-cli';

describe('computeReleaseCompleteness — every desktop product×platform, not just GUI (WI-5515)', () => {
  const gui = (platform: string) => ({ product: 'gui' as const, platform });
  const server = (platform: string) => ({ product: 'server' as const, platform });

  it('flags a linux-only cut as missing mac + windows for BOTH gui and server', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      server('linux-x86_64'),
    ]);
    expect(complete).toBe(false);
    expect(missing).toEqual([
      { product: 'gui', platform: 'darwin-universal' },
      { product: 'gui', platform: 'windows-x86_64' },
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
  });

  it('catches the exact gap the owner hit: full GUI + linux Server, but NO mac/windows Server', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
    ]);
    expect(complete).toBe(false);
    // GUI is complete; the miss is Server on mac + windows — invisible to the old
    // gui-only check.
    expect(missing).toEqual([
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
  });

  it('is complete only when both products cover all three desktop platforms', () => {
    const { missing, complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
      server('darwin-universal'),
      server('windows-x86_64'),
    ]);
    expect(complete).toBe(true);
    expect(missing).toEqual([]);
  });

  it('does NOT count mobile toward completeness (a desktop cut with no phone build is complete)', () => {
    const { complete } = computeReleaseCompleteness([
      gui('linux-x86_64'),
      gui('darwin-universal'),
      gui('windows-x86_64'),
      server('linux-x86_64'),
      server('darwin-universal'),
      server('windows-x86_64'),
      { product: 'mobile', platform: 'android-universal' },
    ]);
    expect(complete).toBe(true);
  });

  it('extra AppImage/deb on the same platform does not double-satisfy or break the check', () => {
    // linux GUI ships BOTH deb and AppImage — same product×platform, still one slot.
    const { missing } = computeReleaseCompleteness([gui('linux-x86_64'), gui('linux-x86_64')]);
    expect(missing).toContainEqual({ product: 'server', platform: 'linux-x86_64' });
  });
});

describe('formatCompletenessAlert — non-blocking, names every missing slot (WI-5515)', () => {
  it('is empty when nothing is missing (a complete release prints no alert)', () => {
    expect(formatCompletenessAlert('0.0.12', 'alpha', [])).toBe('');
  });

  it('names the version + each missing product/platform and says it is NOT a rejection', () => {
    const alert = formatCompletenessAlert('0.0.12', 'alpha', [
      { product: 'server', platform: 'darwin-universal' },
      { product: 'server', platform: 'windows-x86_64' },
    ]);
    expect(alert).toContain('INCOMPLETE RELEASE: 0.0.12 (alpha)');
    expect(alert).toContain('SERVER');
    expect(alert).toContain('macOS (universal)');
    expect(alert).toContain('Windows (x64)');
    expect(alert).toContain('NOT a rejection');
  });
});

describe('computeMobileRegression — a cut that LOSES a phone build its predecessor had (WI-5583)', () => {
  const gui = (platform: string) => ({ product: 'gui' as const, platform });
  const android = { product: 'mobile' as const, platform: 'android-universal' };
  const ios = { product: 'mobile' as const, platform: 'ios-arm64' };

  it('catches the exact 0.0.12 gap: prior shipped android+ios, this cut ships neither', () => {
    const { dropped } = computeMobileRegression(
      [gui('linux-x86_64'), gui('darwin-universal'), gui('windows-x86_64')], // 0.0.12: desktop only
      [gui('linux-x86_64'), android, ios], // 0.0.11: had both phones
    );
    expect(dropped).toEqual(['android-universal', 'ios-arm64']);
  });

  it('reports only the platform actually dropped, not the one still present', () => {
    const { dropped } = computeMobileRegression([android], [android, ios]);
    expect(dropped).toEqual(['ios-arm64']);
  });

  it('is silent once the drop settles — a mobile-less cut after a mobile-less predecessor does not re-fire', () => {
    // 0.0.13 (no mobile) vs 0.0.12 (no mobile) → nothing regressed.
    const { dropped } = computeMobileRegression([gui('linux-x86_64')], [gui('linux-x86_64')]);
    expect(dropped).toEqual([]);
  });

  it('a mobile ADDITION is not a regression (gaining a phone build never warns)', () => {
    const { dropped } = computeMobileRegression([android, ios], [android]);
    expect(dropped).toEqual([]);
  });

  it('no predecessor (first release ever) is not a regression', () => {
    const { dropped } = computeMobileRegression([gui('linux-x86_64')], []);
    expect(dropped).toEqual([]);
  });

  it('ignores desktop churn entirely — dropping a desktop platform is the completeness check’s job, not this one', () => {
    const { dropped } = computeMobileRegression([gui('linux-x86_64'), android, ios], [
      gui('linux-x86_64'),
      gui('windows-x86_64'),
      android,
      ios,
    ]);
    expect(dropped).toEqual([]); // windows dropped, but mobile intact → no mobile regression
  });
});

describe('formatMobileRegressionAlert — non-blocking, names the dropped phone build (WI-5583)', () => {
  it('is empty when nothing regressed (a cut that kept its mobile builds prints no alert)', () => {
    expect(formatMobileRegressionAlert('0.0.13', 'alpha', '0.0.12', [])).toBe('');
  });

  it('names the version, the predecessor, each dropped platform, and says it is NOT a rejection', () => {
    const alert = formatMobileRegressionAlert('0.0.12', 'alpha', '0.0.11', [
      'android-universal',
      'ios-arm64',
    ]);
    expect(alert).toContain('MOBILE REGRESSION: 0.0.12 (alpha)');
    expect(alert).toContain('0.0.11');
    expect(alert).toContain('Android');
    expect(alert).toContain('iOS (arm64)');
    expect(alert).toContain('NOT a rejection');
  });

  it('still renders without a known predecessor version', () => {
    const alert = formatMobileRegressionAlert('0.0.12', 'alpha', null, ['android-universal']);
    expect(alert).toContain('MOBILE REGRESSION: 0.0.12 (alpha)');
    expect(alert).toContain('the previous release');
    expect(alert).toContain('Android');
  });
});

describe('classifyArtifact — real filenames from real cuts, not invented ones', () => {
  it('maps the linux artifacts', () => {
    expect(classifyArtifact('Papercusp GUI_0.0.8_amd64.deb')).toEqual({
      product: 'gui',
      platform: 'linux-x86_64',
    });
    expect(classifyArtifact('Papercusp_GUI_0.0.8_amd64.AppImage')).toEqual({
      product: 'gui',
      platform: 'linux-x86_64',
    });
  });

  it('tells the Server product apart from the GUI', () => {
    expect(classifyArtifact('Papercusp Server_0.0.8_amd64.deb')).toEqual({
      product: 'server',
      platform: 'linux-x86_64',
    });
  });

  it('maps mac and windows', () => {
    expect(classifyArtifact('Papercusp GUI_0.0.9_universal.dmg')?.platform).toBe('darwin-universal');
    expect(classifyArtifact('Papercusp GUI.app.tar.gz')?.platform).toBe('darwin-universal');
    expect(classifyArtifact('Papercusp GUI_0.0.9_x64-setup.exe')?.platform).toBe('windows-x86_64');
    expect(classifyArtifact('Papercusp GUI_0.0.9_x64_en-US.msi')?.platform).toBe('windows-x86_64');
  });

  it('WI-5600: recognizes the normalized spanned Windows Server zip as the windows installer', () => {
    // The Windows Server DiskSpans (it bundles the dogfood source tree >4GB), so
    // release-local.sh normalizes the setup.exe stub + *-setup-N.bin disks into a
    // single "…-setup.zip" — THAT is the Windows Server download the page offers.
    expect(classifyArtifact('Papercusp Server_0.0.12_x64-setup.zip')).toEqual({
      product: 'server',
      platform: 'windows-x86_64',
    });
    // a gui-role zip (were the GUI ever to span) classifies as gui/windows.
    expect(classifyArtifact('Papercusp GUI_0.0.12_x64-setup.zip')).toEqual({
      product: 'gui',
      platform: 'windows-x86_64',
    });
    // Scoped to the "-setup.zip" suffix: an unrelated .zip is NOT a desktop installer.
    expect(classifyArtifact('source-bundle.zip')).toBeNull();
    expect(classifyArtifact('Papercusp_0.0.12_debug-symbols.zip')).toBeNull();
  });

  it('ignores signatures and checksums — they are not downloads', () => {
    expect(classifyArtifact('Papercusp_GUI_0.0.8_amd64.AppImage.sig')).toBeNull();
    expect(classifyArtifact('Papercusp GUI_0.0.8_amd64.deb.sha256')).toBeNull();
    expect(classifyArtifact('latest.json')).toBeNull();
  });

  it('maps the mobile apps to their own product (not gui/server)', () => {
    expect(classifyArtifact('Papercusp_0.0.9_android.apk')).toEqual({
      product: 'mobile',
      platform: 'android-universal',
    });
    expect(classifyArtifact('app-debug.apk')).toEqual({
      product: 'mobile',
      platform: 'android-universal',
    });
    expect(classifyArtifact('Papercusp_0.0.9_android.aab')?.platform).toBe('android-universal');
    expect(classifyArtifact('Papercusp_0.0.9_ios.ipa')).toEqual({
      product: 'mobile',
      platform: 'ios-arm64',
    });
    // "Server" in a mobile filename must NOT flip it to the server product — the
    // extension decides mobile, and mobile is its own product.
    expect(classifyArtifact('Papercusp Server_0.0.9_android.apk')?.product).toBe('mobile');
  });
});

describe('releaseTag', () => {
  it('carries the channel for a pre-release, and omits it for stable', () => {
    expect(releaseTag('0.0.9', 'alpha')).toBe('desktop-v0.0.9-alpha');
    expect(releaseTag('1.0.0', 'stable')).toBe('desktop-v1.0.0');
  });
});

describe('scanArtifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-scan-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmp, 'deb'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'appimage'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'), 'deb-bytes');
  fs.writeFileSync(path.join(tmp, 'deb', 'Papercusp GUI_0.0.8_amd64.deb'), 'old-version');
  fs.writeFileSync(path.join(tmp, 'appimage', 'Papercusp_GUI_0.0.9_amd64.AppImage'), 'appimage-bytes');
  fs.writeFileSync(path.join(tmp, 'appimage', 'Papercusp_GUI_0.0.9_amd64.AppImage.sig'), 'sig');

  const found = scanArtifacts([tmp], '0.0.9', 'desktop-v0.0.9-alpha');

  it('finds only THIS version, and no signatures', () => {
    expect(found.map((a) => a.name).sort()).toEqual([
      'Papercusp GUI_0.0.9_amd64.deb',
      'Papercusp_GUI_0.0.9_amd64.AppImage',
    ]);
  });

  it('stores the url RELATIVE — the base path is the shared secret and must not reach Postgres', () => {
    for (const a of found) {
      expect(a.url).toBe(`desktop-v0.0.9-alpha/${a.name}`);
      expect(a.url).not.toMatch(/^https?:\/\//);
    }
  });

  it('records real size and a real sha256 of the actual bytes', () => {
    const deb = found.find((a) => a.name.endsWith('.deb'))!;
    expect(deb.size).toBe('deb-bytes'.length);
    // sha256("deb-bytes")
    expect(deb.sha256).toMatch(/^[0-9a-f]{64}$/);
    const appimage = found.find((a) => a.name.endsWith('.AppImage'))!;
    expect(appimage.sha256).not.toBe(deb.sha256);
  });

  it('returns nothing rather than throwing when the bundle dir is absent', () => {
    expect(scanArtifacts([path.join(tmp, 'nope')], '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
  });

  /**
   * THE 0.0.8 BUG, pinned. The mac and windows installers were built, signed, and
   * sitting on disk — in DIFFERENT bundle roots than linux — and the recorder, which
   * scanned one linux root and a subdir list with no `inno` in it, never looked at
   * them. 0.0.8 shipped a release page that offered a Mac or Windows tester nothing
   * to download, and told nobody. If this ever goes green with fewer than 3
   * platforms, that release is lying to two thirds of the beta testers again.
   */
  it('finds ALL THREE platforms across their separate bundle roots (0.0.8 shipped linux-only)', () => {
    const lin = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-lin-'));
    const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-mac-'));
    const win = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-win-'));
    fs.mkdirSync(path.join(lin, 'deb'), { recursive: true });
    fs.mkdirSync(path.join(mac, 'dmg'), { recursive: true });
    // Windows lands in inno/ — the subdir the old list omitted entirely.
    fs.mkdirSync(path.join(win, 'inno'), { recursive: true });
    fs.writeFileSync(path.join(lin, 'deb', 'Papercusp GUI_0.0.9_amd64.deb'), 'l');
    fs.writeFileSync(path.join(mac, 'dmg', 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg'), 'm');
    fs.writeFileSync(path.join(win, 'inno', 'Papercusp GUI_0.0.9_x64-setup.exe'), 'w');
    fs.writeFileSync(path.join(win, 'inno', 'Papercusp GUI_0.0.9_x64-setup.exe.sig'), 'sig');

    const all = scanArtifacts([lin, mac, win], '0.0.9', 'desktop-v0.0.9-alpha');
    expect(all.map((a) => a.platform).sort()).toEqual([
      'darwin-universal',
      'linux-x86_64',
      'windows-x86_64',
    ]);
    // every platform a beta tester can actually be on has a GUI installer
    expect(all.filter((a) => a.product === 'gui')).toHaveLength(3);

    for (const d of [lin, mac, win]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('WI-5600: records the normalized Server zip and SKIPS the bare spanned stub + .bin disks', () => {
    // As they land on disk after release-local.sh's span-normalization: the raw
    // spanned Server (stub + disks) PLUS the single "…-setup.zip" it produces, and
    // a single-file GUI alongside. The recorder must publish the zip (a working
    // download) — never the bare stub (isSpannedInstaller: an uninstallable
    // download) nor the raw .bin disks (not installers on their own).
    const win = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-span-'));
    fs.mkdirSync(path.join(win, 'inno'), { recursive: true });
    const inno = path.join(win, 'inno');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup.exe'), 'stub');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup-1.bin'), 'd1');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup-2.bin'), 'd2');
    fs.writeFileSync(path.join(inno, 'Papercusp Server_0.0.12_x64-setup.zip'), 'zip');
    fs.writeFileSync(path.join(inno, 'Papercusp GUI_0.0.12_x64-setup.exe'), 'gui');

    // scanArtifacts warns (by design) as it skips the bare spanned stub; swallow
    // + assert that warning so vitest-fail-on-console stays green and the skip is pinned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const found = scanArtifacts([win], '0.0.12', 'desktop-v0.0.12-alpha');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SKIPPING Papercusp Server_0.0.12_x64-setup.exe'));
    warn.mockRestore();
    const names = found.map((a) => a.name).sort();
    expect(names).toContain('Papercusp Server_0.0.12_x64-setup.zip');
    expect(names).not.toContain('Papercusp Server_0.0.12_x64-setup.exe'); // bare stub skipped
    expect(names).not.toContain('Papercusp Server_0.0.12_x64-setup-1.bin'); // raw disk not an installer
    expect(names).toContain('Papercusp GUI_0.0.12_x64-setup.exe'); // single-file GUI recorded normally
    expect(found).toHaveLength(2); // exactly the two real downloads, no phantom rows
    const srv = found.find((a) => a.name.endsWith('.zip'))!;
    expect(srv.product).toBe('server');
    expect(srv.platform).toBe('windows-x86_64');

    fs.rmSync(win, { recursive: true, force: true });
  });

  it('records an artifact reachable from two roots exactly ONCE', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-dup-'));
    fs.mkdirSync(path.join(a, 'dmg'), { recursive: true });
    fs.writeFileSync(path.join(a, 'dmg', 'Papercusp GUI_0.0.9_universal-apple-darwin.dmg'), 'm');
    // same root passed twice (the salvage/reuse path can alias two trees)
    expect(scanArtifacts([a, a], '0.0.9', 'desktop-v0.0.9-alpha')).toHaveLength(1);
    fs.rmSync(a, { recursive: true, force: true });
  });

  it('hashes a file LARGER than one read chunk — the whole file, not just the first 1 MiB', () => {
    // Real artifacts are 3-4 GB. The first version of this used readFileSync and
    // died with ERR_FS_FILE_TOO_LARGE (Node's 2 GiB ceiling) on the first genuine
    // release; the chunked replacement's classic failure is hashing only chunk one.
    // 3 MiB of NON-uniform bytes: with uniform filler, a first-chunk-only bug
    // would still produce a plausible-looking (but wrong) digest.
    const big = path.join(tmp, 'deb', 'Papercusp GUI_9.9.9_amd64.deb');
    const chunk = 1 << 20;
    const bytes = Buffer.alloc(3 * chunk);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    fs.writeFileSync(big, bytes);

    const [artifact] = scanArtifacts([tmp], '9.9.9', 'desktop-v9.9.9-alpha');
    expect(artifact.size).toBe(3 * chunk);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // ...and specifically NOT the digest of just the first chunk.
    expect(artifact.sha256).not.toBe(
      createHash('sha256').update(bytes.subarray(0, chunk)).digest('hex'),
    );
  });
});

describe('scanMobileArtifacts — the phone builds live in a SEPARATE repo, unversioned names', () => {
  it('returns nothing when the mobile root is null or absent (a desktop-only cut is legal)', () => {
    expect(scanMobileArtifacts(null, '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
    expect(scanMobileArtifacts('/no/such/mobile/root', '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
  });

  it('records a debug APK under a SYNTHESIZED versioned name + a RELATIVE url', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const apkDir = path.join(root, 'android/app/build/outputs/apk/debug');
    fs.mkdirSync(apkDir, { recursive: true });
    // The built APK carries NO version — that is the whole reason this function
    // synthesizes the recorded name instead of filtering by a version substring.
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), 'apk-bytes');

    const found = scanMobileArtifacts(root, '0.0.9', 'desktop-v0.0.9-alpha');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      product: 'mobile',
      platform: 'android-universal',
      name: 'Papercusp_0.0.9_android.apk',
      url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_android.apk',
      size: 'apk-bytes'.length,
    });
    expect(found[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(found[0].url).not.toMatch(/^https?:\/\//); // base path is the secret
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prefers the release APK over the debug APK — one row, release bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    fs.mkdirSync(path.join(root, 'android/app/build/outputs/apk/release'), { recursive: true });
    fs.mkdirSync(path.join(root, 'android/app/build/outputs/apk/debug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android/app/build/outputs/apk/release/app-release.apk'), 'RELEASE');
    fs.writeFileSync(path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), 'debug-bytes');

    const apks = scanMobileArtifacts(root, '0.0.9', 'desktop-v0.0.9-alpha').filter((a) =>
      a.name.endsWith('.apk'),
    );
    expect(apks).toHaveLength(1);
    expect(apks[0].size).toBe('RELEASE'.length); // release bytes, not debug
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds an iOS .ipa nested under ios/build once a signed build exists (dormant until enrollment)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const ipaDir = path.join(root, 'ios/build/export');
    fs.mkdirSync(ipaDir, { recursive: true });
    fs.writeFileSync(path.join(ipaDir, 'Papercup.ipa'), 'ipa-bytes');

    const ios = scanMobileArtifacts(root, '0.0.9', 'desktop-v0.0.9-alpha').find(
      (a) => a.platform === 'ios-arm64',
    );
    expect(ios).toMatchObject({
      product: 'mobile',
      name: 'Papercusp_0.0.9_ios.ipa',
      url: 'desktop-v0.0.9-alpha/Papercusp_0.0.9_ios.ipa',
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('scanMobileArtifactSources — the src↔published-name pairs the UPLOADER consumes', () => {
  it('returns nothing for a null/absent root, like the artifact scan', () => {
    expect(scanMobileArtifactSources(null, '0.0.9')).toEqual([]);
    expect(scanMobileArtifactSources('/no/such/mobile/root', '0.0.9')).toEqual([]);
  });

  it('maps the real on-disk file to the synthesized name (bytes at src, name for the object key)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    const apkDir = path.join(root, 'android/app/build/outputs/apk/debug');
    const ipaDir = path.join(root, 'ios/build/export');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.mkdirSync(ipaDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), 'apk-bytes');
    fs.writeFileSync(path.join(ipaDir, 'Papercup.ipa'), 'ipa-bytes');

    const pairs = scanMobileArtifactSources(root, '0.0.9');
    expect(pairs).toEqual([
      { src: path.join(apkDir, 'app-debug.apk'), outName: 'Papercusp_0.0.9_android.apk' },
      { src: path.join(ipaDir, 'Papercup.ipa'), outName: 'Papercusp_0.0.9_ios.ipa' },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('release APK claims the name — debug src never appears once release exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-'));
    fs.mkdirSync(path.join(root, 'android/app/build/outputs/apk/release'), { recursive: true });
    fs.mkdirSync(path.join(root, 'android/app/build/outputs/apk/debug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'android/app/build/outputs/apk/release/app-release.apk'), 'RELEASE');
    fs.writeFileSync(path.join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'), 'debug-bytes');

    const apkPairs = scanMobileArtifactSources(root, '0.0.9').filter((p) => p.outName.endsWith('.apk'));
    expect(apkPairs).toHaveLength(1);
    expect(apkPairs[0].src).toContain('app-release.apk');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('buildRunOpts — the mobileRoot-drop regression guard', () => {
  // main() once computed `mobileRoot` and then FORGOT to put it in the run({...})
  // object, so scanMobileArtifacts got `undefined` and silently recorded NO mobile
  // artifact on every real cut. Every unit test passed; only an end-to-end dry-run
  // caught it. buildRunOpts builds ONE object; asserting its fields here makes that
  // whole class of "computed-but-not-wired" drop impossible without a red test.
  it('wires --mobile-root through onto the opts object', () => {
    const opts = buildRunOpts(['--version', '0.0.9', '--mobile-root', '/tmp/some-mobile-root']);
    expect(opts.mobileRoot).toBe('/tmp/some-mobile-root');
    expect(opts.version).toBe('0.0.9');
    expect(Array.isArray(opts.bundleDirs)).toBe(true);
  });

  it('falls back to PAPERCUSP_MOBILE_ROOT when --mobile-root is absent', () => {
    const prev = process.env.PAPERCUSP_MOBILE_ROOT;
    process.env.PAPERCUSP_MOBILE_ROOT = '/tmp/env-mobile-root';
    try {
      expect(buildRunOpts(['--version', '0.0.9']).mobileRoot).toBe('/tmp/env-mobile-root');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MOBILE_ROOT;
      else process.env.PAPERCUSP_MOBILE_ROOT = prev;
    }
  });

  it('carries the channel + dry-run flags through the same object', () => {
    const opts = buildRunOpts([
      '--version',
      '1.2.3',
      '--channel',
      'beta',
      '--dry-run',
      '--mobile-root',
      '/x',
    ]);
    expect(opts.channel).toBe('beta');
    expect(opts.dryRun).toBe(true);
    expect(opts.mobileRoot).toBe('/x');
  });
});
