import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, createPublicKey } from 'node:crypto';
import { verifyChannel1, verifyChannel2, verifyBoth } from './two-channel-verifier';
import {
  CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER,
  contributorFilePath,
  contributorBranchRef,
  ContributorFileBody,
} from './contributor-file-types';

// ─── test helpers ─────────────────────────────────────────────────────────────

function makeSpkiDer(raw: Buffer): Buffer {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return Buffer.concat([prefix, raw]);
}

/** Build a signed ContributorFileBody fixture. */
function makeSignedContributorFile(opts: {
  githubUserId: number;
  githubLogin: string;
  devicePubkeyBase64: string;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  gistId?: string;
}): ContributorFileBody {
  const { githubUserId, githubLogin, devicePubkeyBase64, privateKey, gistId = 'gist-abc' } = opts;

  const unsignedFields = {
    device_attestation_gist_id: gistId,
    device_pubkey: devicePubkeyBase64,
    github_login: githubLogin,
    github_user_id: githubUserId,
    joined_at: '2026-01-01T00:00:00Z',
    version: 1 as const,
  };

  // JCS canonical signing order: CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER minus signature_by_device
  const signingFields = CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER.filter(
    (f) => f !== 'signature_by_device',
  );
  const ordered: Record<string, unknown> = {};
  for (const f of signingFields) {
    ordered[f] = (unsignedFields as Record<string, unknown>)[f];
  }
  const payload = Buffer.from(JSON.stringify(ordered), 'utf8');
  const sig = nodeSign(null, payload, privateKey).toString('base64');

  return { ...unsignedFields, signature_by_device: sig };
}

function makeFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const resp = responses[call++];
    if (!resp) throw new Error('unexpected fetch call ' + call);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function networkErrorFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

// ─── Channel 1 ────────────────────────────────────────────────────────────────

describe('verifyChannel1', () => {
  it('passes when /user id matches claimed id', async () => {
    const result = await verifyChannel1({
      token: 'tok-valid',
      claimedGithubUserId: 42,
      fetchFn: makeFetch([{ status: 200, body: { id: 42, login: 'alice' } }]),
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('fails with oauth_user_id_mismatch when id differs', async () => {
    const result = await verifyChannel1({
      token: 'tok-valid',
      claimedGithubUserId: 42,
      fetchFn: makeFetch([{ status: 200, body: { id: 99, login: 'bob' } }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'oauth_user_id_mismatch' });
  });

  it('fails with oauth_token_revoked on 401', async () => {
    const result = await verifyChannel1({
      token: 'tok-expired',
      claimedGithubUserId: 1,
      fetchFn: makeFetch([{ status: 401, body: { message: 'Bad credentials' } }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'oauth_token_revoked' });
  });

  it('fails with github_api_down on non-200/non-401 error', async () => {
    const result = await verifyChannel1({
      token: 'tok',
      claimedGithubUserId: 1,
      fetchFn: makeFetch([{ status: 503, body: {} }]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });

  it('fails with github_api_down on network error', async () => {
    const result = await verifyChannel1({
      token: 'tok',
      claimedGithubUserId: 1,
      fetchFn: networkErrorFetch(),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });
});

// ─── Channel 2 ────────────────────────────────────────────────────────────────

describe('verifyChannel2', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPubkey = spkiDer.subarray(-32);
  const devicePubkeyBase64 = rawPubkey.toString('base64');

  const USER_ID = 1001;
  const LOGIN = 'alice';
  const REPO_OWNER = 'myorg';
  const REPO_NAME = 'myharness';

  const commonOpts = {
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    githubLogin: LOGIN,
    githubUserId: USER_ID,
    devicePubkeyBase64,
  };

  function makeContentsBody(body: ContributorFileBody): { status: number; body: unknown } {
    const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
    return {
      status: 200,
      body: {
        content: encoded + '\n',
        encoding: 'base64',
        sha: 'deadbeef',
      },
    };
  }

  const goodCommitResp = {
    status: 200,
    body: {
      author: { login: LOGIN },
      commit: { verification: { verified: true } },
    },
  };

  it('passes when file exists, sig valid, commit verified', async () => {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([makeContentsBody(fileBody), goodCommitResp]),
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('returns pending (just_joined) when file 404', async () => {
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([{ status: 404, body: { message: 'Not Found' } }]),
    });
    expect(result).toEqual({ kind: 'pending', reason: 'just_joined_channel2_propagating' });
  });

  it('returns channel2_signature_invalid when sig tampered', async () => {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const tampered = { ...fileBody, signature_by_device: 'AAAA' };
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([makeContentsBody(tampered as ContributorFileBody), goodCommitResp]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'channel2_signature_invalid' });
  });

  it('returns channel2_commit_author_mismatch when author login differs', async () => {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const wrongAuthorResp = {
      status: 200,
      body: {
        author: { login: 'mallory' },
        commit: { verification: { verified: true } },
      },
    };
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([makeContentsBody(fileBody), wrongAuthorResp]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'channel2_commit_author_mismatch' });
  });

  it('returns channel2_commit_not_verified when GitHub did not verify the commit', async () => {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const unverifiedCommit = {
      status: 200,
      body: {
        author: { login: LOGIN },
        commit: { verification: { verified: false } },
      },
    };
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([makeContentsBody(fileBody), unverifiedCommit]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'channel2_commit_not_verified' });
  });

  it('returns github_api_down on contents fetch network error', async () => {
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: networkErrorFetch(),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });

  it('returns github_api_down when commit fetch fails', async () => {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const errorCommit = { status: 500, body: {} };
    const result = await verifyChannel2({
      ...commonOpts,
      fetchFn: makeFetch([makeContentsBody(fileBody), errorCommit]),
    });
    expect(result).toEqual({ kind: 'fail', reason: 'github_api_down' });
  });
});

// ─── verifyBoth ───────────────────────────────────────────────────────────────

describe('verifyBoth', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPubkey = spkiDer.subarray(-32);
  const devicePubkeyBase64 = rawPubkey.toString('base64');

  const USER_ID = 2001;
  const LOGIN = 'bob';
  const REPO_OWNER = 'testorg';
  const REPO_NAME = 'testharness';

  const ch1Opts = {
    token: 'tok-ok',
    claimedGithubUserId: USER_ID,
  };
  const ch2Opts = {
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    githubLogin: LOGIN,
    githubUserId: USER_ID,
    devicePubkeyBase64,
  };

  function makeGoodCh1Fetch() {
    return makeFetch([{ status: 200, body: { id: USER_ID, login: LOGIN } }]);
  }

  function makeGoodContentsBody(): { status: number; body: unknown } {
    const fileBody = makeSignedContributorFile({ githubUserId: USER_ID, githubLogin: LOGIN, devicePubkeyBase64, privateKey });
    const encoded = Buffer.from(JSON.stringify(fileBody)).toString('base64');
    return { status: 200, body: { content: encoded + '\n', encoding: 'base64', sha: 'abc123' } };
  }

  const goodCommit = { status: 200, body: { author: { login: LOGIN }, commit: { verification: { verified: true } } } };

  it('returns verified when both channels pass', async () => {
    const ch1Fetch = makeGoodCh1Fetch();
    const ch2Fetch = makeFetch([makeGoodContentsBody(), goodCommit]);
    const result = await verifyBoth({
      channel1: { ...ch1Opts, fetchFn: ch1Fetch },
      channel2: { ...ch2Opts, fetchFn: ch2Fetch },
      nowMs: 1_000_000,
    });
    expect(result.status).toBe('verified');
    expect(result.channel1).toEqual({ kind: 'ok' });
    expect(result.channel2).toEqual({ kind: 'ok' });
  });

  it('returns unverified when channel 1 fails', async () => {
    const ch1Fetch = makeFetch([{ status: 401, body: {} }]);
    const ch2Fetch = makeFetch([makeGoodContentsBody(), goodCommit]);
    const result = await verifyBoth({
      channel1: { ...ch1Opts, fetchFn: ch1Fetch },
      channel2: { ...ch2Opts, fetchFn: ch2Fetch },
      nowMs: 1_000_000,
    });
    expect(result.status).toBe('unverified');
  });

  it('returns pending when channel 1 ok and channel 2 just-joined', async () => {
    const ch1Fetch = makeGoodCh1Fetch();
    const ch2Fetch = makeFetch([{ status: 404, body: {} }]);
    const now = 1_000_000;
    const result = await verifyBoth({
      channel1: { ...ch1Opts, fetchFn: ch1Fetch },
      channel2: { ...ch2Opts, fetchFn: ch2Fetch },
      nowMs: now,
    });
    expect(result.status).toBe('pending');
    expect(result.pendingUntil).toBeGreaterThan(now);
  });

  it('returns unverified when channel 2 pending past grace window', async () => {
    const ch1Fetch = makeGoodCh1Fetch();
    const ch2Fetch = makeFetch([{ status: 404, body: {} }]);
    const graceWindowMs = 60_000;
    const ch2PendingSince = 1_000_000;
    const now = ch2PendingSince + graceWindowMs + 1;
    const result = await verifyBoth({
      channel1: { ...ch1Opts, fetchFn: ch1Fetch },
      channel2: { ...ch2Opts, fetchFn: ch2Fetch },
      channel2PendingSince: ch2PendingSince,
      graceWindowMs,
      nowMs: now,
    });
    expect(result.status).toBe('unverified');
  });

  it('checkedAt reflects the nowMs passed in', async () => {
    const ch1Fetch = makeGoodCh1Fetch();
    const ch2Fetch = makeFetch([makeGoodContentsBody(), goodCommit]);
    const nowMs = 9_999_999;
    const result = await verifyBoth({
      channel1: { ...ch1Opts, fetchFn: ch1Fetch },
      channel2: { ...ch2Opts, fetchFn: ch2Fetch },
      nowMs,
    });
    expect(result.checkedAt).toBe(nowMs);
  });
});
