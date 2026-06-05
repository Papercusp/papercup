import { describe, expect, it } from 'vitest';
import { loadSharedConfigFromProjectDir } from '../load-shared-config';
import {
  HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
  type HarnessSharedConfig,
} from '../harness-shared-config-types';

function validConfigJson(over: Partial<HarnessSharedConfig> = {}): string {
  const cfg: HarnessSharedConfig = {
    topic: 'a'.repeat(64),
    github_remote: 'https://github.com/owner/repo',
    github_repository_id: 12345,
    claim_status: 'unclaimed',
    privacy: 'shared-private',
    created_at: 1_700_000_000_000,
    schema_version: HARNESS_SHARED_CONFIG_SCHEMA_VERSION,
    ...over,
  };
  return JSON.stringify(cfg);
}

describe('loadSharedConfigFromProjectDir', () => {
  it('returns null for empty projectDir', () => {
    expect(
      loadSharedConfigFromProjectDir('', {
        pathExists: () => true,
        readFile: () => validConfigJson(),
      }),
    ).toBeNull();
  });

  it('returns null when file does not exist', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => false,
      readFile: () => {
        throw new Error('should not be called');
      },
    });
    expect(got).toBeNull();
  });

  it('returns null when readFile throws', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(got).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () => 'not json',
    });
    expect(got).toBeNull();
  });

  it('returns null when schema validation rejects', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () => JSON.stringify({ topic: 'short', github_remote: '', github_repository_id: -1 }),
    });
    expect(got).toBeNull();
  });

  it('returns parsed config when file is present + valid', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () => validConfigJson({ github_repository_id: 999 }),
    });
    expect(got).not.toBeNull();
    expect(got?.github_repository_id).toBe(999);
    expect(got?.privacy).toBe('shared-private');
    expect(got?.topic).toBe('a'.repeat(64));
  });

  it('uses the correct path inside projectDir', () => {
    let observed: string | null = null;
    loadSharedConfigFromProjectDir('/abs/harness-root', {
      pathExists: (p) => {
        observed = p;
        return false;
      },
    });
    expect(observed).toBe('/abs/harness-root/.papercusp/shared.json');
  });

  it('reads file when pathExists is true and parses successfully', () => {
    let readPath: string | null = null;
    const got = loadSharedConfigFromProjectDir('/abs/harness-root', {
      pathExists: () => true,
      readFile: (p) => {
        readPath = p;
        return validConfigJson();
      },
    });
    expect(readPath).toBe('/abs/harness-root/.papercusp/shared.json');
    expect(got).not.toBeNull();
  });

  it('handles shared-public privacy', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () => validConfigJson({ privacy: 'shared-public' }),
    });
    expect(got?.privacy).toBe('shared-public');
  });

  it('rejects mismatched schema_version', () => {
    const got = loadSharedConfigFromProjectDir('/tmp/x', {
      pathExists: () => true,
      readFile: () =>
        JSON.stringify({
          ...JSON.parse(validConfigJson()),
          schema_version: 999,
        }),
    });
    expect(got).toBeNull();
  });
});
