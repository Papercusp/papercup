import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const beginGovernedExecutionMock = vi.fn();
const governedExecutionRuntimeMock = vi.fn((_workspaceId?: string, _namespace?: string) => ({
  governor: {},
  driver: {},
}));

vi.mock('./execution', () => ({
  beginGovernedExecution: (...args: unknown[]) => beginGovernedExecutionMock(...args),
  governedExecutionRuntime: (workspaceId: string, namespace?: string) =>
    governedExecutionRuntimeMock(workspaceId, namespace),
}));

import { spawnGovernedAgentProcess } from './spawn-execution';

const context = {
  contractVersion: 1 as const,
  requestId: 'request-1',
  rootRequestId: 'request-1',
  parentRequestId: null,
  parentReceiptId: null,
  receiptId: 'WI-1',
  idempotencyKey: 'spawn-1',
  admissionClass: 'agent',
  priority: 0,
  demand: { cpuWeight: 1 },
  depth: 0,
  createdAtMs: 1,
  decisionGeneration: 2,
  leaseId: 'lease-1',
};

describe('spawnGovernedAgentProcess', () => {
  const finish = vi.fn(async () => true);
  const cancel = vi.fn(async () => true);

  beforeEach(() => {
    vi.clearAllMocks();
    beginGovernedExecutionMock.mockResolvedValue({ context, finish, cancel });
  });

  it('admits before spawning, passes nested context, and releases on child exit', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(async (received) => ({
      status: 'ok' as const,
      pid: 42,
      terminal: 'xterm',
      child,
      display: ':0',
      desktopEnvResolvedVia: 'active-seat' as const,
    }));
    const result = await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher', parent: context },
      spawn as never,
    );

    expect(beginGovernedExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'spawn-1', admissionClass: 'agent', parent: context }),
      { owner: 'launcher' },
      expect.anything(),
    );
    expect(spawn).toHaveBeenCalledWith(context);
    expect(result).toMatchObject({ status: 'ok', admissionContext: context });
    child.emit('exit', 0, null);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  });

  it('cancels the durable receipt when the spawn returns an error', async () => {
    const result = await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher' },
      async () => ({ status: 'error', error: 'no terminal', code: 502 }),
    );
    expect(result).toEqual({ status: 'error', error: 'no terminal', code: 502 });
    expect(cancel).toHaveBeenCalledWith('no terminal');
    expect(finish).not.toHaveBeenCalled();
  });

  it('uses the persistent headless childExit observer when available', async () => {
    let resolveExit!: (value: { code: number; signal: null }) => void;
    const childExit = new Promise<{ code: number; signal: null }>((resolve) => { resolveExit = resolve; });
    await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher' },
      async () => ({
        status: 'ok',
        pid: 43,
        terminal: 'headless',
        child: null,
        childExit,
        display: null,
        desktopEnvResolvedVia: null,
      }),
    );
    resolveExit({ code: 0, signal: null });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  });
});
