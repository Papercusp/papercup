import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isForcedHttp1,
  readHostedHttp1AcceptanceConfig,
  redactEvidenceUrl,
} from './_hosted-http1-config';

const dirs: string[] = [];

function storageState(mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'p029-http1-config-'));
  dirs.push(dir);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{"cookies":[],"origins":[]}\n', { mode });
  chmodSync(file, mode);
  return file;
}

afterEach(() => {
  // Temp files intentionally age out with the system tmp cleaner. Avoid a
  // recursive delete in a test that exists partly to guard credential files.
  dirs.length = 0;
});

describe('hosted HTTP/1.1 acceptance configuration', () => {
  it('requires a private storage-state file and exact HTTPS origin', () => {
    const state = storageState();
    const config = readHostedHttp1AcceptanceConfig({
      PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: state,
      PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN: 'https://app.papercusp.com',
    });
    expect(config.origin).toBe('https://app.papercusp.com');
    expect(config.storageStatePath).toBe(state);

    expect(() =>
      readHostedHttp1AcceptanceConfig({
        PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: state,
        PAPERCUSP_HOSTED_ACCEPTANCE_ORIGIN: 'https://user:pw@app.papercusp.com/path',
      }),
    ).toThrow(/exact HTTPS origin/);
    expect(() =>
      readHostedHttp1AcceptanceConfig({
        PAPERCUSP_HOSTED_ACCEPTANCE_STORAGE_STATE: storageState(0o644),
      }),
    ).toThrow(/chmod 600/);
  });

  it('rejects absent auth instead of silently running anonymous acceptance', () => {
    expect(() => readHostedHttp1AcceptanceConfig({})).toThrow(/STORAGE_STATE is required/);
  });

  it('redacts query and fragment data and accepts only measured HTTP\/1.1', () => {
    expect(redactEvidenceUrl('https://app.papercusp.com/a?ticket=secret#x')).toBe(
      'https://app.papercusp.com/a',
    );
    expect(isForcedHttp1('http/1.1')).toBe(true);
    expect(isForcedHttp1('h2')).toBe(false);
    expect(isForcedHttp1('h3')).toBe(false);
  });
});
