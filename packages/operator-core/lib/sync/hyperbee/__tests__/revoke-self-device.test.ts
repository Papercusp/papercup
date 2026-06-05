/**
 * revoke-self-device.test.ts — unit tests for revokeSelfDevice.
 *
 * All seams injected — no PG, no Hypercore, no gh-token.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  revokeSelfDevice,
  type RevokeSelfDeviceSeams,
} from '../revoke-self-device';
import type { ContributorRow } from '../../../harness/contributor-row-types';
import { CONTRIBUTOR_ROW_SCHEMA_VERSION } from '../../../harness/contributor-row-types';

// ─── helpers ──────────────────────────────────────────────────────────────────

const DEVICE_A = 'device-pubkey-AAAA';
const DEVICE_B = 'device-pubkey-BBBB';

function mkRow(opts: Partial<ContributorRow> = {}): ContributorRow {
  return {
    harness_slug: 'papercup',
    github_user_id: 42,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    device_attestations: [
      {
        device_pubkey: DEVICE_A,
        gist_id: 'gist-a',
        gist_url: 'https://gist.github.com/alice/gist-a',
        device_label: 'laptop',
        created_at: 1_700_000_000_000,
        signature_by_device: 'sig-a',
      },
    ],
    revoked_pubkeys: [],
    joined_at: 1_700_000_000_000,
    last_seen_at: null,
    binding_status: 'verified',
    channel1_verified_at: null,
    channel2_verified_at: null,
    channel2_branch_ref: null,
    binding_last_checked_at: null,
    schema_version: CONTRIBUTOR_ROW_SCHEMA_VERSION,
    ...opts,
  };
}

function okIdentity() {
  return async () => ({
    kind: 'ok' as const,
    token: 'token',
    githubUserId: 42,
    githubLogin: 'alice',
  });
}

function buildSeams(over: Partial<RevokeSelfDeviceSeams> = {}): {
  seams: RevokeSelfDeviceSeams;
  writeRow: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  const revoke = vi.fn(async (_pk: string) => {});
  const writeRow = vi.fn(async (_opts: unknown) => {});
  const seams: RevokeSelfDeviceSeams = {
    resolveIdentity: okIdentity(),
    loadOwnRow: async () => mkRow(),
    writeRow,
    getHandle: () => ({ revoke }),
    ...over,
  };
  return { seams, writeRow, revoke };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('revokeSelfDevice', () => {
  it('success: writes updated row with pubkey in revoked_pubkeys and calls handle.revoke; returns {ok:true, live:true}', async () => {
    const { seams, writeRow, revoke } = buildSeams();
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_A },
      seams,
    );
    expect(result).toEqual({ ok: true, revoked: DEVICE_A, live: true });
    // writeRow received the updated row with DEVICE_A in revoked_pubkeys
    expect(writeRow).toHaveBeenCalledOnce();
    const { row: writtenRow } = writeRow.mock.calls[0][0] as { row: ContributorRow };
    expect(writtenRow.revoked_pubkeys).toContain(DEVICE_A);
    // live handle.revoke was called with the same pubkey
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(DEVICE_A);
  });

  it('not_your_key: devicePubkey not in own device_attestations → no write, no revoke, {ok:false,code:"not_your_key"}', async () => {
    const { seams, writeRow, revoke } = buildSeams();
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_B },
      seams,
    );
    expect(result).toEqual({ ok: false, code: 'not_your_key' });
    expect(writeRow).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('no_contributor_row: loadOwnRow returns null → {ok:false,code:"no_contributor_row"}', async () => {
    const { seams, writeRow, revoke } = buildSeams({
      loadOwnRow: async () => null,
    });
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_A },
      seams,
    );
    expect(result).toEqual({ ok: false, code: 'no_contributor_row' });
    expect(writeRow).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('gh_auth_required: resolveIdentity returns gh_auth_required → {ok:false,code:"gh_auth_required"}', async () => {
    const { seams, writeRow, revoke } = buildSeams({
      resolveIdentity: async () => ({ kind: 'gh_auth_required' as const }),
    });
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_A },
      seams,
    );
    expect(result).toEqual({ ok: false, code: 'gh_auth_required' });
    expect(writeRow).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it('handle_not_booted: getHandle returns null → row still written, live:false', async () => {
    const { seams, writeRow } = buildSeams({
      getHandle: () => null,
    });
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_A },
      seams,
    );
    expect(result).toEqual({ ok: true, revoked: DEVICE_A, live: false });
    // The row MUST still be written even when no live handle is present
    expect(writeRow).toHaveBeenCalledOnce();
  });

  it('idempotent: already-revoked pubkey → ok:true, still calls live revoke', async () => {
    const { seams, writeRow, revoke } = buildSeams({
      loadOwnRow: async () => mkRow({ revoked_pubkeys: [DEVICE_A] }),
    });
    const result = await revokeSelfDevice(
      { workspaceId: 'ws1', harnessSlug: 'papercup', devicePubkey: DEVICE_A },
      seams,
    );
    expect(result).toEqual({ ok: true, revoked: DEVICE_A, live: true });
    // writeRow was still called — the row is re-published for idempotency
    expect(writeRow).toHaveBeenCalledOnce();
    // revoke was still called — the live handle must also be updated
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(DEVICE_A);
    // The written row still has DEVICE_A in revoked_pubkeys exactly once
    const { row: writtenRow } = writeRow.mock.calls[0][0] as { row: ContributorRow };
    expect(writtenRow.revoked_pubkeys.filter((p) => p === DEVICE_A)).toHaveLength(1);
  });

  it('writeRow receives the correct workspaceId and harnessSlug', async () => {
    const { seams, writeRow } = buildSeams();
    await revokeSelfDevice(
      { workspaceId: 'my-workspace', harnessSlug: 'my-harness', devicePubkey: DEVICE_A },
      {
        ...seams,
        loadOwnRow: async () =>
          mkRow({
            harness_slug: 'my-harness',
            device_attestations: [
              {
                device_pubkey: DEVICE_A,
                gist_id: 'g',
                gist_url: 'https://gist.github.com/x/g',
                device_label: 'dev',
                created_at: 1_700_000_000_000,
                signature_by_device: 'sig',
              },
            ],
          }),
      },
    );
    const callArg = writeRow.mock.calls[0][0] as { workspaceId: string; harnessSlug: string };
    expect(callArg.workspaceId).toBe('my-workspace');
    expect(callArg.harnessSlug).toBe('my-harness');
  });
});
