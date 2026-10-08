import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));

import { createSystemdNotifier, notifySystemdReady } from './systemd-readiness';

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

describe('persistent systemd notification transport', () => {
  beforeEach(() => spawnMock.mockReset());

  function senderFixture() {
    const sender = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    const requests: Array<{ id: number; state: string }> = [];
    sender.stdin.on('data', (chunk) => requests.push(JSON.parse(String(chunk))));
    spawnMock.mockReturnValue(sender);
    const notifier = createSystemdNotifier({ PATH: '/usr/bin', NOTIFY_SOCKET: '/test/notify', SECRET: 'never-copy' }, 100);
    return { sender, requests, notifier: notifier! };
  }

  it('does not spawn a bridge outside a notify service', () => {
    expect(createSystemdNotifier({})).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps one sender alive for readiness and subsequent heartbeats without copying secrets', async () => {
    const { sender, requests, notifier } = senderFixture();
    try {
      const ready = notifier.notify('READY=1');
      sender.stdout.write(JSON.stringify({ id: 1, result: 1 }) + '\n');
      await ready;
      const ping = notifier.notify('WATCHDOG=1');
      sender.stdout.write(JSON.stringify({ id: 2, result: 1 }) + '\n');
      await ping;
      expect(requests).toEqual([{ id: 1, state: 'READY=1' }, { id: 2, state: 'WATCHDOG=1' }]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][2].env).toEqual({ PATH: '/usr/bin', NOTIFY_SOCKET: '/test/notify' });
      expect(sender.kill).not.toHaveBeenCalled();
    } finally { notifier.close(); }
    expect(sender.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects native send failure instead of claiming delivery', async () => {
    const { sender, notifier } = senderFixture();
    try {
      const result = expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_send_failed:-13');
      sender.stdout.write(JSON.stringify({ id: 1, result: -13 }) + '\n');
      await result;
    } finally { notifier.close(); }
  });

  it('rejects pending calls when the persistent sender exits', async () => {
    const { sender, notifier } = senderFixture();
    try {
      const result = expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_sender_exit:1');
      sender.emit('exit', 1, null);
      await result;
      await expect(notifier.notify('WATCHDOG=1')).rejects.toThrow('systemd_notification_sender_exit:1');
    } finally { notifier.close(); }
  });
});
