/**
 * RECURRENCE GUARD for WI-38150 — the gate's self-healer must be launchable.
 *
 * The defect this guards: green-checkpoint's release-red NOTIFY and release-fixer DISPATCH are
 * both reached through `await import(...)` at the very end of a 30-55 minute run, executing
 * against the live staging checkout that git-sync mutates every few minutes. On 2026-08-12 both
 * died on `The requested module './agent-tools/coordination/identity' does not provide an export
 * named 'isTransportOnlyIdentity'` — an export that landed 21 minutes INTO the run. The gate was
 * on its 12th consecutive red, so the ONE path that only runs when the gate is red was broken,
 * and it took the notifier down with it: no repair, and no report that no repair had happened.
 *
 * What this asserts is narrow and true: every module the self-heal paths late-bind can be
 * imported, and `prebindSelfHealModules()` reports honestly whether they were. It cannot detect
 * a mutation that happens mid-run — nothing in-process can — which is exactly why the fix is to
 * bind the graph at run START, and why this guard tests that the binding is possible at all.
 *
 * If this fails, the gate's self-healer is dead. Do NOT quarantine it: a red gate blocks every
 * agent's deploys, and a dead self-healer is how a 12-red streak accumulates unattended.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

/** The modules the self-heal paths late-bind. Kept in lockstep with prebindSelfHealModules(). */
const SELF_HEAL_MODULES = [
  '../../attention-notify',
  '../../blueprint/launch-blueprint',
  '../../dev-data',
  '../../severe-event-broadcast',
  '../../coord/gate-ownership',
] as const;

describe('gate self-healer is launchable (WI-38150)', () => {
  beforeEach(async () => {
    const mod = await import('./release-actions');
    mod.__resetSelfHealPrebindForTest();
  });

  it.each(SELF_HEAL_MODULES)(
    'the self-heal path can import %s — a missing export here means a red gate goes unrepaired',
    async (spec) => {
      // A bare import is the whole assertion: an unresolvable export throws at bind time, which
      // is precisely the failure mode observed (the module RESOLVES, then the named binding fails).
      await expect(import(spec)).resolves.toBeTruthy();
    },
  );

  it('prebindSelfHealModules resolves and announces success when the graph is intact', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { prebindSelfHealModules } = await import('./release-actions');
      await expect(prebindSelfHealModules()).resolves.toBeUndefined();

      const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SELF-HEAL PREBIND FAILED'));
      expect(
        warned,
        `prebind reported a failure, so this run's release-red notify and release-fixer dispatch ` +
          `would NOT launch:\n${warned.join('\n')}`,
      ).toEqual([]);
      expect(log.mock.calls.map((c) => String(c[0])).some((m) => m.includes('self-heal modules prebound'))).toBe(true);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('is idempotent — a stale-red auto-refire recurses in the same process and must not re-announce', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { prebindSelfHealModules } = await import('./release-actions');
      const first = prebindSelfHealModules();
      const second = prebindSelfHealModules();
      // Same promise identity is the contract: one binding per process, shared by every pass.
      expect(second).toBe(first);
      await first;
      const announcements = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('self-heal modules prebound'));
      expect(announcements).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it('green-checkpoint prebinds BEFORE the suite, not after — the window is the whole point', async () => {
    // Anchored to source: binding after the suite would reintroduce the exact defect, and a
    // behavioural assertion would need a 30-minute suite to distinguish the two orderings.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./release-actions.ts', import.meta.url), 'utf8');
    const action = src.indexOf("registerSystemAction('green-checkpoint'");
    expect(action, 'green-checkpoint action not found — this guard is anchored to it').toBeGreaterThan(-1);
    const prebindCall = src.indexOf('await prebindSelfHealModules()', action);
    const routing = src.indexOf("await import('./hive-release-env')", action);
    expect(prebindCall, 'green-checkpoint no longer prebinds the self-heal graph').toBeGreaterThan(-1);
    expect(
      prebindCall,
      'prebind must be the FIRST thing the action does — anything before it can run long enough for the tree to move',
    ).toBeLessThan(routing);
  });
});
