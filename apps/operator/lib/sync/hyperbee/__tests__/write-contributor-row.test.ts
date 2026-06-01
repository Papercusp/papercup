import { afterEach, describe, expect, it } from 'vitest';
import { publishContributorRow } from '../write-contributor-row';
import type { BootedHarnessHandle, LocalWriteOp } from '../boot';
import type { ContributorRow } from '../../../harness/contributor-row-types';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import {
  clobberEvents,
  observeMergedOp,
  _resetForTests,
  _setNowForTests,
  type ClobberEvent,
} from '../clobber-events';
import { makeFakeBootedHandle } from './fake-booted-handle';

afterEach(() => _resetForTests());

function fakeHandle(slug = 'papercup'): {
  handle: BootedHarnessHandle;
  appended: LocalWriteOp[];
} {
  return makeFakeBootedHandle({ harnessSlug: slug });
}

function mkRow(opts: Partial<ContributorRow> = {}): ContributorRow {
  return {
    harness_slug: 'papercup',
    github_user_id: 42,
    github_username: 'alice',
    display_name: 'Alice',
    avatar_url: 'https://a.png',
    device_attestations: [],
    revoked_pubkeys: [],
    joined_at: 1700000000000,
    last_seen_at: null,
    binding_status: 'pending',
    channel1_verified_at: null,
    channel2_verified_at: null,
    channel2_branch_ref: 'user/42',
    binding_last_checked_at: null,
    schema_version: CURRENT_SCHEMA_VERSION,
    ...opts,
  };
}

describe('publishContributorRow', () => {
  it('appends a put op with table=contributors + hbKey=<github_user_id>', async () => {
    const { handle, appended } = fakeHandle();
    await publishContributorRow({ handle, row: mkRow(), now: 1700000001000 });
    expect(appended).toHaveLength(1);
    const op = appended[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('contributors');
    expect(op.hbKey).toBe('42');
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(op.ts).toBe(1700000001000);
    expect(op.value).toEqual(mkRow());
  });

  it('uses Date.now() when no clock injected', async () => {
    const { handle, appended } = fakeHandle();
    const before = Date.now();
    await publishContributorRow({ handle, row: mkRow() });
    const after = Date.now();
    expect(appended[0].ts).toBeGreaterThanOrEqual(before);
    expect(appended[0].ts).toBeLessThanOrEqual(after);
  });

  it('rejects when row.harness_slug does not match handle.harnessSlug', async () => {
    const { handle } = fakeHandle('papercup');
    await expect(
      publishContributorRow({ handle, row: mkRow({ harness_slug: 'sheets' }) }),
    ).rejects.toThrow(/harness_slug/);
  });

  it('rejects missing handle', async () => {
    await expect(
      publishContributorRow({ handle: null as never, row: mkRow() }),
    ).rejects.toThrow(/handle/);
  });

  it('rejects missing row', async () => {
    const { handle } = fakeHandle();
    await expect(
      publishContributorRow({ handle, row: null as never }),
    ).rejects.toThrow(/row required/);
  });

  it('rejects 0/negative/float user id', async () => {
    const { handle } = fakeHandle();
    for (const bad of [0, -1, 1.5]) {
      await expect(
        publishContributorRow({ handle, row: mkRow({ github_user_id: bad }) }),
      ).rejects.toThrow(/github_user_id/);
    }
  });

  it('records the local write with clobber-events when writerPubkey provided', async () => {
    _setNowForTests(() => 1000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    const { handle } = fakeHandle();
    await publishContributorRow({
      handle,
      row: mkRow({ github_user_id: 42 }),
      now: 1000,
      writerPubkey: 'me-hex',
    });
    _setNowForTests(() => 1500);
    const fired = observeMergedOp({
      table: 'contributors',
      hbKey: '42',
      ts: 1200,
      pubkey: 'remote-hex',
    });
    expect(fired).toBe(true);
    expect(events[0].my.pubkey).toBe('me-hex');
  });

  it('omits recordLocalWrite when writerPubkey is absent', async () => {
    _setNowForTests(() => 1000);
    const { handle } = fakeHandle();
    await publishContributorRow({
      handle,
      row: mkRow({ github_user_id: 42 }),
      now: 1000,
    });
    const fired = observeMergedOp({
      table: 'contributors',
      hbKey: '42',
      ts: 1200,
      pubkey: 'remote-hex',
    });
    expect(fired).toBe(false);
  });

  it('round-trips: published value passes the projection decoder', async () => {
    const { handle, appended } = fakeHandle();
    const row = mkRow({ display_name: null, avatar_url: null });
    await publishContributorRow({ handle, row });
    // The projection's decodeValue is isContributorRow — same predicate.
    const { isContributorRow } = await import('../../../harness/contributor-row-types');
    expect(isContributorRow(appended[0].value)).toBe(true);
  });
});
