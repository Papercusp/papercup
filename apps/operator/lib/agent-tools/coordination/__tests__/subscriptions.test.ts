/**
 * Unit tests for subscriptions (Phase D core).
 * Pure filesystem, no PG.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The coord stores are PG-backed (getOrgPg().sql), and getOrgPg() crashes under
// vitest. Replace them with coordinated in-memory stores: PgSubscriptionStore
// holds watches; coordLog writes notify envelopes that readInbox reads.
const __subs: any[] = [];
const __inbox: any[] = [];
vi.mock('@papercusp/coordination/subscription-store', () => ({
  PgSubscriptionStore: class {
    constructor(_opts: unknown) {}
    async add(rec: any) { __subs.push({ ...rec, cancelled: false }); }
    async cancel(ownerId: string, msgId: string) {
      const r = __subs.find((s) => s.owner_id === ownerId && s.msg_id === msgId);
      if (r) r.cancelled = true;
    }
    async listActive({ owner }: { owner?: string } = {}) {
      const now = Date.now();
      return __subs
        .filter((s) => !s.cancelled)
        .filter((s) => s.expires_ts == null || new Date(s.expires_ts).getTime() > now)
        .filter((s) => (owner ? s.owner_id === owner : true))
        .sort((a, b) =>
          a.created_ts < b.created_ts ? -1 : a.created_ts > b.created_ts ? 1 : a.msg_id < b.msg_id ? -1 : 1,
        );
    }
  },
}));
vi.mock('../log', () => ({
  coordLog: { appendLine: async (_surface: string, _writerKey: string, env: any) => { __inbox.push(env); } },
}));
vi.mock('../messages', () => ({
  readInbox: async (owner: string, opts: { kinds?: string[] } = {}) =>
    __inbox
      .filter((e) => Array.isArray(e.to) && e.to.includes(owner))
      .filter((e) => (opts.kinds ? opts.kinds.includes(e.kind) : true)),
}));

import {
  addWatch,
  findMatchingWatchers,
  fireNotifications,
  listWatches,
  matchesPattern,
  patternToRegex,
  removeWatch,
} from '../subscriptions';
import { readInbox } from '../messages';
import type { AgentIdentity } from '../identity';

function id(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'omp-hook-session',
    workspaceId: 'default',
    userId: null,
  };
}

let tmp = '';
let prev: string | undefined;
beforeEach(async () => {
  __subs.length = 0;
  __inbox.length = 0;
  tmp = await fs.mkdtemp(join(tmpdir(), 'coord-d-'));
  prev = process.env.PAPERCUSP_COORD_DIR;
  process.env.PAPERCUSP_COORD_DIR = tmp;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.PAPERCUSP_COORD_DIR;
  else process.env.PAPERCUSP_COORD_DIR = prev;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('pattern matching', () => {
  it('* does not cross / boundaries', () => {
    expect(matchesPattern('apps/operator/*.ts', 'apps/operator/foo.ts')).toBe(true);
    expect(matchesPattern('apps/operator/*.ts', 'apps/operator/sub/foo.ts')).toBe(false);
  });
  it('** matches across path segments', () => {
    expect(matchesPattern('apps/operator/auth/**', 'apps/operator/auth/x/y.ts')).toBe(true);
    expect(matchesPattern('apps/operator/auth/**', 'apps/operator/auth/x.ts')).toBe(true);
    expect(matchesPattern('apps/operator/auth/**', 'apps/operator/other/x.ts')).toBe(false);
  });
  it('regex specials in the pattern are escaped literally', () => {
    const re = patternToRegex('foo.bar+baz');
    expect(re.test('foo.bar+baz')).toBe(true);
    expect(re.test('fooxbar+baz')).toBe(false);
  });
});

describe('addWatch / listWatches / removeWatch', () => {
  it('roundtrip: add appears in listWatches; remove cancels it', async () => {
    const A = id('A');
    const sub = await addWatch(A, { pattern: 'apps/**', trigger: 'lock_acquired' });
    const active = await listWatches();
    expect(active.map((w) => w.msg_id)).toEqual([sub.msg_id]);

    await removeWatch(A, sub.msg_id);
    expect(await listWatches()).toEqual([]);
  });

  it('listWatches({owner}) filters per agent', async () => {
    await addWatch(id('A'), { pattern: 'a/**' });
    await addWatch(id('B'), { pattern: 'b/**' });
    const onlyA = await listWatches({ owner: 'A' });
    expect(onlyA.map((w) => w.owner)).toEqual(['A']);
  });

  it('expired watches drop out', async () => {
    const A = id('A');
    // ttl_sec = -1 produces an already-past expires_ts.
    const w = await addWatch(A, { pattern: 'x/**', ttl_sec: -1 });
    const active = await listWatches();
    expect(active).toEqual([]);
    // The subscribe line is still on disk; only the active filter excludes it.
    expect(w.expires_ts).not.toBeNull();
  });
});

describe('findMatchingWatchers + fireNotifications', () => {
  it('matches by pattern + trigger; trigger=any always accepts', async () => {
    await addWatch(id('A'), { pattern: 'apps/**', trigger: 'lock_acquired' });
    await addWatch(id('B'), { pattern: 'apps/**', trigger: 'any' });
    await addWatch(id('C'), { pattern: 'apps/**', trigger: 'plan_referenced' });

    const lockMatches = await findMatchingWatchers(['apps/foo.ts'], 'lock_acquired');
    expect(lockMatches.map((m) => m.watcher).sort()).toEqual(['A', 'B']);

    const planMatches = await findMatchingWatchers(['apps/foo.ts'], 'plan_referenced');
    expect(planMatches.map((m) => m.watcher).sort()).toEqual(['B', 'C']);
  });

  it('fireNotifications writes one notify per match into each watcher inbox', async () => {
    const src = id('source');
    await addWatch(id('alice'), { pattern: 'apps/**', trigger: 'lock_acquired' });
    await addWatch(id('bob'), { pattern: '**/auth/**', trigger: 'any' });

    const n = await fireNotifications(
      src,
      ['apps/operator/auth/locks/x.ts'],
      'lock_acquired',
    );
    expect(n).toBe(2);

    const aliceInbox = await readInbox('alice', { kinds: ['notify'] });
    expect(aliceInbox).toHaveLength(1);
    expect(aliceInbox[0]?.matched_path).toBe('apps/operator/auth/locks/x.ts');

    const bobInbox = await readInbox('bob', { kinds: ['notify'] });
    expect(bobInbox).toHaveLength(1);
    expect(bobInbox[0]?.pattern).toBe('**/auth/**');
  });

  it('no watches → no notifications', async () => {
    const n = await fireNotifications(id('s'), ['foo'], 'any');
    expect(n).toBe(0);
  });

  it('dedups: overlapping patterns on one watcher → one notify per path (B3)', async () => {
    // alice watches the same path through two overlapping globs.
    await addWatch(id('alice'), { pattern: 'apps/**', trigger: 'any' });
    await addWatch(id('alice'), { pattern: 'apps/operator/**', trigger: 'any' });

    const n = await fireNotifications(
      id('source'),
      ['apps/operator/lib/x.ts'],
      'lock_acquired',
    );
    // Both watches match — but the watcher gets exactly one notify.
    expect(n).toBe(1);
    const inbox = await readInbox('alice', { kinds: ['notify'] });
    expect(inbox).toHaveLength(1);
  });

  it('dedup is per-path: two matched paths still yield two notifies', async () => {
    await addWatch(id('alice'), { pattern: 'apps/**', trigger: 'any' });
    await addWatch(id('alice'), { pattern: 'apps/operator/**', trigger: 'any' });

    const n = await fireNotifications(
      id('source'),
      ['apps/operator/a.ts', 'apps/operator/b.ts'],
      'lock_acquired',
    );
    expect(n).toBe(2);
    const inbox = await readInbox('alice', { kinds: ['notify'] });
    expect(inbox).toHaveLength(2);
  });
});
