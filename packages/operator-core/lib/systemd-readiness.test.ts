import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { notifySystemdReady } from './systemd-readiness';

const originalNotifySocket = process.env.NOTIFY_SOCKET;
const originalTimeout = process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS;

function restoreEnv(name: 'NOTIFY_SOCKET' | 'PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('notifySystemdReady', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.NOTIFY_SOCKET;
    delete process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS;
  });

  afterEach(() => {
    restoreEnv('NOTIFY_SOCKET', originalNotifySocket);
    restoreEnv('PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS', originalTimeout);
    vi.restoreAllMocks();
  });

  it('does nothing when systemd did not provide NOTIFY_SOCKET', () => {
    notifySystemdReady();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('sends READY=1 through systemd-notify with a one-second default timeout', () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';

    notifySystemdReady();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.slice(0, 3)).toEqual([
      'systemd-notify',
      ['--ready'],
      { timeout: 1_000 },
    ]);
  });

  it('honors a configured timeout but clamps it to ten seconds', () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    process.env.PAPERCUSP_SYSTEMD_NOTIFY_TIMEOUT_MS = '20000';

    notifySystemdReady();

    expect(execFileMock.mock.calls[0]?.[2]).toEqual({ timeout: 10_000 });
  });

  it('swallows notifier and logging failures', () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger unavailable');
    });
    execFileMock.mockImplementation(() => {
      throw new Error('systemd-notify unavailable');
    });

    expect(() => notifySystemdReady()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('swallows an asynchronous notifier failure', () => {
    process.env.NOTIFY_SOCKET = '/run/user/1000/notify';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    execFileMock.mockImplementation((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) => {
      callback(new Error('notify failed'));
    });

    expect(() => notifySystemdReady()).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[systemd-readiness] systemd-notify --ready failed: notify failed');
  });
});
