import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './psu-launcher.mjs';

vi.mock('./psu-pty-host.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./psu-pty-host.mjs')>()),
  appendHostEvent: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function bareLauncher(reexecCount: string | undefined) {
  process.argv = ['node', '/test/psu-launcher.mjs'];
  vi.stubEnv('PAPERCUSP_PSU_REEXEC', '87');
  vi.stubEnv('PAPERCUSP_PSU_REEXEC_PPID', String(process.ppid));
  vi.stubEnv('PAPERCUSP_PSU_HOST_ADOPT', undefined);
  vi.stubEnv('PAPERCUSP_PSU_REEXEC_COUNT', reexecCount);
  vi.stubEnv('PAPERCUSP_SID', undefined);
  vi.stubEnv('PAPERCUSP_PSU_HOSTED_CUSTOMER', undefined);
}

describe('guarded host adoption before the connection picker', () => {
  it.each([undefined, '1'])('resumes a bare interactive shim with count %s without opening a picker', async (count) => {
    bareLauncher(count);
    const handoff = { ownerId: 'su-existing', mode: 'carry-respawn' };
    const readHandoff = vi.fn().mockReturnValue(handoff);
    const launchHandoff = vi.fn().mockResolvedValue(undefined);
    const connectionFrontController = vi.fn().mockRejectedValue(new Error('unexpected connection picker'));

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).toHaveBeenCalledExactlyOnceWith(process.ppid,
      expect.objectContaining({ ownerId: null, onReject: expect.any(Function) }));
    expect(launchHandoff).toHaveBeenCalledExactlyOnceWith(handoff);
    expect(connectionFrontController).not.toHaveBeenCalled();
  });

  it('keeps an ordinary first launch on the connection route without scanning handoffs', async () => {
    bareLauncher('0');
    const readHandoff = vi.fn();
    const launchHandoff = vi.fn();
    const connectionFrontController = vi.fn().mockResolvedValue({ handled: true, argv: [] });

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).not.toHaveBeenCalled();
    expect(launchHandoff).not.toHaveBeenCalled();
    expect(connectionFrontController).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('keeps the connection route when the existing validator rejects or cannot find a handoff', async () => {
    bareLauncher('1');
    const readHandoff = vi.fn().mockReturnValue(null);
    const launchHandoff = vi.fn();
    const connectionFrontController = vi.fn().mockResolvedValue({ handled: true, argv: [] });

    await main({ readHandoff, launchHandoff, connectionFrontController });

    expect(readHandoff).toHaveBeenCalledOnce();
    expect(launchHandoff).not.toHaveBeenCalled();
    expect(connectionFrontController).toHaveBeenCalledExactlyOnceWith([]);
  });
});
