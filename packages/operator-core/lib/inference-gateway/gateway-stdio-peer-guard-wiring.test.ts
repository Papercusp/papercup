/**
 * (WI-39599) The gateway process must install the stdio peer guard ITSELF.
 *
 * The mechanism — that an absorbing 'error' listener stops a broken stdio pipe
 * from becoming an unbounded uncaughtException loop — is already proven by
 * stdio-peer-guard.{test,integration.test}.ts. What THIS file guards is the
 * WIRING, which those cannot see: serve.ts installs the guard at module scope,
 * which covers only the PACKAGED re-exec divert. `bin.ts` and the
 * `papercup-inference-gateway` systemd unit enter runGatewaySidecarMain without
 * ever loading serve.ts, so deleting the install from sidecar-main.ts would
 * silently re-arm the 1-core spin on both of those paths while every existing
 * test stayed green.
 *
 * The property asserted is deliberately stronger than "it is installed
 * somewhere": it must be installed EVEN WHEN BOOT FAILS. The uncaughtException
 * backstop in this module is registered only after a successful boot (so genuine
 * startup faults still propagate), and copying that placement for the guard
 * would leave the whole startup window — the window in which a supervisor is
 * most likely to be killing things — unprotected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetStdioPeerGuardForTests,
  installStdioPeerGuard,
} from '../process-supervision/stdio-peer-guard';

vi.mock('../flag-override-store', () => ({ installFlagOverrideStore: vi.fn() }));
vi.mock('../flag-change-listener', () => ({ ensureFlagChangeListener: vi.fn(async () => {}) }));
vi.mock('../runtime-vintage', () => ({ reportRuntimeVintageOnBoot: vi.fn() }));
vi.mock('./launch', () => ({
  DEFAULT_GATEWAY_PORT: 8788,
  // Fail the boot: every assertion below is about what is true DESPITE this.
  startGatewayService: vi.fn(async () => {
    throw new Error('boot failed (test)');
  }),
}));

/**
 * PERMANENT WRONG-IMPL CONTROL — a gateway main that boots exactly like the real
 * one but never installs the guard. It is what this file looked like before the
 * fix, kept so the assertions are demonstrably falsifiable: if `expect` below
 * passed for this too, it would be measuring nothing.
 */
async function unguardedGatewayMainControl(): Promise<void> {
  const { startGatewayService } = await import('./launch');
  await startGatewayService({ port: 8788 } as never);
}

function errorListenerCounts(): { stdout: number; stderr: number } {
  return {
    stdout: process.stdout.listenerCount('error'),
    stderr: process.stderr.listenerCount('error'),
  };
}

describe('runGatewaySidecarMain stdio peer guard wiring', () => {
  let before: { stdout: number; stderr: number };

  beforeEach(() => {
    _resetStdioPeerGuardForTests();
    before = errorListenerCounts();
  });

  afterEach(() => {
    _resetStdioPeerGuardForTests();
  });

  it('installs the guard even though boot fails', async () => {
    const { runGatewaySidecarMain } = await import('./sidecar-main');

    await expect(runGatewaySidecarMain()).rejects.toThrow('boot failed (test)');

    const after = errorListenerCounts();
    expect(after.stdout).toBe(before.stdout + 1);
    expect(after.stderr).toBe(before.stderr + 1);
  });

  it('absorbs a peer-gone stdout error instead of letting it become an uncaughtException', async () => {
    const { runGatewaySidecarMain } = await import('./sidecar-main');
    await expect(runGatewaySidecarMain()).rejects.toThrow('boot failed (test)');

    // The handle is the one the gateway installed (install is idempotent, so this
    // returns it rather than stacking a second listener).
    const handle = installStdioPeerGuard();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    // Emitting 'error' with no listener is what Node turns into an
    // uncaughtException; the guard's listener is what makes this a no-op.
    process.stdout.emit('error', epipe);

    expect(handle.peerGone()).toBe(true);
    expect(handle.absorbed().stdout).toBe(1);
  });

  it('CONTROL: the same assertions fail for a main that omits the install', async () => {
    await expect(unguardedGatewayMainControl()).rejects.toThrow('boot failed (test)');

    const after = errorListenerCounts();
    // No listener was added — this is precisely the state the two tests above
    // would have to distinguish, and it proves they can.
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe(before.stderr);
  });
});
