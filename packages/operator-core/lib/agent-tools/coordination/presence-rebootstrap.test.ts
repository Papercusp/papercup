/**
 * presence-rebootstrap.test.ts — P-010 re-bootstrap-on-compaction (D-007).
 *
 * The divergence case the plan calls out explicitly: a snapshot was dropped (the
 * agent's cached roster baseline was lost to compaction) but the cursor advanced
 * — so the next read must re-inject the snapshot ONCE, then never again. Exercised
 * over the InMemoryWatermarkStore (no PG), plus the pure render guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryWatermarkStore } from '@papercusp/pubsub-substrate/watermark-store';
import {
  configureWatermarkStore,
  resetWatermarkStore,
  readWatermark,
  writeWatermark,
} from './watermarks';
import {
  consumePresenceRebootstrap,
  renderPresenceRebootstrapBlock,
  type PresenceSnapshot,
} from './presence-snapshot';

describe('consumePresenceRebootstrap (P-010 / D-007)', () => {
  beforeEach(() => configureWatermarkStore(new InMemoryWatermarkStore()));
  afterEach(() => resetWatermarkStore());

  it('divergence case: re-injects the snapshot ONCE after a fresh-context flag, then never again', async () => {
    // A session-lifecycle start marked a re-bootstrap (the cursor advanced while
    // the cached baseline was lost).
    await writeWatermark('su-x', { snapshot_rebootstrap_pending: true });

    let builds = 0;
    const build = async () => {
      builds++;
      return 'BASELINE';
    };

    // Turn 1: flag set → block returned, build ran, flag cleared.
    const r1 = await consumePresenceRebootstrap('su-x', await readWatermark('su-x'), build);
    expect(r1).toBe('BASELINE');
    expect(builds).toBe(1);
    expect((await readWatermark('su-x')).snapshot_rebootstrap_pending).toBe(false);

    // Turn 2: flag cleared → no re-inject, build NOT called again (idempotent).
    const r2 = await consumePresenceRebootstrap('su-x', await readWatermark('su-x'), build);
    expect(r2).toBeNull();
    expect(builds).toBe(1);
  });

  it('no flag → no re-bootstrap, build is never called', async () => {
    let builds = 0;
    const r = await consumePresenceRebootstrap('su-fresh', await readWatermark('su-fresh'), async () => {
      builds++;
      return 'X';
    });
    expect(r).toBeNull();
    expect(builds).toBe(0);
  });

  it('build failure leaves the flag set to retry next turn (clear runs only after build)', async () => {
    await writeWatermark('su-y', { snapshot_rebootstrap_pending: true });
    await expect(
      consumePresenceRebootstrap('su-y', await readWatermark('su-y'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // flag still set → the next turn re-attempts the re-bootstrap.
    expect((await readWatermark('su-y')).snapshot_rebootstrap_pending).toBe(true);
  });

  it('a peer cursor write (omitting the flag) does NOT clear a pending re-bootstrap', async () => {
    await writeWatermark('su-z', { snapshot_rebootstrap_pending: true });
    // e.g. coord:watermark-set advancing a surface cursor — must preserve the flag.
    await writeWatermark('su-z', { messages_since_ts: '2026-06-15T00:00:00.000Z' });
    expect((await readWatermark('su-z')).snapshot_rebootstrap_pending).toBe(true);
  });
});

describe('renderPresenceRebootstrapBlock', () => {
  it('renders a terse line per agent (label / role / intent / plan) under an as_of header', () => {
    const snap: PresenceSnapshot = {
      as_of: '2026-06-15T02:00:00.000Z',
      scope: 'hive',
      summary: { active: 2, stale: 0, federated: 1, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 0, parked: 0, ended: 0, recorded: 0 } },
      active: [
        { ownerLabel: 'su · a', agentRole: 'su', intent: 'reviewing the fold', currentPlanSlug: 'presence-v2-2026-06-14' },
        { ownerLabel: 'fed:42@box', intent: 'remote work' }, // no role/plan
      ],
    };
    const block = renderPresenceRebootstrapBlock(snap);
    expect(block).toContain('[presence ⟲ 2]');
    expect(block).toContain('as_of 2026-06-15T02:00:00.000Z');
    expect(block).toContain('su · a [su] reviewing the fold (presence-v2-2026-06-14)');
    expect(block).toContain('fed:42@box [—] remote work');
  });

  it('caps the roster at REBOOTSTRAP_MAX_ROWS (40) and points overflow at coord:presence', () => {
    const active = Array.from({ length: 45 }, (_, i) => ({
      ownerLabel: `su-${i}`,
      agentRole: 'su',
      intent: 'x',
    }));
    const block = renderPresenceRebootstrapBlock({
      as_of: '2026-06-15T02:00:00.000Z',
      scope: 'workspace',
      summary: { active: 45, stale: 0, federated: 0, wakeable: 0, onDesktop: 0, viewerAttached: 0, byState: { live: 0, parked: 0, ended: 0, recorded: 0 } },
      active,
    });
    const lines = block.split('\n');
    // header + 40 rows + 1 overflow line
    expect(lines.length).toBe(1 + 40 + 1);
    expect(lines[lines.length - 1]).toContain('…+5 more');
  });
});
