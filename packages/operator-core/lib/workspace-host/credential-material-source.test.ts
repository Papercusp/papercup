import {
  buildWorkspaceHostCredentialReference,
  workspaceHostCredentialReferenceDigest,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import {
  UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
  WORKSPACE_HOST_MATERIAL_KEY_PREFIX,
  createOperatorWorkspaceHostCredentialMaterialSource,
  workspaceHostCredentialMaterialKey,
  type WorkspaceHostCredentialMaterialRequest,
} from './credential-material-source';

const GIT_REF = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
  forge: 'github',
  owner: 'papercupai',
  repository: 'private-canary',
});
const CLOUD_REF = buildWorkspaceHostCredentialReference('cloud-workload-identity', {
  provider: 'gcp',
  scopeId: 'active-alcove-504205-q3',
  workloadId: 'p046-canary-03',
});

const SECRET = 'https://x-access-token:private-token-value@github.com';

function gitRequest(generation = 7): WorkspaceHostCredentialMaterialRequest {
  return {
    channel: 'git',
    credentialRef: GIT_REF,
    family: 'git-short-lived-delegation',
    generation,
  };
}

describe('the store key is derived from the reference', () => {
  it('is readable AND injective — the readable half alone would collide', () => {
    const key = workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7);

    expect(key.startsWith(`${WORKSPACE_HOST_MATERIAL_KEY_PREFIX}__`)).toBe(true);
    // Readable half: a person has to be able to find and write this key.
    expect(key).toContain('GIT_SHORT_LIVED_DELEGATION__GITHUB__PAPERCUPAI__PRIVATE_CANARY');
    expect(key).toContain('__G7__');
    // Injective half. `screamingSnake` folds '-', '.' and '/' all onto '_', so without the digest
    // `private-canary` and `private.canary` would name ONE key — and delivering one repository's
    // credential for another authenticates successfully, which makes the fault invisible.
    expect(key.endsWith(workspaceHostCredentialReferenceDigest(GIT_REF).slice(0, 16).toUpperCase())).toBe(
      true,
    );
    const sibling = buildWorkspaceHostCredentialReference('git-short-lived-delegation', {
      forge: 'github',
      owner: 'papercupai',
      repository: 'private.canary',
    });
    expect(workspaceHostCredentialMaterialKey(sibling, 'git', 7)).not.toBe(key);
  });

  it('separates generations, because a rotation must not destroy what it replaces', () => {
    // Rotation requires a strictly increasing generation carrying DIFFERENT material. A
    // generation-less key would make both values one row.
    expect(workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7)).not.toBe(
      workspaceHostCredentialMaterialKey(GIT_REF, 'git', 8),
    );
  });

  it('is stable across calls, so a key written once keeps resolving', () => {
    expect(workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7)).toBe(
      workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7),
    );
  });

  it('refuses a generation that is not a positive integer', () => {
    expect(() => workspaceHostCredentialMaterialKey(GIT_REF, 'git', 0)).toThrow(
      /positive safe integer/,
    );
  });

  it('refuses a reference that does not belong to the named channel', () => {
    // The parser is the authority; deriving a key from a mismatched pair would silently address a
    // different subject's secret.
    expect(() => workspaceHostCredentialMaterialKey(GIT_REF, 'agent', 7)).toThrow();
  });
});

describe('the operator-store source', () => {
  it('reads the derived key and returns its bytes as material', async () => {
    const seen: string[] = [];
    const source = createOperatorWorkspaceHostCredentialMaterialSource(async (name) => {
      seen.push(name);
      return SECRET;
    });

    const material = await source.resolve(gitRequest());

    expect(seen).toEqual([workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7)]);
    expect(material.reveal().toString('utf8')).toBe(SECRET);
  });

  it('returns the material inside the redacting wrapper, not a bare string', async () => {
    const source = createOperatorWorkspaceHostCredentialMaterialSource(async () => SECRET);
    const material = await source.resolve(gitRequest());

    // The wrapper redacts on inspection, so a stray log line or an error that interpolates it
    // cannot print the credential. Returning a bare string here would lose that property at the
    // one boundary where material legitimately exists.
    expect(String(material)).not.toContain('private-token-value');
    expect(JSON.stringify({ material })).not.toContain('private-token-value');
  });

  it('REFUSES a missing key by name, with no fallback of any kind', async () => {
    const source = createOperatorWorkspaceHostCredentialMaterialSource(async () => undefined);

    await expect(source.resolve(gitRequest())).rejects.toMatchObject({
      name: 'WorkspaceHostCredentialMaterialUnavailableError',
      channel: 'git',
      family: 'git-short-lived-delegation',
      generation: 7,
    });
    // It must name the exact key the operator has to write; "not configured" alone is the message
    // that sends someone hunting.
    await expect(source.resolve(gitRequest())).rejects.toThrow(
      new RegExp(workspaceHostCredentialMaterialKey(GIT_REF, 'git', 7)),
    );
  });

  it('REFUSES an empty stored value rather than delivering zero bytes', async () => {
    const source = createOperatorWorkspaceHostCredentialMaterialSource(async () => '');

    // This is the single most dangerous fallback available: `bind()` only checks that the material
    // path EXISTS, so zero bytes would make every binding step pass against a credential that
    // authenticates nothing — and the canary would go green on it.
    await expect(source.resolve(gitRequest())).rejects.toThrow(/no material is stored under/);
  });

  it('refuses an ambient family instead of looking up a key for it', async () => {
    let looked = false;
    const source = createOperatorWorkspaceHostCredentialMaterialSource(async () => {
      looked = true;
      return SECRET;
    });

    await expect(
      source.resolve({
        channel: 'cloud',
        credentialRef: CLOUD_REF,
        family: 'cloud-workload-identity',
        generation: 1,
      }),
    ).rejects.toThrow(/answered ambiently/);
    // A stored key for an ambient family would be a standing invitation to write a file that must
    // not exist (D-215 point 4), so the lookup must not happen at all.
    expect(looked).toBe(false);
  });
});

describe('the unconfigured source', () => {
  it('refuses every request and says the controller has no source', async () => {
    await expect(
      UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE.resolve(gitRequest()),
    ).rejects.toThrow(/no credential material source is configured/);
  });
});
