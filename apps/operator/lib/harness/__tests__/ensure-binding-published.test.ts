/**
 * ensure-binding-published.test.ts — unit tests for `ensureMyBindingPublished`.
 *
 * Uses a fake Octokit + a generated Ed25519 keypair (no network, no OS keychain).
 *
 * Three cases:
 *   1. Branch missing + file missing → createRef then createOrUpdateFileContents
 *      called once each; PUT content decodes to a valid signed body.
 *   2. Branch exists + file already carries my pubkey + valid sig → NO PUT.
 *   3. File exists but different pubkey → PUT with sha: 'existing-sha'.
 *
 * R-1 note: `verification.verified === true` is a GitHub *runtime* property
 * of the Contents API web-flow commit. It CANNOT be asserted offline (the
 * Octokit is faked here). That property is verified by DESIGN (we use
 * `createOrUpdateFileContents`, never local git). Live verification is left
 * to manual / integration acceptance.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateKeyPairSync,
  sign as nodeSign,
  createPublicKey,
  verify as nodeVerify,
} from 'node:crypto';
import {
  ensureMyBindingPublished,
  type EnsureBindingOpts,
} from '../ensure-binding-published';
import {
  buildSignedContributorFile,
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
} from '../../identity/contributor-file-types';

// ─── Ed25519 test keypair helpers ─────────────────────────────────────────────

function generateTestKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // Raw 32-byte public key is the last 32 bytes of the SPKI DER.
  const rawPubkeyBase64 = spkiDer.subarray(-32).toString('base64');

  const sign = async (_keychainId: string, payload: Buffer): Promise<Buffer> => {
    return nodeSign(null, payload, privateKey) as Buffer;
  };

  const verifyOffline = (payload: Buffer, sig: Buffer): boolean => {
    return nodeVerify(null, payload, publicKey, sig);
  };

  return { privateKey, publicKey, rawPubkeyBase64, sign, verifyOffline };
}

// ─── Fake Octokit factory ─────────────────────────────────────────────────────

interface FakeOctokitOpts {
  /** Response for git.getRef calls.
   * Map of ref → response object or error to throw. */
  getRefResponses?: Record<string, { data: unknown } | { throw: { status: number } }>;
  /** Response for git.createRef calls. */
  createRefResponse?: { data: unknown } | { throw: { status: number } };
  /** Response for repos.getContent calls. */
  getContentResponse?: { data: unknown } | { throw: { status: number } };
  /** Response for repos.createOrUpdateFileContents calls. */
  createOrUpdateResponse?: { data: unknown };
}

function makeFakeOctokit(opts: FakeOctokitOpts = {}) {
  const createRef = vi.fn(async (_params: unknown) => {
    const r = opts.createRefResponse ?? { data: {} };
    if ('throw' in r) throw Object.assign(new Error('octokit error'), r.throw);
    return r;
  });

  const getRef = vi.fn(async (params: { ref?: string } = {}) => {
    const ref = params.ref ?? '';
    const responses = opts.getRefResponses ?? {};
    // Match by suffix: caller passes "heads/<branch>" or "heads/<defaultBranch>"
    const entry = Object.entries(responses).find(([k]) => ref.endsWith(k) || ref === k);
    if (entry) {
      const r = entry[1];
      if ('throw' in r) throw Object.assign(new Error('octokit error'), r.throw);
      return r;
    }
    // Default: 404
    throw Object.assign(new Error('Not Found'), { status: 404 });
  });

  const getContent = vi.fn(async (_params: unknown) => {
    const r = opts.getContentResponse ?? { throw: { status: 404 } };
    if ('throw' in r) throw Object.assign(new Error('Not Found'), r.throw);
    return r;
  });

  const createOrUpdateFileContents = vi.fn(async (_params: unknown) => {
    const r = opts.createOrUpdateResponse ?? {
      data: { commit: { sha: 'new-commit-sha' } },
    };
    return r;
  });

  return {
    rest: {
      git: { getRef, createRef },
      repos: { getContent, createOrUpdateFileContents },
    },
    // expose spies for assertions
    _spies: { getRef, createRef, getContent, createOrUpdateFileContents },
  };
}

// ─── shared opts builder ──────────────────────────────────────────────────────

function makeOpts(
  keypair: ReturnType<typeof generateTestKeypair>,
  octokitOverride: unknown,
): EnsureBindingOpts {
  return {
    repoOwner: 'test-org',
    repoName: 'test-repo',
    identity: {
      token: 'ghp_test',
      githubUserId: 42,
      githubLogin: 'alice',
    },
    keychainId: 'test-keychain-id',
    devicePubkeyBase64: keypair.rawPubkeyBase64,
    sign: keypair.sign,
    defaultBranch: 'main',
    attestationGistId: 'gist-abc123',
    octokit: octokitOverride,
  };
}

// ─── Test case 1 ──────────────────────────────────────────────────────────────

describe('ensureMyBindingPublished — branch missing + file missing', () => {
  it('calls createRef then createOrUpdateFileContents once each; PUT content is a valid signed body', async () => {
    const keypair = generateTestKeypair();

    const fakeOctokit = makeFakeOctokit({
      // Both getRef calls (branch check + default branch HEAD) follow the
      // same response set:
      //   heads/user/42      → 404 (branch doesn't exist)
      //   heads/main         → returns a sha
      getRefResponses: {
        'heads/user/42': { throw: { status: 404 } },
        'heads/main': { data: { object: { sha: 'default-head-sha' } } },
      },
      createRefResponse: { data: {} },
      // getContent → 404 (file doesn't exist)
      getContentResponse: { throw: { status: 404 } },
      createOrUpdateResponse: { data: { commit: { sha: 'new-commit-sha' } } },
    });

    const opts = makeOpts(keypair, fakeOctokit);
    const result = await ensureMyBindingPublished(opts);

    // createRef was called once to create the user branch
    expect(fakeOctokit._spies.createRef).toHaveBeenCalledTimes(1);
    const createRefCall = fakeOctokit._spies.createRef.mock.calls[0]![0] as {
      ref: string;
      sha: string;
    };
    expect(createRefCall.ref).toBe('refs/heads/user/42');
    expect(createRefCall.sha).toBe('default-head-sha');

    // createOrUpdateFileContents was called once to publish the file
    expect(fakeOctokit._spies.createOrUpdateFileContents).toHaveBeenCalledTimes(1);

    // Decode the PUT'd content and verify it
    const putCall = fakeOctokit._spies.createOrUpdateFileContents.mock.calls[0]![0] as {
      content: string;
      path: string;
      branch: string;
      sha?: string;
    };
    expect(putCall.path).toBe('.harness/contributors/alice.json');
    expect(putCall.branch).toBe('user/42');
    expect(putCall.sha).toBeUndefined();

    // Decode the base64 content and parse the body
    const decoded = Buffer.from(putCall.content, 'base64').toString('utf8');
    const body = JSON.parse(decoded) as Record<string, unknown>;

    expect(body.device_pubkey).toBe(`ed25519:${keypair.rawPubkeyBase64}`);
    expect(body.github_login).toBe('alice');
    expect(body.github_user_id).toBe(42);
    expect(body.version).toBe(1);
    expect(typeof body.signature_by_device).toBe('string');
    expect((body.signature_by_device as string).length).toBeGreaterThan(0);

    // Verify the signature offline using the test public key
    const signingFields = (CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER as readonly string[]).filter(
      (f) => f !== 'signature_by_device',
    );
    const ordered: Record<string, unknown> = {};
    for (const f of signingFields) {
      ordered[f] = body[f];
    }
    const payloadBytes = Buffer.from(JSON.stringify(ordered), 'utf8');
    const sigBytes = Buffer.from(body.signature_by_device as string, 'base64');
    const sigValid = keypair.verifyOffline(payloadBytes, sigBytes);
    expect(sigValid).toBe(true);

    // Result carries the pubkey and commit sha
    expect(result.devicePubkeyBase64).toBe(keypair.rawPubkeyBase64);
    expect(result.commitSha).toBe('new-commit-sha');
  });
});

// ─── Test case 2 ──────────────────────────────────────────────────────────────

describe('ensureMyBindingPublished — branch exists + file carries my pubkey + valid sig', () => {
  it('does NOT call createOrUpdateFileContents (no-op idempotent return)', async () => {
    const keypair = generateTestKeypair();

    // Build an existing-file fixture using the SAME buildSignedContributorFile
    // helper so the signature is genuinely valid.
    const existingBody = await buildSignedContributorFile({
      githubUserId: 42,
      githubLogin: 'alice',
      devicePubkeyBase64: keypair.rawPubkeyBase64,
      attestationGistId: 'gist-abc123',
      sign: keypair.sign,
      keychainId: 'test-keychain-id',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    const existingContentBase64 = Buffer.from(
      JSON.stringify(existingBody, null, 2) + '\n',
      'utf8',
    ).toString('base64');

    const fakeOctokit = makeFakeOctokit({
      getRefResponses: {
        // Branch exists → getRef succeeds
        'heads/user/42': { data: { object: { sha: 'branch-sha' } } },
      },
      getContentResponse: {
        data: {
          content: existingContentBase64,
          encoding: 'base64',
          sha: 'existing-blob-sha',
        },
      },
    });

    const opts = makeOpts(keypair, fakeOctokit);
    const result = await ensureMyBindingPublished(opts);

    // No PUT should have been issued
    expect(fakeOctokit._spies.createOrUpdateFileContents).not.toHaveBeenCalled();

    // No createRef either (branch already exists)
    expect(fakeOctokit._spies.createRef).not.toHaveBeenCalled();

    // Returns the pubkey, no commitSha
    expect(result.devicePubkeyBase64).toBe(keypair.rawPubkeyBase64);
    expect(result.commitSha).toBeUndefined();
  });
});

// ─── Test case 3 ──────────────────────────────────────────────────────────────

describe('ensureMyBindingPublished — file exists but different pubkey', () => {
  it('calls createOrUpdateFileContents with sha: "existing-sha" (update path)', async () => {
    const myKeypair = generateTestKeypair();
    const otherKeypair = generateTestKeypair();

    // Build a file body signed with a DIFFERENT keypair
    const otherBody = await buildSignedContributorFile({
      githubUserId: 42,
      githubLogin: 'alice',
      devicePubkeyBase64: otherKeypair.rawPubkeyBase64, // different pubkey!
      attestationGistId: 'gist-old',
      sign: otherKeypair.sign,
      keychainId: 'other-keychain',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    const otherContentBase64 = Buffer.from(
      JSON.stringify(otherBody, null, 2) + '\n',
      'utf8',
    ).toString('base64');

    const fakeOctokit = makeFakeOctokit({
      getRefResponses: {
        'heads/user/42': { data: { object: { sha: 'branch-sha' } } },
      },
      getContentResponse: {
        data: {
          content: otherContentBase64,
          encoding: 'base64',
          sha: 'existing-sha',
        },
      },
      createOrUpdateResponse: { data: { commit: { sha: 'updated-commit-sha' } } },
    });

    const opts = makeOpts(myKeypair, fakeOctokit);
    const result = await ensureMyBindingPublished(opts);

    // PUT must have been called
    expect(fakeOctokit._spies.createOrUpdateFileContents).toHaveBeenCalledTimes(1);

    const putCall = fakeOctokit._spies.createOrUpdateFileContents.mock.calls[0]![0] as {
      sha?: string;
      content: string;
    };
    // The existing blob sha must be forwarded so GitHub handles the update
    expect(putCall.sha).toBe('existing-sha');

    // The new content must carry MY pubkey
    const decoded = Buffer.from(putCall.content, 'base64').toString('utf8');
    const body = JSON.parse(decoded) as Record<string, unknown>;
    expect(body.device_pubkey).toBe(`ed25519:${myKeypair.rawPubkeyBase64}`);

    expect(result.commitSha).toBe('updated-commit-sha');
  });
});
