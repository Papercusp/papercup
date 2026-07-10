/**
 * flag-override-store.test.ts — recurrence guard for the silent-flag-override class
 * (codex-gateway-chatgpt-live-2026-07-09).
 *
 * THE BUG THIS PINS: `getFlag()` reads the PG override store only in a process that called
 * `initFlagOverrideStore()`. That call lived solely in `flag-bus.ts`, which the standalone
 * inference-gateway process does not import — so the gateway silently ignored every runtime
 * `flags:set` and fell through to FLAG_DEFAULTS. The flip reported success and changed nothing;
 * nothing failed, nothing logged. A DETECTOR, not just a fix, is what this file adds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const readOperatorState = vi.fn();
const writeOperatorState = vi.fn();

vi.mock('./operator-state-pg', () => ({
  readOperatorState: (...a: unknown[]) => readOperatorState(...a),
  writeOperatorState: (...a: unknown[]) => writeOperatorState(...a),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-under-test' }));

import { initFlagOverrideStore, isOverrideStoreConfigured, getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { installFlagOverrideStore, FLAG_OVERRIDES_STATE_KEY } from './flag-override-store';

describe('installFlagOverrideStore', () => {
  beforeEach(() => {
    readOperatorState.mockReset();
    writeOperatorState.mockReset();
    initFlagOverrideStore(null); // start from "no store", the buggy state
  });
  afterEach(() => {
    initFlagOverrideStore(null);
  });

  it('is NOT configured until installed — the exact state the gateway process was in', () => {
    expect(isOverrideStoreConfigured()).toBe(false);
  });

  it('installs a store that getFlag() actually consults', async () => {
    // A flag whose baked default is OFF, overridden ON at runtime.
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    installFlagOverrideStore();
    expect(isOverrideStoreConfigured()).toBe(true);
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
    expect(readOperatorState).toHaveBeenCalledWith(FLAG_OVERRIDES_STATE_KEY);
  });

  it('WITHOUT the store, a runtime override is silently ignored (the regression, pinned)', async () => {
    // The store is never installed, so the same PG row is never read: getFlag falls through to
    // the baked default. This asserts the FAILURE MODE so a future refactor that drops the
    // install() call is caught here rather than by a dark flag that mysteriously won't turn on.
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(false);
    expect(readOperatorState).not.toHaveBeenCalled();
  });

  it('set(key, null) deletes the override rather than writing false', async () => {
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true, other: true });
    installFlagOverrideStore();
    const { setFlagOverride } = await import('@papercusp/flags/server');
    await setFlagOverride(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, null);
    expect(writeOperatorState).toHaveBeenCalledWith(FLAG_OVERRIDES_STATE_KEY, { other: true });
  });

  it('is idempotent — installing twice leaves a working store', async () => {
    readOperatorState.mockResolvedValue({ [FLAGS.CODEX_GATEWAY_OAUTH_PROXY]: true });
    installFlagOverrideStore();
    installFlagOverrideStore();
    expect(isOverrideStoreConfigured()).toBe(true);
    await expect(getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system')).resolves.toBe(true);
  });
});

/**
 * EVERY standalone process that reaches a flag read must install the override store.
 *
 * These processes do NOT import flag-bus (it drags in SSE + lexicon config), so each must
 * install the store itself or it silently serves FLAG_DEFAULTS and ignores every `flags:set`.
 * The gateway shipped in exactly that state; its two sibling sidecars (spawner, substrate) had
 * the same latent hole, found by transitive import-reachability rather than by grep — a DIRECT
 * grep exonerates all three, because each one's flag read lives several modules deep (the
 * gateway's is in launch.ts, not sidecar-main.ts).
 *
 * Table-driven so adding a new sidecar to the list is the natural way to protect it.
 */
describe('every standalone sidecar installs the override store (the actual regression guard)', () => {
  const ENTRYPOINTS: Array<{ file: string[]; startMarker: string; what: string }> = [
    { file: ['inference-gateway', 'sidecar-main.ts'], startMarker: 'await startGatewayService(', what: 'inference gateway' },
    { file: ['fleet', 'spawner-sidecar-server.ts'], startMarker: 'server.listen(', what: 'spawner sidecar' },
    { file: ['sync', 'hyperbee', 'substrate-sidecar-server.ts'], startMarker: 'server.listen(', what: 'substrate sidecar' },
  ];

  it.each(ENTRYPOINTS)('$what installs the store before it starts serving', async ({ file, startMarker, what }) => {
    // Source-level assertion: importing these for real would boot a server / open a socket. What
    // matters is that the call EXISTS and PRECEDES the point a flag could first be read.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(__dirname, ...file), 'utf8');
    // Strip block + line comments FIRST: the doc comments above each call legitimately name
    // `startGatewayService()` / the marker in prose, and a naive indexOf would match the comment
    // instead of the real call (this very guard caught exactly that on its first run, and would
    // now catch it three times over). Measure CODE, not prose.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const install = src.indexOf('installFlagOverrideStore()');
    const start = src.indexOf(startMarker);
    expect(install, `${what} must install the flag override store`).toBeGreaterThan(-1);
    expect(start, `${what} must reach its start marker (${startMarker})`).toBeGreaterThan(-1);
    expect(install, `${what}: install must run BEFORE any flag can be resolved`).toBeLessThan(start);
  });
});
