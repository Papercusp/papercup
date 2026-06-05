/**
 * su-locks-workspace-cap — the listener-pool cap (plan P-014 branch).
 *
 * `subscribeWorkspace` caps concurrent distinct-workspace LISTEN subscriptions
 * at MAX_ACTIVE_WORKSPACES = 20 (the listener pool is `max: 20`); the 21st
 * distinct workspace throws TooManyActiveWorkspacesError. This is the first
 * user-visible failure mode at scale (≥21 concurrently-waiting workspaces), and
 * `locks:acquire` turns it into a clean `reason: 'too_many_active_workspaces'`
 * busy result — but the cap itself had ZERO coverage. Deterministic: the guard
 * (`STATE.size >= 20`) fires on the 21st BEFORE it reserves a connection, so the
 * test never depends on timing or on a 21st socket the pool couldn't grant.
 *
 * Own file so the module-level listener STATE is isolated in its own forked
 * process (it fills to the cap here).
 */
import { describe, it, expect } from 'vitest';
import { getTxPool, _resetForTests } from '../su-lock-store';
import {
  subscribeWorkspace,
  TooManyActiveWorkspacesError,
  _resetListenersForTests,
} from '../workspace-listener';

async function dbLive(): Promise<boolean> {
  try {
    await getTxPool()`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

describe('su-locks workspace-listener cap', async () => {
  const live = await dbLive();

  it.skipIf(!live)('admits 20 distinct workspaces, then throws on the 21st', async () => {
    const unsubs: Array<() => Promise<void>> = [];
    try {
      // 20 distinct workspaces subscribe cleanly (fills the listener pool, max 20).
      for (let i = 0; i < 20; i++) {
        unsubs.push(await subscribeWorkspace(`cap-ws-${i}`, () => {}));
      }
      expect(unsubs).toHaveLength(20);

      // The 21st distinct workspace is rejected — the cap guard fires before it
      // reserves a 21st connection.
      await expect(subscribeWorkspace('cap-ws-overflow', () => {})).rejects.toBeInstanceOf(
        TooManyActiveWorkspacesError,
      );

      // Re-subscribing an ALREADY-active workspace still works (no new STATE
      // entry, no cap hit) — only DISTINCT workspaces count toward the cap.
      const dup = await subscribeWorkspace('cap-ws-0', () => {});
      await dup();
    } finally {
      for (const u of unsubs) await u().catch(() => {});
      await _resetListenersForTests();
      await _resetForTests();
    }
  }, 60_000);

  it('skipped diagnostic when DB unreachable', () => {
    expect(live ? 'live' : 'offline').toMatch(/^(live|offline)$/);
  });
});
