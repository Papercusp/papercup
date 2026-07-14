import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildRunOpts,
  classifyArtifact,
  releaseTag,
  scanArtifacts,
  scanMobileArtifactSources,
  scanMobileArtifacts,
} from './record-release-cli';

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
