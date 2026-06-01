/**
 * bootHarnessSubstrate — composer tests (Model B, Stage 4a).
 *
 * Covers:
 *   - Argument validation (workspaceRoot / workspaceId / harnessSlug).
 *   - Schema-version alert event subscription / unsubscription.
 *   - The Model B handle shape: `ownLog.keyHex` + `mergeNow` + `admitted`
 *     (NOT the retired Autobase `base`).
 *   - The single-peer path: own writes → mergeNow → PG projection.
 *
 * The single-peer test uses a real Corestore over a tmp dir (mirrors
 * peer-log.test.ts) + a capturing projection sink (no real PG), with the
 * merge poll-timer disabled so the test drives `mergeNow()` by hand.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootHarnessSubstrate, onSchemaVersionAlert } from '../boot';
import { schemaVersionEvents, type SchemaVersionAlert, CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import {
  registerProjection,
  _clearRegistryForTests,
  type TableProjection,
} from '../projection';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  schemaVersionEvents.removeAllListeners();
  _clearRegistryForTests();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
});

describe('bootHarnessSubstrate — validation', () => {
  it('rejects missing workspaceRoot', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '', workspaceId: 'w', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceRoot/);
  });

  it('rejects missing workspaceId', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: '', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceId/);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: 'w', harnessSlug: '' }),
    ).rejects.toThrow(/harnessSlug/);
  });
});

describe('bootHarnessSubstrate — Model B handle shape + single-peer merge', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('exposes ownLog.keyHex + mergeNow + admitted, NOT base', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      mergePollMs: 0, // disable the poll timer; drive mergeNow by hand
    });
    cleanups.push(() => handle.close());

    expect(handle.ownLog.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof handle.mergeNow).toBe('function');
    expect(handle.admitted.get(handle.ownLog.keyHex)).toBe(handle.ownLog);
    // The retired Autobase `base` is gone.
    expect((handle as unknown as { base?: unknown }).base).toBeUndefined();
    expect(handle.swarm).toBeNull();
  });

  it('single-peer: own writes flow through mergeNow into the projection sink', async () => {
    // Register a capturing projection for a test table.
    const writes: unknown[] = [];
    const proj: TableProjection<{ id: string }> = {
      tableTag: 'mb_test_table',
      composeKey: (row) => row.id,
      decodeValue: (raw) => (raw && typeof raw === 'object' ? (raw as { id: string }) : null),
      writeToPg: async (row) => { writes.push(row); },
      deleteFromPg: async () => {},
    };
    registerProjection(proj);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's2',
      mergePollMs: 0,
    });
    cleanups.push(() => handle.close());

    await handle.append({
      type: 'put',
      table: 'mb_test_table',
      hbKey: 'F-1',
      value: { id: 'F-1' },
      ts: 1000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    expect(handle.ownLog.length).toBe(1);

    const applied = await handle.mergeNow();
    expect(applied).toBe(1);
    expect(writes).toEqual([{ id: 'F-1' }]);
  });
});

describe('onSchemaVersionAlert', () => {
  it('subscribes to alerts emitted by the substrate', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(1);
    expect(received[0].observed_version).toBe(99);
    unsub();
  });

  it('unsub stops further deliveries', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    unsub();
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers receive the alert independently', () => {
    const a: SchemaVersionAlert[] = [];
    const b: SchemaVersionAlert[] = [];
    const unsub1 = onSchemaVersionAlert((x) => a.push(x));
    const unsub2 = onSchemaVersionAlert((x) => b.push(x));
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 5, known_version: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsub1();
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 6, known_version: 1 });
    expect(a).toHaveLength(1);    // unsubbed
    expect(b).toHaveLength(2);    // still active
    unsub2();
  });
});
