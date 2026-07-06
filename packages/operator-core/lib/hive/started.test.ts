/**
 * started.ts — the persisted Start/Pause-Hive state, focused on the WI-3261
 * pause-PROVENANCE addition: `setHiveStarted`'s `deliberate` opt + the
 * `listPausedHives()` join. The hive_started/{deliberate} write-through is
 * exercised against a capturing fake sql (no PG); the K1 workspace-brain
 * flag is mocked OFF (byte-identical per-hive scoping) so these tests don't
 * need a live flag backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const inserted: Row[] = [];

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        if (/INSERT INTO harness_shared\.operator_settings/i.test(text)) {
          const [key, value] = values as [string, string, ...unknown[]];
          inserted.push({ key, value });
          return Promise.resolve([]);
        }
        if (/SELECT key, updated_at FROM harness_shared\.operator_settings/i.test(text)) {
          return Promise.resolve(startedRows);
        }
        if (/SELECT key FROM harness_shared\.operator_settings/i.test(text)) {
          return Promise.resolve(deliberateRows);
        }
        return Promise.resolve([]);
      },
      {},
    ),
  }),
}));

// K1 flag OFF (the dark default): scope collapses to the identity (per-hive
// slug), byte-identical to legacy keying — these tests don't exercise K1 ON.
vi.mock('../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: async () => false,
  workspaceBrainScopeKey: (_ws: string, perHiveSlug: string) => perHiveSlug,
  workspaceBrainReadKeys: (_ws: string, perHiveSlug: string) => [perHiveSlug],
}));

import { setHiveStarted, listPausedHives } from './started';

let startedRows: Array<{ key: string; updated_at: number }> = [];
let deliberateRows: Array<{ key: string }> = [];

beforeEach(() => {
  inserted.length = 0;
  startedRows = [];
  deliberateRows = [];
});
afterEach(() => vi.clearAllMocks());

describe('setHiveStarted — pause provenance (WI-3261)', () => {
  it('a deliberate pause (started:false, deliberate:true) writes BOTH the started row and a deliberate:true provenance row', async () => {
    await setHiveStarted('ws-1', 'hive-a', false, { deliberate: true });
    expect(inserted).toEqual([
      { key: 'hive_started:ws-1:hive-a', value: 'false' },
      { key: 'hive_paused_deliberate:ws-1:hive-a', value: 'true' },
    ]);
  });

  it('a plain pause (deliberate omitted) writes deliberate:false — never mistaken for owner-initiated', async () => {
    await setHiveStarted('ws-1', 'hive-a', false);
    expect(inserted).toEqual([
      { key: 'hive_started:ws-1:hive-a', value: 'false' },
      { key: 'hive_paused_deliberate:ws-1:hive-a', value: 'false' },
    ]);
  });

  it('a resume (started:true) ALWAYS clears provenance, even if deliberate:true is (nonsensically) passed', async () => {
    await setHiveStarted('ws-1', 'hive-a', true, { deliberate: true });
    expect(inserted).toEqual([
      { key: 'hive_started:ws-1:hive-a', value: 'true' },
      { key: 'hive_paused_deliberate:ws-1:hive-a', value: 'false' },
    ]);
  });
});

describe('listPausedHives — deliberate join (WI-3261)', () => {
  it('joins deliberate:true only for a paused hive with a matching deliberate:true row', async () => {
    startedRows = [
      { key: 'hive_started:ws-1:hive-a', updated_at: 1000 },
      { key: 'hive_started:ws-1:hive-b', updated_at: 2000 },
    ];
    deliberateRows = [{ key: 'hive_paused_deliberate:ws-1:hive-a' }];
    const rows = await listPausedHives();
    expect(rows).toEqual([
      { workspaceId: 'ws-1', installSlug: 'hive-a', pausedAtMs: 1000, deliberate: true },
      { workspaceId: 'ws-1', installSlug: 'hive-b', pausedAtMs: 2000, deliberate: false },
    ]);
  });

  it('no deliberate rows at all ⇒ every paused hive reads deliberate:false (today\'s behaviour, zero-regression)', async () => {
    startedRows = [{ key: 'hive_started:ws-1:hive-a', updated_at: 1000 }];
    deliberateRows = [];
    const rows = await listPausedHives();
    expect(rows).toEqual([{ workspaceId: 'ws-1', installSlug: 'hive-a', pausedAtMs: 1000, deliberate: false }]);
  });
});
