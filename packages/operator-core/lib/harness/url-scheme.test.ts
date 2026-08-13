import { describe, it, expect } from 'vitest';
import { parseHarnessLink, formatHarnessLink, type HarnessLink } from './url-scheme';

const TOPIC = 'a'.repeat(64);

const base: HarnessLink = {
  topic: TOPIC,
  github: 'octo/repo',
  repoOwner: 'octo',
  repoName: 'repo',
  repoId: 12345,
};

describe('url-scheme: base (no owner binding) — backward compatibility', () => {
  it('round-trips a plain 3-param link', () => {
    const url = formatHarnessLink(base);
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.topic).toBe(TOPIC);
    expect(parsed!.github).toBe('octo/repo');
    expect(parsed!.repoOwner).toBe('octo');
    expect(parsed!.repoName).toBe('repo');
    expect(parsed!.repoId).toBe(12345);
    // No owner binding present.
    expect(parsed!.hivePubkey).toBeUndefined();
    expect(parsed!.ownerDevicePubkey).toBeUndefined();
    expect(parsed!.ownerGithubUserId).toBeUndefined();
    expect(parsed!.attestationGistId).toBeUndefined();
  });

  it('a legacy hand-written 3-param URL (unencoded github slash) still parses', () => {
    const url = `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.github).toBe('octo/repo');
    // formatHarnessLink %2F-encodes the slash (pre-existing); it must NOT emit any
    // of the D-007 owner-binding keys when the binding is absent.
    const formatted = formatHarnessLink(base);
    expect(formatted).not.toContain('hive_pubkey');
    expect(formatted).not.toContain('owner_device_pubkey');
    expect(parseHarnessLink(formatted)!.github).toBe('octo/repo');
  });

  it('rejects a link with an unknown extra param', () => {
    const url = `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345&bogus=1`;
    expect(parseHarnessLink(url)).toBeNull();
  });
});

describe('url-scheme: D-007 owner binding', () => {
  const withBinding: HarnessLink = {
    ...base,
    hivePubkey: 'aGl2ZVB1YmtleS0zMmJ5dGVzLWJhc2U2NC1leGFtcGxlISE=',
    ownerDevicePubkey: 'ed25519:b3duZXJEZXZpY2VQdWJrZXktYmFzZTY0LWV4YW1wbGU=',
    ownerGithubUserId: 279242982,
    attestationGistId: 'abc123def456abc123def456abc12345',
  };

  it('round-trips the full verified owner binding', () => {
    const url = formatHarnessLink(withBinding);
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.hivePubkey).toBe(withBinding.hivePubkey);
    expect(parsed!.ownerDevicePubkey).toBe(withBinding.ownerDevicePubkey);
    expect(parsed!.ownerGithubUserId).toBe(279242982);
    expect(parsed!.attestationGistId).toBe(withBinding.attestationGistId);
  });

  it("preserves base64 '+' and '/' across the URLSearchParams round-trip", () => {
    // The +→space gotcha: a raw base64 pubkey with + and / must survive.
    const plusKey: HarnessLink = {
      ...withBinding,
      hivePubkey: 'AB+CD/EF+gh/ij==',
      ownerDevicePubkey: 'ed25519:Z+z/Y+y/X+x==',
    };
    const parsed = parseHarnessLink(formatHarnessLink(plusKey));
    expect(parsed).not.toBeNull();
    expect(parsed!.hivePubkey).toBe('AB+CD/EF+gh/ij==');
    expect(parsed!.ownerDevicePubkey).toBe('ed25519:Z+z/Y+y/X+x==');
  });

  it('all-or-nothing: a partial owner binding is ignored (not partially threaded)', () => {
    // Only hive_pubkey + owner_device_pubkey present, missing owner_github_user_id.
    const url =
      `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345` +
      `&hive_pubkey=${encodeURIComponent(withBinding.hivePubkey!)}` +
      `&owner_device_pubkey=${encodeURIComponent(withBinding.ownerDevicePubkey!)}`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.hivePubkey).toBeUndefined();
    expect(parsed!.ownerDevicePubkey).toBeUndefined();
    expect(parsed!.ownerGithubUserId).toBeUndefined();
    expect(parsed!.attestationGistId).toBeUndefined();
  });

  it('ignores a malformed owner_github_user_id (non-numeric) without rejecting the link', () => {
    const url =
      `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345` +
      `&hive_pubkey=${encodeURIComponent(withBinding.hivePubkey!)}` +
      `&owner_device_pubkey=${encodeURIComponent(withBinding.ownerDevicePubkey!)}` +
      `&owner_github_user_id=notanumber` +
      `&attestation_gist_id=${withBinding.attestationGistId}`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull(); // required params still valid → link parses
    expect(parsed!.ownerGithubUserId).toBeUndefined(); // binding dropped
    expect(parsed!.hivePubkey).toBeUndefined();
  });

  it('formatHarnessLink omits the binding when any of the three channel-1 fields is missing', () => {
    const partial: HarnessLink = { ...base, hivePubkey: withBinding.hivePubkey };
    const url = formatHarnessLink(partial);
    expect(url).not.toContain('hive_pubkey');
    expect(parseHarnessLink(url)!.hivePubkey).toBeUndefined();
  });
});

describe('url-scheme: WI-38345 — a gist-less owner still publishes a usable binding', () => {
  // THE LIVE FAILURE THIS PINS. An owner with no verified GitHub email gets a 422
  // from the gist create, so `resolveLocalAnnounceIdentity` yields
  // `attestationGistId: ''`. That empty string used to be a falsy conjunct in
  // formatHarnessLink's all-or-nothing gate, silently deleting `owner_device_pubkey`
  // from EVERY member link the owner published. join-hive.ts reads exactly that field
  // as its deterministic owner-binding source, so the joiner had none:
  // resolveJoinedHiveOwnerDevice() → null → the WI-787 owner-bootstrap admit could not
  // fire → the owner's announce was rejected `binding_invalid`. Announces are never
  // re-delivered, so A→B federation stalled permanently (WI-5481 soak attempt 4:
  // 0 membership rows on the joiner, never converged in 422s).
  const channel1: HarnessLink = {
    ...base,
    hivePubkey: 'aGl2ZVB1YmtleS0zMmJ5dGVzLWJhc2U2NC1leGFtcGxlISE=',
    ownerDevicePubkey: 'ed25519:b3duZXJEZXZpY2VQdWJrZXktYmFzZTY0LWV4YW1wbGU=',
    ownerGithubUserId: 279242982,
  };

  it("emits the owner binding when attestationGistId is '' (the 422 case)", () => {
    const url = formatHarnessLink({ ...channel1, attestationGistId: '' });
    expect(url).toContain('owner_device_pubkey');
    const parsed = parseHarnessLink(url)!;
    expect(parsed.ownerDevicePubkey).toBe(channel1.ownerDevicePubkey);
    expect(parsed.hivePubkey).toBe(channel1.hivePubkey);
    expect(parsed.ownerGithubUserId).toBe(279242982);
    // The anchor genuinely isn't there — the point is that its absence no longer
    // costs us the binding, not that we fabricate one.
    expect(parsed.attestationGistId).toBeUndefined();
    expect(url).not.toContain('attestation_gist_id');
  });

  it('emits the owner binding when attestationGistId is omitted entirely', () => {
    const parsed = parseHarnessLink(formatHarnessLink(channel1))!;
    expect(parsed.ownerDevicePubkey).toBe(channel1.ownerDevicePubkey);
    expect(parsed.attestationGistId).toBeUndefined();
  });

  it('parses a gist-less link produced by another peer', () => {
    const url =
      `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345` +
      `&hive_pubkey=${encodeURIComponent(channel1.hivePubkey!)}` +
      `&owner_device_pubkey=${encodeURIComponent(channel1.ownerDevicePubkey!)}` +
      `&owner_github_user_id=279242982`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.ownerDevicePubkey).toBe(channel1.ownerDevicePubkey);
    expect(parsed!.attestationGistId).toBeUndefined();
  });

  it('still carries the gist anchor when the owner HAS one (no regression)', () => {
    const gist = 'abc123def456abc123def456abc12345';
    const parsed = parseHarnessLink(formatHarnessLink({ ...channel1, attestationGistId: gist }))!;
    expect(parsed.attestationGistId).toBe(gist);
    expect(parsed.ownerDevicePubkey).toBe(channel1.ownerDevicePubkey);
  });

  it('drops a lone gist anchor that names no owner device (it attests nothing)', () => {
    // Both directions: format refuses to emit it, and parse refuses to keep it.
    const url = formatHarnessLink({ ...base, attestationGistId: 'abc123def456abc123def456abc12345' });
    expect(url).not.toContain('attestation_gist_id');

    const handRolled =
      `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345` +
      `&attestation_gist_id=abc123def456abc123def456abc12345`;
    const parsed = parseHarnessLink(handRolled);
    expect(parsed).not.toBeNull();
    expect(parsed!.attestationGistId).toBeUndefined();
  });

  it('drops a MALFORMED gist anchor without taking the binding down with it', () => {
    // The regression shape in miniature: a bad channel-2 field must cost only itself.
    const url =
      `papercusp://harness?topic=${TOPIC}&github=octo/repo&repo_id=12345` +
      `&hive_pubkey=${encodeURIComponent(channel1.hivePubkey!)}` +
      `&owner_device_pubkey=${encodeURIComponent(channel1.ownerDevicePubkey!)}` +
      `&owner_github_user_id=279242982` +
      `&attestation_gist_id=${encodeURIComponent('not a gist id!!')}`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.attestationGistId).toBeUndefined();
    expect(parsed!.ownerDevicePubkey).toBe(channel1.ownerDevicePubkey);
  });
});

describe('url-scheme: A3 repo_key — the owner-minted pot-git repoKey', () => {
  it('round-trips the repoKey', () => {
    const url = formatHarnessLink({ ...base, repoKey: 'gh-1223568103' });
    expect(url).toContain('repo_key=gh-1223568103');
    expect(parseHarnessLink(url)!.repoKey).toBe('gh-1223568103');
  });

  it('rides ALONE — it is not part of the D-007 all-or-nothing owner binding', () => {
    // The owner binding is absent here; the repoKey must still arrive, or a pot
    // whose owner has no attestation could never federate its key.
    const parsed = parseHarnessLink(formatHarnessLink({ ...base, repoKey: 'papercusp' }))!;
    expect(parsed.repoKey).toBe('papercusp');
    expect(parsed.hivePubkey).toBeUndefined();
  });

  it('omits the param entirely when no repoKey is supplied (pre-A3 links are unchanged)', () => {
    const url = formatHarnessLink(base);
    expect(url).not.toContain('repo_key');
    expect(parseHarnessLink(url)!.repoKey).toBeUndefined();
  });

  it('still parses a link that carries no repo_key — an older owner build', () => {
    const url = `papercusp://harness?topic=${TOPIC}&github=octo%2Frepo&repo_id=12345`;
    const parsed = parseHarnessLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.repoKey).toBeUndefined();
  });

  it('DROPS a malformed repo_key instead of rejecting the whole link', () => {
    // A repoKey becomes a filesystem path component and a git ref component, so
    // traversal/junk must never survive — but losing the key must degrade to
    // "derive locally", not to an unjoinable link.
    for (const bad of ['..', '.', 'a%2Fb', 'a%20b', 'x'.repeat(201)]) {
      const url = `papercusp://harness?topic=${TOPIC}&github=octo%2Frepo&repo_id=12345&repo_key=${bad}`;
      const parsed = parseHarnessLink(url);
      expect(parsed, `link with repo_key=${bad} must still parse`).not.toBeNull();
      expect(parsed!.repoKey, `repo_key=${bad} must be dropped`).toBeUndefined();
    }
  });

  it('format refuses to emit a malformed repoKey', () => {
    expect(formatHarnessLink({ ...base, repoKey: '../etc' })).not.toContain('repo_key');
    expect(formatHarnessLink({ ...base, repoKey: '..' })).not.toContain('repo_key');
  });
});
