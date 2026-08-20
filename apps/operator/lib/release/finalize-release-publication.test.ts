import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveReleaseBaseUrl,
  verifyReleasePublication,
  type HeadProbe,
  type HeadProbeResult,
} from './finalize-release-publication';
import type { ReleaseRow } from './release-registry';

const BASE = 'https://downloads.example.test/permanent-secret';
const ARTIFACT_URL = 'desktop-v0.0.16-alpha/Papercusp_GUI_0.0.16.AppImage';

function releaseRow(): ReleaseRow {
  return {
    version: '0.0.16',
    channel: 'alpha',
    cutAt: new Date('2026-08-13T07:45:45Z'),
    publishedAt: null,
    changelogMd: null,
    workItemIds: [],
    planSlugs: [],
    artifacts: [
      {
        product: 'gui',
        platform: 'linux-x86_64',
        name: 'Papercusp_GUI_0.0.16.AppImage',
        url: ARTIFACT_URL,
        size: 1234,
        sha256: 'a'.repeat(64),
      },
    ],
    gitSha: null,
    cutBy: null,
    notes: null,
  };
}

function fakeHead(
  results: Record<string, HeadProbeResult>,
): { head: HeadProbe; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    head: async (url) => {
      calls.push(url);
      return results[url] ?? { status: 404, contentLength: null };
    },
  };
}

describe('verifyReleasePublication', () => {
  it('accepts a live manifest and every artifact at its recorded size', async () => {
    const manifestUrl = `${BASE}/latest.json`;
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [manifestUrl]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 200, contentLength: 1234 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).resolves.toEqual({
      manifestStatus: 200,
      artifactCount: 1,
    });
    expect(fake.calls).toEqual([manifestUrl, artifactUrl]);
  });

  it('refuses a missing public manifest before marking anything live', async () => {
    const fake = fakeHead({ [`${BASE}/latest.json`]: { status: 404, contentLength: null } });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'latest.json',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('refuses a missing or failed artifact even when the manifest is live', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 404, contentLength: null },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'artifact Papercusp_GUI_0.0.16.AppImage',
    );
  });

  it('refuses an artifact whose public Content-Length differs from the registry', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 200, contentLength: 1235 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'does not match recorded size 1234',
    );
  });

  it('requires a successful HTTP response for an artifact, not just a size header', async () => {
    const artifactUrl = `${BASE}/${ARTIFACT_URL}`;
    const fake = fakeHead({
      [`${BASE}/latest.json`]: { status: 200, contentLength: 456 },
      [artifactUrl]: { status: 503, contentLength: 1234 },
    });

    await expect(verifyReleasePublication(releaseRow(), BASE, fake.head)).rejects.toThrow(
      'HTTP 503',
    );
  });
});

describe('release publication configuration and wiring', () => {
  it('prefers the manifest base and removes only trailing slashes', () => {
    expect(
      resolveReleaseBaseUrl({
        PAPERCUSP_UPDATE_BASE_URL: `${BASE}///`,
        PAPERCUSP_RELEASE_HOST: 'https://other.example.test',
      }),
    ).toBe(BASE);
  });

  it('runs the registry finalizer after the uploader public URL probe', () => {
    const upload = fs.readFileSync(
      path.resolve(__dirname, '../../../../papercusp-desktop/bin/upload-release.sh'),
      'utf8',
    );
    const publicProbe = upload.indexOf('python3 - "$TMP_MANIFEST" <<\'PY\'');
    const finalizer = upload.indexOf('finalize-release-publication.ts');
    expect(publicProbe).toBeGreaterThanOrEqual(0);
    expect(finalizer).toBeGreaterThan(publicProbe);
    expect(upload).toContain('PAPERCUSP_UPDATE_BASE_URL="$BASE"');
    expect(upload).toContain('--workspace "${PAPERCUSP_WORKSPACE_ID:-papercusp-workspace}"');
  });
});
