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
    // Only hive_pubkey + owner_device_pubkey present, missing the other two.
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

  it('formatHarnessLink omits the binding when any of the four is missing', () => {
    const partial: HarnessLink = { ...base, hivePubkey: withBinding.hivePubkey };
    const url = formatHarnessLink(partial);
    expect(url).not.toContain('hive_pubkey');
    expect(parseHarnessLink(url)!.hivePubkey).toBeUndefined();
  });
});
