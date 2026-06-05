/**
 * plugin-discovery-clamp.test.ts — pins the getDynamicTools discovery-timeout
 * clamp `Math.min(Math.max(declared, 100), 120_000)` from
 * revive-plugin-system-2026-06-04 D-003.
 *
 * The clamp is INLINED inside `registerPluginTools` in
 * @papercusp/plugin-loader/src/index.ts (around the `DISCOVERY_TIMEOUT_MS`
 * computation) and is NOT directly importable. We therefore pin its arithmetic
 * through the nearest observable surface: a plugin whose `getDynamicTools` never
 * resolves trips the timeout, and the surfaced error
 *   `getDynamicTools timed out after <DISCOVERY_TIMEOUT_MS>ms`
 * reports the exact clamped value. Fake timers fire the timeout deterministically
 * (no real-wall waits), so we can assert the clamp for every input cheaply.
 *
 * LIMITATION (noted per the brief): because the clamp is not exported, this test
 * asserts the *effective* timeout via the error message rather than calling the
 * clamp directly. If the constant were extracted to a named exported helper the
 * assertion could be exact-value rather than message-substring. The existing
 * packages/plugin-loader/src/tools.test.ts covers only {100, default, over-large};
 * this file adds the full {0,-5,50,100,120000,200000,NaN,Infinity,undefined} grid.
 *
 * Run: cd packages/operator-core && npx vitest run lib/plugin-discovery-clamp.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPluginTools, type LoadedPlugin } from '@papercusp/plugin-loader';
import { _resetProjectionRegistryForTests } from '@papercusp/agent-mcp';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const FLOOR = 100;
const CEIL = 120_000;

/** Expected effective (clamped) timeout for a declared value, mirroring the SUT. */
function expectedClamp(declared: number | undefined): number {
  if (typeof declared === 'number' && Number.isFinite(declared)) {
    return Math.min(Math.max(declared, FLOOR), CEIL);
  }
  return DEFAULT_DISCOVERY_TIMEOUT_MS;
}

/**
 * A loaded plugin whose getDynamicTools never resolves — so the ONLY way
 * registerPluginTools settles is via the discovery-timeout Promise.race branch,
 * which surfaces the clamped value in errors[].
 */
function neverResolvingPlugin(name: string, discoveryTimeoutMs: number | undefined): LoadedPlugin {
  return {
    plugin: {
      kind: 'plugin',
      name,
      version: '0.1.0',
      papercusp: '^0.1.0',
      capabilities: [],
      ...(discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs } : {}),
      // Never resolves → registerPluginTools can only complete via the timeout.
      getDynamicTools: () => new Promise<never>(() => {}),
    },
    path: `/tmp/${name}`,
    source: 'global',
    toolDefinitions: [],
    runtime: { kind: 'js' },
  } as unknown as LoadedPlugin;
}

/**
 * Drive registerPluginTools to the timeout under fake timers and return the
 * effective timeout parsed out of the surfaced error message.
 */
async function effectiveTimeoutFor(
  name: string,
  declared: number | undefined,
): Promise<number> {
  const lp = neverResolvingPlugin(name, declared);
  const resultP = registerPluginTools([lp]);
  // Advance past any plausible clamped budget so the timeout fires regardless of
  // which value the clamp picked. (Slightly over the ceiling covers all cases.)
  await vi.advanceTimersByTimeAsync(CEIL + 1);
  const result = await resultP;
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].tool).toBe('<getDynamicTools>');
  const m = /timed out after (\d+)ms/.exec(result.errors[0].error);
  expect(m, `error did not report a timeout: ${result.errors[0].error}`).not.toBeNull();
  return Number(m![1]);
}

beforeEach(() => {
  _resetProjectionRegistryForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('discovery-timeout clamp — Math.min(Math.max(declared, 100), 120_000)', () => {
  // [declared, expected-effective-ms]
  const cases: Array<[label: string, declared: number | undefined, expected: number]> = [
    ['0 → floor 100', 0, 100],
    ['-5 (negative) → floor 100', -5, 100],
    ['50 (below floor) → floor 100', 50, 100],
    ['100 (at floor) → 100', 100, 100],
    ['120000 (at ceil) → 120000', 120_000, 120_000],
    ['200000 (above ceil) → ceil 120000', 200_000, 120_000],
    ['NaN (non-finite) → default 10000', Number.NaN, 10_000],
    ['Infinity (non-finite) → default 10000', Number.POSITIVE_INFINITY, 10_000],
    ['undefined (absent) → default 10000', undefined, 10_000],
  ];

  it.each(cases)('declared=%s', async (label, declared, expected) => {
    // The local mirror and the table agree (guards the table itself).
    expect(expectedClamp(declared)).toBe(expected);
    const effective = await effectiveTimeoutFor(
      `clamp-${String(label).replace(/\W+/g, '-')}`,
      declared,
    );
    expect(effective).toBe(expected);
  });
});
