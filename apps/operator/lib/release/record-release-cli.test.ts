import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyArtifact, releaseTag, scanArtifacts } from './record-release-cli';

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

  const found = scanArtifacts(tmp, '0.0.9', 'desktop-v0.0.9-alpha');

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
    expect(scanArtifacts(path.join(tmp, 'nope'), '0.0.9', 'desktop-v0.0.9-alpha')).toEqual([]);
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

    const [artifact] = scanArtifacts(tmp, '9.9.9', 'desktop-v9.9.9-alpha');
    expect(artifact.size).toBe(3 * chunk);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // ...and specifically NOT the digest of just the first chunk.
    expect(artifact.sha256).not.toBe(
      createHash('sha256').update(bytes.subarray(0, chunk)).digest('hex'),
    );
  });
});
