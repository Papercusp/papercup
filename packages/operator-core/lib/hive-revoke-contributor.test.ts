/**
 * hive-revoke-contributor — the Hive-scope owner-revocation decision
 * (shared-hive-federation P-006). Hermetic: all PG/keychain/gh seams injected.
 */

import { describe, it, expect } from 'vitest';
import { revokeHiveContributor, type RevokeHiveContributorSeams } from './hive-revoke-contributor';

function seams(over: Partial<RevokeHiveContributorSeams> = {}): RevokeHiveContributorSeams {
  return {
    loadOwnerKeyStatus: async () => ({ kind: 'ok', pubkeyBase64: 'hive-pk' }),
    resolveOwnerGithubUserId: async () => 1,
    loadTargetPubkeys: async () => ['t-pk-1', 't-pk-2'],
    publishRevocation: async () => ({ live: false }),
    ...over,
  };
}

const input = { workspaceId: 'ws', potHomeSlug: 'alpha', githubUserId: 42 };

describe('revokeHiveContributor', () => {
  it('happy path: the owner revokes the target device pubkeys into their own row', async () => {
    let published: string[] | null = null;
    let publishedOwner: number | null = null;
    const r = await revokeHiveContributor(
      input,
      seams({
        publishRevocation: async (_ws, _slug, owner, pks) => {
          publishedOwner = owner;
          published = pks;
          return { live: true };
        },
      }),
    );
    expect(r).toEqual({ ok: true, revokedPubkeys: ['t-pk-1', 't-pk-2'], live: true });
    expect(publishedOwner).toBe(1);
    expect(published).toEqual(['t-pk-1', 't-pk-2']);
  });

  it('rejects a non-positive-integer target id (bad_target)', async () => {
    expect(await revokeHiveContributor({ ...input, githubUserId: 0 }, seams())).toMatchObject({ ok: false, code: 'bad_target' });
    expect(await revokeHiveContributor({ ...input, githubUserId: -1 }, seams())).toMatchObject({ ok: false, code: 'bad_target' });
  });

  it('not_owner when this Swarm does not hold the Hive key — and short-circuits BEFORE loading the target', async () => {
    let loaded = false;
    const r = await revokeHiveContributor(
      input,
      seams({
        loadOwnerKeyStatus: async () => ({ kind: 'not_found' }),
        loadTargetPubkeys: async () => {
          loaded = true;
          return ['x'];
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'not_owner' });
    expect(loaded).toBe(false); // no target lookup leaks to a non-owner
  });

  // ── WI-37195 (C-001 breach) ────────────────────────────────────────────────────
  // The owner gate is TRI-STATE. It used to be `loadHivePubkey(...) !== null`, which flattened
  // "no key held" and "key held but UNREADABLE" into the same `null` → both returned `not_owner`
  // → the revoke returned before the epoch advance → no re-key → the revoked contributor kept a
  // valid key and went on reading post-revoke content. A security control failing OPEN and QUIET.
  // These two tests pin the distinction; the second is the one that was breached.
  it('owner_key_unreadable (NOT not_owner) when the Hive key is present but cannot be read — the revoke FAILS LOUDLY rather than silently skipping the re-key', async () => {
    let loaded = false;
    let published = false;
    const r = await revokeHiveContributor(
      input,
      seams({
        loadOwnerKeyStatus: async () => ({ kind: 'error', reason: 'decryption_failed' }),
        loadTargetPubkeys: async () => {
          loaded = true;
          return ['x'];
        },
        publishRevocation: async () => {
          published = true;
          return { live: true };
        },
      }),
    );
    // The whole point: an unreadable key must NOT be reported as `not_owner`. A caller (or a gate)
    // that sees `not_owner` reasonably concludes "this box isn't the owner, nothing to do here",
    // when in truth ownership could not be DETERMINED and the re-key was skipped.
    expect(r).toMatchObject({ ok: false, code: 'owner_key_unreadable' });
    expect((r as { code: string }).code).not.toBe('not_owner');
    // It must carry the underlying reason, so a 0→0 names its own cause instead of needing a manual trace.
    expect((r as { detail?: string }).detail).toContain('decryption_failed');
    // And it must refuse EARLY — never half-apply a revocation whose re-key it cannot perform.
    expect(loaded).toBe(false);
    expect(published).toBe(false);
  });

  it('a genuine non-owner and an unreadable key are DISTINGUISHABLE — the flattening that caused C-001 cannot silently return', async () => {
    const notOwner = await revokeHiveContributor(input, seams({ loadOwnerKeyStatus: async () => ({ kind: 'not_found' }) }));
    const unreadable = await revokeHiveContributor(
      input,
      seams({ loadOwnerKeyStatus: async () => ({ kind: 'error', reason: 'io_error' }) }),
    );
    expect((notOwner as { code: string }).code).not.toEqual((unreadable as { code: string }).code);
  });

  it('no_owner_identity when the local gh identity is unavailable', async () => {
    expect(await revokeHiveContributor(input, seams({ resolveOwnerGithubUserId: async () => null }))).toMatchObject({
      ok: false,
      code: 'no_owner_identity',
    });
  });

  it('no_target when the target has no bound devices', async () => {
    expect(await revokeHiveContributor(input, seams({ loadTargetPubkeys: async () => [] }))).toMatchObject({
      ok: false,
      code: 'no_target',
    });
  });

  it('no_owner_row when the owner has not joined the Hive (publish throws no-row)', async () => {
    const r = await revokeHiveContributor(
      input,
      seams({
        publishRevocation: async () => {
          throw new Error('owner has no hive_members row — join the Hive before revoking');
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, code: 'no_owner_row' });
  });

  it('revoke_failed on an unexpected publish error', async () => {
    expect(
      await revokeHiveContributor(input, seams({ publishRevocation: async () => { throw new Error('pg down'); } })),
    ).toMatchObject({ ok: false, code: 'revoke_failed', detail: 'pg down' });
  });
});
