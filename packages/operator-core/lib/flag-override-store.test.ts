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

describe('the gateway sidecar installs the override store (the actual regression guard)', () => {
  it('sidecar-main.ts calls installFlagOverrideStore before startGatewayService', async () => {
    // Source-level assertion: importing sidecar-main for real would boot a gateway. What matters
    // is that the call exists AND precedes the service start (flags are resolved at boot).
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(__dirname, 'inference-gateway', 'sidecar-main.ts'), 'utf8');
    // Strip block + line comments FIRST: the doc comment above the call legitimately names
    // `startGatewayService()` in prose, and a naive indexOf would match that instead of the
    // real call (this very guard caught exactly that on its first run). Measure CODE, not prose.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const install = src.indexOf('installFlagOverrideStore()');
    const start = src.indexOf('await startGatewayService(');
    expect(install, 'gateway sidecar must install the flag override store').toBeGreaterThan(-1);
    expect(start, 'gateway sidecar must call startGatewayService').toBeGreaterThan(-1);
    expect(install, 'install must run BEFORE startGatewayService resolves boot flags').toBeLessThan(start);
  });
});
