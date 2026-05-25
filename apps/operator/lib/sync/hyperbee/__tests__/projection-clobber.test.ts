import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyHyperbeeOpToPg,
  registerProjection,
  _clearRegistryForTests,
} from '../projection';
import {
  clobberEvents,
  recordLocalWrite,
  _resetForTests,
  _setNowForTests,
  type ClobberEvent,
} from '../clobber-events';

afterEach(() => {
  _clearRegistryForTests();
  _resetForTests();
});

function registerStubProjection(tableTag: string): void {
  registerProjection({
    tableTag,
    composeKey: () => '',
    decodeValue: (raw) => raw as Record<string, unknown> | null,
    writeToPg: vi.fn(async () => {}),
    deleteFromPg: vi.fn(async () => {}),
  });
}

describe('applyHyperbeeOpToPg — clobber-event integration', () => {
  it('fires clobber event when incoming op tuple beats a recent local write', async () => {
    registerStubProjection('queue');
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1_000,
      pubkey: 'me-hex',
    });
    _setNowForTests(() => 1_500);
    const applied = await applyHyperbeeOpToPg({
      type: 'put',
      table: 'queue',
      hbKey: '1/F-1',
      value: { queued_at: 1_200 },
      ts: 1_200,
      writerPubkey: 'remote-hex',
    });
    expect(applied).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].my.pubkey).toBe('me-hex');
    expect(events[0].theirs.pubkey).toBe('remote-hex');
  });

  it('does NOT fire when op has no writerPubkey (legacy write)', async () => {
    registerStubProjection('queue');
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1_000,
      pubkey: 'me-hex',
    });
    const applied = await applyHyperbeeOpToPg({
      type: 'put',
      table: 'queue',
      hbKey: '1/F-1',
      value: { queued_at: 1_200 },
      ts: 1_200,
    });
    expect(applied).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('does NOT fire when there is no recent local write', async () => {
    registerStubProjection('queue');
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    const applied = await applyHyperbeeOpToPg({
      type: 'put',
      table: 'queue',
      hbKey: '1/F-1',
      value: { x: 1 },
      ts: 1_200,
      writerPubkey: 'remote-hex',
    });
    expect(applied).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('does NOT fire on self-echo (same pubkey as the recorded local write)', async () => {
    registerStubProjection('queue');
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1_000,
      pubkey: 'me-hex',
    });
    const applied = await applyHyperbeeOpToPg({
      type: 'put',
      table: 'queue',
      hbKey: '1/F-1',
      value: { x: 1 },
      ts: 1_005,
      writerPubkey: 'me-hex',
    });
    expect(applied).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('still applies the PG write even when no clobber fires', async () => {
    const writeSpy = vi.fn(async () => {});
    registerProjection({
      tableTag: 'queue',
      composeKey: () => '',
      decodeValue: (raw) => raw as Record<string, unknown> | null,
      writeToPg: writeSpy,
      deleteFromPg: vi.fn(async () => {}),
    });
    await applyHyperbeeOpToPg({
      type: 'put',
      table: 'queue',
      hbKey: '1/F-1',
      value: { x: 1 },
      ts: 1_200,
      writerPubkey: 'remote-hex',
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('clobber-fire path tolerates `del` ops (only put fires)', async () => {
    registerStubProjection('queue');
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1_000,
      pubkey: 'me-hex',
    });
    // del ops don't go through observeMergedOp.
    await applyHyperbeeOpToPg({
      type: 'del',
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1_200,
      writerPubkey: 'remote-hex',
    });
    expect(events).toHaveLength(0);
  });
});
